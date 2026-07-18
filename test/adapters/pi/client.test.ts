import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

describe("Pi RPC client", () => {
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
    expect(result.diagnostics.join("\n")).toContain(
      "Pi assistant error: temporary quota [REDACTED]",
    );
  });
});
