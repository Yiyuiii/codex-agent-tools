import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

import {
  OwnedProcessFailure,
  type OwnedAgentProcess,
  type OwnedCompletion,
  type OwnedProcessExit,
  type OwnedProcessFailureCode,
  type OwnedTerminationReason,
  type SpawnOwnedAgentProcessRequest,
} from "./owned-agent-process.js";
import {
  encodeWindowsJobFrame,
  WindowsJobFrameDecoder,
  type WindowsJobFrame,
  type WindowsJobReason,
  type WindowsJobStage,
} from "./windows-job-protocol.js";
import {
  resolveWindowsJobHelper,
  type ResolvedWindowsJobHelper,
} from "./windows-job-helper.js";

export { OwnedProcessFailure } from "./owned-agent-process.js";

export interface WindowsHelperSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly windowsHide: true;
  readonly stdio: readonly ["pipe", "pipe", "pipe", "overlapped"];
}

export interface WindowsHelperChild extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdio: readonly [Writable, Readable, Readable, Readable & Writable];
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface WindowsOwnedAgentProcessDependencies {
  readonly resolveHelper: () => Promise<ResolvedWindowsJobHelper>;
  readonly spawnHelper?: (
    executable: string,
    args: readonly string[],
    options: WindowsHelperSpawnOptions,
  ) => WindowsHelperChild;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly settled: () => boolean;
}

interface FailureRecord {
  readonly code: OwnedProcessFailureCode;
  readonly helperStage?: WindowsJobStage;
}

interface TerminalExit {
  readonly type: "exit";
  readonly rootExitCode: number;
  readonly reason: Exclude<WindowsJobReason, "protocolError">;
}

interface TerminalError {
  readonly type: "error";
  readonly stage: WindowsJobStage;
}

type Terminal = TerminalExit | TerminalError;

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve(value): void {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(reason): void {
      if (settled) return;
      settled = true;
      rejectPromise(reason);
    },
    settled: () => settled,
  };
}

function defaultSpawnHelper(
  executable: string,
  args: readonly string[],
  options: WindowsHelperSpawnOptions,
): WindowsHelperChild {
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide,
    stdio: [...options.stdio],
  };
  return spawn(
    executable,
    [...args],
    spawnOptions,
  ) as ChildProcess as unknown as WindowsHelperChild;
}

const defaultDependencies: WindowsOwnedAgentProcessDependencies = {
  resolveHelper: resolveWindowsJobHelper,
  spawnHelper: defaultSpawnHelper,
};

function publicReason(reason: WindowsJobReason): OwnedCompletion {
  switch (reason) {
    case "noneOrRootExit":
      return "root_exit";
    case "cancelled":
      return "cancelled";
    case "timedOut":
      return "timed_out";
    case "sessionShutdown":
      return "session_shutdown";
    case "protocolError":
      throw new OwnedProcessFailure("protocol_failed");
  }
}

function protocolReason(
  reason: OwnedTerminationReason,
): Exclude<WindowsJobReason, "noneOrRootExit" | "protocolError"> {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timedOut";
    case "session_shutdown":
      return "sessionShutdown";
  }
}

function makeFailure(
  primary: FailureRecord,
  secondary: ReadonlySet<OwnedProcessFailureCode>,
): OwnedProcessFailure {
  const options: {
    helperStage?: string;
    secondaryCodes?: readonly OwnedProcessFailureCode[];
  } = {
    secondaryCodes: [...secondary],
  };
  if (primary.helperStage !== undefined) {
    options.helperStage = primary.helperStage;
  }
  return new OwnedProcessFailure(primary.code, options);
}

function isUsableControl(value: unknown): value is Readable & Writable {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Readable & Writable>;
  return (
    typeof candidate.on === "function" && typeof candidate.write === "function"
  );
}

function isReadableStream(value: unknown): value is Readable {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Readable>;
  return (
    typeof candidate.on === "function" && typeof candidate.once === "function"
  );
}

function isWritableStream(value: unknown): value is Writable {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Writable>;
  return (
    typeof candidate.on === "function" &&
    typeof candidate.once === "function" &&
    typeof candidate.write === "function"
  );
}

export async function spawnWindowsOwnedAgentProcess(
  request: SpawnOwnedAgentProcessRequest,
): Promise<OwnedAgentProcess> {
  return spawnWindowsOwnedAgentProcessWithDependencies(
    request,
    defaultDependencies,
  );
}

