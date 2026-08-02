import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { AdapterExecutionTelemetry } from "../../src/adapters/adapter.js";
import type { HostAcceptanceLifecycleEvent } from "../../src/mcp/host-acceptance-events.js";
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
import type { TaskExecutionContext } from "../../src/tasks/service.js";

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

function executionTelemetry(
  overrides: Partial<AdapterExecutionTelemetry> = {},
): AdapterExecutionTelemetry {
  return {
    adapterClientInvocationCount: 1,
    adapterRetryCount: 0,
    runtimeReportedAutoRetryCount: 0,
    adapterReportedFallbackUsed: false,
    source: "pi-rpc-observable",
    ...overrides,
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

  it("emits isolated Stop evidence only after progress and in-flight closure", async () => {
    const callbacks = new Map<
      string,
      (input: unknown, extra: Record<string, unknown>) => Promise<unknown>
    >();
    const signals = new Map<string, AbortController>();
    const events: HostAcceptanceLifecycleEvent[] = [];
    const telemetryCallbacks = new Map<
      string,
      NonNullable<TaskExecutionContext["onExecutionTelemetry"]>
    >();
    const serviceResults = new Map([
      ["secret prompt one", deferred<ExternalDelegateResult>()],
      ["secret prompt two", deferred<ExternalDelegateResult>()],
    ]);
    const service = {
      review: vi.fn(),
      delegate: vi.fn(
        (
          input: unknown,
          context?: TaskExecutionContext,
        ) => {
          const prompt = (input as { prompt: string }).prompt;
          telemetryCallbacks.set(prompt, context!.onExecutionTelemetry!);
          return serviceResults.get(prompt)!.promise;
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
        callbacks.set(name, handler);
      },
    };
    const inFlight = new InFlightTasks();
    registerExternalTools(
      fakeServer as never,
      service,
      inFlight,
      (event) => {
        events.push(event);
      },
    );

    const start = (
      prompt: string,
      requestId: string,
    ) => {
      const controller = new AbortController();
      signals.set(prompt, controller);
      const handler = callbacks.get("external_delegate")!;
      return handler(
        { llm: "ark-agent-plan", prompt, cwd: `C:\\private\\${prompt}` },
        {
          requestId,
          signal: controller.signal,
          sendNotification: async () => undefined,
        },
      );
    };

    const first = start("secret prompt one", "raw-request-one");
    const second = start("secret prompt two", "raw-request-two");
    expect(events.map(({ type }) => type)).toEqual([
      "requestStarted",
      "requestStarted",
    ]);
    expect(events[0]).not.toEqual(events[1]);
    const firstRequestSha = events[0]!.requestIdSha256;
    const secondRequestSha = events[1]!.requestIdSha256;

    signals.get("secret prompt one")!.abort("sdk_request_cancelled");
    signals.get("secret prompt one")!.abort("duplicate");
    telemetryCallbacks.get("secret prompt one")!({
      ...executionTelemetry({
        ownedProcessCompletion: "cancelled",
        ownedProcessDrained: true,
      }),
    });
    telemetryCallbacks.get("secret prompt one")!(
      executionTelemetry({
        ownedProcessCompletion: "cancelled",
        ownedProcessDrained: true,
      }),
    );
    serviceResults.get("secret prompt one")!.resolve({
      ...delegateResult(),
      ok: false,
      status: "cancelled",
    });
    await first;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.map(({ type }) => type)).toEqual([
      "requestStarted",
      "requestStarted",
      "sdkAbort",
      "ownedExit",
      "handlerCancelled",
      "inFlightRemoved",
    ]);
    expect(
      events.slice(2).map(({ requestIdSha256 }) => requestIdSha256),
    ).toEqual(Array(4).fill(firstRequestSha));
    expect(inFlight.size).toBe(1);

    signals.get("secret prompt one")!.abort("late");
    telemetryCallbacks.get("secret prompt one")!(
      executionTelemetry({
        ownedProcessCompletion: "cancelled",
        ownedProcessDrained: true,
      }),
    );
    expect(events).toHaveLength(6);

    serviceResults.get("secret prompt two")!.resolve(delegateResult());
    await second;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.at(-1)?.type).toBe("inFlightRemoved");
    expect(events.at(-1)?.requestIdSha256).toBe(secondRequestSha);
    expect(events.filter(({ type }) => type === "handlerCancelled")).toHaveLength(
      1,
    );
    expect(inFlight.size).toBe(0);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("raw-request-one");
    expect(serialized).not.toContain("raw-request-two");
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("C:\\\\private");
  });

  it("does not install lifecycle observation when the request-bound descriptor resolver is absent", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    let receivedContext: TaskExecutionContext | undefined;
    const service = {
      review: vi.fn(),
      delegate: vi.fn(
        async (_input: unknown, context?: TaskExecutionContext) => {
          receivedContext = context;
          return delegateResult();
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
    const resolver = {
      openRequest: vi.fn(async () => undefined),
    };
    const controller = new AbortController();
    const addAbortListener = vi.spyOn(controller.signal, "addEventListener");
    registerExternalTools(
      fakeServer as never,
      service,
      new InFlightTasks(),
      resolver,
    );
    const input = {
      llm: "ark-agent-plan",
      prompt: "ordinary request",
      cwd: process.cwd(),
    };

    const result = (await callback?.(input, {
      requestId: "raw-request-must-not-be-hashed",
      signal: controller.signal,
      sendNotification: async () => undefined,
    })) as { structuredContent: ExternalDelegateResult };

    expect(resolver.openRequest).toHaveBeenCalledOnce();
    expect(resolver.openRequest).toHaveBeenCalledWith("delegate", input);
    expect(addAbortListener).not.toHaveBeenCalled();
    expect(receivedContext?.onExecutionTelemetry).toBeUndefined();
    expect(result.structuredContent).toEqual(delegateResult());
    expect(JSON.stringify(result)).not.toContain("raw-request-must-not-be-hashed");
  });

  it("does not late-start a service when session shutdown wins during descriptor loading", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const descriptor = deferred<undefined>();
    const service = {
      review: vi.fn(),
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
    const inFlight = new InFlightTasks();
    registerExternalTools(fakeServer as never, service, inFlight, {
      openRequest: vi.fn(() => descriptor.promise),
    });
    const controller = new AbortController();
    const result = callback?.(
      {
        llm: "ark-agent-plan",
        prompt: "must not late start",
        cwd: process.cwd(),
      },
      {
        requestId: "shutdown-during-descriptor",
        signal: controller.signal,
        sendNotification: async () => undefined,
      },
    );
    await Promise.resolve();
    expect(inFlight.size).toBe(1);

    inFlight.closeAdmission();
    descriptor.resolve(undefined);

    await expect(result).rejects.toThrow(/session is shutting down/iu);
    expect(service.delegate).not.toHaveBeenCalled();
    expect(inFlight.size).toBe(0);
  });

  it("records a pre-aborted SDK signal exactly once and isolates sink failures", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    let telemetryCallback:
      | NonNullable<TaskExecutionContext["onExecutionTelemetry"]>
      | undefined;
    const events: HostAcceptanceLifecycleEvent[] = [];
    const service = {
      review: vi.fn(
        async (
          _input: unknown,
          context?: TaskExecutionContext,
        ): Promise<ExternalReviewResult> => {
          telemetryCallback = context?.onExecutionTelemetry;
          context?.onExecutionTelemetry?.(executionTelemetry({
            ownedProcessCompletion: "root_exit",
            ownedProcessDrained: true,
          }));
          context?.onExecutionTelemetry?.(executionTelemetry({
            ownedProcessCompletion: "cancelled",
          }));
          return { ...reviewResult(), ok: false, status: "cancelled" };
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
    const controller = new AbortController();
    controller.abort("already stopped");
    registerExternalTools(
      fakeServer as never,
      service,
      new InFlightTasks(),
      (event) => {
        events.push(event);
        if (event.type === "sdkAbort") {
          return Promise.reject(new Error("observer failed"));
        }
        throw new Error("observer failed");
      },
    );

    const result = (await callback?.(
      {
        llm: "kimi-k3",
        task: "review_plan",
        prompt: "Review",
        cwd: process.cwd(),
      },
      {
        requestId: 99,
        signal: controller.signal,
        sendNotification: async () => undefined,
      },
    )) as { structuredContent: ExternalReviewResult };
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result.structuredContent.status).toBe("cancelled");
    expect(events.map(({ type }) => type)).toEqual([
      "requestStarted",
      "sdkAbort",
      "handlerCancelled",
      "inFlightRemoved",
    ]);
    telemetryCallback?.(executionTelemetry({
      ownedProcessCompletion: "cancelled",
      ownedProcessDrained: true,
    }));
    expect(events).toHaveLength(4);
  });

  it("emits handler cancellation after progress finishes and before removal", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const notification = deferred<void>();
    const events: HostAcceptanceLifecycleEvent[] = [];
    const service = {
      review: vi.fn(
        async (
          _input: unknown,
          context?: TaskExecutionContext,
        ): Promise<ExternalReviewResult> => {
          context?.onProgress?.("cancellation pending");
          return { ...reviewResult(), ok: false, status: "cancelled" };
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
    const controller = new AbortController();
    registerExternalTools(
      fakeServer as never,
      service,
      new InFlightTasks(),
      (event) => {
        events.push(event);
      },
    );

    const handler = callback?.(
      {
        llm: "kimi-k3",
        task: "review_plan",
        prompt: "Review",
        cwd: process.cwd(),
      },
      {
        requestId: "progress-order",
        signal: controller.signal,
        _meta: { progressToken: "progress-order" },
        sendNotification: () => notification.promise,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.map(({ type }) => type)).toEqual(["requestStarted"]);

    notification.resolve();
    await handler;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.map(({ type }) => type)).toEqual([
      "requestStarted",
      "handlerCancelled",
      "inFlightRemoved",
    ]);
  });
});
