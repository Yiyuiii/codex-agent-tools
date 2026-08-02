import { execa } from "execa";
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { AdapterRunResult } from "../adapter.js";
import { scheduleDeadline } from "../../runtime/deadline.js";
import {
  spawnOwnedAgentProcess,
  type OwnedAgentProcess,
  type OwnedProcessExit,
  type OwnedTerminationReason,
  type SpawnOwnedAgentProcessRequest,
} from "../../runtime/owned-agent-process.js";
import { redactText } from "../../runtime/redaction.js";
import { terminateProcessTree } from "../../runtime/process-tree.js";
import { LfJsonlDecoder } from "./jsonl.js";

export type PiThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiRpcRunRequest {
  executable: string;
  executableArgs?: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  provider: string;
  model: string;
  thinkingLevel: PiThinkingLevel;
  task: "review" | "delegate";
  prompt: string;
  timeoutMs?: number;
  heartbeatMs?: number;
  terminationGraceMs?: number;
  secretValues?: readonly string[];
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
  onProgress?: (message: string) => void;
  autoRetry?: boolean;
  autoCompaction?: boolean;
}

export interface PiRpcClientDependencies {
  spawnOwnedAgentProcess?: (
    request: SpawnOwnedAgentProcessRequest,
  ) => Promise<OwnedAgentProcess>;
}

interface RpcResponse extends Record<string, unknown> {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface PendingResponse {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

const KNOWN_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "extension_error",
]);

const REVIEW_TOOLS = "read,grep,find,ls";
const DELEGATE_TOOLS = "read,bash,edit,write,grep,find,ls";

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function assistantText(message: unknown): string {
  const record = recordOf(message);
  if (record?.role !== "assistant" || !Array.isArray(record.content)) return "";
  return record.content
    .map((part) => recordOf(part))
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function modelIdFromResponse(response: RpcResponse): string | undefined {
  const data = recordOf(response.data);
  if (typeof data?.id === "string") return data.id;
  const model = recordOf(data?.model);
  return typeof model?.id === "string" ? model.id : undefined;
}

function providerIdFromResponse(response: RpcResponse): string | undefined {
  const data = recordOf(response.data);
  if (typeof data?.provider === "string") return data.provider;
  const model = recordOf(data?.model);
  return typeof model?.provider === "string" ? model.provider : undefined;
}

function retryAttemptKey(event: Record<string, unknown>): string | undefined {
  const attempt = event.attempt;
  if (typeof attempt === "number" && Number.isFinite(attempt)) {
    return `number:${attempt}`;
  }
  if (typeof attempt === "string" && attempt !== "") {
    return `string:${attempt}`;
  }
  return undefined;
}

function sanitizedEvent(
  event: Record<string, unknown>,
  secrets: readonly string[],
): unknown {
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") > 65_536) {
    const summary: Record<string, unknown> = {
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      truncated: true,
    };
    if (typeof event.isError === "boolean") {
      summary.isError = event.isError;
    }
    return summary;
  }
  return JSON.parse(redactText(serialized, secrets)) as unknown;
}

