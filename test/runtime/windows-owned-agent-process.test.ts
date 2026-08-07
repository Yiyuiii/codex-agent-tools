import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  OwnedProcessFailure,
  spawnWindowsOwnedAgentProcessWithDependencies,
  type WindowsHelperChild,
  type WindowsHelperSpawnOptions,
} from "../../src/runtime/windows-owned-agent-process.js";
import {
  decodeWindowsJobFrame,
  encodeWindowsJobFrame,
} from "../../src/runtime/windows-job-protocol.js";

class FakeControl extends Duplex {
  readonly writes: Buffer[] = [];
  endCalls = 0;
  destroyCalls = 0;
  private holdNextWrite = false;
  private readonly heldWriteCallbacks: Array<(error?: Error | null) => void> =
    [];

  public _read(): void {}

  public _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.from(chunk));
    if (this.holdNextWrite) {
      this.holdNextWrite = false;
      this.heldWriteCallbacks.push(callback);
      return;
    }
    callback();
  }

  public override end(callback?: () => void): this;
  public override end(chunk: unknown, callback?: () => void): this;
  public override end(
    chunk: unknown,
    encoding: BufferEncoding,
    callback?: () => void,
  ): this;
  public override end(
    chunkOrCallback?: unknown | (() => void),
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): this {
    this.endCalls += 1;
    if (arguments.length === 0) return super.end();
    if (arguments.length === 1) {
      return typeof chunkOrCallback === "function"
        ? super.end(chunkOrCallback)
        : super.end(chunkOrCallback);
    }
    if (arguments.length === 2) {
      return typeof encodingOrCallback === "function"
        ? super.end(chunkOrCallback, encodingOrCallback)
        : super.end(chunkOrCallback, encodingOrCallback as BufferEncoding);
    }
    return super.end(
      chunkOrCallback,
      encodingOrCallback as BufferEncoding,
      callback,
    );
  }

  public override destroy(error?: Error): this {
    this.destroyCalls += 1;
    return super.destroy(error);
  }

  public receive(frame: Parameters<typeof encodeWindowsJobFrame>[0]): void {
    this.push(Buffer.from(encodeWindowsJobFrame(frame)));
  }

  public receiveBytes(bytes: Uint8Array): void {
    this.push(Buffer.from(bytes));
  }

  public holdOneWrite(): void {
    this.holdNextWrite = true;
  }

  public releaseHeldWrites(): void {
    for (const callback of this.heldWriteCallbacks.splice(0)) callback();
  }

  public closeFromHelper(): void {
    this.once("end", () => {
      queueMicrotask(() => this.emit("close"));
    });
    this.push(null);
  }
}

class FakeWindowsHelperChild
  extends EventEmitter
  implements WindowsHelperChild
{
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly control = new FakeControl();
  readonly stdio = [
    this.stdin,
    this.stdout,
    this.stderr,
    this.control,
  ] as const;
  readonly kill = vi.fn(() => true);

  public closeFromHelper(code: number): void {
    for (const stream of [this.stdin, this.stdout, this.stderr]) {
      stream.emit("close");
    }
    this.control.closeFromHelper();
    queueMicrotask(() => this.emit("close", code, null));
  }

  public closeFromRetainedKill(): void {
    for (const stream of [this.stdin, this.stdout, this.stderr]) {
      stream.emit("close");
    }
    this.control.closeFromHelper();
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
  }
}

interface Harness {
  child: FakeWindowsHelperChild;
  spawnCalls: Array<{
    executable: string;
    args: readonly string[];
    options: WindowsHelperSpawnOptions;
  }>;
  start(): ReturnType<typeof spawnWindowsOwnedAgentProcessWithDependencies>;
}

function createHarness(): Harness {
  const child = new FakeWindowsHelperChild();
  const spawnCalls: Harness["spawnCalls"] = [];
  return {
    child,
    spawnCalls,
    start: () =>
      spawnWindowsOwnedAgentProcessWithDependencies(
        {
          executable: "C:\\runtime\\target.exe",
          args: ["--flag", "value with spaces"],
          cwd: "C:\\workspace",
          environment: {
            SYSTEMROOT: "C:\\Windows",
            OWNED_SENTINEL: "request-only",
          },
        },
        {
          resolveHelper: async () => ({
            executablePath: "C:\\package\\codex-agent-job-helper.exe",
            sha256: "a".repeat(64),
          }),
          spawnHelper: (executable, args, options) => {
            spawnCalls.push({ executable, args, options });
            return child;
          },
        },
      ),
  };
}

async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function expectFailure(
  promise: Promise<unknown>,
  code: OwnedProcessFailure["code"],
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: "OwnedProcessFailure",
    code,
  }) as Promise<void>;
}

