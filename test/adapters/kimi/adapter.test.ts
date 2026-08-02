import { describe, expect, it, vi } from "vitest";

import { KimiAdapter } from "../../../src/adapters/kimi/adapter.js";
import type { KimiAcpRunRequest } from "../../../src/adapters/kimi/client.js";
import { resolveLlm } from "../../../src/llms/registry.js";

describe("KimiAdapter", () => {
  it("maps a logical profile and preserves an explicit per-call timeout", async () => {
    const shutdown = new AbortController();
    const runClient = vi.fn(async (_request: KimiAcpRunRequest) => ({
      status: "completed" as const,
      text: "done",
      actualModel: "kimi-code/k3",
      sessionId: "session-1",
      elapsedMs: 10,
      events: [],
      diagnostics: [],
      executionTelemetry: {
        adapterClientInvocationCount: 1,
        adapterRetryCount: 0,
        runtimeReportedAutoRetryCount: 0,
        adapterReportedFallbackUsed: false,
        source: "kimi-acp-observable" as const,
      },
    }));
    const adapter = new KimiAdapter({
      locateExecutable: async () => "C:\\Users\\test\\.kimi-code\\bin\\kimi.exe",
      runClient,
    });
    const profile = resolveLlm("kimi-k3");

    const result = await adapter.run({
      profile,
      task: "review",
      cwd: process.cwd(),
      prompt: "Review this repository",
      timeoutMs: 1_800_000,
      shutdownSignal: shutdown.signal,
      parentEnvironment: {
        PATH: "C:\\Windows",
        HTTPS_PROXY: "http://parent:9999",
        ANTHROPIC_API_KEY: "forbidden",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.executionTelemetry).toEqual({
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      source: "kimi-acp-observable",
    });
    expect(runClient).toHaveBeenCalledOnce();
    const clientRequest = runClient.mock.calls[0]![0];
    expect(clientRequest).toMatchObject({
      executable: "C:\\Users\\test\\.kimi-code\\bin\\kimi.exe",
      args: ["acp"],
      task: "review",
      model: "kimi-code/k3",
      timeoutMs: 1_800_000,
      shutdownSignal: shutdown.signal,
      environment: { PATH: "C:\\Windows" },
    });
    expect(clientRequest.environment.HTTPS_PROXY).toBeUndefined();
    expect(clientRequest.environment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("passes an explicit session id to the Kimi ACP client", async () => {
    const runClient = vi.fn(async (_request: KimiAcpRunRequest) => ({
      status: "completed" as const,
      text: "continued",
      actualModel: "kimi-code/k3",
      sessionId: "existing-session",
      elapsedMs: 10,
      events: [],
      diagnostics: [],
      executionTelemetry: {
        adapterClientInvocationCount: 1,
        adapterRetryCount: 0,
        runtimeReportedAutoRetryCount: 0,
        adapterReportedFallbackUsed: false,
        source: "kimi-acp-observable" as const,
      },
    }));
    const adapter = new KimiAdapter({
      locateExecutable: async () => "kimi.exe",
      runClient,
    });
    const result = await adapter.run({
      profile: resolveLlm("kimi-k3"),
      task: "delegate",
      cwd: process.cwd(),
      prompt: "Continue",
      sessionId: "existing-session",
      parentEnvironment: { PATH: "x" },
    });
    expect(result.sessionId).toBe("existing-session");
    expect(runClient.mock.calls[0]![0].sessionId).toBe("existing-session");
    expect(runClient.mock.calls[0]![0]).not.toHaveProperty("timeoutMs");
  });
});