export async function runPiRpc(
  request: PiRpcRunRequest,
  dependencies: PiRpcClientDependencies = {},
): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  const secrets = request.secretValues ?? [];
  const diagnostics: string[] = [];
  const events: unknown[] = [];
  const textChunks: string[] = [];
  const pending = new Map<string, PendingResponse>();
  const decoder = new LfJsonlDecoder();
  const heartbeatMs = request.heartbeatMs ?? 15_000;
  let diagnosticBytes = 0;
  let sequence = 0;
  let actualModel: string | undefined;
  let stopReason: string | undefined;
  let assistantFailure: Error | undefined;
  let assistantFailureReported = false;
  let cancellationReason: OwnedTerminationReason | undefined;
  let status: AdapterRunResult["status"] = "failed";
  let stderr = "";
  let stdoutEnded = false;
  let decoderFinished = false;
  let completionFinished = false;
  let killTimer: NodeJS.Timeout | undefined;
  let owned: OwnedAgentProcess | undefined;
  let ownedExit: OwnedProcessExit | undefined;
  let ownedProcessDrained: true | undefined;
  let ownedClosedError: unknown;
  let ownedTerminationPromise: Promise<void> | undefined;
  let ownedClosurePromise: Promise<void> | undefined;
  let ownedTerminationReason: OwnedTerminationReason | undefined;
  let ownedReadyState: "pending" | "fulfilled" | "rejected" = "pending";
  let ownedInputEnded = false;
  let ownedFailureReported = false;
  let internalFailure: Error | undefined;
  let adapterClientInvocationCount = 0;
  let adapterReportedFallbackUsed = false;
  const explicitRetryAttempts = new Set<string>();
  const abortResponseIds = new Set<string>();
  let anonymousExplicitRetryCount = 0;
  let activeRetryAttempt: string | "anonymous" | undefined;
  let agentWillRetryCount = 0;
  let compactionWillRetryCount = 0;
  let retryEventsUnbalanced = false;
  let assistantIdentityObserved = false;
  let assistantIdentityUnknown = false;
  let assistantIdentityMismatch = false;

  const preStartCancellationReason: OwnedTerminationReason | undefined =
    request.shutdownSignal?.aborted === true
      ? "session_shutdown"
      : request.signal?.aborted === true
        ? "cancelled"
        : undefined;
  if (preStartCancellationReason !== undefined) {
    return {
      status: "cancelled",
      text: "",
      elapsedMs: Date.now() - startedAt,
      events,
      diagnostics,
      executionTelemetry: {
        adapterClientInvocationCount: 0,
        adapterRetryCount: 0,
        runtimeReportedAutoRetryCount: 0,
        adapterReportedFallbackUsed: false,
        source: "pi-rpc-observable",
      },
    };
  }

  const appendDiagnostic = (value: string): void => {
    if (diagnosticBytes >= 65_536) return;
    const redacted = redactText(value, secrets);
    const limited =
      redacted.length <= 4_096
        ? redacted
        : `${redacted.slice(0, 4_096)}[TRUNCATED]`;
    diagnosticBytes += Buffer.byteLength(limited, "utf8");
    diagnostics.push(limited);
  };
  const emitProgress = (message: string): void => {
    try {
      request.onProgress?.(message);
    } catch (error) {
      appendDiagnostic(`Progress callback failed: ${String(error)}`);
    }
  };
  const observeAssistantIdentity = (message: unknown): void => {
    const record = recordOf(message);
    if (record?.role !== "assistant") return;
    assistantIdentityObserved = true;
    if (
      typeof record.model !== "string" ||
      typeof record.provider !== "string"
    ) {
      assistantIdentityUnknown = true;
      return;
    }
    if (
      record.model !== request.model ||
      record.provider !== request.provider
    ) {
      assistantIdentityMismatch = true;
    }
  };

  const args = [
    ...(request.executableArgs ?? []),
    "--mode",
    "rpc",
    "--no-approve",
    "--no-session",
    "--name",
    "codex-external-agents",
    "--offline",
    "--provider",
    request.provider,
    "--model",
    request.model,
    "--thinking",
    request.thinkingLevel,
    "--tools",
    request.task === "review" ? REVIEW_TOOLS : DELEGATE_TOOLS,
  ];
  let legacyChild: ChildProcess | undefined;
  let legacyCompletion: Promise<unknown> | undefined;
  let stdin: Writable;
  let stdout: Readable;
  let stderrStream: Readable;
  try {
    if (process.platform === "win32") {
      owned = await (
        dependencies.spawnOwnedAgentProcess ?? spawnOwnedAgentProcess
      )({
        executable: request.executable,
        args,
        cwd: request.cwd,
        environment: request.environment,
      });
      stdin = owned.stdin;
      stdout = owned.stdout;
      stderrStream = owned.stderr;
      void owned.ready.then(
        () => {
          ownedReadyState = "fulfilled";
        },
        () => {
          ownedReadyState = "rejected";
        },
      );
    } else {
      const spawned = execa(request.executable, args, {
        cwd: request.cwd,
        env: request.environment,
        extendEnv: false,
        detached: true,
        reject: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      legacyChild = spawned;
      legacyCompletion = spawned;
      if (
        legacyChild.stdin === null ||
        legacyChild.stdout === null ||
        legacyChild.stderr === null
      ) {
        throw new Error("Pi RPC standard I/O is unavailable");
      }
      stdin = legacyChild.stdin;
      stdout = legacyChild.stdout;
      stderrStream = legacyChild.stderr;
    }
  } catch (error) {
    appendDiagnostic(error instanceof Error ? error.message : String(error));
    return {
      status: "failed",
      text: "",
      elapsedMs: Date.now() - startedAt,
      events,
      diagnostics,
      executionTelemetry: null,
    };
  }
  emitProgress("pi process started");

  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  const finishCompletion = (error?: Error): void => {
    if (completionFinished) return;
    completionFinished = true;
    if (error === undefined) resolveCompletion();
    else rejectCompletion(error);
  };
  const rejectPending = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const terminateOwnedOnce = (
    reason: OwnedTerminationReason,
  ): Promise<void> => {
    if (owned === undefined) return Promise.resolve();
    ownedTerminationPromise ??= owned.terminate(reason);
    void ownedTerminationPromise.catch(() => undefined);
    return ownedTerminationPromise;
  };
  const publicCancellationStatus = (
    reason: OwnedTerminationReason,
  ): Extract<AdapterRunResult["status"], "cancelled" | "timed_out"> =>
    reason === "timed_out" ? "timed_out" : "cancelled";
  const reportOwnedFailure = (error: unknown): void => {
    if (ownedFailureReported) return;
    ownedFailureReported = true;
    appendDiagnostic(
      `Owned Pi process cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    status = "failed";
  };
  const validateOwnedExit = (
    exit: OwnedProcessExit,
    expected: "root_exit" | OwnedTerminationReason,
  ): void => {
    const expectedTermination = expected !== "root_exit";
    if (
      exit.completion !== expected &&
      !(expectedTermination && exit.completion === "root_exit")
    ) {
      throw new Error(
        `Owned Pi process completion mismatch: expected=${expected} actual=${exit.completion}`,
      );
    }
    if (expected === "root_exit" && exit.rootExitCode !== 0) {
      throw new Error(
        `Owned Pi process root exited unsuccessfully: code=${exit.rootExitCode}`,
      );
    }
  };
  const normalizeError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));
  const writeRpcLine = (value: Record<string, unknown>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      try {
        stdin.write(`${JSON.stringify(value)}\n`, (error?: Error | null) => {
          if (error !== null && error !== undefined) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  const sendAbort = (): Promise<void> => {
    const id = `pi-${++sequence}`;
    abortResponseIds.add(id);
    return writeRpcLine({ id, type: "abort" }).catch((error) => {
      abortResponseIds.delete(id);
      throw error;
    });
  };
  const startOwnedClosure = (
    reason: OwnedTerminationReason,
  ): Promise<void> => {
    if (owned === undefined || ownedExit !== undefined) return Promise.resolve();
    ownedTerminationReason ??= reason;
    if (ownedClosurePromise === undefined) {
      if (ownedReadyState === "fulfilled") {
        void sendAbort().catch((error) => {
          appendDiagnostic(`Pi RPC abort failed: ${String(error)}`);
        });
      }
      try {
        ownedClosurePromise = terminateOwnedOnce(ownedTerminationReason);
      } catch (error) {
        ownedClosurePromise = Promise.reject(error);
      }
    }
    void ownedClosurePromise.catch(() => undefined);
    return ownedClosurePromise;
  };
  const latchInternalFailure = (error: unknown): Error => {
    const normalized = normalizeError(error);
    if (internalFailure === undefined) {
      internalFailure = normalized;
      if (!(normalized === assistantFailure && assistantFailureReported)) {
        appendDiagnostic(normalized.message);
      }
      rejectPending(normalized);
      finishCompletion(normalized);
      if (owned !== undefined) {
        void startOwnedClosure("cancelled").catch(() => undefined);
      } else if (legacyChild?.pid !== undefined) {
        void terminateProcessTree(legacyChild.pid).catch(() => undefined);
      }
    }
    return internalFailure;
  };
  const finishDecoder = (): void => {
    if (decoderFinished) return;
    decoderFinished = true;
    const tail = decoder.finish().incomplete;
    if (tail !== undefined && cancellationReason === undefined) {
      latchInternalFailure(
        new Error("Pi RPC stdout ended with an incomplete JSONL record"),
      );
    }
  };

  const handleRecord = (value: unknown): void => {
    const record = recordOf(value);
    if (record === undefined || typeof record.type !== "string") {
      appendDiagnostic(`Unknown Pi RPC record: ${JSON.stringify(value)}`);
      return;
    }
    if (record.type === "response") {
      const response = record as RpcResponse;
      const id = response.id;
      if (id !== undefined && abortResponseIds.delete(id)) return;
      const waiter = id === undefined ? undefined : pending.get(id);
      if (waiter === undefined) {
        appendDiagnostic(
          `Unexpected Pi RPC response: ${response.command ?? "unknown"}`,
        );
        return;
      }
      pending.delete(id!);
      if (response.success === true) waiter.resolve(response);
      else {
        waiter.reject(
          new Error(
            `Pi RPC ${waiter.command} failed: ${response.error ?? "unknown error"}`,
          ),
        );
      }
      return;
    }
    if (!KNOWN_EVENT_TYPES.has(record.type)) {
      appendDiagnostic(
        `Unknown Pi RPC event ${record.type}: ${JSON.stringify(record)}`,
      );
      return;
    }
    if (record.type === "agent_end" && record.willRetry === true) {
      agentWillRetryCount += 1;
    }
    if (record.type === "compaction_end" && record.willRetry === true) {
      compactionWillRetryCount += 1;
    }
    if (record.type === "auto_retry_start") {
      const attempt = retryAttemptKey(record);
      if (attempt === undefined) {
        anonymousExplicitRetryCount += 1;
        activeRetryAttempt = "anonymous";
      } else {
        explicitRetryAttempts.add(attempt);
        activeRetryAttempt = attempt;
      }
      return;
    }
    if (record.type === "auto_retry_end") {
      const attempt = retryAttemptKey(record);
      if (attempt === undefined) {
        if (activeRetryAttempt === undefined) {
          anonymousExplicitRetryCount += 1;
          retryEventsUnbalanced = true;
        } else {
          activeRetryAttempt = undefined;
        }
      } else if (!explicitRetryAttempts.has(attempt)) {
        explicitRetryAttempts.add(attempt);
        retryEventsUnbalanced = true;
      } else if (activeRetryAttempt === attempt) {
        activeRetryAttempt = undefined;
      }
      return;
    }
    if (record.type === "message_end") {
      observeAssistantIdentity(record.message);
      const text = assistantText(record.message);
      if (text !== "") textChunks.push(text);
      const message = recordOf(record.message);
      if (typeof message?.stopReason === "string")
        stopReason = message.stopReason;
      if (message?.role === "assistant") {
        if (
          typeof message.errorMessage === "string" &&
          message.errorMessage.trim() !== ""
        ) {
          assistantFailure = new Error(
            `Pi assistant error: ${message.errorMessage}`,
          );
          appendDiagnostic(assistantFailure.message);
          assistantFailureReported = true;
        } else {
          assistantFailure = undefined;
        }
      }
      return;
    }
    if (record.type === "agent_end") {
      const messages = Array.isArray(record.messages) ? record.messages : [];
      const collectText = textChunks.length === 0;
      for (const message of messages) {
        observeAssistantIdentity(message);
        if (collectText) {
          const text = assistantText(message);
          if (text !== "") textChunks.push(text);
        }
      }
      return;
    }
    if (record.type.startsWith("tool_execution_")) {
      events.push(sanitizedEvent(record, secrets));
      return;
    }
    if (record.type === "agent_settled") finishCompletion();
  };

  stdout.on("data", (chunk: Buffer) => {
    if (decoderFinished || internalFailure !== undefined) return;
    try {
      for (const record of decoder.push(chunk)) handleRecord(record);
    } catch (error) {
      latchInternalFailure(error);
    }
  });
  stdout.once("end", () => {
    stdoutEnded = true;
    finishDecoder();
  });
  stderrStream.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-65_536);
  });
  if (owned !== undefined) {
    const observedClosed = owned.closed.then(
      (exit) => {
        ownedExit = exit;
        if (!completionFinished) {
          const error = new Error(
            `Pi RPC process closed before agent_settled: completion=${exit.completion} code=${String(exit.rootExitCode)}`,
          );
          rejectPending(error);
          finishCompletion(error);
        }
        return exit;
      },
      (error: unknown) => {
        ownedClosedError = error;
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        rejectPending(normalized);
        finishCompletion(normalized);
        throw error;
      },
    );
    void observedClosed.catch(() => undefined);
  } else {
    legacyChild!.once("error", (error) => {
      rejectPending(error);
      finishCompletion(error);
    });
    legacyChild!.once("exit", (code, signal) => {
      const error = new Error(
        `Pi RPC process exited before agent_settled: code=${String(code)} signal=${String(signal)}`,
      );
      rejectPending(error);
      finishCompletion(error);
    });
  }

  const sendCommand = (
    command: string,
    fields: Record<string, unknown>,
  ): Promise<RpcResponse> => {
    if (cancellationReason !== undefined) {
      return Promise.reject(new Error(`Pi RPC ${cancellationReason}`));
    }
    const id = `pi-${++sequence}`;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      pending.set(id, { command, resolve, reject });
    });
    void writeRpcLine({ id, type: command, ...fields }).catch((error) => {
      const waiter = pending.get(id);
      pending.delete(id);
      waiter?.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return response;
  };

  let cancellationFlow: Promise<void> | undefined;
  let resolveCancellationStarted!: (reason: OwnedTerminationReason) => void;
  const cancellationStarted = new Promise<OwnedTerminationReason>((resolve) => {
    resolveCancellationStarted = resolve;
  });
  const cancel = (reason: OwnedTerminationReason): void => {
    if (cancellationReason !== undefined) return;
    cancellationReason = reason;
    resolveCancellationStarted(reason);
    emitProgress(`pi ${reason}`);
    if (owned !== undefined) {
      cancellationFlow = startOwnedClosure(reason);
    } else {
      void sendAbort().catch((error) => {
        appendDiagnostic(`Pi RPC abort failed: ${String(error)}`);
      });
      if (legacyChild?.pid !== undefined) {
        const terminationGraceMs = request.terminationGraceMs ?? 1_000;
        killTimer = setTimeout(() => {
          void terminateProcessTree(legacyChild!.pid!).catch(() => undefined);
        }, terminationGraceMs);
      }
      cancellationFlow = Promise.resolve();
    }
    void cancellationFlow.catch(() => undefined);
  };
  const onShutdownAbort = (): void => cancel("session_shutdown");
  const onCallerAbort = (): void => cancel("cancelled");
  request.shutdownSignal?.addEventListener("abort", onShutdownAbort, {
    once: true,
  });
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (request.shutdownSignal?.aborted) cancel("session_shutdown");
  else if (request.signal?.aborted) cancel("cancelled");
  const deadline = scheduleDeadline(request.timeoutMs, () =>
    cancel("timed_out"),
  );
  const heartbeat = setInterval(
    () => emitProgress(`pi heartbeat ${Date.now() - startedAt}ms`),
    heartbeatMs,
  );

  try {
    if (owned !== undefined) {
      const readyOutcome = await Promise.race([
        owned.ready.then(() => "ready" as const),
        cancellationStarted.then(() => "cancelled" as const),
      ]);
      if (readyOutcome === "cancelled" || cancellationReason !== undefined) {
        throw new Error(`Pi RPC ${cancellationReason}`);
      }
    }
    const modelResponse = await sendCommand("set_model", {
      provider: request.provider,
      modelId: request.model,
    });
    actualModel = modelIdFromResponse(modelResponse);
    const actualProvider = providerIdFromResponse(modelResponse);
    if (actualModel !== request.model || actualProvider !== request.provider) {
      adapterReportedFallbackUsed = true;
      throw new Error("Pi model binding response mismatch");
    }
    await sendCommand("set_thinking_level", { level: request.thinkingLevel });
    if (request.autoRetry !== undefined) {
      await sendCommand("set_auto_retry", { enabled: request.autoRetry });
    }
    if (request.autoCompaction !== undefined) {
      await sendCommand("set_auto_compaction", {
        enabled: request.autoCompaction,
      });
    }
    adapterClientInvocationCount = 1;
    await sendCommand("prompt", { message: request.prompt });
    emitProgress("pi prompt started");
    await completion;
    if (assistantFailure !== undefined) throw assistantFailure;
    if (owned !== undefined) {
      if (cancellationReason === undefined) {
        ownedInputEnded = true;
        stdin.end();
      } else {
        await cancellationFlow;
      }
      ownedExit = await owned.closed;
      if (ownedExit.ownershipDrained === true) ownedProcessDrained = true;
      validateOwnedExit(ownedExit, cancellationReason ?? "root_exit");
    }
    status =
      cancellationReason === undefined
        ? "completed"
        : publicCancellationStatus(cancellationReason);
  } catch (error) {
    if (cancellationReason === undefined) {
      if (owned !== undefined && ownedClosedError !== undefined) {
        reportOwnedFailure(error);
      } else {
        latchInternalFailure(error);
      }
    }
    status =
      internalFailure !== undefined || ownedFailureReported
        ? "failed"
        : cancellationReason === undefined
          ? "failed"
          : publicCancellationStatus(cancellationReason);
  } finally {
    deadline.cancel();
    clearInterval(heartbeat);
    if (killTimer !== undefined) clearTimeout(killTimer);
    request.shutdownSignal?.removeEventListener("abort", onShutdownAbort);
    request.signal?.removeEventListener("abort", onCallerAbort);
    if (owned !== undefined) {
      try {
        if (cancellationFlow !== undefined) {
          await cancellationFlow;
        } else if (internalFailure !== undefined) {
          await startOwnedClosure("cancelled");
        } else if (
          !ownedInputEnded &&
          ownedExit === undefined &&
          ownedClosedError === undefined
        ) {
          await startOwnedClosure("cancelled");
        }
      } catch (error) {
        reportOwnedFailure(error);
      }
      try {
        const drainedExit = await owned.closed;
        if (drainedExit.ownershipDrained === true) ownedProcessDrained = true;
        ownedExit ??= drainedExit;
      } catch (error) {
        ownedClosedError ??= error;
        reportOwnedFailure(error);
      }
      if (ownedExit !== undefined) {
        try {
          validateOwnedExit(
            ownedExit,
            ownedTerminationReason ?? "root_exit",
          );
        } catch (error) {
          reportOwnedFailure(error);
        }
      }
    } else {
      if (legacyChild?.pid !== undefined) {
        await terminateProcessTree(legacyChild.pid).catch((error) => {
          appendDiagnostic(`Process tree cleanup failed: ${String(error)}`);
          if (status === "completed") status = "failed";
        });
      }
      await legacyCompletion?.catch(() => undefined);
    }
    if (!stdoutEnded) finishDecoder();
    if (stderr.trim() !== "") appendDiagnostic(stderr.trim());
  }

  if (internalFailure !== undefined) status = "failed";

  if (activeRetryAttempt !== undefined) retryEventsUnbalanced = true;
  if (retryEventsUnbalanced) {
    appendDiagnostic("pi_runtime_retry_events_unbalanced");
  }
  const runtimeReportedAutoRetryCount =
    compactionWillRetryCount +
    Math.max(
      explicitRetryAttempts.size + anonymousExplicitRetryCount,
      agentWillRetryCount,
    );
  let executionTelemetry: AdapterRunResult["executionTelemetry"];
  if (
    adapterClientInvocationCount > 0 &&
    (!assistantIdentityObserved || assistantIdentityUnknown)
  ) {
    appendDiagnostic("pi_runtime_identity_unknown");
    if (status === "completed") status = "failed";
    executionTelemetry = null;
  } else {
    if (assistantIdentityMismatch) {
      adapterReportedFallbackUsed = true;
      appendDiagnostic("pi_runtime_identity_mismatch");
      if (status === "completed") status = "failed";
    }
    executionTelemetry = {
      adapterClientInvocationCount,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount,
      adapterReportedFallbackUsed,
      source: "pi-rpc-observable",
      ...(ownedProcessDrained === true ? { ownedProcessDrained: true } : {}),
    };
  }

  const result: AdapterRunResult = {
    status,
    text: redactText(textChunks.join("\n"), secrets),
    elapsedMs: Date.now() - startedAt,
    events,
    diagnostics,
    executionTelemetry,
  };
  if (actualModel !== undefined) result.actualModel = actualModel;
  if (stopReason !== undefined) result.stopReason = stopReason;
  return result;
}
