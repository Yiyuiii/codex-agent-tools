import { spawn } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type { TaskKind } from "../../domain/types.js";
import { redactText } from "../../runtime/redaction.js";
import { terminateProcessTree } from "../../runtime/process-tree.js";
import {
  decidePermission,
  selectPermissionResponse,
} from "./permissions.js";

export type KimiRunStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type KimiAcpEvent =
  | { type: "message"; text: string }
  | { type: "thought"; text: string }
  | {
      type: "tool_call";
      toolCallId: string;
      title: string;
      kind?: string;
      status?: string;
      locations: string[];
    }
  | {
      type: "tool_call_update";
      toolCallId: string;
      status?: string;
    }
  | { type: "other"; updateType: string };

export interface KimiAcpRunRequest {
  executable: string;
  args: readonly string[];
  task: TaskKind;
  cwd: string;
  prompt: string;
  model: string;
  sessionId?: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  heartbeatMs?: number;
  terminationGraceMs?: number;
  secretValues?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface KimiAcpRunResult {
  status: KimiRunStatus;
  text: string;
  actualModel?: string;
  sessionId?: string;
  stopReason?: string;
  elapsedMs: number;
  events: KimiAcpEvent[];
  diagnostics: string[];
}

interface ModelSelection {
  configId: string;
  value: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function flattenSelectOptions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const flattened: Record<string, unknown>[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) {
      continue;
    }
    if (typeof record.value === "string") {
      flattened.push(record);
      continue;
    }
    flattened.push(...flattenSelectOptions(record.options));
  }
  return flattened;
}

function findModelSelection(
  configOptions: readonly unknown[] | null | undefined,
  model: string,
): ModelSelection {
  const modelOption = configOptions
    ?.map(asRecord)
    .find(
      (option) =>
        option?.type === "select" &&
        (option.category === "model" || option.id === "model"),
    );
  const configId = modelOption?.id;
  if (typeof configId !== "string") {
    throw new Error("Kimi model configuration is not available");
  }

  const selected = flattenSelectOptions(modelOption?.options).find(
    (option) => option.value === model || option.name === model,
  );
  if (typeof selected?.value !== "string") {
    throw new Error(`Kimi model configuration does not contain ${model}`);
  }
  return { configId, value: selected.value };
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function readContainedTextFile(
  cwd: string,
  request: acp.ReadTextFileRequest,
): Promise<acp.ReadTextFileResponse> {
  if (!path.isAbsolute(request.path)) {
    throw new Error("ACP read path must be absolute");
  }
  const [root, target] = await Promise.all([realpath(cwd), realpath(request.path)]);
  if (!isContainedPath(root, target)) {
    throw new Error("ACP read path escapes cwd");
  }

  const content = await readFile(target, "utf8");
  if (request.line == null && request.limit == null) {
    return { content };
  }
  const lines = content.split(/\r?\n/u);
  const start = Math.max(0, (request.line ?? 1) - 1);
  const end = request.limit == null ? lines.length : start + request.limit;
  return { content: lines.slice(start, end).join("\n") };
}

async function writeContainedTextFile(
  cwd: string,
  request: acp.WriteTextFileRequest,
): Promise<acp.WriteTextFileResponse> {
  if (!path.isAbsolute(request.path)) {
    throw new Error("ACP write path must be absolute");
  }
  const root = await realpath(cwd);
  let checkedTarget: string;
  try {
    checkedTarget = await realpath(request.path);
  } catch {
    const parent = await realpath(path.dirname(request.path));
    checkedTarget = path.join(parent, path.basename(request.path));
  }
  if (!isContainedPath(root, checkedTarget)) {
    throw new Error("ACP write path escapes cwd");
  }
  await writeFile(checkedTarget, request.content, "utf8");
  return {};
}

function collectUpdate(
  update: acp.SessionUpdate,
  events: KimiAcpEvent[],
  textChunks: string[],
): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") {
        textChunks.push(update.content.text);
        events.push({ type: "message", text: update.content.text });
      }
      return;
    case "agent_thought_chunk":
      if (update.content.type === "text") {
        events.push({ type: "thought", text: update.content.text });
      }
      return;
    case "tool_call": {
      const event: Extract<KimiAcpEvent, { type: "tool_call" }> = {
        type: "tool_call",
        toolCallId: update.toolCallId,
        title: update.title,
        locations: (update.locations ?? []).map((location) => location.path),
      };
      if (update.kind !== undefined) event.kind = update.kind;
      if (update.status !== undefined) event.status = update.status;
      events.push(event);
      return;
    }
    case "tool_call_update": {
      const event: Extract<KimiAcpEvent, { type: "tool_call_update" }> = {
        type: "tool_call_update",
        toolCallId: update.toolCallId,
      };
      if (update.status != null) event.status = update.status;
      events.push(event);
      return;
    }
    default:
      events.push({ type: "other", updateType: update.sessionUpdate });
  }
}

