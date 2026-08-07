import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runKimiAcp,
  type KimiAcpClientDependencies,
  type KimiAcpRunRequest,
} from "../../../src/adapters/kimi/client.js";
import { spawnWindowsOwnedAgentProcessWithDependencies } from "../../../src/runtime/windows-owned-agent-process.js";
import { resolveWindowsJobHelperForModule } from "../../../src/runtime/windows-job-helper.js";
import type {
  OwnedAgentProcess,
  OwnedProcessExit,
  OwnedTerminationReason,
} from "../../../src/runtime/owned-agent-process.js";

const fakePath = fileURLToPath(
  new URL("../../fakes/fake-kimi-acp.mjs", import.meta.url),
);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const syntheticDistModuleUrl = pathToFileURL(
  path.join(repositoryRoot, "dist", "kimi-client-test.mjs"),
).href;

const dependencies: KimiAcpClientDependencies | undefined =
  process.platform === "win32"
    ? {
        spawnOwnedAgentProcess: (request) =>
          spawnWindowsOwnedAgentProcessWithDependencies(request, {
            resolveHelper: () =>
              resolveWindowsJobHelperForModule(syntheticDistModuleUrl),
          }),
      }
    : undefined;

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "codex-agent-kimi-test-"));
  await writeFile(path.join(cwd, "fixture.txt"), "fixture-content", "utf8");
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    executable: process.execPath,
    args: [fakePath],
    task: "review" as const,
    cwd,
    prompt: "Review fixture.txt",
    model: "kimi-code/k3",
    environment: { ...process.env },
    timeoutMs: 5_000,
    heartbeatMs: 1_000,
    secretValues: [],
    ...overrides,
  };
}

function run(request: KimiAcpRunRequest) {
  return runKimiAcp(request, dependencies);
}

