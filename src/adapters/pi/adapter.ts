import path from "node:path";

import type {
  AdapterRunRequest,
  AdapterRunResult,
  ExternalAgentAdapter,
} from "../adapter.js";
import { VERSION } from "../../version.js";
import { buildPiChildEnvironment } from "../../runtime/environment.js";
import {
  buildIsolatedPiConfig,
  type IsolatedPiConfig,
} from "./config.js";
import { runPiRpc, type PiRpcRunRequest } from "./client.js";
import {
  locatePi,
  locatePiInvocation,
  type PiInvocation,
} from "./locator.js";

export interface PiAdapterDependencies {
  readonly locateExecutable?: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<string>;
  readonly locateInvocation?: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<PiInvocation>;
  readonly buildConfig?: () => Promise<IsolatedPiConfig>;
  readonly runClient?: (
    request: PiRpcRunRequest,
  ) => Promise<AdapterRunResult>;
  readonly retryMode?: "default" | "qualification-single-attempt";
}

interface PiClientLaunch {
  readonly executable: string;
  readonly executableArgs?: readonly string[];
}

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const INVALID_PI_INVOCATION = "Pi Windows invocation is invalid";

function validatedWindowsLaunch(invocation: PiInvocation): PiClientLaunch {
  const argvPrefix = invocation?.argvPrefix;
  const identity = invocation?.identity;
  const cli = Array.isArray(argvPrefix) ? argvPrefix[0] : undefined;
  if (
    invocation?.executable !== process.execPath ||
    !Array.isArray(argvPrefix) ||
    argvPrefix.length !== 1 ||
    typeof cli !== "string" ||
    cli.trim() === "" ||
    cli.includes("\0") ||
    !path.isAbsolute(cli) ||
    identity?.packageName !== PI_PACKAGE_NAME ||
    typeof identity.packageVersion !== "string" ||
    identity.packageVersion.trim() === "" ||
    typeof identity.nodeEngine !== "string" ||
    identity.nodeEngine.trim() === ""
  ) {
    throw new Error(INVALID_PI_INVOCATION);
  }
  return { executable: process.execPath, executableArgs: [cli] };
}

function collectChildCredentialSecrets(
  profile: AdapterRunRequest["profile"],
  environment: NodeJS.ProcessEnv,
): string[] {
  const names =
    profile.credentialTargetEnv === undefined
      ? profile.credentialEnv
      : [profile.credentialTargetEnv];
  return [
    ...new Set(
      names
        .map((name) => environment[name])
        .filter(
          (value): value is string => value !== undefined && value !== "",
        ),
    ),
  ];
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
    const mapped: Record<string, unknown> = {
      type: "tool_result",
      runtime: "pi-rpc",
      title: toolName,
      rawOutput: record.result,
      toolCallId: record.toolCallId,
    };
    if (typeof record.isError === "boolean") {
      mapped.isError = record.isError;
    }
    return mapped;
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
  readonly #locateInvocation: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<PiInvocation>;
  readonly #buildConfig: () => Promise<IsolatedPiConfig>;
  readonly #runClient: (
    request: PiRpcRunRequest,
  ) => Promise<AdapterRunResult>;
  readonly #retryMode: "default" | "qualification-single-attempt";

  public constructor(dependencies: PiAdapterDependencies = {}) {
    this.#locateExecutable =
      dependencies.locateExecutable ??
      ((environment) => locatePi({ environment }));
    this.#locateInvocation =
      dependencies.locateInvocation ??
      ((environment) => locatePiInvocation({ environment }));
    this.#buildConfig =
      dependencies.buildConfig ??
      (() =>
        buildIsolatedPiConfig({
          version: VERSION,
          providers: ["ark"],
        }));
    this.#runClient = dependencies.runClient ?? runPiRpc;
    this.#retryMode = dependencies.retryMode ?? "default";
  }

  public async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    if (request.profile.runtime !== this.runtime) {
      throw new Error(`PiAdapter cannot run runtime ${request.profile.runtime}`);
    }
    if (request.profile.provider === undefined) {
      throw new Error(`Pi profile ${request.profile.id} has no fixed provider`);
    }
    const launchPromise: Promise<PiClientLaunch> = process.platform === "win32"
      ? this.#locateInvocation(request.parentEnvironment).then(
          validatedWindowsLaunch,
        )
      : this.#locateExecutable(request.parentEnvironment).then(
          (executable) => ({ executable }),
        );
    const [launch, config] = await Promise.all([
      launchPromise,
      this.#buildConfig(),
    ]);
    const environment = buildPiChildEnvironment(
      request.profile,
      config.environment.PI_CODING_AGENT_DIR,
      request.parentEnvironment,
      process.platform,
    );
    const secretValues = collectChildCredentialSecrets(
      request.profile,
      environment,
    );
    const clientRequest: PiRpcRunRequest = {
      executable: launch.executable,
      cwd: request.cwd,
      environment,
      provider: request.profile.provider,
      model: request.profile.model,
      thinkingLevel: "medium",
      task: request.task,
      prompt: request.prompt,
      secretValues,
    };
    if (launch.executableArgs !== undefined) {
      clientRequest.executableArgs = launch.executableArgs;
    }
    if (request.timeoutMs !== undefined) {
      clientRequest.timeoutMs = request.timeoutMs;
    }
    if (request.signal !== undefined) clientRequest.signal = request.signal;
    if (request.shutdownSignal !== undefined) {
      clientRequest.shutdownSignal = request.shutdownSignal;
    }
    if (request.onProgress !== undefined) {
      clientRequest.onProgress = request.onProgress;
    }
    if (this.#retryMode === "qualification-single-attempt") {
      clientRequest.autoRetry = false;
      clientRequest.autoCompaction = false;
    }
    const result = await this.#runClient(clientRequest);
    const combined = {
      ...result,
      events: result.events
        .filter((event) =>
          typeof event === "object" &&
          event !== null &&
          ((event as Record<string, unknown>).type ===
            "tool_execution_start" ||
            (event as Record<string, unknown>).type === "tool_execution_end"),
        )
        .map(mapToolEvent),
    };
    if (
      result.actualModel !== undefined &&
      result.actualModel !== request.profile.model
    ) {
      return {
        ...combined,
        status: "failed",
        diagnostics: [
          ...result.diagnostics,
          `Model binding violation: expected ${request.profile.model} but Pi reported ${result.actualModel}`,
        ],
        executionTelemetry:
          combined.executionTelemetry === null
            ? null
            : {
                ...combined.executionTelemetry,
                adapterReportedFallbackUsed: true,
              },
      };
    }
    if (
      result.status === "completed" &&
      result.actualModel === undefined
    ) {
      return {
        ...combined,
        status: "failed",
        diagnostics: [
          ...result.diagnostics,
          `Model binding violation: expected ${request.profile.model} but Pi reported no model`,
        ],
      };
    }
    return combined;
  }
}
