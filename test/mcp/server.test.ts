import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { InFlightTasks } from "../../src/mcp/in-flight.js";
import { createMcpServer } from "../../src/mcp/server.js";
import {
  assertPublicExternalToolDefinitions,
  PUBLIC_EXTERNAL_TOOL_DEFINITIONS,
  registerExternalTools,
} from "../../src/mcp/tools.js";
import type {
  ExternalDelegateResult,
  ExternalReviewResult,
} from "../../src/tasks/results.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function reviewResult(): ExternalReviewResult {
  return {
    ok: true,
    status: "completed",
    llm: "kimi-k3",
    actualModel: "kimi-code/k3",
    elapsedMs: 10,
    sessionId: "session-1",
    diagnostics: [],
    filesChanged: [],
    review: "No findings.",
  };
}

function delegateResult(): ExternalDelegateResult {
  return {
    ok: true,
    status: "completed",
    llm: "ark-agent-plan",
    actualModel: "ark-code-latest",
    elapsedMs: 10,
    sessionId: "session-1",
    diagnostics: [],
    filesChanged: [],
    summary: "Delegated.",
    commandsRun: ["npm test"],
    verification: [],
    risks: [],
  };
}

describe("codex_external_agents MCP server", () => {
  it("uses one fail-closed static definition contract for registration and doctor", () => {
    expect(() => assertPublicExternalToolDefinitions()).not.toThrow();
    expect(PUBLIC_EXTERNAL_TOOL_DEFINITIONS.map(({ name }) => name).sort()).toEqual(
      ["external_delegate", "external_review"],
    );

    const withoutLlm = PUBLIC_EXTERNAL_TOOL_DEFINITIONS.map((definition) =>
      definition.name === "external_review"
        ? {
            ...definition,
            registration: {
              ...definition.registration,
              inputSchema: {},
            },
          }
        : definition,
    );
    expect(() => assertPublicExternalToolDefinitions(withoutLlm)).toThrow(
      /public MCP tool definitions/iu,
    );

    const unsafeReview = PUBLIC_EXTERNAL_TOOL_DEFINITIONS.map((definition) =>
      definition.name === "external_review"
        ? {
            ...definition,
            registration: {
              ...definition.registration,
              annotations: {
                ...definition.registration.annotations,
                destructiveHint: true,
              },
            },
          }
        : definition,
    );
    expect(() => assertPublicExternalToolDefinitions(unsafeReview)).toThrow(
      /public MCP tool definitions/iu,
    );
  });

  it("lists only the two approved tools with required llm and accurate annotations", async () => {
    const service = {
      review: vi.fn(async () => reviewResult()),
      delegate: vi.fn(),
    };
    const server = createMcpServer(service);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "external_delegate",
        "external_review",
      ]);
      const review = listed.tools.find((tool) => tool.name === "external_review")!;
      const delegate = listed.tools.find((tool) => tool.name === "external_delegate")!;
      expect(review.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(delegate.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      for (const tool of [review, delegate]) {
        expect(tool.outputSchema).toBeDefined();
        expect(tool.outputSchema?.required).toContain("status");
        expect(tool.outputSchema?.required).toContain("llm");
        expect(tool.inputSchema.required).toContain("llm");
        expect(tool.inputSchema.properties).toHaveProperty("llm");
        expect(tool.inputSchema.properties).not.toHaveProperty("backend");
        expect(tool.inputSchema.properties).not.toHaveProperty("provider");
        expect(tool.inputSchema.properties).not.toHaveProperty("model");
        expect(tool.inputSchema.properties).not.toHaveProperty("proxy");
        expect(tool.inputSchema.properties).not.toHaveProperty("tools");
        expect(tool.inputSchema.properties).not.toHaveProperty("effort");
      }
      expect(review.inputSchema).not.toHaveProperty(
        "properties.prompt.maxLength",
      );
      expect(review.inputSchema).not.toHaveProperty(
        "properties.context.maxLength",
      );
      expect(review.inputSchema).not.toHaveProperty(
        "properties.acceptanceCriteria.maxItems",
      );
      expect(review.inputSchema).not.toHaveProperty(
        "properties.acceptanceCriteria.items.maxLength",
      );
      expect(delegate.inputSchema).not.toHaveProperty(
        "properties.prompt.maxLength",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("passes cancellation and progress hooks into review and returns structured content", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const controller = new AbortController();
    const signal = controller.signal;
    let observedSignal: AbortSignal | undefined;
    let observedShutdownSignal: AbortSignal | undefined;
    const notifications: unknown[] = [];
    const service = {
      review: vi.fn(
        async (
          _input: unknown,
          context?: {
            signal?: AbortSignal;
            shutdownSignal?: AbortSignal;
            onProgress?: (message: string) => void;
          },
        ) => {
          observedSignal = context?.signal;
          observedShutdownSignal = context?.shutdownSignal;
          context?.onProgress?.("kimi heartbeat 1000ms");
          return reviewResult();
        },
      ),
      delegate: vi.fn(),
    };
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (input: unknown, extra: Record<string, unknown>) => Promise<unknown>,
      ) {
        if (name === "external_review") callback = handler;
      },
    };
    const inFlight = new InFlightTasks();
    registerExternalTools(fakeServer as never, service, inFlight);

    const result = (await callback?.(
      {
        llm: "kimi-k3",
        task: "review_plan",
        prompt: "Review",
        cwd: process.cwd(),
      },
      {
        signal,
        _meta: { progressToken: "progress-1" },
        sendNotification: async (notification: unknown) => {
          notifications.push(notification);
        },
      },
    )) as { structuredContent: ExternalReviewResult; content: Array<{ text: string }> };

    expect(observedSignal).toBe(signal);
    expect(observedShutdownSignal).toBe(inFlight.shutdownSignal);
    expect(observedShutdownSignal).not.toBe(signal);
    controller.abort("sdk_request_cancelled");
    expect(observedShutdownSignal?.aborted).toBe(false);
    expect(notifications).toEqual([
      {
        method: "notifications/progress",
        params: {
          progressToken: "progress-1",
          progress: 1,
          message: "kimi heartbeat 1000ms",
        },
      },
    ]);
    expect(result.structuredContent.review).toBe("No findings.");
    expect(result.structuredContent).not.toHaveProperty("executionTelemetry");
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "adapterClientInvocationCount",
    );
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "completed",
      llm: "kimi-k3",
    });
    expect(JSON.parse(result.content[0]!.text)).not.toHaveProperty(
      "executionTelemetry",
    );
  });

  it("tracks the complete review handler through service execution and progress drain", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const serviceResult = deferred<ExternalReviewResult>();
    const notification = deferred<void>();
    const inFlight = new InFlightTasks();
    const service = {
      review: vi.fn(
        (
          _input: unknown,
          context?: {
            signal?: AbortSignal;
            onProgress?: (message: string) => void;
          },
        ) => {
          context?.onProgress?.("still running");
          return serviceResult.promise;
        },
      ),
      delegate: vi.fn(),
    };
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (
          input: unknown,
          extra: Record<string, unknown>,
        ) => Promise<unknown>,
      ) {
        if (name === "external_review") callback = handler;
      },
    };
    registerExternalTools(fakeServer as never, service, inFlight);

    let handlerSettled = false;
    const handler = callback?.(
      {
        llm: "kimi-k3",
        task: "review_plan",
        prompt: "Review",
        cwd: process.cwd(),
      },
      {
        _meta: { progressToken: "progress-1" },
        sendNotification: () => notification.promise,
      },
    );
    void handler?.finally(() => {
      handlerSettled = true;
    });

    expect(inFlight.size).toBe(1);
    serviceResult.resolve(reviewResult());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handlerSettled).toBe(false);
    expect(inFlight.size).toBe(1);

    notification.resolve();
    await handler;
    expect(handlerSettled).toBe(true);
    expect(inFlight.size).toBe(0);
  });

  it("rejects synchronously before constructing a handler after admission closes", () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const service = {
      review: vi.fn(async () => reviewResult()),
      delegate: vi.fn(),
    };
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (
          input: unknown,
          extra: Record<string, unknown>,
        ) => Promise<unknown>,
      ) {
        if (name === "external_review") callback = handler;
      },
    };
    const inFlight = new InFlightTasks();
    registerExternalTools(fakeServer as never, service, inFlight);
    inFlight.closeAdmission();

    expect(() =>
      callback?.(
        {
          llm: "kimi-k3",
          task: "review_plan",
          prompt: "Must not start",
          cwd: process.cwd(),
        },
        {},
      ),
    ).toThrowError("In-flight task admission is closed.");
    expect(service.review).not.toHaveBeenCalled();
    expect(inFlight.size).toBe(0);
  });

  it("keeps the business result when a progress notification rejects", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const controller = new AbortController();
    const service = {
      review: vi.fn(
        async (
          _input: unknown,
          context?: {
            signal?: AbortSignal;
            onProgress?: (message: string) => void;
          },
        ) => {
          context?.onProgress?.("best effort");
          return reviewResult();
        },
      ),
      delegate: vi.fn(),
    };
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (
          input: unknown,
          extra: Record<string, unknown>,
        ) => Promise<unknown>,
      ) {
        if (name === "external_review") callback = handler;
      },
    };
    registerExternalTools(fakeServer as never, service);

    const result = (await callback?.(
      {
        llm: "kimi-k3",
        task: "review_plan",
        prompt: "Review",
        cwd: process.cwd(),
      },
      {
        signal: controller.signal,
        _meta: { progressToken: "progress-1" },
        sendNotification: async () => {
          throw new Error("transport failed");
        },
      },
    )) as { structuredContent: ExternalReviewResult };

    expect(result.structuredContent.review).toBe("No findings.");
    expect(controller.signal.aborted).toBe(false);
  });

  it("tracks a synchronous service failure until progress drain finishes", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const notification = deferred<void>();
    const failure = new Error("service failed synchronously");
    const inFlight = new InFlightTasks();
    const service = {
      review: vi.fn(
        (
          _input: unknown,
          context?: {
            signal?: AbortSignal;
            onProgress?: (message: string) => void;
          },
        ): Promise<ExternalReviewResult> => {
          context?.onProgress?.("failure pending");
          throw failure;
        },
      ),
      delegate: vi.fn(),
    };
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (
          input: unknown,
          extra: Record<string, unknown>,
        ) => Promise<unknown>,
      ) {
        if (name === "external_review") callback = handler;
      },
    };
    registerExternalTools(fakeServer as never, service, inFlight);

    const handler = callback?.(
      {
        llm: "kimi-k3",
        task: "review_plan",
        prompt: "Review",
        cwd: process.cwd(),
      },
      {
        _meta: { progressToken: "progress-1" },
        sendNotification: () => notification.promise,
      },
    );
    const rejected = expect(handler).rejects.toBe(failure);

    expect(inFlight.size).toBe(1);
    notification.resolve();
    await rejected;
    expect(inFlight.size).toBe(0);
  });

  it("tracks the complete delegate handler through service execution and progress drain", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const serviceResult = deferred<ExternalDelegateResult>();
    const notification = deferred<void>();
    const inFlight = new InFlightTasks();
    const service = {
      review: vi.fn(),
      delegate: vi.fn(
        (
          _input: unknown,
          context?: {
            signal?: AbortSignal;
            onProgress?: (message: string) => void;
          },
        ) => {
          context?.onProgress?.("still delegating");
          return serviceResult.promise;
        },
      ),
    };
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (
          input: unknown,
          extra: Record<string, unknown>,
        ) => Promise<unknown>,
      ) {
        if (name === "external_delegate") callback = handler;
      },
    };
    registerExternalTools(fakeServer as never, service, inFlight);

    let handlerSettled = false;
    const handler = callback?.(
      {
        llm: "ark-agent-plan",
        prompt: "Delegate",
        cwd: process.cwd(),
      },
      {
        _meta: { progressToken: "progress-1" },
        sendNotification: () => notification.promise,
      },
    );
    void handler?.finally(() => {
      handlerSettled = true;
    });

    expect(inFlight.size).toBe(1);
    serviceResult.resolve(delegateResult());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handlerSettled).toBe(false);
    expect(inFlight.size).toBe(1);

    notification.resolve();
    const result = (await handler) as {
      structuredContent: ExternalDelegateResult;
    };
    expect(result.structuredContent.summary).toBe("Delegated.");
    expect(handlerSettled).toBe(true);
    expect(inFlight.size).toBe(0);
  });

  it("keeps delegate structured content free of Pi lifecycle fields", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const service = {
      review: vi.fn(async () => reviewResult()),
      delegate: vi.fn(async () => delegateResult()),
    };
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (
          input: unknown,
          extra: Record<string, unknown>,
        ) => Promise<unknown>,
      ) {
        if (name === "external_delegate") callback = handler;
      },
    };
    registerExternalTools(fakeServer as never, service);

    const result = (await callback?.(
      {
        llm: "ark-agent-plan",
        prompt: "Delegate",
        cwd: process.cwd(),
      },
      {},
    )) as {
      structuredContent: ExternalDelegateResult;
      content: Array<{ text: string }>;
    };

    expect(Object.keys(result.structuredContent).sort()).toEqual([
      "actualModel",
      "commandsRun",
      "diagnostics",
      "elapsedMs",
      "filesChanged",
      "llm",
      "ok",
      "risks",
      "sessionId",
      "status",
      "summary",
      "verification",
    ]);
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "LifecycleObservation",
    );
  });
});
