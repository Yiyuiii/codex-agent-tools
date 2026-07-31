import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { KimiAdapter } from "../../src/adapters/kimi/adapter.js";
import {
  runKimiAcp,
  type KimiAcpRunResult,
} from "../../src/adapters/kimi/client.js";
import { PiAdapter } from "../../src/adapters/pi/adapter.js";
import {
  buildIsolatedPiConfig,
  type IsolatedPiConfig,
} from "../../src/adapters/pi/config.js";
import { runPiRpc } from "../../src/adapters/pi/client.js";
import type {
  AdapterRunResult,
  ExternalAgentAdapter,
} from "../../src/adapters/adapter.js";
import type { RuntimeKind } from "../../src/domain/types.js";
import { resolveLlm, type LlmRegistry } from "../../src/llms/registry.js";
import { InFlightTasks } from "../../src/mcp/in-flight.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createMcpStdioSession } from "../../src/mcp/stdio-session.js";
import type { ExternalTaskService } from "../../src/mcp/tools.js";
import { terminateProcessTree } from "../../src/runtime/process-tree.js";
import type { ExternalReviewResult } from "../../src/tasks/results.js";
import {
  ExternalAgentService,
  type TaskExecutionContext,
} from "../../src/tasks/service.js";

const fakeKimiPath = fileURLToPath(
  new URL("../fakes/fake-kimi-acp.mjs", import.meta.url),
);
const fakePiPath = fileURLToPath(
  new URL("../fakes/fake-pi-rpc.mjs", import.meta.url),
);
const tempPrefix = "codex-agent-stdio-cleanup-test-";
const tempDirectories: string[] = [];
const ownedPids: number[] = [];
const ownedPidFiles: string[] = [];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