/** @internal Tests replace only artifact resolution and helper creation. */
export async function spawnWindowsOwnedAgentProcessWithDependencies(
  request: SpawnOwnedAgentProcessRequest,
  dependencies: WindowsOwnedAgentProcessDependencies,
): Promise<OwnedAgentProcess> {
  let encodedConfig: Uint8Array;
  try {
    encodedConfig = encodeWindowsJobFrame({
      type: "launchConfig",
      executable: request.executable,
      cwd: request.cwd,
      argv: request.args,
    });
  } catch {
    throw new OwnedProcessFailure("launch_invalid");
  }

  let helper: ResolvedWindowsJobHelper;
  try {
    helper = await dependencies.resolveHelper();
  } catch {
    throw new OwnedProcessFailure("helper_invalid");
  }

  const spawnOptions: WindowsHelperSpawnOptions = {
    cwd: request.cwd,
    env: request.environment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "overlapped"],
  };
  let child: WindowsHelperChild;
  try {
    child = (dependencies.spawnHelper ?? defaultSpawnHelper)(
      helper.executablePath,
      ["--control-v1"],
      spawnOptions,
    );
  } catch {
    throw new OwnedProcessFailure("spawn_failed");
  }

  const control = child.stdio[3];
  if (
    !isUsableControl(control) ||
    !isWritableStream(child.stdin) ||
    !isReadableStream(child.stdout) ||
    !isReadableStream(child.stderr)
  ) {
    try {
      child.kill();
    } catch {}
    throw new OwnedProcessFailure("launch_invalid");
  }

  const ready = deferred<void>();
  const closed = deferred<OwnedProcessExit>();
  const decoder = new WindowsJobFrameDecoder();
  const secondaryFailures = new Set<OwnedProcessFailureCode>();
  let firstFailure: FailureRecord | undefined;
  let readySeen = false;
  let terminal: Terminal | undefined;
  let controlEnded = false;
  let controlClosed = false;
  let stdinClosed = false;
  let stdoutClosed = false;
  let stderrClosed = false;
  let processClosed = false;
  let processCode: number | null = null;
  let processSignal: NodeJS.Signals | null = null;
  let rescueAttempted = false;
  let protocolStopAttempted = false;
  let configWritten = false;
  let expectedExitReason:
    Exclude<WindowsJobReason, "noneOrRootExit" | "protocolError"> | undefined;
  let publicTerminationPromise: Promise<void> | undefined;
  let writeTail = Promise.resolve();

  const failure = (): OwnedProcessFailure | undefined =>
    firstFailure === undefined
      ? undefined
      : makeFailure(firstFailure, secondaryFailures);

  const addSecondary = (code: OwnedProcessFailureCode): void => {
    if (firstFailure?.code !== code) secondaryFailures.add(code);
  };

  const recordFailure = (
    code: OwnedProcessFailureCode,
    helperStage?: WindowsJobStage,
  ): void => {
    if (firstFailure === undefined) {
      firstFailure =
        helperStage === undefined ? { code } : { code, helperStage };
      ready.reject(failure());
      return;
    }
    addSecondary(code);
  };

  const rescueWithRetainedHandle = (): void => {
    if (rescueAttempted) return;
    rescueAttempted = true;
    try {
      if (!child.kill()) addSecondary("termination_failed");
    } catch {
      addSecondary("termination_failed");
    }
  };

  const queueWrite = (bytes: Uint8Array): Promise<void> => {
    const operation = writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          try {
            control.write(Buffer.from(bytes), (error?: Error | null) => {
              if (error !== undefined && error !== null) {
                reject(new OwnedProcessFailure("control_failed"));
                return;
              }
              resolve();
            });
          } catch {
            reject(new OwnedProcessFailure("control_failed"));
          }
        }),
    );
    writeTail = operation.catch(() => undefined);
    return operation;
  };

  const requestPrivateProtocolStop = (): void => {
    if (protocolStopAttempted) return;
    protocolStopAttempted = true;
    if (
      terminal !== undefined ||
      !configWritten ||
      controlEnded ||
      controlClosed
    ) {
      rescueWithRetainedHandle();
      return;
    }
    void queueWrite(
      encodeWindowsJobFrame({ type: "terminate", reason: "protocolError" }),
    ).catch(() => {
      addSecondary("termination_failed");
      rescueWithRetainedHandle();
    });
  };

  const failAndClean = (
    code: OwnedProcessFailureCode,
    helperStage?: WindowsJobStage,
  ): void => {
    recordFailure(code, helperStage);
    if (code === "control_failed" && (controlEnded || controlClosed)) {
      rescueWithRetainedHandle();
    } else {
      requestPrivateProtocolStop();
    }
  };

  const trySettle = (): void => {
    if (
      closed.settled() ||
      !processClosed ||
      !stdinClosed ||
      !stdoutClosed ||
      !stderrClosed ||
      !controlClosed
    ) {
      return;
    }

    if (!controlEnded) recordFailure("control_failed");
    if (terminal === undefined) recordFailure("helper_exit_failed");
    if (processSignal !== null) recordFailure("helper_exit_failed");

    if (terminal?.type === "exit") {
      if (processCode !== 0) recordFailure("helper_exit_failed");
    } else if (terminal?.type === "error") {
      if (processCode !== 68) addSecondary("helper_exit_failed");
    }

    const finalFailure = failure();
    if (finalFailure !== undefined) {
      closed.reject(finalFailure);
      return;
    }
    if (terminal?.type !== "exit") {
      closed.reject(new OwnedProcessFailure("drain_failed"));
      return;
    }
    closed.resolve(
      Object.freeze({
        platform: "win32",
        completion: publicReason(terminal.reason),
        rootExitCode: terminal.rootExitCode,
        signal: null,
        ownershipDrained: true,
      }),
    );
  };

  const onFrame = (frame: WindowsJobFrame): void => {
    if (terminal !== undefined) {
      failAndClean("protocol_failed");
      return;
    }
    if (!readySeen) {
      if (frame.type === "ready") {
        readySeen = true;
        ready.resolve(undefined);
        return;
      }
      if (frame.type === "error") {
        terminal = { type: "error", stage: frame.stage };
        recordFailure("helper_reported_failure", frame.stage);
        return;
      }
      failAndClean("protocol_failed");
      return;
    }

    if (frame.type === "exit") {
      const reasonMatches =
        frame.reason === "noneOrRootExit" ||
        (expectedExitReason !== undefined &&
          frame.reason === expectedExitReason);
      if (!reasonMatches) {
        recordFailure("protocol_failed");
        rescueWithRetainedHandle();
        return;
      }
      terminal = {
        type: "exit",
        rootExitCode: frame.rootExitCode,
        reason: frame.reason,
      };
      return;
    }
    if (frame.type === "error") {
      terminal = { type: "error", stage: frame.stage };
      recordFailure("helper_reported_failure", frame.stage);
      return;
    }
    failAndClean("protocol_failed");
  };

  control.on("data", (chunk: Buffer | string) => {
    try {
      const frames = decoder.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
      for (const frame of frames) onFrame(frame);
    } catch {
      failAndClean("protocol_failed");
    }
  });
  control.once("end", () => {
    controlEnded = true;
    try {
      decoder.finish();
    } catch {
      recordFailure("protocol_failed");
    }
    if (terminal === undefined) failAndClean("control_failed");
    trySettle();
  });
  control.once("close", () => {
    controlClosed = true;
    if (terminal === undefined) failAndClean("control_failed");
    trySettle();
  });
  control.once("error", () => {
    recordFailure("control_failed");
    rescueWithRetainedHandle();
  });
  child.stdin.once("close", () => {
    stdinClosed = true;
    trySettle();
  });
  child.stdin.once("error", () => {
    failAndClean("stdio_failed");
  });
  child.stdout.once("close", () => {
    stdoutClosed = true;
    trySettle();
  });
  child.stdout.once("error", () => {
    failAndClean("stdio_failed");
  });
  child.stderr.once("close", () => {
    stderrClosed = true;
    trySettle();
  });
  child.stderr.once("error", () => {
    failAndClean("stdio_failed");
  });
  child.once("error", () => {
    failAndClean("spawn_failed");
  });
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    processClosed = true;
    processCode = code;
    processSignal = signal;
    if (terminal === undefined) recordFailure("helper_exit_failed");
    trySettle();
  });

  try {
    await queueWrite(encodedConfig);
    configWritten = true;
  } catch {
    failAndClean("control_failed");
  }

  const terminate = (reason: OwnedTerminationReason): Promise<void> => {
    if (publicTerminationPromise !== undefined) {
      return publicTerminationPromise;
    }
    if (terminal !== undefined || processClosed) {
      publicTerminationPromise = Promise.resolve();
      return publicTerminationPromise;
    }
    if (firstFailure !== undefined) {
      publicTerminationPromise = Promise.resolve();
      return publicTerminationPromise;
    }
    const expectedReason = protocolReason(reason);
    expectedExitReason = expectedReason;
    publicTerminationPromise = queueWrite(
      encodeWindowsJobFrame({
        type: "terminate",
        reason: expectedReason,
      }),
    ).catch(() => {
      failAndClean("termination_failed");
      throw failure() ?? new OwnedProcessFailure("termination_failed");
    });
    void publicTerminationPromise.catch(() => undefined);
    return publicTerminationPromise;
  };

  return Object.freeze({
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    ready: ready.promise,
    closed: closed.promise,
    terminate,
  });
}
