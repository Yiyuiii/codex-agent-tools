import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  PiAdapter,
  type PiAdapterDependencies,
} from "../../../src/adapters/pi/adapter.js";
import type { PiRpcRunRequest } from "../../../src/adapters/pi/client.js";
import type { LlmProfile } from "../../../src/domain/types.js";

function profile(): LlmProfile {
  return {
    id: "ark-agent-plan",
    displayName: "Ark Agent Plan",
    runtime: "pi-rpc",
    provider: "ark-agent-plan",
    model: "ark-code-latest",
    network: "direct",
    credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
    credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
    timeoutMs: 900_000,
    maxConcurrency: 1,
    capabilities: { review: true, delegate: true },
    qualityGates: {
      review: { status: "passed", evidence: "test" },
      delegate: { status: "passed", evidence: "test" },
    },
  };
}

describe("PiAdapter", () => {
  it("does not expose a retry-wait dependency", () => {
    expectTypeOf<PiAdapterDependencies>().not.toHaveProperty("waitForRetry");
  });

  it("uses isolated config, fixed provider/model/route, and maps tool events", async () => {
    const runClient = vi.fn(async (_request: PiRpcRunRequest) => ({
      status: "completed" as const,
      text: "done",
      actualModel: "ark-code-latest",
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
      executionTelemetry: {
        adapterClientInvocationCount: 1,
        adapterRetryCount: 0,
        runtimeReportedAutoRetryCount: 0,
        adapterReportedFallbackUsed: false,
        source: "pi-rpc-observable" as const,
      },
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
        OPENAI_API_KEY_DOUBAO: "ark-secret",
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
      provider: "ark-agent-plan",
      model: "ark-code-latest",
      thinkingLevel: "medium",
      task: "delegate",
      timeoutMs: 900_000,
      environment: {
        PATH: "C:\\Windows",
        CODEX_AGENT_ARK_AGENT_KEY: "ark-secret",
        PI_CODING_AGENT_DIR:
          "C:\\cache\\codex-agent-tools\\pi\\0.1.0-alpha.1",
      },
    });
    expect(request.environment.HTTPS_PROXY).toBeUndefined();
    expect(request.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(request.environment.OPENAI_API_KEY_DOUBAO).toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["string", "false"],
    ["number", 0],
    ["object", { value: false }],
  ] as const)(
    "does not invent a successful tool result for a %s isError value",
    async (_label, isError) => {
      const runClient = vi.fn(async (_request: PiRpcRunRequest) => ({
        status: "completed" as const,
        text: "done",
        actualModel: "ark-code-latest",
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
            isError,
          },
        ],
        diagnostics: [],
        executionTelemetry: {
          adapterClientInvocationCount: 1,
          adapterRetryCount: 0,
          runtimeReportedAutoRetryCount: 0,
          adapterReportedFallbackUsed: false,
          source: "pi-rpc-observable" as const,
        },
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
        parentEnvironment: {
          PATH: "C:\\Windows",
          OPENAI_API_KEY_DOUBAO: "ark-secret",
        },
      });

      const toolResult = result.events.find(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "tool_result",
      );
      expect(toolResult).not.toHaveProperty("isError");
    },
  );

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
        executionTelemetry: {
          adapterClientInvocationCount: 1,
          adapterRetryCount: 0,
          runtimeReportedAutoRetryCount: 0,
          adapterReportedFallbackUsed: false,
          source: "pi-rpc-observable",
        },
      }),
    });
    const result = await adapter.run({
      profile: profile(),
      task: "review",
      cwd: process.cwd(),
      prompt: "Review",
      parentEnvironment: {
        PATH: "x",
        OPENAI_API_KEY_DOUBAO: "secret",
      },
    });
    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toMatchObject({
      adapterReportedFallbackUsed: true,
    });
    expect(result.diagnostics.join("\n")).toContain(
      "expected ark-code-latest but Pi reported other-model",
    );
  });

  it.each(["failed", "cancelled"] as const)(
    "marks an observed model fallback even when the child status is %s",
    async (status) => {
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
          status,
          text: "",
          actualModel: "other-model",
          elapsedMs: 10,
          events: [],
          diagnostics: [],
          executionTelemetry: {
            adapterClientInvocationCount: 1,
            adapterRetryCount: 0,
            runtimeReportedAutoRetryCount: 0,
            adapterReportedFallbackUsed: false,
            source: "pi-rpc-observable",
          },
        }),
      });

      const result = await adapter.run({
        profile: profile(),
        task: "delegate",
        cwd: process.cwd(),
        prompt: "Run",
        parentEnvironment: {
          PATH: "x",
          OPENAI_API_KEY_DOUBAO: "secret",
        },
      });

      expect(result.status).toBe("failed");
      expect(result.executionTelemetry).toMatchObject({
        adapterReportedFallbackUsed: true,
      });
    },
  );

  it("fails a completed result with missing model without inventing fallback", async () => {
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
        text: "",
        elapsedMs: 10,
        events: [],
        diagnostics: [],
        executionTelemetry: {
          adapterClientInvocationCount: 1,
          adapterRetryCount: 0,
          runtimeReportedAutoRetryCount: 0,
          adapterReportedFallbackUsed: false,
          source: "pi-rpc-observable",
        },
      }),
    });

    const result = await adapter.run({
      profile: profile(),
      task: "delegate",
      cwd: process.cwd(),
      prompt: "Run",
      parentEnvironment: {
        PATH: "x",
        OPENAI_API_KEY_DOUBAO: "secret",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toMatchObject({
      adapterReportedFallbackUsed: false,
    });
  });

  it("invokes the client once even when diagnostics contain retired quota text", async () => {
    const runClient = vi.fn(async () => ({
      status: "failed" as const,
      text: "",
      actualModel: "ark-code-latest",
      elapsedMs: 10,
      events: [],
      diagnostics: [
        "generate_content_free_tier_requests; Please retry in 15.25s.",
      ],
      executionTelemetry: {
        adapterClientInvocationCount: 1,
        adapterRetryCount: 0,
        runtimeReportedAutoRetryCount: 0,
        adapterReportedFallbackUsed: false,
        source: "pi-rpc-observable" as const,
      },
    }));
    const adapter = new PiAdapter({
      locateExecutable: async () => "pi.cmd",
      buildConfig: async () => ({
        agentDir: "C:\\cache\\pi",
        settingsPath: "C:\\cache\\pi\\settings.json",
        modelsPath: "C:\\cache\\pi\\models.json",
        environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
        contentSha256: "a".repeat(64),
      }),
      runClient,
    });

    const result = await adapter.run({
      profile: profile(),
      task: "review",
      cwd: process.cwd(),
      prompt: "Review",
      parentEnvironment: {
        PATH: "x",
        OPENAI_API_KEY_DOUBAO: "secret",
      },
    });

    expect(runClient).toHaveBeenCalledOnce();
    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toEqual({
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      source: "pi-rpc-observable",
    });
    expect(result.diagnostics.join("\n")).toContain(
      "generate_content_free_tier_requests",
    );
  });

  it("uses one client attempt with Pi retries disabled in qualification mode", async () => {
    const runClient = vi.fn(async (_request: PiRpcRunRequest) => ({
      status: "failed" as const,
      text: "",
      actualModel: "ark-code-latest",
      elapsedMs: 1,
      events: [],
      diagnostics: [
        "generate_content_free_tier_requests; Please retry in 10s.",
      ],
      executionTelemetry: {
        adapterClientInvocationCount: 1,
        adapterRetryCount: 0,
        runtimeReportedAutoRetryCount: 0,
        adapterReportedFallbackUsed: false,
        source: "pi-rpc-observable" as const,
      },
    }));
    const adapter = new PiAdapter({
      retryMode: "qualification-single-attempt",
      locateExecutable: async () => "pi.cmd",
      buildConfig: async () => ({
        agentDir: "C:\\cache\\pi",
        settingsPath: "C:\\cache\\pi\\settings.json",
        modelsPath: "C:\\cache\\pi\\models.json",
        environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
        contentSha256: "a".repeat(64),
      }),
      runClient,
    });

    const result = await adapter.run({
      profile: profile(),
      task: "review",
      cwd: process.cwd(),
      prompt: "Review",
      parentEnvironment: {
        PATH: "x",
        OPENAI_API_KEY_DOUBAO: "secret",
      },
    });

    expect(runClient).toHaveBeenCalledOnce();
    expect(runClient.mock.calls[0]![0]).toMatchObject({
      autoRetry: false,
      autoCompaction: false,
    });
    expect(result.executionTelemetry).toEqual({
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      source: "pi-rpc-observable",
    });
  });

});
