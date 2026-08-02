import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type { TaskKind } from "../../domain/types.js";
import type { AdapterExecutionTelemetry } from "../adapter.js";
import { scheduleDeadline } from "../../runtime/deadline.js";
import {
  spawnOwnedAgentProcess,
  type OwnedAgentProcess,
  type OwnedTerminationReason,
  type SpawnOwnedAgentProcessRequest,
} from "../../runtime/owned-agent-process.js";
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
      rawInput?: unknown;
    }
  | {
      type: "tool_call_update";
      toolCallId: string;
      kind?: string | null;
      status?: string | null;
      title?: string | null;
      rawInput?: unknown;
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
  timeoutMs?: number;
  heartbeatMs?: number;
  terminationGraceMs?: number;
  secretValues?: readonly string[];
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface KimiAcpClientDependencies {
  readonly platform?: NodeJS.Platform;
  readonly spawnOwnedAgentProcess?: (
    request: SpawnOwnedAgentProcessRequest,
  ) => Promise<OwnedAgentProcess>;
  readonly notifySessionCancel?: (
    context: acp.ClientContext,
    sessionId: string,
  ) => Promise<void>;
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
  executionTelemetry: AdapterExecutionTelemetry | null;
}

interface ModelSelection {
  configId: string;
  value: string;
}

const POSIX_CHILD_CLOSE_TIMEOUT_MS = 1_000;

async function waitForChildClose(
  childClosed: Promise<void>,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    childClosed.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), POSIX_CHILD_CLOSE_TIMEOUT_MS);
    }),
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return closed;
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
      if (update.rawInput !== undefined) event.rawInput = update.rawInput;
      events.push(event);
      return;
    }
    case "tool_call_update": {
      const event: Extract<KimiAcpEvent, { type: "tool_call_update" }> = {
        type: "tool_call_update",
        toolCallId: update.toolCallId,
      };
      if (update.kind !== undefined) event.kind = update.kind;
      if (update.status !== undefined) event.status = update.status;
      if (update.title !== undefined) event.title = update.title;
      if (update.rawInput !== undefined) event.rawInput = update.rawInput;
      events.push(event);
      return;
    }
    default:
      events.push({ type: "other", updateType: update.sessionUpdate });
  }
}

function isExpectedCancellationClose(
  error: unknown,
  cancellationReason: OwnedTerminationReason | undefined,
): boolean {
  return (
    cancellationReason !== undefined &&
    error instanceof Error &&
    error.message === "ACP connection closed"
  );
}