export async function runKimiAcp(
  request: KimiAcpRunRequest,
): Promise<KimiAcpRunResult> {
  const startedAt = Date.now();
  const events: KimiAcpEvent[] = [];
  const textChunks: string[] = [];
  const diagnostics: string[] = [];
  const secrets = request.secretValues ?? [];
  const heartbeatMs = request.heartbeatMs ?? 15_000;
  const terminationGraceMs = request.terminationGraceMs ?? 1_000;
  let status: KimiRunStatus = "failed";
  let actualModel: string | undefined;
  let sessionId: string | undefined;
  let stopReason: string | undefined;
  let directSessionId: string | undefined;
  let stderr = "";
  let spawnError: Error | undefined;
  let cancellationReason: "cancelled" | "timed_out" | undefined;
  let clientContext: acp.ClientContext | undefined;
  const requestCancellation = new AbortController();
  let killTimer: NodeJS.Timeout | undefined;

  const emitProgress = (message: string): void => {
    try {
      request.onProgress?.(message);
    } catch (error) {
      diagnostics.push(`Progress callback failed: ${String(error)}`);
    }
  };

  const child = spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.environment,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-65_536);
  });
  emitProgress("kimi process started");

  const cancel = (reason: "cancelled" | "timed_out"): void => {
    if (cancellationReason !== undefined) {
      return;
    }
    cancellationReason = reason;
    requestCancellation.abort();
    emitProgress(`kimi ${reason}`);
    if (clientContext !== undefined && sessionId !== undefined) {
      void clientContext
        .notify(acp.methods.agent.session.cancel, { sessionId })
        .catch((error: unknown) => {
          diagnostics.push(`ACP session cancel failed: ${String(error)}`);
        });
    }
    if (child.pid !== undefined) {
      killTimer = setTimeout(() => {
        void terminateProcessTree(child.pid!).catch(() => undefined);
      }, terminationGraceMs);
    }
  };

  const onCallerAbort = (): void => cancel("cancelled");
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (request.signal?.aborted) {
    cancel("cancelled");
  }
  const deadline = setTimeout(() => cancel("timed_out"), request.timeoutMs);
  const heartbeat = setInterval(() => {
    emitProgress(`kimi heartbeat ${Date.now() - startedAt}ms`);
  }, heartbeatMs);

  try {
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const promptResponse = await acp
      .client({ name: "codex_external_agents" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        const intent: {
          kind?: string | null;
          locations?: readonly { path: string }[] | null;
        } = {};
        if (ctx.params.toolCall.kind !== undefined) {
          intent.kind = ctx.params.toolCall.kind;
        }
        if (ctx.params.toolCall.locations !== undefined) {
          intent.locations = ctx.params.toolCall.locations;
        }
        const decision = decidePermission(request.task, request.cwd, intent);
        return selectPermissionResponse(
          decision,
          ctx.params.options,
        ) as acp.RequestPermissionResponse;
      })
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
        readContainedTextFile(request.cwd, ctx.params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => {
        if (request.task === "review") {
          throw new Error("ACP write denied for review");
        }
        return writeContainedTextFile(request.cwd, ctx.params);
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (directSessionId === ctx.params.sessionId) {
          collectUpdate(ctx.params.update, events, textChunks);
        }
      })
      .connectWith(stream, async (ctx) => {
        clientContext = ctx;
        const initialization = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: request.task === "delegate",
            },
          },
        });

        if (request.sessionId !== undefined) {
          if (
            initialization.agentCapabilities?.sessionCapabilities?.resume == null
          ) {
            throw new Error("Kimi ACP agent does not support session resume");
          }
          sessionId = request.sessionId;
          directSessionId = sessionId;
          const resumed = await ctx.request(acp.methods.agent.session.resume, {
            sessionId,
            cwd: request.cwd,
            mcpServers: [],
          });
          const selection = findModelSelection(
            resumed.configOptions,
            request.model,
          );
          await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: selection.configId,
            value: selection.value,
          });
          actualModel = selection.value;
          emitProgress("kimi prompt started");
          if (cancellationReason !== undefined) {
            await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
            return { stopReason: "cancelled" } as acp.PromptResponse;
          }
          return ctx.request(
            acp.methods.agent.session.prompt,
            {
              sessionId,
              prompt: [{ type: "text", text: request.prompt }],
            },
            { cancellationSignal: requestCancellation.signal },
          );
        }

        return ctx.buildSession(request.cwd).withSession(async (session) => {
          sessionId = session.sessionId;
          const selection = findModelSelection(
            session.newSessionResponse.configOptions,
            request.model,
          );
          await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: selection.configId,
            value: selection.value,
          });
          actualModel = selection.value;
          emitProgress("kimi prompt started");
          if (cancellationReason !== undefined) {
            await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
            return { stopReason: "cancelled" } as acp.PromptResponse;
          }

          void session
            .prompt(request.prompt, {
              cancellationSignal: requestCancellation.signal,
            })
            .catch(() => undefined);
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") {
              return message.response;
            }
            collectUpdate(message.update, events, textChunks);
          }
        });
      });

    stopReason = promptResponse.stopReason;
    status = cancellationReason ?? "completed";
  } catch (error) {
    status = cancellationReason ?? "failed";
    diagnostics.push(
      redactText(
        spawnError?.message ?? (error instanceof Error ? error.message : String(error)),
        secrets,
      ),
    );
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    if (killTimer !== undefined) clearTimeout(killTimer);
    request.signal?.removeEventListener("abort", onCallerAbort);
    if (child.pid !== undefined) {
      try {
        await terminateProcessTree(child.pid);
      } catch (error) {
        diagnostics.push(`Process tree cleanup failed: ${String(error)}`);
        if (status === "completed") status = "failed";
      }
    }
    if (stderr.trim() !== "") {
      diagnostics.push(redactText(stderr.trim(), secrets));
    }
  }

  const result: KimiAcpRunResult = {
    status,
    text: redactText(textChunks.join(""), secrets),
    elapsedMs: Date.now() - startedAt,
    events,
    diagnostics: diagnostics.map((entry) => redactText(entry, secrets)),
  };
  if (actualModel !== undefined) result.actualModel = actualModel;
  if (sessionId !== undefined) result.sessionId = sessionId;
  if (stopReason !== undefined) result.stopReason = stopReason;
  return result;
}
