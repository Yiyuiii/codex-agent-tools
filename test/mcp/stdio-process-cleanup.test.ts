import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

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
import {
  inspectProcessIdentity,
  type ProcessIdentity,
} from "../../src/qualification/lock.js";
import { terminateProcessTree } from "../../src/runtime/process-tree.js";
import type { ExternalReviewResult } from "../../src/tasks/results.js";
import { spawnWindowsOwnedAgentProcessWithDependencies } from "../../src/runtime/windows-owned-agent-process.js";
import { resolveWindowsJobHelperForModule } from "../../src/runtime/windows-job-helper.js";
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
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const syntheticDistModuleUrl = pathToFileURL(
  path.join(repositoryRoot, "dist", "stdio-process-cleanup-test.mjs"),
).href;
const tempPrefix = "codex-agent-stdio-cleanup-test-";
const tempDirectories: string[] = [];
const ownedPids: number[] = [];
const ownedPidFiles: string[] = [];
const ownedProcessStartTimes = new Map<number, string>();
const sessionCleanupHandles: SessionCleanupHandle[] = [];

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

interface SessionCleanupHandle {
  baselineSigintListeners: number;
  baselineSigtermListeners: number;
  input: PassThrough;
  label: string;
  output: PassThrough;
  running: Promise<void>;
  settled: boolean;
}

interface ObservedOwnedProcess {
  label: string;
  pid: number;
}

type CleanupPidFileReadResult =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "unreadable" }
  | { kind: "pid"; pid: number };

type CleanupPidDisposition =
  | {
      kind: "ignore";
      mayTerminate: false;
      reportFailure: false;
      retainEvidence: false;
    }
  | {
      kind: "recorded_identity";
      mayTerminate: true;
      pid: number;
      reportFailure: false;
      retainEvidence: false;
    }
  | {
      failure: string;
      kind: "malformed" | "unreadable" | "unknown_identity";
      mayTerminate: false;
      reportFailure: true;
      retainEvidence: true;
    };

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

function parseFixturePid(value: string): number {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/u.test(trimmed)) {
    throw new Error("Fixture PID file must contain one complete positive integer");
  }
  const pid = Number(trimmed);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Fixture PID file must contain one safe positive integer");
  }
  return pid;
}

async function readPid(filePath: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return parseFixturePid(await readFile(filePath, "utf8"));
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(
    `Fixture PID file was not ready: ${filePath}; ${String(lastError)}`,
  );
}

