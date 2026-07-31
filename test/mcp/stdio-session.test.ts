import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";

import { InFlightTasks } from "../../src/mcp/in-flight.js";
import { createMcpServer } from "../../src/mcp/server.js";
import {
  createMcpStdioSession,
  type McpSignalSource,
} from "../../src/mcp/stdio-session.js";
import type { ExternalReviewResult } from "../../src/tasks/results.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeSignalSource implements McpSignalSource {
  readonly #emitter = new EventEmitter();
  readonly #onLastSessionListenerRemoved: (() => void) | undefined;
  #sessionOffCount = 0;

  constructor(onLastSessionListenerRemoved?: () => void) {
    this.#onLastSessionListenerRemoved = onLastSessionListenerRemoved;
  }

  on(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.#emitter.on(event, listener);
    return this;
  }

  off(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.#emitter.off(event, listener);
    this.#sessionOffCount += 1;
    if (this.#sessionOffCount === 2) {
      this.#onLastSessionListenerRemoved?.();
    }
    return this;
  }

  emit(event: "SIGINT" | "SIGTERM"): void {
    this.#emitter.emit(event);
  }

  listenerCount(event: "SIGINT" | "SIGTERM"): number {
    return this.#emitter.listenerCount(event);
  }
}

interface HarnessOptions {
  close?: () => Promise<void>;
  connect?: () => Promise<void>;
  inFlight?: InFlightTasks;
  reportError?: (message: string) => void;
  signalSource?: FakeSignalSource;
}

function createHarness(options: HarnessOptions = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const signalSource = options.signalSource ?? new FakeSignalSource();
  const server = {
    close: vi.fn(options.close ?? (async () => {})),
    connect: vi.fn(options.connect ?? (async () => {})),
  } as unknown as McpServer;
  const transport = {} as StdioServerTransport;
  const inFlight = options.inFlight ?? new InFlightTasks();
  const session = createMcpStdioSession({
    server,
    transport,
    input,
    output,
    inFlight,
    signalSource,
    ...(options.reportError === undefined
      ? {}
      : { reportError: options.reportError }),
  });

  return {
    close: server.close as unknown as ReturnType<typeof vi.fn>,
    connect: server.connect as unknown as ReturnType<typeof vi.fn>,
    inFlight,
    input,
    output,
    session,
    signalSource,
  };
}

