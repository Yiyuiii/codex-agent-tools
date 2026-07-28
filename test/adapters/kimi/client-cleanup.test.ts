import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const cleanupState = vi.hoisted(() => ({
  pids: [] as number[],
  onTerminate: undefined as (() => void) | undefined,
}));

vi.mock("../../../src/runtime/process-tree.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/runtime/process-tree.js")>();
  return {
    ...actual,
    terminateProcessTree: vi.fn(async (pid: number) => {
      cleanupState.pids.push(pid);
      cleanupState.onTerminate?.();
    }),
  };
});

import { runKimiAcp } from "../../../src/adapters/kimi/client.js";

const fakePath = fileURLToPath(
  new URL("../../fakes/fake-kimi-acp.mjs", import.meta.url),
);
const tempDirectories: string[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function actuallyTerminate(pid: number): Promise<void> {
  const actual =
    await vi.importActual<typeof import("../../../src/runtime/process-tree.js")>(
      "../../../src/runtime/process-tree.js",
    );
  await actual.terminateProcessTree(pid);
}

function terminationObserved(): Promise<void> {
  return new Promise((resolve) => {
    cleanupState.onTerminate = resolve;
  });
}

async function createRequest() {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "codex-agent-kimi-cleanup-test-"),
  );
  tempDirectories.push(cwd);
  await writeFile(path.join(cwd, "fixture.txt"), "fixture-content", "utf8");
  return {
    executable: process.execPath,
    args: [fakePath],
    task: "review" as const,
    cwd,
    prompt: "Review fixture.txt",
    model: "kimi-code/k3",
    sessionId: "existing-session",
    environment: { ...process.env, FAKE_KIMI_SCENARIO: "no-resume" },
    timeoutMs: 5_000,
    heartbeatMs: 1_000,
    terminationGraceMs: 100,
    secretValues: [],
  };
}

afterEach(async () => {
  cleanupState.onTerminate = undefined;
  for (const pid of cleanupState.pids.splice(0)) {
    if (isAlive(pid)) {
      await actuallyTerminate(pid).catch(() => undefined);
    }
  }
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        }),
      ),
  );
});

describe("runKimiAcp process cleanup", () => {
  it("does not return before the terminated ACP child closes", async () => {
    const observed = terminationObserved();
    const request = await createRequest();
    let settled = false;
    const running = runKimiAcp(request).finally(() => {
      settled = true;
    });

    await observed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    expect(cleanupState.pids).toHaveLength(1);
    await actuallyTerminate(cleanupState.pids[0]!);
    const result = await running;

    expect(result.status).toBe("failed");
    expect(isAlive(cleanupState.pids[0]!)).toBe(false);
    await rm(request.cwd, { recursive: true, force: true });
  });

  it("bounds cleanup when a successful terminator does not close the child", async () => {
    const observed = terminationObserved();
    const running = runKimiAcp(await createRequest());
    await observed;

    const timeout = Symbol("timeout");
    const outcome = await Promise.race([
      running,
      new Promise<typeof timeout>((resolve) =>
        setTimeout(() => resolve(timeout), 1_500),
      ),
    ]);

    expect(outcome).not.toBe(timeout);
    expect(outcome).toMatchObject({ status: "failed" });
    expect(
      typeof outcome === "symbol" ? "" : outcome.diagnostics.join("\n"),
    ).toMatch(/child did not close within .* after process tree termination/i);
  });
});