interface JsonRpcRecord extends Record<string, unknown> {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

interface ServiceObservation {
  abortCount: number;
  result?: ExternalReviewResult;
  serviceResolvedOrder?: number;
  signal?: AbortSignal;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function rememberPid(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid fixture PID: ${String(pid)}`);
  }
  if (!ownedPids.includes(pid)) ownedPids.push(pid);
  return pid;
}

async function readPid(filePath: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = Number.parseInt(await readFile(filePath, "utf8"), 10);
      return rememberPid(value);
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(
    `Fixture PID file was not ready: ${filePath}; ${String(lastError)}`,
  );
}

async function waitUntilDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  expect(isAlive(pid), `expected owned PID ${pid} to be dead`).toBe(false);
}

function assertSafeTempDirectory(directory: string): void {
  const resolvedDirectory = path.resolve(directory);
  const resolvedTemp = path.resolve(os.tmpdir());
  const relative = path.relative(resolvedTemp, resolvedDirectory);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !path.basename(resolvedDirectory).startsWith(tempPrefix)
  ) {
    throw new Error(`Refusing to remove unsafe test directory: ${directory}`);
  }
}

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), tempPrefix));
  tempDirectories.push(directory);
  return directory;
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else {
        files.push(path.relative(directory, absolute).split(path.sep).join("/"));
      }
    }
  };
  await visit(directory);
  return files.sort();
}

async function withHarnessTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createJsonlObserver(output: PassThrough): {
  waitFor(
    predicate: (record: JsonRpcRecord) => boolean,
    label: string,
  ): Promise<JsonRpcRecord>;
} {
  const emitter = new EventEmitter();
  const records: JsonRpcRecord[] = [];
  let buffer = "";

  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      const record = JSON.parse(line) as JsonRpcRecord;
      records.push(record);
      emitter.emit("record", record);
    }
  });

  return {
    async waitFor(predicate, label) {
      const existing = records.find(predicate);
      if (existing !== undefined) return existing;
      return withHarnessTimeout(
        new Promise<JsonRpcRecord>((resolve) => {
          const listener = (record: JsonRpcRecord): void => {
            if (!predicate(record)) return;
            emitter.off("record", listener);
            resolve(record);
          };
          emitter.on("record", listener);
        }),
        label,
      );
    },
  };
}

function registryFor(llm: string): LlmRegistry {
  return {
    ids: () => [llm],
    resolve: resolveLlm,
  };
}

function observeService(
  realService: ExternalAgentService,
  observation: ServiceObservation,
  abortObserved: Deferred<void>,
  nextOrder: () => number,
): ExternalTaskService {
  return {
    async review(input: unknown, context: TaskExecutionContext = {}) {
      if (context.signal === undefined) {
        throw new Error("MCP did not supply a request AbortSignal");
      }
      observation.signal = context.signal;
      context.signal.addEventListener(
        "abort",
        () => {
          observation.abortCount += 1;
          abortObserved.resolve();
        },
        { once: true },
      );
      const result = await realService.review(input, context);
      observation.result = result;
      observation.serviceResolvedOrder = nextOrder();
      return result;
    },
    delegate: (input: unknown, context?: TaskExecutionContext) =>
      realService.delegate(input, context),
  };
}

async function runStdioCancellation(
  service: ExternalTaskService,
  cwd: string,
  llm: string,
  promptStartedMessage: string,
  promptStateReady: Promise<readonly [number, number]>,
  abortObserved: Deferred<void>,
  nextOrder: () => number,
): Promise<{ sessionResolvedOrder: number }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const jsonl = createJsonlObserver(output);
  const inFlight = new InFlightTasks();
  const server = createMcpServer(service, inFlight);
  const transport = new StdioServerTransport(input, output);
  const session = createMcpStdioSession({
    server,
    transport,
    input,
    output,
    inFlight,
    signalSource: process,
  });
  let sessionResolvedOrder = 0;
  const running = session.run().then(() => {
    sessionResolvedOrder = nextOrder();
  });

  const write = (record: JsonRpcRecord): void => {
    input.write(`${JSON.stringify(record)}\n`);
  };

  try {
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "1.0.0" },
      },
    });
    const initialized = await jsonl.waitFor(
      (record) => record.id === 1,
      "initialize response",
    );
    expect(initialized).toHaveProperty("result");

    write({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    write({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        _meta: { progressToken: `${llm}-stdio-progress` },
        name: "external_review",
        arguments: {
          llm,
          task: "review_plan",
          prompt: "hold",
          cwd,
        },
      },
    });
    await jsonl.waitFor(
      (record) =>
        record.method === "notifications/progress" &&
        record.params?.message === promptStartedMessage,
      `${llm} prompt-start progress`,
    );
    await withHarnessTimeout(promptStateReady, `${llm} fake prompt state`);

    input.end();
    await withHarnessTimeout(abortObserved.promise, `${llm} request abort`);
    await withHarnessTimeout(running, `${llm} stdio session shutdown`);
    return { sessionResolvedOrder };
  } finally {
    if (!input.writableEnded) input.end();
    await withHarnessTimeout(running, `${llm} fallback session shutdown`).catch(
      () => undefined,
    );
    output.destroy();
  }
}

afterEach(async () => {
  for (const pidFile of ownedPidFiles.splice(0)) {
    try {
      rememberPid(Number.parseInt(await readFile(pidFile, "utf8"), 10));
    } catch {
      // A fixture that never started need not have a PID file.
    }
  }
  for (const pid of [...new Set(ownedPids.splice(0))]) {
    if (isAlive(pid)) {
      await terminateProcessTree(pid);
    }
    await waitUntilDead(pid);
  }
  for (const directory of tempDirectories.splice(0)) {
    assertSafeTempDirectory(directory);
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

describe("MCP stdio owned-process cleanup", () => {
  it(
    "aborts a real Kimi request and waits for its complete owned tree cleanup",
    async () => {
      const cwd = await makeTempDirectory();
      const stateDirectory = await makeTempDirectory();
      const rootPidPath = path.join(stateDirectory, "root.pid");
      const childPidPath = path.join(stateDirectory, "child.pid");
      ownedPidFiles.push(rootPidPath, childPidPath);

      let order = 0;
      const nextOrder = (): number => ++order;
      let clientInvocationCount = 0;
      let clientResolvedOrder = 0;
      let clientResult: KimiAcpRunResult | undefined;
      let cleanupWasCompleteWhenClientResolved = false;
      let clientRequestHadTimeout = false;
      const adapter = new KimiAdapter({
        locateExecutable: async () => process.execPath,
        runClient: async (request) => {
          clientInvocationCount += 1;
          clientRequestHadTimeout = Object.hasOwn(request, "timeoutMs");
          clientResult = await runKimiAcp({
            ...request,
            args: [fakeKimiPath],
            environment: {
              ...request.environment,
              FAKE_KIMI_SCENARIO: "hang",
              FAKE_KIMI_ROOT_PID_FILE: rootPidPath,
              FAKE_KIMI_CHILD_PID_FILE: childPidPath,
            },
            heartbeatMs: 1_000,
            terminationGraceMs: 25,
          });
          const [rootPid, childPid] = await Promise.all([
            readPid(rootPidPath),
            readPid(childPidPath),
          ]);
          cleanupWasCompleteWhenClientResolved =
            !isAlive(rootPid) && !isAlive(childPid);
          clientResolvedOrder = nextOrder();
          return clientResult;
        },
      });
      const adapters = new Map<RuntimeKind, ExternalAgentAdapter>([
        [adapter.runtime, adapter],
      ]);
      const realService = new ExternalAgentService({
        registry: registryFor("kimi-k3"),
        adapters,
        parentEnvironment: { ...process.env },
      });
      const observation: ServiceObservation = { abortCount: 0 };
      const abortObserved = deferred<void>();
      const promptStateReady = Promise.all([
        readPid(rootPidPath),
        readPid(childPidPath),
      ]);
      const service = observeService(
        realService,
        observation,
        abortObserved,
        nextOrder,
      );

      const session = await runStdioCancellation(
        service,
        cwd,
        "kimi-k3",
        "kimi prompt started",
        promptStateReady,
        abortObserved,
        nextOrder,
      );
      const rootPid = await readPid(rootPidPath);
      const childPid = await readPid(childPidPath);
      await Promise.all([waitUntilDead(rootPid), waitUntilDead(childPid)]);

      expect(observation.signal?.aborted).toBe(true);
      expect(observation.abortCount).toBe(1);
      expect(observation.result?.status).toBe("cancelled");
      expect(observation.result?.status).not.toBe("timed_out");
      expect(clientResult?.status).toBe("cancelled");
      expect(clientResult?.executionTelemetry).toMatchObject({
        adapterClientInvocationCount: 1,
      });
      expect(clientInvocationCount).toBe(1);
      expect(clientRequestHadTimeout).toBe(false);
      expect(cleanupWasCompleteWhenClientResolved).toBe(true);
      expect(clientResolvedOrder).toBeLessThan(
        observation.serviceResolvedOrder!,
      );
      expect(observation.serviceResolvedOrder).toBeLessThan(
        session.sessionResolvedOrder,
      );
      expect(await listFiles(cwd)).toEqual([]);
      expect(await listFiles(stateDirectory)).toEqual([
        "child.pid",
        "root.pid",
      ]);
    },
    20_000,
  );

  it(
    "aborts a real Pi request once and waits for its complete owned tree cleanup",
    async () => {
      const cwd = await makeTempDirectory();
      const stateDirectory = await makeTempDirectory();
      const rootPidPath = path.join(stateDirectory, "root.pid");
      const childPidPath = path.join(stateDirectory, "child.pid");
      const logPath = path.join(stateDirectory, "rpc-log.jsonl");
      ownedPidFiles.push(rootPidPath, childPidPath);
      const isolatedConfig = await buildIsolatedPiConfig({
        root: path.join(stateDirectory, "pi-config"),
        version: "stdio-test",
        providers: ["ark"],
      });
      const testConfig: IsolatedPiConfig = isolatedConfig;

      let order = 0;
      const nextOrder = (): number => ++order;
      let clientInvocationCount = 0;
      let clientResolvedOrder = 0;
      let clientResult: AdapterRunResult | undefined;
      let cleanupWasCompleteWhenClientResolved = false;
      let clientRequestHadTimeout = false;
      let clientRequestHadRetryOverride = false;
      const adapter = new PiAdapter({
        locateExecutable: async () => process.execPath,
        buildConfig: async () => testConfig,
        runClient: async (request) => {
          clientInvocationCount += 1;
          clientRequestHadTimeout = Object.hasOwn(request, "timeoutMs");
          clientRequestHadRetryOverride =
            Object.hasOwn(request, "autoRetry") ||
            Object.hasOwn(request, "autoCompaction");
          clientResult = await runPiRpc({
            ...request,
            executableArgs: [fakePiPath],
            environment: {
              ...request.environment,
              FAKE_PI_SCENARIO: "hold",
              FAKE_PI_LOG: logPath,
              FAKE_PI_ROOT_PID_FILE: rootPidPath,
              FAKE_PI_CHILD_PID_FILE: childPidPath,
            },
            heartbeatMs: 1_000,
            terminationGraceMs: 25,
          });
          const [rootPid, childPid] = await Promise.all([
            readPid(rootPidPath),
            readPid(childPidPath),
          ]);
          cleanupWasCompleteWhenClientResolved =
            !isAlive(rootPid) && !isAlive(childPid);
          clientResolvedOrder = nextOrder();
          return clientResult;
        },
      });
      const adapters = new Map<RuntimeKind, ExternalAgentAdapter>([
        [adapter.runtime, adapter],
      ]);
      const realService = new ExternalAgentService({
        registry: registryFor("ark-agent-plan"),
        adapters,
        parentEnvironment: {
          ...process.env,
          OPENAI_API_KEY_DOUBAO: "stdio-test-only-key",
        },
      });
      const observation: ServiceObservation = { abortCount: 0 };
      const abortObserved = deferred<void>();
      const promptStateReady = Promise.all([
        readPid(rootPidPath),
        readPid(childPidPath),
      ]);
      const service = observeService(
        realService,
        observation,
        abortObserved,
        nextOrder,
      );

      const session = await runStdioCancellation(
        service,
        cwd,
        "ark-agent-plan",
        "pi prompt started",
        promptStateReady,
        abortObserved,
        nextOrder,
      );
      const rootPid = await readPid(rootPidPath);
      const childPid = await readPid(childPidPath);
      await Promise.all([waitUntilDead(rootPid), waitUntilDead(childPid)]);
      const commands = (await readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.kind === "command")
        .map((entry) => entry.value as Record<string, unknown>);
      const settings = JSON.parse(
        await readFile(isolatedConfig.settingsPath, "utf8"),
      ) as Record<string, unknown>;

      expect(observation.signal?.aborted).toBe(true);
      expect(observation.abortCount).toBe(1);
      expect(observation.result?.status).toBe("cancelled");
      expect(clientResult?.status).toBe("cancelled");
      expect(clientResult?.executionTelemetry).toMatchObject({
        adapterClientInvocationCount: 1,
      });
      expect(
        commands.filter((command) => command.type === "abort"),
      ).toHaveLength(1);
      expect(clientInvocationCount).toBe(1);
      expect(clientRequestHadTimeout).toBe(false);
      expect(clientRequestHadRetryOverride).toBe(false);
      expect(commands.map((command) => command.type)).not.toContain(
        "set_auto_retry",
      );
      expect(commands.map((command) => command.type)).not.toContain(
        "set_auto_compaction",
      );
      expect(settings).not.toHaveProperty("retry");
      expect(cleanupWasCompleteWhenClientResolved).toBe(true);
      expect(clientResolvedOrder).toBeLessThan(
        observation.serviceResolvedOrder!,
      );
      expect(observation.serviceResolvedOrder).toBeLessThan(
        session.sessionResolvedOrder,
      );
      expect(await listFiles(cwd)).toEqual([]);
      expect(await listFiles(stateDirectory)).toEqual([
        "child.pid",
        "pi-config/pi/stdio-test/models.json",
        "pi-config/pi/stdio-test/settings.json",
        "root.pid",
        "rpc-log.jsonl",
      ]);
    },
    20_000,
  );
});
