import path from "node:path";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  PiAdapter,
  type PiAdapterDependencies,
} from "../../../src/adapters/pi/adapter.js";
import type { PiRpcRunRequest } from "../../../src/adapters/pi/client.js";
import type { IsolatedPiConfig } from "../../../src/adapters/pi/config.js";
import type { PiInvocation } from "../../../src/adapters/pi/locator.js";
import type { LlmProfile } from "../../../src/domain/types.js";

const windowsIt = it.runIf(process.platform === "win32");
const posixIt = it.runIf(process.platform !== "win32");
const verifiedPiCli = path.resolve("test/fakes/fake-pi-rpc.mjs");

interface ControlledPiLocators {
  locateExecutable(environment: NodeJS.ProcessEnv): Promise<string>;
  locateInvocation(environment: NodeJS.ProcessEnv): Promise<PiInvocation>;
}

function verifiedPiInvocation(): PiInvocation {
  return {
    executable: process.execPath,
    argvPrefix: [verifiedPiCli],
    identity: {
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.80.10",
      nodeEngine: ">=20.0.0",
    },
  };
}

function controlledPiLocators(
  posixExecutable = "/usr/local/bin/pi",
  invocation: PiInvocation = verifiedPiInvocation(),
): ControlledPiLocators {
  return {
    async locateExecutable() {
      return posixExecutable;
    },
    async locateInvocation() {
      return invocation;
    },
  };
}

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
    maxConcurrency: 1,
    capabilities: { review: true, delegate: true },
    qualityGates: {
      review: { status: "passed", evidence: "test" },
      delegate: { status: "passed", evidence: "test" },
    },
  };
}

function isolatedConfig(): IsolatedPiConfig {
  return {
    agentDir: "C:\\cache\\pi",
    settingsPath: "C:\\cache\\pi\\settings.json",
    modelsPath: "C:\\cache\\pi\\models.json",
    environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
    contentSha256: "a".repeat(64),
  };
}

function completedPiResult() {
  return {
    status: "completed" as const,
    text: "done",
    actualModel: "ark-code-latest",
    elapsedMs: 1,
    events: [],
    diagnostics: [],
    executionTelemetry: {
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      source: "pi-rpc-observable" as const,
    },
  };
}

