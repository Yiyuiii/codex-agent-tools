import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  runPiRpc as runPiRpcProduction,
  type PiRpcClientDependencies,
  type PiRpcRunRequest,
} from "../../../src/adapters/pi/client.js";
import type {
  OwnedAgentProcess,
  OwnedProcessExit,
  OwnedTerminationReason,
  SpawnOwnedAgentProcessRequest,
} from "../../../src/runtime/owned-agent-process.js";
import { terminatePosixProcessGroup } from "../../../src/runtime/process-tree.js";
import { resolveWindowsJobHelperForModule } from "../../../src/runtime/windows-job-helper.js";
import { spawnWindowsOwnedAgentProcessWithDependencies } from "../../../src/runtime/windows-owned-agent-process.js";

const fakePath = fileURLToPath(
  new URL("../../fakes/fake-pi-rpc.mjs", import.meta.url),
);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const syntheticDistModuleUrl = pathToFileURL(
  path.join(repositoryRoot, "dist", "pi-client-test.mjs"),
).href;
const windowsIt = it.runIf(process.platform === "win32");
const posixIt = it.runIf(process.platform !== "win32");
const tempDirectories: string[] = [];
const fallbackPids: number[] = [];
const ownedTeardowns: Array<() => Promise<void>> = [];

async function spawnCurrentHostOwnedProcess(
  request: SpawnOwnedAgentProcessRequest,
): Promise<OwnedAgentProcess> {
  return spawnWindowsOwnedAgentProcessWithDependencies(request, {
    resolveHelper: () =>
      resolveWindowsJobHelperForModule(syntheticDistModuleUrl),
  });
}

const defaultDependencies: PiRpcClientDependencies | undefined =
  process.platform === "win32"
    ? { spawnOwnedAgentProcess: spawnCurrentHostOwnedProcess }
    : undefined;

function runPiRpc(
  request: PiRpcRunRequest,
  dependencies: PiRpcClientDependencies | undefined = defaultDependencies,
) {
  return runPiRpcProduction(request, dependencies);
}

function trackedWindowsDependencies(
  options: {
    completionOverride?: OwnedProcessExit["completion"];
    neverReady?: boolean;
    rejectClosed?: boolean;
    rejectTerminate?: boolean;
    forwardTermination?: boolean;
    stallAbortWriteCallback?: boolean;
  } = {},
): {
  dependencies: PiRpcClientDependencies;
  exits: OwnedProcessExit[];
  operations: string[];
  reasons: OwnedTerminationReason[];
} {
  const exits: OwnedProcessExit[] = [];
  const operations: string[] = [];
  const reasons: OwnedTerminationReason[] = [];
  return {
    exits,
    operations,
    reasons,
    dependencies: {
      async spawnOwnedAgentProcess(request) {
        const owned = await spawnCurrentHostOwnedProcess(request);
        if (options.neverReady === true) await owned.ready;
        const watchdog = setTimeout(() => {
          void owned.terminate("cancelled").catch(() => undefined);
        }, 15_000);
        ownedTeardowns.push(async () => {
          clearTimeout(watchdog);
          await owned.terminate("cancelled").catch(() => undefined);
          await owned.closed.catch(() => undefined);
        });
        const closed = owned.closed.then((exit) => {
          const observedExit: OwnedProcessExit =
            options.completionOverride === undefined
              ? exit
              : { ...exit, completion: options.completionOverride };
          exits.push(observedExit);
          if (options.rejectClosed === true) {
            throw new Error("synthetic Pi owned-process drain failure");
          }
          return observedExit;
        });
        void closed.catch(() => undefined);
        const observedStdin = new Writable({
          write(chunk, encoding, callback) {
            const line = Buffer.from(chunk).toString("utf8");
            const match = /"type":"([^"]+)"/u.exec(line);
            const recordType = match?.[1] ?? "unknown";
            operations.push(`write:${recordType}`);
            try {
              owned.stdin.write(chunk, encoding, (error) => {
                if (
                  recordType === "abort" &&
                  options.stallAbortWriteCallback === true
                ) {
                  return;
                }
                callback(error);
              });
            } catch (error) {
              callback(error instanceof Error ? error : new Error(String(error)));
            }
          },
          final(callback) {
            owned.stdin.end(callback);
          },
        });
        return {
          stdin: observedStdin,
          stdout: owned.stdout,
          stderr: owned.stderr,
          ready:
            options.neverReady === true
              ? new Promise<void>(() => undefined)
              : owned.ready,
          closed,
          async terminate(reason) {
            reasons.push(reason);
            operations.push(`terminate:${reason}`);
            if (options.forwardTermination !== false) {
              await owned.terminate(reason);
            }
            if (options.rejectTerminate === true) {
              throw new Error("synthetic Pi owned-process termination failure");
            }
          },
        };
      },
    },
  };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codex-pi-client-test-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(isAlive(pid)).toBe(false);
}

