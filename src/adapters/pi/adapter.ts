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
    const result = await this.#runClient(clientRequest);
    const events = result.events
      .filter((event) =>
        typeof event === "object" &&
        event !== null &&
        ((event as Record<string, unknown>).type === "tool_execution_start" ||
          (event as Record<string, unknown>).type === "tool_execution_end"),
      )
      .map(mapToolEvent);
    if (
      result.status === "completed" &&
      result.actualModel !== request.profile.model
    ) {
      return {
        ...result,
        status: "failed",
        events,
        diagnostics: [
          ...result.diagnostics,
          `Model binding violation: expected ${request.profile.model} but Pi reported ${result.actualModel ?? "no model"}`,
        ],
      };
    }
    return { ...result, events };
  }
}
