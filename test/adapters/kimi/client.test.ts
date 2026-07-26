import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runKimiAcp } from "../../../src/adapters/kimi/client.js";

const fakePath = fileURLToPath(
  new URL("../../fakes/fake-kimi-acp.mjs", import.meta.url),
);

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
    terminationGraceMs: 100,
    secretValues: [],
    ...overrides,
  };
}

describe("runKimiAcp", () => {
  it("selects the fixed model, aggregates updates, and rejects review writes", async () => {
    const result = await runKimiAcp(
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

  it("rejects reverse reads that escape cwd", async () => {
    const result = await runKimiAcp(
      baseRequest({
        environment: { ...process.env, FAKE_KIMI_SCENARIO: "outside-read" },
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.text).toContain("read=read-denied");
  });

  it("resumes an explicitly selected Kimi session", async () => {
    const result = await runKimiAcp(
      baseRequest({ sessionId: "existing-session" }),
    );
    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("existing-session");
    expect(result.actualModel).toBe("kimi-code/k3");
    expect(result.text).toContain("model=kimi-code/k3");
  });

  it("fails explicitly when the ACP agent does not advertise session resume", async () => {
    const result = await runKimiAcp(
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
    const result = await runKimiAcp(
      baseRequest({
        environment: { ...process.env, FAKE_KIMI_DELAY_MS: "140" },
        heartbeatMs: 25,
        onProgress: (message: string) => progress.push(message),
      }),
    );
    expect(result.status).toBe("completed");
    expect(progress.filter((message) => message.includes("heartbeat")).length).toBeGreaterThanOrEqual(2);
  });

  it("propagates caller cancellation and reports cancelled", async () => {
    const controller = new AbortController();
    const result = await runKimiAcp(
      baseRequest({
        environment: { ...process.env, FAKE_KIMI_SCENARIO: "hang" },
        signal: controller.signal,
        onProgress: (message: string) => {
          if (message === "kimi prompt started") controller.abort();
        },
      }),
    );
    expect(result.status).toBe("cancelled");
  });

  it("enforces a hard deadline without using an idle timeout", async () => {
    const result = await runKimiAcp(
      baseRequest({
        environment: { ...process.env, FAKE_KIMI_SCENARIO: "hang" },
        timeoutMs: 100,
      }),
    );
    expect(result.status).toBe("timed_out");
  });

  it("fails rather than silently using the default model", async () => {
    const result = await runKimiAcp(
      baseRequest({
        environment: { ...process.env, FAKE_KIMI_SCENARIO: "no-model" },
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toEqual({
      adapterClientInvocationCount: 0,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      source: "kimi-acp-observable",
    });
    expect(result.diagnostics.join("\n")).toMatch(/model configuration.*not available/i);
  });
});