describe("Windows OwnedAgentProcess", () => {
  it("launches only the verified helper, gates READY, and drains a timed-out job", async () => {
    const harness = createHarness();
    const owned = await harness.start();

    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.spawnCalls[0]).toEqual({
      executable: "C:\\package\\codex-agent-job-helper.exe",
      args: ["--control-v1"],
      options: {
        cwd: "C:\\workspace",
        env: {
          SYSTEMROOT: "C:\\Windows",
          OWNED_SENTINEL: "request-only",
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe", "overlapped"],
      },
    });
    expect(owned.stdin).toBe(harness.child.stdin);
    expect(owned.stdout).toBe(harness.child.stdout);
    expect(owned.stderr).toBe(harness.child.stderr);
    expect(decodeWindowsJobFrame(harness.child.control.writes[0]!)).toEqual({
      type: "launchConfig",
      executable: "C:\\runtime\\target.exe",
      cwd: "C:\\workspace",
      argv: ["--flag", "value with spaces"],
    });

    let ready = false;
    void owned.ready.then(() => {
      ready = true;
    });
    await flushEvents();
    expect(ready).toBe(false);

    harness.child.control.receive({ type: "ready" });
    await owned.ready;
    expect(ready).toBe(true);

    const firstTerminate = owned.terminate("timed_out");
    const duplicateTerminate = owned.terminate("cancelled");
    expect(duplicateTerminate).toBe(firstTerminate);
    await firstTerminate;
    expect(harness.child.control.writes).toHaveLength(2);
    expect(decodeWindowsJobFrame(harness.child.control.writes[1]!)).toEqual({
      type: "terminate",
      reason: "timedOut",
    });
    expect(harness.child.control.endCalls).toBe(0);
    expect(harness.child.control.destroyCalls).toBe(0);

    harness.child.control.receive({
      type: "exit",
      rootExitCode: 1,
      reason: "timedOut",
      jobActiveProcessesZero: true,
    });
    harness.child.closeFromHelper(0);

    await expect(owned.closed).resolves.toEqual({
      platform: "win32",
      completion: "timed_out",
      rootExitCode: 1,
      signal: null,
      ownershipDrained: true,
    });
    expect(harness.child.kill).not.toHaveBeenCalled();
    expect(harness.child.control.endCalls).toBe(0);
    expect(harness.child.control.destroyCalls).toBe(0);
  });

  it("fails closed on a terminal before READY and sends one private protocol stop", async () => {
    const harness = createHarness();
    const owned = await harness.start();

    harness.child.control.receive({
      type: "exit",
      rootExitCode: 0,
      reason: "noneOrRootExit",
      jobActiveProcessesZero: true,
    });
    await flushEvents();

    expect(harness.child.control.writes).toHaveLength(2);
    expect(decodeWindowsJobFrame(harness.child.control.writes[1]!)).toEqual({
      type: "terminate",
      reason: "protocolError",
    });
    harness.child.control.receive({
      type: "error",
      stage: "protocolInvalid",
      reason: "protocolError",
      win32Code: null,
    });
    harness.child.closeFromHelper(68);

    await expectFailure(owned.ready, "protocol_failed");
    await expectFailure(owned.closed, "protocol_failed");
    expect(harness.child.kill).not.toHaveBeenCalled();
  });

  it("uses only the retained ChildProcess handle when fd3 closes before terminal", async () => {
    const harness = createHarness();
    const owned = await harness.start();
    harness.child.control.receive({ type: "ready" });
    await owned.ready;

    harness.child.control.closeFromHelper();
    await flushEvents();
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
    harness.child.emit("close", 68, null);
    harness.child.stdout.emit("close");
    harness.child.stderr.emit("close");
    harness.child.stdin.emit("close");

    await expectFailure(owned.closed, "control_failed");
  });

  it("rejects a valid helper ERROR with only fixed safe metadata", async () => {
    const harness = createHarness();
    const owned = await harness.start();
    harness.child.control.receive({ type: "ready" });
    await owned.ready;
    harness.child.control.receive({
      type: "error",
      stage: "createFailed",
      reason: "cancelled",
      win32Code: 1234,
    });
    harness.child.closeFromHelper(68);

    let failure: unknown;
    try {
      await owned.closed;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "OwnedProcessFailure",
      code: "helper_reported_failure",
      helperStage: "createFailed",
    });
    expect(String(failure)).toBe(
      "OwnedProcessFailure: Windows job helper reported a fixed failure.",
    );
    expect(JSON.stringify(failure)).not.toContain("1234");
  });

  it("rescues with the retained handle when a duplicate terminal leaves the helper open", async () => {
    const harness = createHarness();
    harness.child.kill.mockImplementation(() => {
      harness.child.closeFromRetainedKill();
      return true;
    });
    const owned = await harness.start();
    harness.child.control.receive({ type: "ready" });
    await owned.ready;
    const terminal = {
      type: "exit" as const,
      rootExitCode: 0,
      reason: "noneOrRootExit" as const,
      jobActiveProcessesZero: true as const,
    };
    harness.child.control.receiveBytes(
      Buffer.concat([
        Buffer.from(encodeWindowsJobFrame(terminal)),
        Buffer.from(encodeWindowsJobFrame(terminal)),
      ]),
    );

    await expectFailure(owned.closed, "protocol_failed");
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("rescues with the retained handle when malformed bytes follow a terminal", async () => {
    const harness = createHarness();
    harness.child.kill.mockImplementation(() => {
      harness.child.closeFromRetainedKill();
      return true;
    });
    const owned = await harness.start();
    harness.child.control.receive({ type: "ready" });
    await owned.ready;
    harness.child.control.receive({
      type: "exit",
      rootExitCode: 0,
      reason: "noneOrRootExit",
      jobActiveProcessesZero: true,
    });
    const malformed = Buffer.from(encodeWindowsJobFrame({ type: "ready" }));
    malformed[0] = 0;
    harness.child.control.receiveBytes(malformed);

    await expectFailure(owned.closed, "protocol_failed");
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects a natural EXIT reason that is only valid after explicit termination", async () => {
    const harness = createHarness();
    harness.child.kill.mockImplementation(() => {
      harness.child.closeFromRetainedKill();
      return true;
    });
    const owned = await harness.start();
    harness.child.control.receive({ type: "ready" });
    await owned.ready;
    harness.child.control.receive({
      type: "exit",
      rootExitCode: 1,
      reason: "timedOut",
      jobActiveProcessesZero: true,
    });

    await expectFailure(owned.closed, "protocol_failed");
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("requires EXIT to echo the successfully written public termination reason", async () => {
    const harness = createHarness();
    harness.child.kill.mockImplementation(() => {
      harness.child.closeFromRetainedKill();
      return true;
    });
    const owned = await harness.start();
    harness.child.control.receive({ type: "ready" });
    await owned.ready;
    await owned.terminate("timed_out");
    harness.child.control.receive({
      type: "exit",
      rootExitCode: 0,
      reason: "cancelled",
      jobActiveProcessesZero: true,
    });

    await expectFailure(owned.closed, "protocol_failed");
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it("prefers a legal natural completion after public termination linearizes", async () => {
    const harness = createHarness();
    harness.child.kill.mockImplementation(() => {
      harness.child.closeFromRetainedKill();
      return true;
    });
    const owned = await harness.start();
    harness.child.control.receive({ type: "ready" });
    await owned.ready;
    harness.child.control.holdOneWrite();

    const termination = owned.terminate("timed_out");
    await flushEvents();
    harness.child.control.receive({
      type: "exit",
      rootExitCode: 0,
      reason: "noneOrRootExit",
      jobActiveProcessesZero: true,
    });
    harness.child.control.releaseHeldWrites();
    await termination;

    harness.child.closeFromHelper(0);
    await expect(owned.closed).resolves.toMatchObject({
      completion: "root_exit",
      rootExitCode: 0,
      ownershipDrained: true,
    });
    expect(harness.child.kill).not.toHaveBeenCalled();
  });

  it("allows natural completion already observed before public termination", async () => {
    const harness = createHarness();
    const owned = await harness.start();
    harness.child.control.receive({ type: "ready" });
    await owned.ready;
    harness.child.control.receive({
      type: "exit",
      rootExitCode: 0,
      reason: "noneOrRootExit",
      jobActiveProcessesZero: true,
    });
    await owned.terminate("timed_out");
    harness.child.closeFromHelper(0);

    await expect(owned.closed).resolves.toMatchObject({
      completion: "root_exit",
      rootExitCode: 0,
      ownershipDrained: true,
    });
    expect(harness.child.control.writes).toHaveLength(1);
    expect(harness.child.kill).not.toHaveBeenCalled();
  });

  it("rejects a successful terminal when helper exit or stdio settlement is not clean", async () => {
    const harness = createHarness();
    const owned = await harness.start();
    harness.child.control.receive({ type: "ready" });
    await owned.ready;
    harness.child.control.receive({
      type: "exit",
      rootExitCode: 0,
      reason: "noneOrRootExit",
      jobActiveProcessesZero: true,
    });
    harness.child.stderr.emit("error", new Error("SECRET_NATIVE_ERROR"));
    harness.child.closeFromHelper(9);

    await expectFailure(owned.closed, "stdio_failed");
    await expect(owned.closed).rejects.not.toThrow(/SECRET_NATIVE_ERROR/u);
  });
});
