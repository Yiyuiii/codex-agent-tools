import { describe, expect, it, vi } from "vitest";

import { PiAdapter } from "../../../src/adapters/pi/adapter.js";
import type { PiRpcRunRequest } from "../../../src/adapters/pi/client.js";
import type { LlmProfile } from "../../../src/domain/types.js";

function profile(): LlmProfile {
  return {
    id: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    runtime: "pi-rpc",
    provider: "google",
    model: "gemini-3.5-flash",
    network: "proxy-10808",
    credentialEnv: [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ],
    timeoutMs: 600_000,
    maxConcurrency: 2,
    capabilities: { review: true, delegate: true },
    qualityGates: {
      review: { status: "passed", evidence: "test" },
      delegate: { status: "passed", evidence: "test" },
    },
  };
}

describe("PiAdapter", () => {
  it("uses isolated config, fixed provider/model/route, and maps tool events", async () => {
    const runClient = vi.fn(async (_request: PiRpcRunRequest) => ({
      status: "completed" as const,
      text: "done",
      actualModel: "gemini-3.5-flash",
      elapsedMs: 10,
      events: [
        {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "git status --short" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "result.txt" }] },
          isError: false,
        },
      ],
      diagnostics: [],
    }));
    const adapter = new PiAdapter({
      locateExecutable: async () => "C:\\npm\\pi.cmd",
      buildConfig: async () => ({
        agentDir: "C:\\cache\\codex-agent-tools\\pi\\0.1.0-alpha.1",
        settingsPath: "C:\\cache\\settings.json",
        modelsPath: "C:\\cache\\models.json",
        environment: {
          PI_CODING_AGENT_DIR:
            "C:\\cache\\codex-agent-tools\\pi\\0.1.0-alpha.1",
        },
        contentSha256: "a".repeat(64),
      }),
      runClient,
    });

    const result = await adapter.run({
      profile: profile(),
      task: "delegate",
      cwd: process.cwd(),
      prompt: "Implement",
      timeoutMs: 900_000,
      parentEnvironment: {
        PATH: "C:\\Windows",
        HTTPS_PROXY: "http://parent:9999",
        GEMINI_API_KEY: "gemini-secret",
        GOOGLE_API_KEY: "must-not-be-copied",
        ANTHROPIC_API_KEY: "forbidden",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.events).toEqual([
      {
        type: "tool_call",
        runtime: "pi-rpc",
        kind: "execute",
        title: "bash",
        rawInput: { command: "git status --short" },
        toolCallId: "tool-1",
      },
      {
        type: "tool_result",
        runtime: "pi-rpc",
        title: "bash",
        rawOutput: { content: [{ type: "text", text: "result.txt" }] },
        isError: false,
        toolCallId: "tool-1",
      },
    ]);
    const request = runClient.mock.calls[0]![0];
    expect(request).toMatchObject({
      executable: "C:\\npm\\pi.cmd",
      provider: "google",
      model: "gemini-3.5-flash",
      thinkingLevel: "medium",
      task: "delegate",
      timeoutMs: 600_000,
      environment: {
        PATH: "C:\\Windows",
        GEMINI_API_KEY: "gemini-secret",
        HTTP_PROXY: "http://127.0.0.1:10808",
        HTTPS_PROXY: "http://127.0.0.1:10808",
        http_proxy: "http://127.0.0.1:10808",
        https_proxy: "http://127.0.0.1:10808",
        PI_CODING_AGENT_DIR:
          "C:\\cache\\codex-agent-tools\\pi\\0.1.0-alpha.1",
      },
    });
    expect(request.environment.HTTPS_PROXY).toBe("http://127.0.0.1:10808");
    expect(request.environment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("fails explicitly when Pi reports a different actual model", async () => {
    const adapter = new PiAdapter({
      locateExecutable: async () => "pi.cmd",
      buildConfig: async () => ({
        agentDir: "C:\\cache\\pi",
        settingsPath: "C:\\cache\\pi\\settings.json",
        modelsPath: "C:\\cache\\pi\\models.json",
        environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
        contentSha256: "a".repeat(64),
      }),
      runClient: async () => ({
        status: "completed",
        text: "wrong model",
        actualModel: "other-model",
        elapsedMs: 10,
        events: [],
        diagnostics: [],
      }),
    });
    const result = await adapter.run({
      profile: profile(),
      task: "review",
      cwd: process.cwd(),
      prompt: "Review",
      parentEnvironment: { PATH: "x" },
    });
    expect(result.status).toBe("failed");
    expect(result.diagnostics.join("\n")).toContain(
      "expected gemini-3.5-flash but Pi reported other-model",
    );
  });

  it("retries only bounded Gemini free-tier throttles after the requested delay", async () => {
    const waits: number[] = [];
    let calls = 0;
    const adapter = new PiAdapter({
      locateExecutable: async () => "pi.cmd",
      buildConfig: async () => ({
        agentDir: "C:\\cache\\pi",
        settingsPath: "C:\\cache\\pi\\settings.json",
        modelsPath: "C:\\cache\\pi\\models.json",
        environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
        contentSha256: "a".repeat(64),
      }),
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
      runClient: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: "failed",
            text: "",
            actualModel: "gemini-3.5-flash",
            elapsedMs: 10,
            events: [
              {
                type: "tool_execution_start",
                toolCallId: "first",
                toolName: "read",
                args: { path: "a.txt" },
              },
            ],
            diagnostics: [
              "generate_content_free_tier_requests; Please retry in 15.25s.",
            ],
          };
        }
        return {
          status: "completed",
          text: "recovered",
          actualModel: "gemini-3.5-flash",
          elapsedMs: 20,
          events: [
            {
              type: "tool_execution_start",
              toolCallId: "second",
              toolName: "read",
              args: { path: "b.txt" },
            },
          ],
          diagnostics: [],
        };
      },
    });

    const result = await adapter.run({
      profile: profile(),
      task: "review",
      cwd: process.cwd(),
      prompt: "Review",
      parentEnvironment: { PATH: "x", GEMINI_API_KEY: "secret" },
    });

    expect(calls).toBe(2);
    expect(waits).toEqual([60_000]);
    expect(result).toMatchObject({ status: "completed", text: "recovered" });
    expect(result.events).toEqual([
      expect.objectContaining({ type: "tool_call", toolCallId: "first" }),
      expect.objectContaining({ type: "tool_call", toolCallId: "second" }),
    ]);
    expect(result.diagnostics.join("\n")).toContain(
      "generate_content_free_tier_requests",
    );
  });

  it("stops after one full-window Gemini free-tier retry", async () => {
    let calls = 0;
    let waits = 0;
    const adapter = new PiAdapter({
      locateExecutable: async () => "pi.cmd",
      buildConfig: async () => ({
        agentDir: "C:\\cache\\pi",
        settingsPath: "C:\\cache\\pi\\settings.json",
        modelsPath: "C:\\cache\\pi\\models.json",
        environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
        contentSha256: "a".repeat(64),
      }),
      waitForRetry: async () => {
        waits += 1;
      },
      runClient: async () => {
        calls += 1;
        return {
          status: "failed",
          text: "",
          actualModel: "gemini-3.5-flash",
          elapsedMs: 1,
          events: [],
          diagnostics: [
            "generate_content_free_tier_requests; Please retry in 10s.",
          ],
        };
      },
    });

    const result = await adapter.run({
      profile: profile(),
      task: "review",
      cwd: process.cwd(),
      prompt: "Review",
      parentEnvironment: { PATH: "x", GEMINI_API_KEY: "secret" },
    });

    expect(result.status).toBe("failed");
    expect(calls).toBe(2);
    expect(waits).toBe(1);
  });

  it("never retries a writable delegate after a Gemini free-tier failure", async () => {
    let calls = 0;
    let waits = 0;
    const adapter = new PiAdapter({
      locateExecutable: async () => "pi.cmd",
      buildConfig: async () => ({
        agentDir: "C:\\cache\\pi",
        settingsPath: "C:\\cache\\pi\\settings.json",
        modelsPath: "C:\\cache\\pi\\models.json",
        environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
        contentSha256: "a".repeat(64),
      }),
      waitForRetry: async () => {
        waits += 1;
      },
      runClient: async () => {
        calls += 1;
        return {
          status: "failed",
          text: "",
          actualModel: "gemini-3.5-flash",
          elapsedMs: 1,
          events: [],
          diagnostics: [
            "generate_content_free_tier_requests; Please retry in 10s.",
          ],
        };
      },
    });

    const result = await adapter.run({
      profile: profile(),
      task: "delegate",
      cwd: process.cwd(),
      prompt: "Implement",
      parentEnvironment: { PATH: "x", GEMINI_API_KEY: "secret" },
    });

    expect(result.status).toBe("failed");
    expect(calls).toBe(1);
    expect(waits).toBe(0);
  });
});