async function readPidIfAvailable(
  filePath: string,
  timeoutMs = 500,
): Promise<CleanupPidFileReadResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = await readFile(filePath, "utf8");
      try {
        return { kind: "pid", pid: parseFixturePid(content) };
      } catch {
        return { kind: "malformed" };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { kind: "unreadable" };
      }
      if (Date.now() >= deadline) {
        return { kind: "missing" };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function captureOwnedProcessIdentity(pid: number): Promise<number> {
  const identity = await inspectProcessIdentity(pid);
  if (!identity.alive || identity.startTime === null) {
    throw new Error(`Owned PID ${pid} was not alive when identity was captured`);
  }
  const previous = ownedProcessStartTimes.get(pid);
  if (previous !== undefined && previous !== identity.startTime) {
    throw new Error(
      `Owned PID ${pid} changed identity from ${previous} to ${identity.startTime}`,
    );
  }
  ownedProcessStartTimes.set(pid, identity.startTime);
  return pid;
}

function observePromptProcessState(
  processes: readonly { label: string; pidPath: string }[],
): Promise<readonly ObservedOwnedProcess[]> {
  const observation = Promise.all(
    processes.map(async ({ label, pidPath }) => ({
      label,
      pid: await readPid(pidPath)
        .then(rememberPid)
        .then(captureOwnedProcessIdentity),
    })),
  );
  void observation.catch(() => undefined);
  return observation;
}

function mayTerminateRecordedProcess(
  pid: number,
  identity: ProcessIdentity,
): boolean {
  const expectedStartTime = ownedProcessStartTimes.get(pid);
  return (
    identity.alive &&
    identity.startTime !== null &&
    expectedStartTime !== undefined &&
    identity.startTime === expectedStartTime
  );
}

function classifyCleanupPidEvidence(
  readResult: CleanupPidFileReadResult,
  hasRecordedIdentity: boolean,
): CleanupPidDisposition {
  if (readResult.kind === "missing") {
    return {
      kind: "ignore",
      mayTerminate: false,
      reportFailure: false,
      retainEvidence: false,
    };
  }
  if (readResult.kind === "malformed" || readResult.kind === "unreadable") {
    return {
      failure:
        readResult.kind === "malformed"
          ? "cleanup_pid_evidence_malformed"
          : "cleanup_pid_evidence_unreadable",
      kind: readResult.kind,
      mayTerminate: false,
      reportFailure: true,
      retainEvidence: true,
    };
  }
  if (!hasRecordedIdentity) {
    return {
      failure: "cleanup_pid_evidence_unknown_identity",
      kind: "unknown_identity",
      mayTerminate: false,
      reportFailure: true,
      retainEvidence: true,
    };
  }
  return {
    kind: "recorded_identity",
    mayTerminate: true,
    pid: readResult.pid,
    reportFailure: false,
    retainEvidence: false,
  };
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
  promptStateReady: Promise<readonly ObservedOwnedProcess[]>,
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
    inFlight,
    signalSource: process,
  });
  const baselineSigintListeners = process.listenerCount("SIGINT");
  const baselineSigtermListeners = process.listenerCount("SIGTERM");
  let sessionResolvedOrder = 0;
  const cleanupHandle: SessionCleanupHandle = {
    baselineSigintListeners,
    baselineSigtermListeners,
    input,
    label: llm,
    output,
    running: Promise.resolve(),
    settled: false,
  };
  const running = session
    .run()
    .then(() => {
      sessionResolvedOrder = nextOrder();
    })
    .finally(() => {
      cleanupHandle.settled = true;
    });
  cleanupHandle.running = running;
  void running.catch(() => undefined);
  sessionCleanupHandles.push(cleanupHandle);

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
    const promptProcesses = await withHarnessTimeout(
      promptStateReady,
      `${llm} fake prompt state`,
    );
    for (const ownedProcess of promptProcesses) {
      expect(
        isAlive(ownedProcess.pid),
        `${llm} ${ownedProcess.label} must be alive before stdin end`,
      ).toBe(true);
    }

    input.end();
    await withHarnessTimeout(abortObserved.promise, `${llm} request abort`);
    await withHarnessTimeout(running, `${llm} stdio session shutdown`);
    return { sessionResolvedOrder };
  } finally {
    if (!input.writableEnded) input.end();
  }
}

