import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runPiRpc } from "../../../src/adapters/pi/client.js";
import { terminateProcessTree } from "../../../src/runtime/process-tree.js";

const fakePath = fileURLToPath(
  new URL("../../fakes/fake-pi-rpc.mjs", import.meta.url),
);
const tempDirectories: string[] = [];
const fallbackPids: number[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-pi-client-test-"));
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
  for (const pid of fallbackPids.splice(0)) {
    if (isAlive(pid)) await terminateProcessTree(pid).catch(() => undefined);
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
    provider: "google",
    model: "gemini-3.5-flash",
    thinkingLevel: "medium" as const,
    task,
    prompt: "Do the task",
    timeoutMs: 5_000,
    terminationGraceMs: 25,
    secretValues: ["fake-secret"],
  };
}

async function readLog(logPath: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readFakeSetModelMetadata(
  provider: string,
  modelId: string,
): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [fakePath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (child.pid !== undefined) fallbackPids.push(child.pid);
  const lines = createInterface({ input: child.stdout! });
  try {
    child.stdin!.write(
      `${JSON.stringify({
        id: "set-model-contract",
        type: "set_model",
        provider,
        modelId,
      })}\n`,
    );
    const [line] = await once(lines, "line", {
      signal: AbortSignal.timeout(5_000),
    });
    return JSON.parse(String(line)) as Record<string, unknown>;
  } finally {
    lines.close();
    if (child.pid !== undefined) {
      await terminateProcessTree(child.pid).catch(() => undefined);
      const index = fallbackPids.indexOf(child.pid);
      if (index >= 0) fallbackPids.splice(index, 1);
    }
  }
}

describe("Pi RPC client", () => {
  it("reports the configured API in fake set_model responses", async () => {
    const google = await readFakeSetModelMetadata(
      "google",
      "gemini-3.5-flash",
    );
    const arkAgent = await readFakeSetModelMetadata(
      "ark-agent-plan",
      "ark-code-latest",
    );

    expect(google).toMatchObject({
      type: "response",
      command: "set_model",
      success: true,
      data: {
        id: "gemini-3.5-flash",
        provider: "google",
        api: "google-generative-ai",
      },
    });
    expect(arkAgent).toMatchObject({
      type: "response",
      command: "set_model",
      success: true,
      data: {
        id: "ark-code-latest",
        provider: "ark-agent-plan",
        api: "anthropic-messages",
      },
    });
  });

  it("spawns Pi with the explicit request environment without parent proxy reinjection", async () => {
    const cwd = await tempDirectory();
    const logPath = path.join(cwd, "rpc-log.jsonl");
    const wrapperPath = path.join(cwd, "assert-environment.mjs");
    const expectedProxy = "http://127.0.0.1:10808";
    await writeFile(
      wrapperPath,
      [
        `if (process.env.HTTP_PROXY !== ${JSON.stringify(expectedProxy)}) process.exit(81);`,
        `if (process.env.HTTPS_PROXY !== ${JSON.stringify(expectedProxy)}) process.exit(82);`,
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
      const result = await runPiRpc(
        {
          ...baseRequest(cwd, {
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            HTTP_PROXY: expectedProxy,
            HTTPS_PROXY: expectedProxy,
            FAKE_PI_LOG: logPath,
          }),
          executableArgs: [wrapperPath],
        },
      );

      expect(result.status).toBe("completed");
      expect(result.actualModel).toBe("gemini-3.5-flash");
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
      actualModel: "gemini-3.5-flash",
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
    expect(result.diagnostics.join("\n")).toContain("Authorization: [REDACTED]");
    expect(result.diagnostics.join("\n")).not.toContain("fake-secret");

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
        "google",
        "--model",
        "gemini-3.5-flash",
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
    const argv = (await readLog(logPath)).find(
      (entry) => entry.kind === "argv",
    )?.value as string[];
    expect(argv).toContain("read,bash,edit,write,grep,find,ls");
  });

  it("sends abort and removes the fake RPC process tree on cancellation", async () => {
    const cwd = await tempDirectory();
    const logPath = path.join(cwd, "rpc-log.jsonl");
    const childPidPath = path.join(cwd, "child.pid");
    const controller = new AbortController();
    const result = await runPiRpc({
      ...baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_LOG: logPath,
        FAKE_PI_SCENARIO: "hold",
        FAKE_PI_CHILD_PID_FILE: childPidPath,
      }),
      signal: controller.signal,
      onProgress: (message) => {
        if (message === "pi prompt started") setTimeout(() => controller.abort(), 25);
      },
    });
    expect(result.status).toBe("cancelled");
    const childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
    fallbackPids.push(childPid);
    await waitUntilDead(childPid);
    fallbackPids.pop();
    const commandTypes = (await readLog(logPath))
      .filter((entry) => entry.kind === "command")
      .map((entry) => (entry.value as { type: string }).type);
    expect(commandTypes).toContain("abort");
  });

  it("maps a hard deadline to timed_out", async () => {
    const cwd = await tempDirectory();
    const progress: string[] = [];
    const result = await runPiRpc({
      ...baseRequest(cwd, {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FAKE_PI_SCENARIO: "hold",
      }),
      timeoutMs: 75,
      heartbeatMs: 20,
      onProgress: (message) => progress.push(message),
    });
    expect(result.status).toBe("timed_out");
    expect(progress.some((message) => message.startsWith("pi heartbeat "))).toBe(
      true,
    );
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
    expect(Buffer.byteLength(result.diagnostics.join("\n"), "utf8")).toBeLessThan(
      70_000,
    );
  });

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
    expect(JSON.stringify(result)).not.toContain("unbalanced retry fake-secret");
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
    expect(JSON.stringify(result)).not.toContain("compaction retry fake-secret");
  });

  it.each([
    "compaction-and-explicit",
    "agent-explicit-compaction",
  ] as const)(
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
      expect(JSON.stringify(result)).not.toContain(
        "runtime-model-fake-secret",
      );
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
    expect(JSON.stringify(result)).not.toContain(
      "agent-end-model-fake-secret",
    );
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