describe("runKimiAcp", () => {
  it("selects the fixed model, aggregates updates, and rejects review writes", async () => {
    const result = await run(
      baseRequest({
        environment: {
          ...process.env,
          FAKE_KIMI_SCENARIO: "write-rpc",
          FAKE_KIMI_STDERR: "Authorization: Bearer test-secret",
        },
        secretValues: ["test-secret"],
      }),
    );

    expect(result).toMatchObject({
      status: "completed",
      sessionId: "fake-session-1",
      actualModel: "kimi-code/k3",
      executionTelemetry: {
        adapterClientInvocationCount: 1,
        adapterRetryCount: 0,
        runtimeReportedAutoRetryCount: 0,
        adapterReportedFallbackUsed: false,
        source: "kimi-acp-observable",
      },
    });
    expect(result.text).toContain(
      "model=kimi-code/k3;read=fixture-content;permission=reject;writeDenied=true",
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "thought",
      "tool_call",
      "tool_call_update",
      "message",
    ]);
    expect(result.events[1]).toMatchObject({
      type: "tool_call",
      rawInput: { path: path.join(cwd, "fixture.txt") },
    });
    expect(result.diagnostics.join("\n")).toContain(
      "Authorization: [REDACTED]",
    );
    expect(result.diagnostics.join("\n")).not.toContain("test-secret");
    await expect(
      import("node:fs/promises").then(({ access }) =>
        access(path.join(cwd, "written.txt")),
      ),
    ).rejects.toBeDefined();
  });

  it("preserves command input first delivered by a tool-call update", async () => {
    const result = await run(
      baseRequest({
        environment: {
          ...process.env,
          FAKE_KIMI_SCENARIO: "late-execute-input",
        },
      }),
    );

    expect(result.status).toBe("completed");
    expect(
      result.events.find(
        (event) =>
          event.type === "tool_call_update" &&
          event.toolCallId === "execute-late-1",
      ),
    ).toMatchObject({
      type: "tool_call_update",
      rawInput: { command: "git status --short" },
    });
    expect(result.diagnostics.join("\n")).not.toContain("git status --short");
  });

  it("rejects reverse reads that escape cwd", async () => {
    const result = await run(
      baseRequest({
        environment: { ...process.env, FAKE_KIMI_SCENARIO: "outside-read" },
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.text).toContain("read=read-denied");
  });

  it("resumes an explicitly selected Kimi session", async () => {
    const result = await run(
      baseRequest({ sessionId: "existing-session" }),
    );
    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("existing-session");
    expect(result.actualModel).toBe("kimi-code/k3");
    expect(result.text).toContain("model=kimi-code/k3");
  });

  it("fails explicitly when the ACP agent does not advertise session resume", async () => {
    const result = await run(
      baseRequest({
        sessionId: "existing-session",
        environment: { ...process.env, FAKE_KIMI_SCENARIO: "no-resume" },
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.diagnostics.join("\n")).toMatch(/does not support session resume/);
  });

  it("emits bridge heartbeats while the child is silent", async () => {
    const progress: string[] = [];
    const result = await run(
      baseRequest({
        environment: { ...process.env, FAKE_KIMI_DELAY_MS: "140" },
        heartbeatMs: 25,
        onProgress: (message: string) => progress.push(message),
      }),
    );
    expect(result.status).toBe("completed");
    expect(progress.filter((message) => message.includes("heartbeat")).length).toBeGreaterThanOrEqual(2);
  });

  it("propagates caller cancellation without a timeout and reports cancelled", async () => {
    const controller = new AbortController();
    const {
      timeoutMs: _omittedTimeoutMs,
      ...requestWithoutTimeout
    } = baseRequest({
      environment: { ...process.env, FAKE_KIMI_SCENARIO: "hang" },
      signal: controller.signal,
      onProgress: (message: string) => {
        if (message === "kimi prompt started") controller.abort();
      },
    });
    const result = await run(requestWithoutTimeout);
    expect(result.status).toBe("cancelled");
    if (process.platform === "win32") {
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "cancelled",
      });
    } else {
      expect(result.executionTelemetry).not.toHaveProperty(
        "ownedProcessCompletion",
      );
    }
    expect(result.diagnostics.join("\n")).not.toContain("ACP connection closed");
  });

  it("enforces a hard deadline without using an idle timeout", async () => {
    const result = await run(
      baseRequest({
        environment: {
          ...process.env,
          FAKE_KIMI_SCENARIO: "hang-ignore-native-cancel",
        },
        timeoutMs: 2_000,
      }),
    );
    expect(result).toMatchObject({ status: "timed_out", diagnostics: [] });
    if (process.platform === "win32") {
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "timed_out",
      });
    } else {
      expect(result.executionTelemetry).not.toHaveProperty(
        "ownedProcessCompletion",
      );
    }
  });

  it("fails rather than silently using the default model", async () => {
    const result = await run(
      baseRequest({
        environment: { ...process.env, FAKE_KIMI_SCENARIO: "no-model" },
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toMatchObject({
      adapterClientInvocationCount: 0,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      source: "kimi-acp-observable",
    });
    if (process.platform === "win32") {
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
      });
    } else {
      expect(result.executionTelemetry).not.toHaveProperty(
        "ownedProcessDrained",
      );
      expect(result.executionTelemetry).not.toHaveProperty(
        "ownedProcessCompletion",
      );
    }
    expect(result.diagnostics.join("\n")).toMatch(/model configuration.*not available/i);
  });

  it("maps stdio shutdown to a cancelled result without a default deadline", async () => {
    const shutdown = new AbortController();
    const {
      timeoutMs: _omittedTimeoutMs,
      ...requestWithoutTimeout
    } = baseRequest({
      environment: { ...process.env, FAKE_KIMI_SCENARIO: "hang" },
      shutdownSignal: shutdown.signal,
      onProgress: (message: string) => {
        if (message === "kimi prompt started") shutdown.abort("session_shutdown");
      },
    });

    const result = await run(requestWithoutTimeout);

    expect(result.status).toBe("cancelled");
    if (process.platform === "win32") {
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "session_shutdown",
      });
    } else {
      expect(result.executionTelemetry).not.toHaveProperty(
        "ownedProcessCompletion",
      );
    }
    expect(result.diagnostics.join("\n")).not.toContain("ACP connection closed");
    expect(result.diagnostics.join("\n")).not.toMatch(/timed.?out/i);
  });

  it.each(["caller", "shutdown"] as const)(
    "does not spawn a Windows helper when the %s signal is already aborted",
    async (source) => {
      const caller = new AbortController();
      const shutdown = new AbortController();
      if (source === "caller") {
        caller.abort("request_cancelled");
      } else {
        shutdown.abort("session_shutdown");
      }
      let spawnCalls = 0;
      const {
        timeoutMs: _omittedTimeoutMs,
        ...requestWithoutTimeout
      } = baseRequest({
        signal: caller.signal,
        shutdownSignal: shutdown.signal,
      });

      const result = await runKimiAcp(requestWithoutTimeout, {
        platform: "win32",
        async spawnOwnedAgentProcess() {
          spawnCalls += 1;
          throw new Error("pre-aborted invocation must not spawn");
        },
      });

      expect(result).toMatchObject({ status: "cancelled", diagnostics: [] });
      expect(result.executionTelemetry).not.toHaveProperty(
        "ownedProcessDrained",
      );
      expect(spawnCalls).toBe(0);
    },
  );

  it("does not report owned drain when the Windows spawner rejects", async () => {
    const result = await runKimiAcp(baseRequest(), {
      platform: "win32",
      async spawnOwnedAgentProcess() {
        throw new Error("synthetic owned spawner rejection");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).not.toHaveProperty(
      "ownedProcessDrained",
    );
    expect(result.executionTelemetry).not.toHaveProperty(
      "ownedProcessCompletion",
    );
    expect(result.diagnostics.join("\n")).toContain(
      "synthetic owned spawner rejection",
    );
  });

  it("reconciles shutdown that arrives while the Windows spawner is pending without awaiting ready", async () => {
    const shutdown = new AbortController();
    let resolveSpawn!: (owned: OwnedAgentProcess) => void;
    const pendingSpawn = new Promise<OwnedAgentProcess>((resolve) => {
      resolveSpawn = resolve;
    });
    let rejectReadyForTeardown!: (error: Error) => void;
    const neverReady = new Promise<void>((_resolve, reject) => {
      rejectReadyForTeardown = reject;
    });
    let resolveClosed!: (exit: OwnedProcessExit) => void;
    const closed = new Promise<OwnedProcessExit>((resolve) => {
      resolveClosed = resolve;
    });
    const terminationReasons: OwnedTerminationReason[] = [];
    const owned: OwnedAgentProcess = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      ready: neverReady,
      closed,
      async terminate(reason) {
        terminationReasons.push(reason);
        resolveClosed(
          Object.freeze({
            platform: "win32",
            completion: reason,
            rootExitCode: 1,
            signal: null,
            ownershipDrained: true,
          }),
        );
      },
    };
    const {
      timeoutMs: _omittedTimeoutMs,
      ...requestWithoutTimeout
    } = baseRequest({ shutdownSignal: shutdown.signal });

    const running = runKimiAcp(requestWithoutTimeout, {
      platform: "win32",
      spawnOwnedAgentProcess() {
        return pendingSpawn;
      },
    });
    shutdown.abort("session_shutdown");
    resolveSpawn(owned);

    const watchdog = Symbol("test-watchdog");
    let watchdogTimer: NodeJS.Timeout | undefined;
    const earlyOutcome = await Promise.race([
      running,
      new Promise<typeof watchdog>((resolve) => {
        watchdogTimer = setTimeout(() => resolve(watchdog), 1_000);
      }),
    ]);
    if (earlyOutcome === watchdog) {
      rejectReadyForTeardown(new Error("test-only ready teardown"));
    }
    const result = await running;
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);

    expect(earlyOutcome).not.toBe(watchdog);
    expect(result).toMatchObject({ status: "cancelled", diagnostics: [] });
    expect(result.executionTelemetry).toMatchObject({
      ownedProcessDrained: true,
      ownedProcessCompletion: "session_shutdown",
    });
    expect(terminationReasons).toEqual(["session_shutdown"]);
  });
});
