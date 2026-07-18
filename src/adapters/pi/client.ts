import { execa } from "execa";

import type { AdapterRunResult } from "../adapter.js";
import { redactText } from "../../runtime/redaction.js";
import { terminateProcessTree } from "../../runtime/process-tree.js";
import { LfJsonlDecoder } from "./jsonl.js";

export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

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
  timeoutMs: number;
  heartbeatMs?: number;
  terminationGraceMs?: number;
  secretValues?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
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

function sanitizedEvent(
  event: Record<string, unknown>,
  secrets: readonly string[],
): unknown {
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") > 65_536) {
    return {
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      truncated: true,
    };
  }
  return JSON.parse(redactText(serialized, secrets)) as unknown;
}

export async function runPiRpc(
  request: PiRpcRunRequest,
): Promise<AdapterRunResult> {
  const startedAt = Date.now();
  const secrets = request.secretValues ?? [];
  const diagnostics: string[] = [];
  const events: unknown[] = [];
  const textChunks: string[] = [];
  const pending = new Map<string, PendingResponse>();
  const decoder = new LfJsonlDecoder();
  const heartbeatMs = request.heartbeatMs ?? 15_000;
  const terminationGraceMs = request.terminationGraceMs ?? 1_000;
  let diagnosticBytes = 0;
  let sequence = 0;
  let actualModel: string | undefined;
  let stopReason: string | undefined;
  let assistantError = false;
  let cancellationReason: "cancelled" | "timed_out" | undefined;
  let status: AdapterRunResult["status"] = "failed";
  let stderr = "";
  let stdoutEnded = false;
  let completionFinished = false;
  let killTimer: NodeJS.Timeout | undefined;

  const appendDiagnostic = (value: string): void => {
    if (diagnosticBytes >= 65_536) return;
    const redacted = redactText(value, secrets);
    const limited = redacted.length <= 4_096
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
  const child = execa(request.executable, args, {
    cwd: request.cwd,
    env: request.environment,
    detached: process.platform !== "win32",
    reject: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
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

  const handleRecord = (value: unknown): void => {
    const record = recordOf(value);
    if (record === undefined || typeof record.type !== "string") {
      appendDiagnostic(`Unknown Pi RPC record: ${JSON.stringify(value)}`);
      return;
    }
    if (record.type === "response") {
      const response = record as RpcResponse;
      const id = response.id;
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
    if (record.type === "message_end") {
      const text = assistantText(record.message);
      if (text !== "") textChunks.push(text);
      const message = recordOf(record.message);
      if (typeof message?.stopReason === "string") stopReason = message.stopReason;
      if (message?.role === "assistant") {
        assistantError =
          typeof message.errorMessage === "string" &&
          message.errorMessage.trim() !== "";
        if (assistantError) {
          appendDiagnostic(`Pi assistant error: ${message.errorMessage}`);
        }
      }
      return;
    }
    if (record.type === "agent_end" && textChunks.length === 0) {
      const messages = Array.isArray(record.messages) ? record.messages : [];
      for (const message of messages) {
        const text = assistantText(message);
        if (text !== "") textChunks.push(text);
      }
      return;
    }
    if (record.type.startsWith("tool_execution_")) {
      events.push(sanitizedEvent(record, secrets));
      return;
    }
    if (record.type === "agent_settled") finishCompletion();
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    try {
      for (const record of decoder.push(chunk)) handleRecord(record);
    } catch (error) {
      finishCompletion(error instanceof Error ? error : new Error(String(error)));
      if (child.pid !== undefined) {
        void terminateProcessTree(child.pid).catch(() => undefined);
      }
    }
  });
  child.stdout?.once("end", () => {
    stdoutEnded = true;
    const tail = decoder.finish().incomplete;
    if (tail !== undefined && cancellationReason === undefined) {
      finishCompletion(new Error("Pi RPC stdout ended with an incomplete JSONL record"));
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-65_536);
  });
  child.once("error", (error) => finishCompletion(error));
  child.once("exit", (code, signal) => {
    const error = new Error(
      `Pi RPC process exited before agent_settled: code=${String(code)} signal=${String(signal)}`,
    );
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    finishCompletion(error);
  });

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
    child.stdin?.write(`${JSON.stringify({ id, type: command, ...fields })}\n`, (error) => {
      if (error !== null && error !== undefined) {
        const waiter = pending.get(id);
        pending.delete(id);
        waiter?.reject(error);
      }
    });
    return response;
  };

  const sendAbort = (): void => {
    const id = `pi-${++sequence}`;
    child.stdin?.write(`${JSON.stringify({ id, type: "abort" })}\n`);
  };
  const cancel = (reason: "cancelled" | "timed_out"): void => {
    if (cancellationReason !== undefined) return;
    cancellationReason = reason;
    emitProgress(`pi ${reason}`);
    sendAbort();
    if (child.pid !== undefined) {
      killTimer = setTimeout(() => {
        void terminateProcessTree(child.pid!).catch(() => undefined);
      }, terminationGraceMs);
    }
  };
  const onCallerAbort = (): void => cancel("cancelled");
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (request.signal?.aborted) cancel("cancelled");
  const deadline = setTimeout(() => cancel("timed_out"), request.timeoutMs);
  const heartbeat = setInterval(
    () => emitProgress(`pi heartbeat ${Date.now() - startedAt}ms`),
    heartbeatMs,
  );

  try {
    const modelResponse = await sendCommand("set_model", {
      provider: request.provider,
      modelId: request.model,
    });
    actualModel = modelIdFromResponse(modelResponse);
    await sendCommand("set_thinking_level", { level: request.thinkingLevel });
    await sendCommand("prompt", { message: request.prompt });
    emitProgress("pi prompt started");
    await completion;
    status = cancellationReason ?? (assistantError ? "failed" : "completed");
  } catch (error) {
    status = cancellationReason ?? "failed";
    if (cancellationReason === undefined) {
      appendDiagnostic(error instanceof Error ? error.message : String(error));
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    if (killTimer !== undefined) clearTimeout(killTimer);
    request.signal?.removeEventListener("abort", onCallerAbort);
    if (child.pid !== undefined) {
      await terminateProcessTree(child.pid).catch((error) => {
        appendDiagnostic(`Process tree cleanup failed: ${String(error)}`);
        if (status === "completed") status = "failed";
      });
    }
    await child.catch(() => undefined);
    if (!stdoutEnded) {
      const tail = decoder.finish().incomplete;
      if (tail !== undefined && cancellationReason === undefined) {
        appendDiagnostic("Pi RPC stopped with an incomplete JSONL record");
        if (status === "completed") status = "failed";
      }
    }
    if (stderr.trim() !== "") appendDiagnostic(stderr.trim());
  }

  const result: AdapterRunResult = {
    status,
    text: redactText(textChunks.join("\n"), secrets),
    elapsedMs: Date.now() - startedAt,
    events,
    diagnostics,
  };
  if (actualModel !== undefined) result.actualModel = actualModel;
  if (stopReason !== undefined) result.stopReason = stopReason;
  return result;
}