afterEach(async () => {
  await Promise.all(ownedTeardowns.splice(0).map((teardown) => teardown()));
  for (const pid of fallbackPids.splice(0)) {
    if (isAlive(pid)) {
      await terminatePosixProcessGroup(pid).catch(() => undefined);
    }
  }
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function baseRequest(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  task: "review" | "delegate" = "review",
) {
  return {
    executable: process.execPath,
    executableArgs: [fakePath],
    cwd,
    environment,
    provider: "ark-agent-plan",
    model: "ark-code-latest",
    thinkingLevel: "medium" as const,
    task,
    prompt: "Do the task",
    timeoutMs: 5_000,
    terminationGraceMs: 25,
    secretValues: ["fake-secret"],
  };
}

async function readLog(
  logPath: string,
): Promise<Array<Record<string, unknown>>> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Pi RPC client", () => {
  windowsIt(
    "ends RPC input and accepts natural root_exit after a descendant drains",
    async () => {
      const cwd = await tempDirectory();
      const tracked = trackedWindowsDependencies();
      const result = await runPiRpc(
        {
          ...baseRequest(cwd, {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            FAKE_PI_SCENARIO: "normal-descendant",
          }),
        },
        tracked.dependencies,
      );

      expect(result.status).toBe("completed");
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "root_exit",
      });
      expect(tracked.reasons).toEqual([]);
      expect(tracked.exits).toEqual([
        expect.objectContaining({
          completion: "root_exit",
          rootExitCode: 0,
          ownershipDrained: true,
        }),
      ]);
    },
  );

  windowsIt.each([
    ["caller", "cancelled", "cancelled"],
    ["deadline", "timed_out", "timed_out"],
    ["shutdown", "session_shutdown", "cancelled"],
  ] as const)(
    "maps %s cancellation, starts abort, and terminates ownership once",
    async (source, expectedReason, expectedStatus) => {
      const cwd = await tempDirectory();
      const tracked = trackedWindowsDependencies({ forwardTermination: false });
      const shutdown = new AbortController();
      const caller = new AbortController();
      const request = baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "abort-root-exit",
      });
      const result = await runPiRpc(
        {
          ...request,
          timeoutMs: source === "deadline" ? 1_000 : request.timeoutMs,
          signal: caller.signal,
          shutdownSignal: shutdown.signal,
          onProgress(message) {
            if (message === "pi prompt started") {
              if (source === "caller") caller.abort("caller cancelled");
              if (source === "shutdown") {
                shutdown.abort("stdio closed");
                caller.abort("caller cancelled");
              }
            }
          },
        },
        tracked.dependencies,
      );

      expect(result.status).toBe(expectedStatus);
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "root_exit",
      });
      expect(tracked.reasons).toEqual([expectedReason]);
      expect(tracked.exits).toEqual([
        expect.objectContaining({
          completion: "root_exit",
          ownershipDrained: true,
        }),
      ]);
      expect(
        tracked.operations.filter((value) => value.startsWith("terminate:")),
      ).toEqual([`terminate:${expectedReason}`]);
      expect(tracked.operations.indexOf("write:abort")).toBeGreaterThan(-1);
      expect(tracked.operations.indexOf("write:abort")).toBeLessThan(
        tracked.operations.indexOf(`terminate:${expectedReason}`),
      );
      expect(result.diagnostics.join("\n")).not.toContain(
        "Unexpected Pi RPC response",
      );
    },
  );

  windowsIt.each(["caller", "shutdown", "both"] as const)(
    "does not spawn an owned process for a pre-aborted %s signal",
    async (source) => {
      const cwd = await tempDirectory();
      const caller = new AbortController();
      const shutdown = new AbortController();
      if (source === "caller" || source === "both") caller.abort();
      if (source === "shutdown" || source === "both") shutdown.abort();
      let spawnCalls = 0;

      const result = await runPiRpc(
        {
          ...baseRequest(cwd, {}),
          signal: caller.signal,
          shutdownSignal: shutdown.signal,
        },
        {
          async spawnOwnedAgentProcess() {
            spawnCalls += 1;
            throw new Error("pre-aborted Pi invocation must not spawn");
          },
        },
      );

      expect(result.status).toBe("cancelled");
      expect(result.executionTelemetry).toMatchObject({
        adapterClientInvocationCount: 0,
      });
      expect(result.executionTelemetry?.ownedProcessDrained).toBeUndefined();
      expect(result.executionTelemetry?.ownedProcessCompletion).toBeUndefined();
      expect(spawnCalls).toBe(0);
    },
  );

  windowsIt(
    "terminates without waiting for an abort write callback",
    async () => {
      const cwd = await tempDirectory();
      const caller = new AbortController();
      const tracked = trackedWindowsDependencies({
        forwardTermination: false,
        stallAbortWriteCallback: true,
      });
      const running = runPiRpc(
        {
          ...baseRequest(cwd, {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            FAKE_PI_SCENARIO: "abort-root-exit",
          }),
          signal: caller.signal,
          onProgress(message) {
            if (message === "pi prompt started") caller.abort();
          },
        },
        tracked.dependencies,
      );

      const watchdog = Symbol("test-watchdog");
      const outcome = await Promise.race([
        running,
        new Promise<typeof watchdog>((resolve) => {
          setTimeout(() => resolve(watchdog), 2_000);
        }),
      ]);

      expect(outcome).not.toBe(watchdog);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        status: "cancelled",
      });
      expect(tracked.operations).toEqual(
        expect.arrayContaining(["write:abort", "terminate:cancelled"]),
      );
    },
  );

  windowsIt(
    "terminates pre-ready ownership without waiting for ready",
    async () => {
      const cwd = await tempDirectory();
      const caller = new AbortController();
      const tracked = trackedWindowsDependencies({ neverReady: true });
      const running = runPiRpc(
        {
          ...baseRequest(cwd, {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            FAKE_PI_SCENARIO: "hold",
          }),
          signal: caller.signal,
          onProgress(message) {
            if (message === "pi process started") caller.abort();
          },
        },
        tracked.dependencies,
      );

      const watchdog = Symbol("test-watchdog");
      const outcome = await Promise.race([
        running,
        new Promise<typeof watchdog>((resolve) => {
          setTimeout(() => resolve(watchdog), 2_000);
        }),
      ]);

      expect(outcome).not.toBe(watchdog);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        status: "cancelled",
      });
      expect(
        typeof outcome === "symbol" ? null : outcome.executionTelemetry,
      ).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "cancelled",
      });
      expect(tracked.reasons).toEqual(["cancelled"]);
      expect(tracked.operations).not.toContain("write:abort");
    },
  );

  windowsIt.each([
    ["provider-mismatch", "Pi model binding response mismatch"],
    ["command-error", "Pi RPC set_model failed"],
    ["api-error", "Pi assistant error"],
    ["invalid-json", "Invalid Pi RPC JSON"],
  ] as const)(
    "aborts before one validated owned termination for internal %s failure",
    async (scenario, expectedDiagnostic) => {
      const cwd = await tempDirectory();
      const tracked = trackedWindowsDependencies();
      const result = await runPiRpc(
        baseRequest(cwd, {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          FAKE_PI_SCENARIO: scenario,
        }),
        tracked.dependencies,
      );

      expect(result.status).toBe("failed");
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "cancelled",
      });
      expect(result.diagnostics.join("\n")).toContain(expectedDiagnostic);
      expect(tracked.reasons).toEqual(["cancelled"]);
      expect(
        tracked.operations.filter((value) => value.startsWith("terminate:")),
      ).toEqual(["terminate:cancelled"]);
      expect(tracked.operations.indexOf("write:abort")).toBeGreaterThan(-1);
      expect(tracked.operations.indexOf("write:abort")).toBeLessThan(
        tracked.operations.indexOf("terminate:cancelled"),
      );
      expect(tracked.exits).toEqual([
        expect.objectContaining({ ownershipDrained: true }),
      ]);
      expect(result.diagnostics.join("\n")).not.toContain(
        "Unexpected Pi RPC response",
      );
    },
  );

  windowsIt(
    "fails closed when stdout ends with an incomplete record after agent_settled",
    async () => {
      const cwd = await tempDirectory();
      const tracked = trackedWindowsDependencies();
      const result = await runPiRpc(
        baseRequest(cwd, {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          FAKE_PI_SCENARIO: "settled-incomplete-tail",
        }),
        tracked.dependencies,
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics.join("\n")).toContain("incomplete JSONL record");
    },
  );

  windowsIt(
    "changes cancellation to failed when owned termination rejects",
    async () => {
      const cwd = await tempDirectory();
      const tracked = trackedWindowsDependencies({ rejectTerminate: true });
      const controller = new AbortController();
      const result = await runPiRpc(
        {
          ...baseRequest(cwd, {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            FAKE_PI_SCENARIO: "hold",
          }),
          signal: controller.signal,
          onProgress(message) {
            if (message === "pi prompt started") controller.abort();
          },
        },
        tracked.dependencies,
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics.join("\n")).toContain(
        "synthetic Pi owned-process termination failure",
      );
    },
  );

  windowsIt(
    "changes cancellation to failed when owned drain rejects",
    async () => {
      const cwd = await tempDirectory();
      const tracked = trackedWindowsDependencies({ rejectClosed: true });
      const controller = new AbortController();
      const result = await runPiRpc(
        {
          ...baseRequest(cwd, {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            FAKE_PI_SCENARIO: "hold",
          }),
          signal: controller.signal,
          onProgress(message) {
            if (message === "pi prompt started") controller.abort();
          },
        },
        tracked.dependencies,
      );

      expect(result.status).toBe("failed");
      expect(result.executionTelemetry?.ownedProcessDrained).toBeUndefined();
      expect(result.executionTelemetry?.ownedProcessCompletion).toBeUndefined();
      expect(result.diagnostics.join("\n")).toContain(
        "synthetic Pi owned-process drain failure",
      );
    },
  );

  windowsIt(
    "changes cancellation to failed when owned completion mismatches",
    async () => {
      const cwd = await tempDirectory();
      const tracked = trackedWindowsDependencies({
        completionOverride: "timed_out",
      });
      const controller = new AbortController();
      const result = await runPiRpc(
        {
          ...baseRequest(cwd, {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            FAKE_PI_SCENARIO: "hold",
          }),
          signal: controller.signal,
          onProgress(message) {
            if (message === "pi prompt started") controller.abort();
          },
        },
        tracked.dependencies,
      );

      expect(result.status).toBe("failed");
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "timed_out",
      });
      expect(result.diagnostics.join("\n")).toContain(
        "expected=cancelled actual=timed_out",
      );
    },
  );

  windowsIt(
    "returns a structured failed result when owned spawn rejects",
    async () => {
      const cwd = await tempDirectory();
      const result = await runPiRpc(
        baseRequest(cwd, {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
        }),
        {
          spawnOwnedAgentProcess: async () => {
            throw new Error("synthetic spawn failure fake-secret");
          },
        },
      );

      expect(result.status).toBe("failed");
      expect(result.executionTelemetry).toBeNull();
      expect(result.diagnostics.join("\n")).toContain(
        "synthetic spawn failure [REDACTED]",
      );
    },
  );

  windowsIt(
    "changes completed to failed when owned drain rejects",
    async () => {
      const cwd = await tempDirectory();
      const tracked = trackedWindowsDependencies({ rejectClosed: true });
      const result = await runPiRpc(
        baseRequest(cwd, {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
        }),
        tracked.dependencies,
      );

      expect(result.status).toBe("failed");
      expect(result.executionTelemetry?.ownedProcessDrained).toBeUndefined();
      expect(result.executionTelemetry?.ownedProcessCompletion).toBeUndefined();
      expect(result.diagnostics.join("\n")).toContain(
        "synthetic Pi owned-process drain failure",
      );
    },
  );

  it("spawns direct Ark Pi without parent proxy reinjection", async () => {
    const cwd = await tempDirectory();
    const logPath = path.join(cwd, "rpc-log.jsonl");
    const wrapperPath = path.join(cwd, "assert-environment.mjs");
    await writeFile(
      wrapperPath,
      [
        "if (process.env.HTTP_PROXY !== undefined || process.env.http_proxy !== undefined) process.exit(81);",
        "if (process.env.HTTPS_PROXY !== undefined || process.env.https_proxy !== undefined) process.exit(82);",
        "if (process.env.ALL_PROXY !== undefined || process.env.all_proxy !== undefined) process.exit(83);",
        "if (!process.env.PATH) process.exit(84);",
        'if (process.platform === "win32" && !process.env.SYSTEMROOT) process.exit(85);',
        `await import(${JSON.stringify(pathToFileURL(fakePath).href)});`,
        "",
      ].join("\n"),
      "utf8",
    );
    const originalAllProxy = process.env.ALL_PROXY;
    process.env.ALL_PROXY = "socks5://parent.invalid:9999";
    try {
      const result = await runPiRpc({
        ...baseRequest(cwd, {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          FAKE_PI_LOG: logPath,
        }),
        executableArgs: [wrapperPath],
      });

      expect(result.status).toBe("completed");
      expect(result.actualModel).toBe("ark-code-latest");
      expect((await readLog(logPath)).length).toBeGreaterThan(0);
    } finally {
      if (originalAllProxy === undefined) delete process.env.ALL_PROXY;
      else process.env.ALL_PROXY = originalAllProxy;
    }
  });

  it("correlates commands, accepts fragmented CRLF, and separates events from stderr", async () => {
    const cwd = await tempDirectory();
    const logPath = path.join(cwd, "rpc-log.jsonl");
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_LOG: logPath,
      }),
    );

    expect(result).toMatchObject({
      status: "completed",
      text: "Pi says hello.",
      actualModel: "ark-code-latest",
      executionTelemetry: {
        adapterClientInvocationCount: 1,
        adapterRetryCount: 0,
        runtimeReportedAutoRetryCount: 0,
        adapterReportedFallbackUsed: false,
        source: "pi-rpc-observable",
      },
    });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_execution_start",
          toolName: "read",
        }),
      ]),
    );
    expect(result.diagnostics.join("\n")).toContain("future_event");
    expect(result.diagnostics.join("\n")).toContain(
      "Authorization: [REDACTED]",
    );
    expect(result.diagnostics.join("\n")).not.toContain("fake-secret");
    if (process.platform !== "win32") {
      expect(result.executionTelemetry).not.toBeNull();
      expect(result.executionTelemetry).not.toHaveProperty(
        "ownedProcessDrained",
      );
      expect(result.executionTelemetry).not.toHaveProperty(
        "ownedProcessCompletion",
      );
    }

    const log = await readLog(logPath);
    const argv = log.find((entry) => entry.kind === "argv")?.value as string[];
    expect(argv).toEqual(
      expect.arrayContaining([
        "--mode",
        "rpc",
        "--no-approve",
        "--no-session",
        "--name",
        "codex-external-agents",
        "--provider",
        "ark-agent-plan",
        "--model",
        "ark-code-latest",
        "--tools",
        "read,grep,find,ls",
      ]),
    );
    const commands = log
      .filter((entry) => entry.kind === "command")
      .map((entry) => entry.value as { id?: string; type: string });
    expect(commands.map((command) => command.type)).toEqual([
      "set_model",
      "set_thinking_level",
      "prompt",
    ]);
    expect(commands.map((command) => command.id)).toEqual([
      "pi-1",
      "pi-2",
      "pi-3",
    ]);
  });

  it("enables the fixed writable tool set for delegate", async () => {
    const cwd = await tempDirectory();
    const logPath = path.join(cwd, "rpc-log.jsonl");
    const result = await runPiRpc(
      baseRequest(
        cwd,
        {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          FAKE_PI_LOG: logPath,
        },
        "delegate",
      ),
    );
    expect(result.status).toBe("completed");
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_execution_start",
          toolName: "bash",
        }),
      ]),
    );
    const argv = (await readLog(logPath)).find((entry) => entry.kind === "argv")
      ?.value as string[];
    expect(argv).toContain("read,bash,edit,write,grep,find,ls");
  });

  posixIt(
    "cancels without a timeout and removes the fake RPC POSIX process group",
    async () => {
      const cwd = await tempDirectory();
      const logPath = path.join(cwd, "rpc-log.jsonl");
      const childPidPath = path.join(cwd, "child.pid");
      const controller = new AbortController();
      const { timeoutMs: _omittedTimeoutMs, ...requestWithoutTimeout } =
        baseRequest(cwd, {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          FAKE_PI_LOG: logPath,
          FAKE_PI_SCENARIO: "hold",
          FAKE_PI_CHILD_PID_FILE: childPidPath,
        });
      const result = await runPiRpc({
        ...requestWithoutTimeout,
        signal: controller.signal,
        onProgress: (message) => {
          if (message === "pi prompt started")
            setTimeout(() => controller.abort(), 25);
        },
      });
      expect(result.status).toBe("cancelled");
      expect(result.executionTelemetry).toBeNull();
      const childPid = Number.parseInt(
        await readFile(childPidPath, "utf8"),
        10,
      );
      fallbackPids.push(childPid);
      await waitUntilDead(childPid);
      fallbackPids.pop();
      const commandTypes = (await readLog(logPath))
        .filter((entry) => entry.kind === "command")
        .map((entry) => (entry.value as { type: string }).type);
      expect(commandTypes).toContain("abort");
    },
  );

  it("maps a hard deadline to timed_out", async () => {
    const cwd = await tempDirectory();
    const progress: string[] = [];
    const result = await runPiRpc({
      ...baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "hold",
      }),
      timeoutMs: 1_000,
      heartbeatMs: 20,
      onProgress: (message) => progress.push(message),
    });
    expect(result.status, JSON.stringify(result)).toBe("timed_out");
    if (process.platform === "win32") {
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "timed_out",
      });
    } else {
      expect(result.executionTelemetry).toBeNull();
    }
    expect(
      progress.some((message) => message.startsWith("pi heartbeat ")),
    ).toBe(true);
  });

  it("bounds a stderr flood without feeding it to the JSONL decoder", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_STDERR_BYTES: "100000",
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Pi says hello.");
    expect(result.diagnostics.join("\n")).toContain("[TRUNCATED]");
    expect(
      Buffer.byteLength(result.diagnostics.join("\n"), "utf8"),
    ).toBeLessThan(70_000);
  });

  it.each([
    {
      scenario: "oversized-tool-end-error",
      expected: {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        isError: true,
        truncated: true,
      },
    },
    {
      scenario: "oversized-tool-end-nonboolean",
      expected: {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        truncated: true,
      },
    },
  ] as const)(
    "sanitizes $scenario without inventing a boolean outcome",
    async ({ scenario, expected }) => {
      const cwd = await tempDirectory();
      const result = await runPiRpc({
        ...baseRequest(
          cwd,
          {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            FAKE_PI_SCENARIO: scenario,
          },
          "delegate",
        ),
      });
      const end = result.events.find(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "tool_execution_end",
      );
      expect(end).toEqual(expected);
      expect(JSON.stringify(end)).not.toContain("x".repeat(128));
    },
  );

  it("reports an abnormal exit as failed", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "exit",
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.diagnostics.join("\n")).toMatch(/exit|closed/iu);
  });

  it("fails and redacts an assistant API error with empty content", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "api-error",
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.text).toBe("");
    expect(result.stopReason).toBe("error");
    expect(result.diagnostics.join("\n")).toContain(
      "Pi assistant error: upstream rejected [REDACTED]",
    );
    expect(result.diagnostics.join("\n")).not.toContain("fake-secret");
  });

  it("uses the final assistant state after a transient error is retried successfully", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "retry-success",
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Recovered after retry.");
    expect(result.stopReason).toBe("stop");
    expect(result.executionTelemetry).toMatchObject({
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 1,
      adapterReportedFallbackUsed: false,
      source: "pi-rpc-observable",
    });
    expect(result.diagnostics.join("\n")).toContain(
      "Pi assistant error: temporary quota [REDACTED]",
    );
  });

  it("counts two explicit runtime retry groups without double-counting willRetry", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "retry-two",
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.executionTelemetry).toMatchObject({
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 2,
      adapterReportedFallbackUsed: false,
    });
  });

  it("conservatively counts unbalanced retry events with only a fixed redacted label", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "retry-unbalanced",
      }),
    );

    expect(result.executionTelemetry).toMatchObject({
      runtimeReportedAutoRetryCount: 1,
    });
    expect(result.diagnostics).toContain("pi_runtime_retry_events_unbalanced");
    expect(JSON.stringify(result)).not.toContain(
      "unbalanced retry fake-secret",
    );
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "auto_retry_start" }),
      ]),
    );
  });

  it("counts compaction willRetry as one observable runtime retry", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "compaction-retry",
      }),
    );

    expect(result.executionTelemetry).toMatchObject({
      runtimeReportedAutoRetryCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain(
      "compaction retry fake-secret",
    );
  });

  it.each(["compaction-and-explicit", "agent-explicit-compaction"] as const)(
    "counts compaction retry independently from correlated auto/agent retries in %s",
    async (scenario) => {
      const cwd = await tempDirectory();
      const result = await runPiRpc(
        baseRequest(cwd, {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          FAKE_PI_SCENARIO: scenario,
        }),
      );

      expect(result.executionTelemetry).toMatchObject({
        runtimeReportedAutoRetryCount: 2,
      });
      expect(JSON.stringify(result)).not.toContain(
        "independent compaction retry fake-secret",
      );
      expect(JSON.stringify(result)).not.toContain(
        "explicit retry fake-secret",
      );
    },
  );

  it("conservatively counts two unmatched willRetry signals", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "retry-two-will-only",
      }),
    );

    expect(result.executionTelemetry).toMatchObject({
      runtimeReportedAutoRetryCount: 2,
    });
  });

  it("correlates a willRetry signal reported after its explicit retry group", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "retry-signal-after",
      }),
    );

    expect(result.executionTelemetry).toMatchObject({
      runtimeReportedAutoRetryCount: 1,
    });
    expect(result.diagnostics).not.toContain(
      "pi_runtime_retry_events_unbalanced",
    );
  });

  it("deduplicates repeated start/end records for the same attempt", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "retry-duplicates",
      }),
    );

    expect(result.executionTelemetry).toMatchObject({
      runtimeReportedAutoRetryCount: 1,
    });
    expect(result.diagnostics).not.toContain(
      "pi_runtime_retry_events_unbalanced",
    );
  });

  it("accepts consecutive starts followed by the latest matching end", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "retry-overlapping",
      }),
    );

    expect(result.executionTelemetry).toMatchObject({
      runtimeReportedAutoRetryCount: 2,
    });
    expect(result.diagnostics).not.toContain(
      "pi_runtime_retry_events_unbalanced",
    );
  });

  it("sends qualification retry and compaction disables before the prompt", async () => {
    const cwd = await tempDirectory();
    const logPath = path.join(cwd, "rpc-log.jsonl");
    const result = await runPiRpc({
      ...baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_LOG: logPath,
      }),
      autoRetry: false,
      autoCompaction: false,
    });

    expect(result.status).toBe("completed");
    const commands = (await readLog(logPath))
      .filter((entry) => entry.kind === "command")
      .map((entry) => entry.value as Record<string, unknown>);
    expect(commands.map((command) => command.type)).toEqual([
      "set_model",
      "set_thinking_level",
      "set_auto_retry",
      "set_auto_compaction",
      "prompt",
    ]);
    expect(commands[2]).toMatchObject({ enabled: false });
    expect(commands[3]).toMatchObject({ enabled: false });
  });

  it("fails closed and marks fallback when Pi reports a different provider", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "provider-mismatch",
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toMatchObject({
      adapterClientInvocationCount: 0,
      adapterReportedFallbackUsed: true,
    });
    expect(result.diagnostics.join("\n")).toContain(
      "Pi model binding response mismatch",
    );
  });

  it.each([
    ["runtime-identity-mismatch", "failed"],
    ["runtime-identity-mismatch-failed", "failed"],
  ] as const)(
    "fails closed for assistant runtime identity mismatch in %s",
    async (scenario, expectedStatus) => {
      const cwd = await tempDirectory();
      const result = await runPiRpc(
        baseRequest(cwd, {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          FAKE_PI_SCENARIO: scenario,
        }),
      );

      expect(result.status).toBe(expectedStatus);
      expect(result.executionTelemetry).toMatchObject({
        adapterClientInvocationCount: 1,
        adapterReportedFallbackUsed: true,
      });
      expect(result.diagnostics).toContain("pi_runtime_identity_mismatch");
      expect(JSON.stringify(result)).not.toContain("runtime-model-fake-secret");
      expect(JSON.stringify(result)).not.toContain(
        "runtime-provider-fake-secret",
      );
    },
  );

  it("keeps cancelled status while marking an observed runtime fallback", async () => {
    const cwd = await tempDirectory();
    const controller = new AbortController();
    const result = await runPiRpc({
      ...baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "runtime-identity-mismatch-cancelled",
      }),
      signal: controller.signal,
      onProgress: (message) => {
        if (message === "pi prompt started") controller.abort();
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.executionTelemetry).toMatchObject({
      adapterReportedFallbackUsed: true,
    });
    expect(result.diagnostics).toContain("pi_runtime_identity_mismatch");
  });

  it("marks a retry whose final assistant changes runtime identity", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "retry-final-identity-mismatch",
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toMatchObject({
      runtimeReportedAutoRetryCount: 1,
      adapterReportedFallbackUsed: true,
    });
    expect(result.diagnostics).toContain("pi_runtime_identity_mismatch");
  });

  it("checks assistant identity found only in agent_end.messages", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "runtime-identity-agent-end-only",
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.text).toBe("Agent-end-only result.");
    expect(result.executionTelemetry).toMatchObject({
      adapterReportedFallbackUsed: true,
    });
    expect(result.diagnostics).toContain("pi_runtime_identity_mismatch");
    expect(JSON.stringify(result)).not.toContain("agent-end-model-fake-secret");
  });

  it("returns unknown telemetry when an assistant runtime identity is missing", async () => {
    const cwd = await tempDirectory();
    const result = await runPiRpc(
      baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "runtime-identity-missing",
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toBeNull();
    expect(result.diagnostics).toContain("pi_runtime_identity_unknown");
  });
});