describe("MCP stdio session", () => {
  it("closes the server, drains aborted handlers, then removes its listeners", async () => {
    const events: string[] = [];
    const handler = deferred<void>();
    const inFlight = new InFlightTasks();
    inFlight.track(
      handler.promise.then(() => {
        events.push("handler.settle");
      }),
    );
    const signalSource = new FakeSignalSource(() => {
      events.push("listeners.removed");
    });
    const harness = createHarness({
      inFlight,
      signalSource,
      close: async () => {
        events.push("server.close");
        events.push("handler.cancel");
        handler.resolve();
      },
    });

    const completion = harness.session.run();
    await flushPromises();
    harness.input.emit("end");
    await completion;

    expect(events).toEqual([
      "server.close",
      "handler.cancel",
      "handler.settle",
      "listeners.removed",
    ]);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.output.writableEnded).toBe(false);
  });

  it.each([
    {
      name: "stdin end",
      trigger: (harness: ReturnType<typeof createHarness>) => {
        harness.input.emit("end");
      },
    },
    {
      name: "stdin close",
      trigger: (harness: ReturnType<typeof createHarness>) => {
        harness.input.emit("close");
      },
    },
    {
      name: "SIGINT",
      trigger: (harness: ReturnType<typeof createHarness>) => {
        harness.signalSource.emit("SIGINT");
      },
    },
    {
      name: "SIGTERM",
      trigger: (harness: ReturnType<typeof createHarness>) => {
        harness.signalSource.emit("SIGTERM");
      },
    },
    {
      name: "explicit close",
      trigger: (harness: ReturnType<typeof createHarness>) => {
        void harness.session.close();
      },
    },
  ])("shuts down once for $name", async ({ trigger }) => {
    const harness = createHarness();
    const completion = harness.session.run();
    await flushPromises();

    trigger(harness);
    await completion;

    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.input.listenerCount("end")).toBe(0);
    expect(harness.input.listenerCount("close")).toBe(0);
    expect(harness.input.listenerCount("error")).toBe(0);
    expect(harness.signalSource.listenerCount("SIGINT")).toBe(0);
    expect(harness.signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("lets the first end event win when close follows immediately", async () => {
    const harness = createHarness();
    const completion = harness.session.run();
    await flushPromises();

    harness.input.emit("end");
    harness.input.emit("close");
    await completion;

    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("shares one completion promise and waits for the tracked handler to settle", async () => {
    const handler = deferred<void>();
    const inFlight = new InFlightTasks();
    inFlight.track(handler.promise);
    const harness = createHarness({ inFlight });
    const completion = harness.session.run();
    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    await flushPromises();

    harness.input.emit("end");
    const closeCompletion = harness.session.close();
    await flushPromises();

    expect(harness.session.run()).toBe(completion);
    expect(closeCompletion).toBe(completion);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    handler.resolve();
    await closeCompletion;
    expect(settled).toBe(true);
  });

  it("records a synchronous pre-connect close request and shuts down only after connect", async () => {
    const connect = deferred<void>();
    const input = new PassThrough();
    const output = new PassThrough();
    const signalSource = new FakeSignalSource();
    const server = {
      close: vi.fn(async () => {}),
      connect: vi.fn(() => {
        input.emit("close");
        return connect.promise;
      }),
    };
    const session = createMcpStdioSession({
      server: server as unknown as McpServer,
      transport: {} as StdioServerTransport,
      input,
      output,
      inFlight: new InFlightTasks(),
      signalSource,
    });
    let settled = false;

    const completion = session.run();
    void completion.then(() => {
      settled = true;
    });
    await flushPromises();

    expect(server.close).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    connect.resolve();
    await completion;
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
  });

  it("removes only its own listeners and rejects with the original connect failure", async () => {
    const connect = deferred<void>();
    const secret = "CONNECT_SECRET_SENTINEL";
    const failure = new Error(secret);
    const reports: string[] = [];
    const harness = createHarness({
      connect: () => connect.promise,
      reportError: (message) => reports.push(message),
    });
    const externalEnd = vi.fn();
    const externalError = vi.fn();
    const externalSignal = vi.fn();
    harness.input.on("end", externalEnd);
    harness.input.on("error", externalError);
    harness.signalSource.on("SIGINT", externalSignal);

    const completion = harness.session.run();
    connect.reject(failure);

    await expect(completion).rejects.toBe(failure);
    expect(harness.close).not.toHaveBeenCalled();
    expect(harness.input.listeners("end")).toContain(externalEnd);
    expect(harness.input.listeners("error")).toContain(externalError);
    expect(harness.input.listenerCount("close")).toBe(0);
    expect(harness.signalSource.listenerCount("SIGINT")).toBe(1);
    expect(harness.signalSource.listenerCount("SIGTERM")).toBe(0);
    expect(reports.join("\n")).not.toContain(secret);
  });

  it("treats stdin error as shutdown, reports generically, and propagates the original error", async () => {
    const secret = "STDIN_SECRET_SENTINEL";
    const failure = new Error(secret);
    const reports: string[] = [];
    const harness = createHarness({
      reportError: (message) => reports.push(message),
    });
    const completion = harness.session.run();
    await flushPromises();

    harness.input.emit("error", failure);

    await expect(completion).rejects.toBe(failure);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(reports).toEqual(["MCP stdio input failed; shutting down."]);
    expect(reports.join("\n")).not.toContain(secret);
  });

  it("drains and cleans up after close and drain both fail, then rejects with the first failure", async () => {
    const closeSecret = "CLOSE_SECRET_SENTINEL";
    const drainSecret = "DRAIN_SECRET_SENTINEL";
    const closeFailure = new Error(closeSecret);
    const drainFailure = new Error(drainSecret);
    const reports: string[] = [];
    const drain = vi.fn(async () => {
      throw drainFailure;
    });
    const harness = createHarness({
      close: async () => {
        throw closeFailure;
      },
      inFlight: { drain } as unknown as InFlightTasks,
      reportError: (message) => reports.push(message),
    });
    const completion = harness.session.run();
    await flushPromises();

    harness.signalSource.emit("SIGTERM");

    await expect(completion).rejects.toBe(closeFailure);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(harness.input.listenerCount("end")).toBe(0);
    expect(harness.input.listenerCount("close")).toBe(0);
    expect(harness.input.listenerCount("error")).toBe(0);
    expect(harness.signalSource.listenerCount("SIGINT")).toBe(0);
    expect(harness.signalSource.listenerCount("SIGTERM")).toBe(0);
    expect(reports).toEqual([
      "MCP server close failed during shutdown.",
      "MCP in-flight task drain failed during shutdown.",
    ]);
    expect(reports.join("\n")).not.toContain(closeSecret);
    expect(reports.join("\n")).not.toContain(drainSecret);
  });

  it("uses the caller's in-flight tracker when creating the MCP server", async () => {
    const serviceResult = deferred<ExternalReviewResult>();
    const inFlight = new InFlightTasks();
    const service = {
      review: vi.fn(() => serviceResult.promise),
      delegate: vi.fn(),
    };
    const server = createMcpServer(service, inFlight);
    const client = new Client({ name: "tracker-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = client.callTool({
        name: "external_review",
        arguments: {
          llm: "kimi-k3",
          task: "review_plan",
          prompt: "Review",
          cwd: process.cwd(),
        },
      });
      await vi.waitFor(() => {
        expect(service.review).toHaveBeenCalledTimes(1);
      });
      expect(inFlight.size).toBe(1);

      serviceResult.resolve({
        ok: true,
        status: "completed",
        llm: "kimi-k3",
        actualModel: "kimi-code/k3",
        elapsedMs: 1,
        sessionId: "tracker-session",
        diagnostics: [],
        filesChanged: [],
        review: "No findings.",
      });
      await result;
      expect(inFlight.size).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps raw top-level failures out of MCP stderr", async () => {
    const secret = "MCP_TOP_LEVEL_SECRET_SENTINEL";
    const result = await execa(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/mcp/main.ts", secret],
      {
        reject: false,
        windowsHide: true,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("codex_external_agents MCP server failed.");
    expect(result.stderr).not.toContain(secret);
  });
});