export async function runKimiAcp(
  request: KimiAcpRunRequest,
  dependencies: KimiAcpClientDependencies = {},
): Promise<KimiAcpRunResult> {
  const startedAt = Date.now();
  const events: KimiAcpEvent[] = [];
  const textChunks: string[] = [];
  const diagnostics: string[] = [];
  const secrets = request.secretValues ?? [];
  const heartbeatMs = request.heartbeatMs ?? 15_000;
  const platform = dependencies.platform ?? process.platform;
  let status: KimiRunStatus = "failed";
  let actualModel: string | undefined;
  let sessionId: string | undefined;
  let stopReason: string | undefined;
  let directSessionId: string | undefined;
  let stderr = "";
  let spawnError: Error | undefined;
  let cancellationReason: OwnedTerminationReason | undefined;
  let clientContext: acp.ClientContext | undefined;
  let connection: acp.ClientConnection | undefined;
  const requestCancellation = new AbortController();
  let killTimer: NodeJS.Timeout | undefined;
  let promptSubmitted = false;
  let directChild: ChildProcessWithoutNullStreams | undefined;
  let directChildClosed: Promise<void> | undefined;
  let owned: OwnedAgentProcess | undefined;
  let ownedTermination: Promise<void> | undefined;
  let ownedProcessDrained: true | undefined;
  const preStartCancellation = Symbol("pre-start-cancellation");

  const beginOwnedTermination = (
    process: OwnedAgentProcess,
    reason: OwnedTerminationReason,
  ): Promise<void> => {
    if (ownedTermination !== undefined) {
      return ownedTermination;
    }
    let started: Promise<void>;
    try {
      started = process.terminate(reason);
    } catch (error) {
      started = Promise.reject(error);
    }
    ownedTermination = started;
    void started.catch(() => undefined);
    return started;
  };

  const emitProgress = (message: string): void => {
    try {
      request.onProgress?.(message);
    } catch (error) {
      diagnostics.push(`Progress callback failed: ${String(error)}`);
    }
  };

  const cancel = (reason: OwnedTerminationReason): void => {
    if (cancellationReason !== undefined) {
      return;
    }
    cancellationReason = reason;
    requestCancellation.abort();
    emitProgress(
      `kimi ${reason === "session_shutdown" ? "session shutdown" : reason}`,
    );

    const nativeCancel = async (): Promise<void> => {
      if (clientContext !== undefined && sessionId !== undefined) {
        try {
          await (
            dependencies.notifySessionCancel ??
            ((context: acp.ClientContext, id: string) =>
              context.notify(acp.methods.agent.session.cancel, {
                sessionId: id,
              }))
          )(clientContext, sessionId);
        } catch (error) {
          diagnostics.push(`ACP session cancel failed: ${String(error)}`);
        }
      }
    };

    if (platform === "win32" && owned !== undefined) {
      const nativeCancellation = nativeCancel();
      void nativeCancellation.catch(() => undefined);
      beginOwnedTermination(owned, reason);
      return;
    }

    void nativeCancel();
    if (directChild?.pid !== undefined) {
      killTimer = setTimeout(() => {
        void terminateProcessTree(directChild!.pid!).catch(() => undefined);
      }, request.terminationGraceMs ?? 1_000);
    }
  };

  const onCallerAbort = (): void => cancel("cancelled");
  const onSessionShutdown = (): void => cancel("session_shutdown");
  request.shutdownSignal?.addEventListener("abort", onSessionShutdown, {
    once: true,
  });
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (request.shutdownSignal?.aborted) {
    cancel("session_shutdown");
  } else if (request.signal?.aborted) {
    cancel("cancelled");
  }
  const deadline = scheduleDeadline(
    request.timeoutMs,
    () => cancel("timed_out"),
  );
  const heartbeat = setInterval(() => {
    emitProgress(`kimi heartbeat ${Date.now() - startedAt}ms`);
  }, heartbeatMs);

  try {
    let childInput: NodeJS.WritableStream;
    let childOutput: NodeJS.ReadableStream;
    if (platform === "win32") {
      if (cancellationReason !== undefined) {
        throw preStartCancellation;
      }
      owned = await (
        dependencies.spawnOwnedAgentProcess ?? spawnOwnedAgentProcess
      )({
        executable: request.executable,
        args: request.args,
        cwd: request.cwd,
        environment: request.environment,
      });
      if (cancellationReason !== undefined) {
        beginOwnedTermination(owned, cancellationReason);
        throw preStartCancellation;
      }
      childInput = owned.stdin;
      childOutput = owned.stdout;
      owned.stderr.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk}`.slice(
          -65_536,
        );
      });
    } else {
      directChild = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.environment,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      directChildClosed = new Promise<void>((resolve) => {
        directChild!.once("close", () => resolve());
      });
      directChild.once("error", (error) => {
        spawnError = error;
      });
      directChild.stderr.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk}`.slice(
          -65_536,
        );
      });
      childInput = directChild.stdin;
      childOutput = directChild.stdout;
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(childInput as Writable) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(childOutput as Readable) as unknown as ReadableStream<Uint8Array>,
    );
    emitProgress("kimi process started");
    if (owned !== undefined) {
      if (cancellationReason !== undefined) {
        beginOwnedTermination(owned, cancellationReason);
        throw preStartCancellation;
      }
      await owned.ready;
    }
    if (cancellationReason !== undefined) {
      throw new Error("Kimi ACP invocation was cancelled before initialization");
    }

    const app = acp
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
      });
    const executePrompt = async (
      ctx: acp.ClientContext,
    ): Promise<acp.PromptResponse> => {
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
          return { stopReason: "cancelled" } as acp.PromptResponse;
        }
        promptSubmitted = true;
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
          return { stopReason: "cancelled" } as acp.PromptResponse;
        }

        promptSubmitted = true;
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
    };
    let promptResponse: acp.PromptResponse;
    if (platform === "win32") {
      connection = app.connect(stream);
      promptResponse = await executePrompt(connection.agent);
    } else {
      promptResponse = await app.connectWith(stream, executePrompt);
    }

    stopReason = promptResponse.stopReason;
    status =
      cancellationReason === "timed_out"
        ? "timed_out"
        : cancellationReason === undefined
          ? "completed"
          : "cancelled";
  } catch (error) {
    status =
      cancellationReason === "timed_out"
        ? "timed_out"
        : cancellationReason === undefined
          ? "failed"
          : "cancelled";
    const reportedError = spawnError ?? error;
    if (
      reportedError !== preStartCancellation &&
      !isExpectedCancellationClose(reportedError, cancellationReason)
    ) {
      diagnostics.push(
        redactText(
          reportedError instanceof Error
            ? reportedError.message
            : String(reportedError),
          secrets,
        ),
      );
    }
  } finally {
    deadline.cancel();
    clearInterval(heartbeat);
    if (killTimer !== undefined) clearTimeout(killTimer);
    request.shutdownSignal?.removeEventListener("abort", onSessionShutdown);
    request.signal?.removeEventListener("abort", onCallerAbort);

    if (owned !== undefined) {
      try {
        if (cancellationReason !== undefined) {
          await beginOwnedTermination(owned, cancellationReason);
        } else if (status === "completed") {
          owned.stdin.end();
        } else {
          await beginOwnedTermination(owned, "cancelled");
        }
        const exit = await owned.closed;
        if (exit.ownershipDrained === true) ownedProcessDrained = true;
        await connection?.closed;
        if (
          status === "completed" &&
          exit.completion !== "root_exit"
        ) {
          diagnostics.push("Kimi ACP owned process did not exit naturally");
          status = "failed";
        } else if (
          status === "completed" &&
          exit.rootExitCode !== 0
        ) {
          diagnostics.push(
            `Kimi ACP owned process root exited unsuccessfully: code=${exit.rootExitCode}`,
          );
          status = "failed";
        }
      } catch (error) {
        diagnostics.push(`Owned process cleanup failed: ${String(error)}`);
        status = "failed";
      }
    } else if (directChild !== undefined && directChildClosed !== undefined) {
      let shouldAwaitChildClose = directChild.pid === undefined;
      if (directChild.pid !== undefined) {
        try {
          await terminateProcessTree(directChild.pid);
          shouldAwaitChildClose = true;
        } catch (error) {
          diagnostics.push(`Process tree cleanup failed: ${String(error)}`);
          if (status === "completed") status = "failed";
        }
      }
      if (shouldAwaitChildClose) {
        const childDidClose = await waitForChildClose(directChildClosed);
        if (!childDidClose) {
          directChild.stdin.destroy();
          directChild.stdout.destroy();
          directChild.stderr.destroy();
          diagnostics.push(
            `Kimi ACP child did not close within ${POSIX_CHILD_CLOSE_TIMEOUT_MS}ms after process tree termination`,
          );
          status = "failed";
        }
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
    executionTelemetry: {
      adapterClientInvocationCount: promptSubmitted ? 1 : 0,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      source: "kimi-acp-observable",
      ...(ownedProcessDrained === true ? { ownedProcessDrained: true } : {}),
    },
  };
  if (actualModel !== undefined) result.actualModel = actualModel;
  if (sessionId !== undefined) result.sessionId = sessionId;
  if (stopReason !== undefined) result.stopReason = stopReason;
  return result;
}