afterEach(async () => {
  const cleanupFailures: string[] = [];
  const cleanupHandles = sessionCleanupHandles.splice(0);
  for (const handle of cleanupHandles) {
    if (!handle.input.writableEnded) handle.input.end();
  }
  await Promise.all(
    cleanupHandles.map(async (handle) => {
      if (handle.settled) return;
      await withHarnessTimeout(
        handle.running,
        `${handle.label} initial afterEach session shutdown`,
        500,
      ).catch(() => undefined);
    }),
  );

  const latePidReads = await Promise.all(
    ownedPidFiles
      .splice(0)
      .map((pidFile) => readPidIfAvailable(pidFile)),
  );
  let retainEvidence = false;
  for (const readResult of latePidReads) {
    const disposition = classifyCleanupPidEvidence(
      readResult,
      readResult.kind === "pid" &&
        ownedProcessStartTimes.has(readResult.pid),
    );
    if (disposition.reportFailure) {
      cleanupFailures.push(disposition.failure);
    }
    if (disposition.retainEvidence) {
      retainEvidence = true;
    }
    if (disposition.mayTerminate) {
      rememberPid(disposition.pid);
    }
  }
  const uniquePids = [...new Set(ownedPids.splice(0))];
  for (const pid of uniquePids) {
    const expectedStartTime = ownedProcessStartTimes.get(pid);
    if (expectedStartTime === undefined) continue;
    try {
      const identity = await inspectProcessIdentity(pid);
      if (!identity.alive) continue;
      if (!mayTerminateRecordedProcess(pid, identity)) {
        cleanupFailures.push(
          `Refused to terminate reused PID ${pid}: expected ${expectedStartTime}, observed ${String(identity.startTime)}`,
        );
        continue;
      }
      await terminateProcessTree(pid);
      await waitUntilDead(pid);
    } catch (error) {
      cleanupFailures.push(String(error));
    }
  }

  for (const handle of cleanupHandles) {
    try {
      await withHarnessTimeout(
        handle.running,
        `${handle.label} afterEach session shutdown`,
      );
    } catch (error) {
      cleanupFailures.push(String(error));
    }
    if (handle.settled) {
      handle.output.destroy();
    } else {
      cleanupFailures.push(
        `${handle.label} output retained because session did not resolve`,
      );
    }
    if (
      process.listenerCount("SIGINT") !== handle.baselineSigintListeners
    ) {
      cleanupFailures.push(
        `${handle.label} SIGINT listeners did not return to baseline`,
      );
    }
    if (
      process.listenerCount("SIGTERM") !== handle.baselineSigtermListeners
    ) {
      cleanupFailures.push(
        `${handle.label} SIGTERM listeners did not return to baseline`,
      );
    }
  }

  let recordedOwnedProcessStillAlive = false;
  for (const [pid, expectedStartTime] of ownedProcessStartTimes) {
    if (!isAlive(pid)) continue;
    try {
      const identity = await inspectProcessIdentity(pid);
      if (!identity.alive || identity.startTime !== expectedStartTime) continue;
      recordedOwnedProcessStillAlive = true;
      cleanupFailures.push(
        `Recorded owned PID ${pid} remained alive after session cleanup`,
      );
    } catch (error) {
      cleanupFailures.push(String(error));
      recordedOwnedProcessStillAlive = true;
    }
  }
  ownedProcessStartTimes.clear();

  const directories = tempDirectories.splice(0);
  if (
    cleanupHandles.every((handle) => handle.settled) &&
    !recordedOwnedProcessStillAlive &&
    !retainEvidence
  ) {
    for (const directory of directories) {
      assertSafeTempDirectory(directory);
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }
  if (cleanupFailures.length > 0) {
    throw new Error(cleanupFailures.join("\n"));
  }
});

describe("MCP stdio owned-process cleanup", () => {
  it("retains an unknown late PID without allowing termination", () => {
    expect(
      classifyCleanupPidEvidence({ kind: "pid", pid: 123_456 }, false),
    ).toEqual({
      failure: "cleanup_pid_evidence_unknown_identity",
      kind: "unknown_identity",
      mayTerminate: false,
      reportFailure: true,
      retainEvidence: true,
    });
  });

  it("distinguishes malformed PID evidence from a missing file", async () => {
    const directory = await makeTempDirectory();
    const malformedPath = path.join(directory, "malformed.pid");
    await writeFile(malformedPath, "123junk", "utf8");

    await expect(readPidIfAvailable(malformedPath, 75)).resolves.toEqual({
      kind: "malformed",
    });
    await expect(
      readPidIfAvailable(path.join(directory, "missing.pid"), 75),
    ).resolves.toEqual({ kind: "missing" });
  });

  it("refuses to terminate a live PID without a pre-disconnect identity", () => {
    expect(
      mayTerminateRecordedProcess(987_654_321, {
        alive: true,
        startTime: "2026-07-31T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("rejects a PID file with trailing non-digits", async () => {
    const directory = await makeTempDirectory();
    const pidPath = path.join(directory, "invalid.pid");
    await writeFile(pidPath, "123junk", "utf8");

    await expect(readPid(pidPath, 75)).rejects.toThrow(
      "Fixture PID file was not ready",
    );
  });

  it(
    "aborts a real Kimi request and waits for its complete owned tree cleanup",
    async () => {
      const cwd = await makeTempDirectory();
      const stateDirectory = await makeTempDirectory();
      const rootPidPath = path.join(stateDirectory, "root.pid");
      const carrierPidPath = path.join(stateDirectory, "carrier.pid");
      const childPidPath = path.join(stateDirectory, "child.pid");
      ownedPidFiles.push(rootPidPath, carrierPidPath, childPidPath);

      let order = 0;
      const nextOrder = (): number => ++order;
      let adapterClientInvocationCount = 0;
      let clientResolvedOrder = 0;
      let clientResult: KimiAcpRunResult | undefined;
      let cleanupWasCompleteWhenClientResolved = false;
      let clientRequestHadTimeout = false;
      const adapter = new KimiAdapter({
        locateExecutable: async () => process.execPath,
        runClient: async (request) => {
          adapterClientInvocationCount += 1;
          clientRequestHadTimeout = Object.hasOwn(request, "timeoutMs");
          clientResult = await runKimiAcp({
            ...request,
            args: [fakeKimiPath],
            environment: {
              ...request.environment,
              FAKE_KIMI_SCENARIO: "hang",
              FAKE_KIMI_ROOT_PID_FILE: rootPidPath,
              FAKE_KIMI_CARRIER_PID_FILE: carrierPidPath,
              FAKE_KIMI_CHILD_PID_FILE: childPidPath,
            },
          });
          const [rootPid, carrierPid, childPid] = await Promise.all([
            readPid(rootPidPath),
            readPid(carrierPidPath),
            readPid(childPidPath),
          ]);
          cleanupWasCompleteWhenClientResolved =
            !isAlive(rootPid) &&
            !isAlive(carrierPid) &&
            !isAlive(childPid);
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
      const promptStateReady = observePromptProcessState([
        { label: "root", pidPath: rootPidPath },
        { label: "carrier", pidPath: carrierPidPath },
        { label: "grandchild", pidPath: childPidPath },
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
      const [rootPid, carrierPid, childPid] = await Promise.all([
        readPid(rootPidPath),
        readPid(carrierPidPath),
        readPid(childPidPath),
      ]);
      await Promise.all([
        waitUntilDead(rootPid),
        waitUntilDead(carrierPid),
        waitUntilDead(childPid),
      ]);

      expect(observation.signal?.aborted).toBe(true);
      expect(observation.abortCount).toBe(1);
      expect(observation.result?.status).toBe("cancelled");
      expect(observation.result?.status).not.toBe("timed_out");
      expect(clientResult?.status).toBe("cancelled");
      expect(clientResult?.executionTelemetry).toMatchObject({
        adapterClientInvocationCount: 1,
      });
      expect(adapterClientInvocationCount).toBe(1);
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
        "carrier.pid",
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
      let adapterClientInvocationCount = 0;
      let clientResolvedOrder = 0;
      let clientResult: AdapterRunResult | undefined;
      let cleanupWasCompleteWhenClientResolved = false;
      let clientRequestHadTimeout = false;
      let clientRequestHadRetryOverride = false;
      const adapter = new PiAdapter({
        locateExecutable: async () => process.execPath,
        locateInvocation: async () => ({
          executable: process.execPath,
          argvPrefix: [fakePiPath],
          identity: {
            packageName: "@earendil-works/pi-coding-agent",
            packageVersion: "0.80.10",
            nodeEngine: ">=20.0.0",
          },
        }),
        buildConfig: async () => testConfig,
        runClient: async (request) => {
          adapterClientInvocationCount += 1;
          clientRequestHadTimeout = Object.hasOwn(request, "timeoutMs");
          clientRequestHadRetryOverride =
            Object.hasOwn(request, "autoRetry") ||
            Object.hasOwn(request, "autoCompaction");
          clientResult = await runPiRpc(
            {
              ...request,
              executableArgs: request.executableArgs ?? [fakePiPath],
              environment: {
                ...request.environment,
                FAKE_PI_SCENARIO: "hold",
                FAKE_PI_LOG: logPath,
                FAKE_PI_ROOT_PID_FILE: rootPidPath,
                FAKE_PI_CHILD_PID_FILE: childPidPath,
              },
            },
            process.platform === "win32"
              ? {
                  spawnOwnedAgentProcess: (launch) =>
                    spawnWindowsOwnedAgentProcessWithDependencies(launch, {
                      resolveHelper: () =>
                        resolveWindowsJobHelperForModule(
                          syntheticDistModuleUrl,
                        ),
                    }),
                }
              : {},
          );
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
      const promptStateReady = observePromptProcessState([
        { label: "root", pidPath: rootPidPath },
        { label: "grandchild", pidPath: childPidPath },
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
      expect(clientResult?.executionTelemetry).toBeNull();
      expect(clientResult?.diagnostics).toContain("pi_runtime_identity_unknown");
      expect(
        commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
      expect(
        commands.filter((command) => command.type === "abort"),
      ).toHaveLength(1);
      expect(adapterClientInvocationCount).toBe(1);
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