describe("PiAdapter", () => {
  it("does not expose a retry-wait dependency", () => {
    expectTypeOf<PiAdapterDependencies>().not.toHaveProperty("waitForRetry");
  });

  it("uses isolated config, fixed provider/model/route, and maps tool events", async () => {
    const shutdown = new AbortController();
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
        ownedProcessDrained: true as const,
        ownedProcessCompletion: "root_exit" as const,
      },
    }));
    const controlled = controlledPiLocators();
    const locateExecutable = vi.fn(controlled.locateExecutable);
    const locateInvocation = vi.fn(controlled.locateInvocation);
    const adapter = new PiAdapter({
      locateExecutable,
      locateInvocation,
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
      timeoutMs: 1_800_000,
      shutdownSignal: shutdown.signal,
      parentEnvironment: {
        PATH: "C:\\Windows",
        HTTPS_PROXY: "http://parent:9999",
        OPENAI_API_KEY_DOUBAO: "ark-secret",
        ANTHROPIC_API_KEY: "forbidden",
        pi_coding_agent_dir: "C:\\parent-poison",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.executionTelemetry).toMatchObject({
      ownedProcessDrained: true,
      ownedProcessCompletion: "root_exit",
    });
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
      executable:
        process.platform === "win32" ? process.execPath : "/usr/local/bin/pi",
      provider: "ark-agent-plan",
      model: "ark-code-latest",
      thinkingLevel: "medium",
      task: "delegate",
      timeoutMs: 1_800_000,
      shutdownSignal: shutdown.signal,
      environment: {
        PATH: "C:\\Windows",
        CODEX_AGENT_ARK_AGENT_KEY: "ark-secret",
        PI_CODING_AGENT_DIR: "C:\\cache\\codex-agent-tools\\pi\\0.1.0-alpha.1",
      },
    });
    expect(request.environment.HTTPS_PROXY).toBeUndefined();
    expect(request.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(request.environment.OPENAI_API_KEY_DOUBAO).toBeUndefined();
    expect(
      Object.keys(request.environment).filter(
        (name) => name.toLowerCase() === "pi_coding_agent_dir",
      ),
    ).toEqual(["PI_CODING_AGENT_DIR"]);
    if (process.platform === "win32") {
      expect(request.executableArgs).toEqual([verifiedPiCli]);
      expect(locateInvocation).toHaveBeenCalledOnce();
      expect(locateExecutable).not.toHaveBeenCalled();
    } else {
      expect(request).not.toHaveProperty("executableArgs");
      expect(locateExecutable).toHaveBeenCalledOnce();
      expect(locateInvocation).not.toHaveBeenCalled();
    }
  });

  it("binds Direct DeepSeek through Pi and forwards only its private child credential", async () => {
    const runClient = vi.fn(async (_request: PiRpcRunRequest) => ({
      ...completedPiResult(),
      actualModel: "deepseek-v4-flash",
    }));
    const buildConfig = vi.fn(async () => isolatedConfig());
    const adapter = new PiAdapter({
      ...controlledPiLocators(),
      buildConfig,
      runClient,
    });
    const directProfile: LlmProfile = {
      ...profile(),
      id: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      credentialEnv: ["OPENAI_API_KEY_DEEPSEEK"],
      credentialTargetEnv: "CODEX_AGENT_DEEPSEEK_KEY",
      concurrencyKey: "deepseek",
    };

    const result = await adapter.run({
      profile: directProfile,
      task: "review",
      cwd: process.cwd(),
      prompt: "Review",
      parentEnvironment: {
        PATH: "C:\\Windows",
        OPENAI_API_KEY_DEEPSEEK: "deepseek-secret",
        OPENAI_API_KEY_DOUBAO: "ark-secret-must-not-leak",
        HTTPS_PROXY: "http://parent:9999",
      },
    });

    expect(result).toMatchObject({
      status: "completed",
      actualModel: "deepseek-v4-flash",
    });
    expect(buildConfig).toHaveBeenCalledOnce();
    expect(buildConfig).toHaveBeenCalledWith({
      version: "0.1.2-beta.1",
      providers: ["deepseek"],
    });
    const request = runClient.mock.calls[0]![0];
    expect(request).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      environment: {
        PATH: "C:\\Windows",
        CODEX_AGENT_DEEPSEEK_KEY: "deepseek-secret",
        PI_CODING_AGENT_DIR: "C:\\cache\\pi",
      },
    });
    expect(request.environment.OPENAI_API_KEY_DEEPSEEK).toBeUndefined();
    expect(request.environment.OPENAI_API_KEY_DOUBAO).toBeUndefined();
    expect(request.environment.CODEX_AGENT_ARK_AGENT_KEY).toBeUndefined();
    expect(request.environment.HTTPS_PROXY).toBeUndefined();
    expect(request.secretValues).toEqual(["deepseek-secret"]);
  });

  windowsIt(
    "derives redaction secrets from the canonical child credential",
    async () => {
      const runClient = vi.fn(async (_request: PiRpcRunRequest) =>
        completedPiResult(),
      );
      const adapter = new PiAdapter({
        ...controlledPiLocators(),
        buildConfig: async () => isolatedConfig(),
        runClient,
      });

      await adapter.run({
        profile: profile(),
        task: "review",
        cwd: process.cwd(),
        prompt: "Review",
        parentEnvironment: {
          PATH: "C:\\Windows",
          openai_api_key_doubao: "lowercase-secret",
        },
      });

      const request = runClient.mock.calls[0]![0];
      expect(request.environment.CODEX_AGENT_ARK_AGENT_KEY).toBe(
        "lowercase-secret",
      );
      expect(request.secretValues).toEqual(["lowercase-secret"]);
    },
  );

  windowsIt("fails closed on case-conflicting credential sources", async () => {
    const runClient = vi.fn(async (_request: PiRpcRunRequest) =>
      completedPiResult(),
    );
    const adapter = new PiAdapter({
      ...controlledPiLocators(),
      buildConfig: async () => isolatedConfig(),
      runClient,
    });

    await expect(
      adapter.run({
        profile: profile(),
        task: "review",
        cwd: process.cwd(),
        prompt: "Review",
        parentEnvironment: {
          PATH: "C:\\Windows",
          OPENAI_API_KEY_DOUBAO: "first-secret",
          openai_api_key_doubao: "second-secret",
        },
      }),
    ).rejects.toThrow("Invalid child environment");
    expect(runClient).not.toHaveBeenCalled();
  });

  windowsIt(
    "uses the canonical source key when no credential target exists",
    async () => {
      const runClient = vi.fn(async (_request: PiRpcRunRequest) =>
        completedPiResult(),
      );
      const adapter = new PiAdapter({
        ...controlledPiLocators(),
        buildConfig: async () => isolatedConfig(),
        runClient,
      });
      const { credentialTargetEnv: _omittedTarget, ...profileWithoutTarget } =
        profile();

      await adapter.run({
        profile: profileWithoutTarget,
        task: "review",
        cwd: process.cwd(),
        prompt: "Review",
        parentEnvironment: {
          PATH: "C:\\Windows",
          openai_api_key_doubao: "source-secret",
        },
      });

      const request = runClient.mock.calls[0]![0];
      expect(request.environment.OPENAI_API_KEY_DOUBAO).toBe("source-secret");
      expect(request.secretValues).toEqual(["source-secret"]);
    },
  );

  windowsIt.each([
    [
      "non-Node executable",
      { ...verifiedPiInvocation(), executable: verifiedPiCli },
    ],
    ["empty argv prefix", { ...verifiedPiInvocation(), argvPrefix: [] }],
    [
      "relative argv prefix",
      { ...verifiedPiInvocation(), argvPrefix: ["relative-cli.js"] },
    ],
    [
      "NUL argv prefix",
      { ...verifiedPiInvocation(), argvPrefix: [`${verifiedPiCli}\0tail`] },
    ],
    [
      "wrong package identity",
      {
        ...verifiedPiInvocation(),
        identity: {
          ...verifiedPiInvocation().identity,
          packageName: "other-package",
        },
      },
    ],
    [
      "empty package version",
      {
        ...verifiedPiInvocation(),
        identity: {
          ...verifiedPiInvocation().identity,
          packageVersion: " ",
        },
      },
    ],
    [
      "empty Node engine",
      {
        ...verifiedPiInvocation(),
        identity: {
          ...verifiedPiInvocation().identity,
          nodeEngine: "",
        },
      },
    ],
  ])(
    "rejects a malformed Windows invocation: %s",
    async (_label, malformed) => {
      const runClient = vi.fn(async (_request: PiRpcRunRequest) =>
        completedPiResult(),
      );
      const adapter = new PiAdapter({
        ...controlledPiLocators(
          "/usr/local/bin/pi",
          malformed as unknown as PiInvocation,
        ),
        buildConfig: async () => isolatedConfig(),
        runClient,
      });

      await expect(
        adapter.run({
          profile: profile(),
          task: "review",
          cwd: process.cwd(),
          prompt: "Review",
          parentEnvironment: {
            PATH: "C:\\Windows",
            OPENAI_API_KEY_DOUBAO: "secret",
          },
        }),
      ).rejects.toThrow("Pi Windows invocation is invalid");
      expect(runClient).not.toHaveBeenCalled();
    },
  );

  posixIt("does not add a timeout when the caller omits it", async () => {
    const runClient = vi.fn(async (_request: PiRpcRunRequest) => ({
      status: "completed" as const,
      text: "done",
      actualModel: "ark-code-latest",
      elapsedMs: 10,
      events: [],
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
      ...controlledPiLocators(),
      buildConfig: async () => ({
        agentDir: "C:\\cache\\pi",
        settingsPath: "C:\\cache\\pi\\settings.json",
        modelsPath: "C:\\cache\\pi\\models.json",
        environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
        contentSha256: "a".repeat(64),
      }),
      runClient,
    });

    await adapter.run({
      profile: profile(),
      task: "review",
      cwd: process.cwd(),
      prompt: "Review",
      parentEnvironment: {
        PATH: "C:\\Windows",
        OPENAI_API_KEY_DOUBAO: "ark-secret",
      },
    });
    expect(runClient.mock.calls[0]![0]).not.toHaveProperty("timeoutMs");
    expect(runClient.mock.calls[0]![0]).toMatchObject({
      executable: "/usr/local/bin/pi",
    });
    expect(runClient.mock.calls[0]![0]).not.toHaveProperty("executableArgs");
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
        ...controlledPiLocators("C:\\npm\\pi.cmd"),
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
      ...controlledPiLocators("pi.cmd"),
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
        ...controlledPiLocators("pi.cmd"),
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
      ...controlledPiLocators("pi.cmd"),
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
      ...controlledPiLocators("pi.cmd"),
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
      ...controlledPiLocators("pi.cmd"),
      retryMode: "qualification-single-attempt",
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
