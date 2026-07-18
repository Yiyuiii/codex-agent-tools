import type {
  AdapterRunRequest,
  AdapterRunResult,
  ExternalAgentAdapter,
} from "../adapter.js";
import { VERSION } from "../../version.js";
import { buildChildEnvironment } from "../../runtime/environment.js";
import {
  buildIsolatedPiConfig,
  type IsolatedPiConfig,
} from "./config.js";
import { runPiRpc, type PiRpcRunRequest } from "./client.js";
import { locatePi } from "./locator.js";

export interface PiAdapterDependencies {
  locateExecutable?: (environment: NodeJS.ProcessEnv) => Promise<string>;
  buildConfig?: () => Promise<IsolatedPiConfig>;
  runClient?: (request: PiRpcRunRequest) => Promise<AdapterRunResult>;
  waitForRetry?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_GEMINI_FREE_TIER_RETRIES = 1;

async function waitForRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Gemini retry cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Gemini retry cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function geminiFreeTierRetryDelay(
  profile: AdapterRunRequest["profile"],
  result: AdapterRunResult,
): number | undefined {
  if (
    profile.provider !== "google" ||
    result.status !== "failed" ||
    !result.diagnostics.some((entry) =>
      entry.includes("generate_content_free_tier_requests"),
    )
  ) {
    return undefined;
  }
  const match = result.diagnostics.join("\n").match(
    /Please retry in\s+(\d+(?:\.\d+)?)s/iu,
  );
  const seconds = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) {
    return undefined;
  }
  return 60_000;
}

function mapToolEvent(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return event;
  const record = event as Record<string, unknown>;
  if (
    record.type !== "tool_execution_start" &&
    record.type !== "tool_execution_end"
  ) {
    return event;
  }
  const toolName = typeof record.toolName === "string" ? record.toolName : "unknown";
  if (record.type === "tool_execution_end") {
    return {
      type: "tool_result",
      runtime: "pi-rpc",
      title: toolName,
      rawOutput: record.result,
      isError: record.isError === true,
      toolCallId: record.toolCallId,
    };
  }
  const kind =
    toolName === "bash"
      ? "execute"
      : toolName === "edit" || toolName === "write"
        ? "write"
        : toolName === "read"
          ? "read"
          : "search";
  return {
    type: "tool_call",
    runtime: "pi-rpc",
    kind,
    title: toolName,
    rawInput:
      typeof record.args === "object" && record.args !== null
        ? record.args
        : {},
    toolCallId: record.toolCallId,
  };
}

export class PiAdapter implements ExternalAgentAdapter {
  public readonly runtime = "pi-rpc" as const;
  readonly #locateExecutable: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<string>;
  readonly #buildConfig: () => Promise<IsolatedPiConfig>;
  readonly #runClient: (
    request: PiRpcRunRequest,
  ) => Promise<AdapterRunResult>;
  readonly #waitForRetry: (
    delayMs: number,
    signal?: AbortSignal,
  ) => Promise<void>;

  public constructor(dependencies: PiAdapterDependencies = {}) {
    this.#locateExecutable =
      dependencies.locateExecutable ??
      ((environment) => locatePi({ environment }));
    this.#buildConfig =
      dependencies.buildConfig ??
      (() =>
        buildIsolatedPiConfig({
          version: VERSION,
          providers: ["ark"],
        }));
    this.#runClient = dependencies.runClient ?? runPiRpc;
    this.#waitForRetry = dependencies.waitForRetry ?? waitForRetry;
  }

  public async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    if (request.profile.runtime !== this.runtime) {
      throw new Error(`PiAdapter cannot run runtime ${request.profile.runtime}`);
    }
    if (request.profile.provider === undefined) {
      throw new Error(`Pi profile ${request.profile.id} has no fixed provider`);
    }
    const [executable, config] = await Promise.all([
      this.#locateExecutable(request.parentEnvironment),
      this.#buildConfig(),
    ]);
    const environment = {
      ...buildChildEnvironment(request.profile, request.parentEnvironment),
      ...config.environment,
    };
    const secretValues = request.profile.credentialEnv
      .map((name) => request.parentEnvironment[name])
      .filter((value): value is string => value !== undefined && value !== "");
    const clientRequest: PiRpcRunRequest = {
      executable,
      cwd: request.cwd,
      environment,
      provider: request.profile.provider,
      model: request.profile.model,
      thinkingLevel: "medium",
      task: request.task,
      prompt: request.prompt,
      timeoutMs: Math.min(
        request.timeoutMs ?? request.profile.timeoutMs,
        request.profile.timeoutMs,
      ),
      secretValues,
    };
    if (request.signal !== undefined) clientRequest.signal = request.signal;
    if (request.onProgress !== undefined) {
      clientRequest.onProgress = request.onProgress;
    }
    const events: unknown[] = [];
    const diagnostics: string[] = [];
    let elapsedMs = 0;
    let retryCount = 0;

    for (;;) {
      const result = await this.#runClient(clientRequest);
      elapsedMs += result.elapsedMs;
      diagnostics.push(...result.diagnostics);
      events.push(
        ...result.events
          .filter((event) =>
            typeof event === "object" &&
            event !== null &&
            ((event as Record<string, unknown>).type ===
              "tool_execution_start" ||
              (event as Record<string, unknown>).type === "tool_execution_end"),
          )
          .map(mapToolEvent),
      );
      const combined = { ...result, elapsedMs, events, diagnostics };
      if (
        result.status === "completed" &&
        result.actualModel !== request.profile.model
      ) {
        return {
          ...combined,
          status: "failed",
          diagnostics: [
            ...diagnostics,
            `Model binding violation: expected ${request.profile.model} but Pi reported ${result.actualModel ?? "no model"}`,
          ],
        };
      }

      const delayMs =
        request.task === "review"
          ? geminiFreeTierRetryDelay(request.profile, result)
          : undefined;
      if (
        delayMs === undefined ||
        retryCount >= MAX_GEMINI_FREE_TIER_RETRIES
      ) {
        return combined;
      }
      try {
        await this.#waitForRetry(delayMs, request.signal);
      } catch (error) {
        return {
          ...combined,
          status: request.signal?.aborted ? "cancelled" : "failed",
          diagnostics: [
            ...diagnostics,
            error instanceof Error ? error.message : String(error),
          ],
        };
      }
      elapsedMs += delayMs;
      retryCount += 1;
    }
  }
}
