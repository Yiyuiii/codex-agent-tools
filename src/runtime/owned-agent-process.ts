import type { Readable, Writable } from "node:stream";

export type OwnedTerminationReason =
  "cancelled" | "timed_out" | "session_shutdown";

export type OwnedCompletion = "root_exit" | OwnedTerminationReason;

export type OwnedProcessExit = Readonly<{
  platform: "win32";
  completion: OwnedCompletion;
  rootExitCode: number;
  signal: null;
  ownershipDrained: true;
}>;

export interface OwnedAgentProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly ready: Promise<void>;
  readonly closed: Promise<OwnedProcessExit>;
  terminate(reason: OwnedTerminationReason): Promise<void>;
}

export interface SpawnOwnedAgentProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export type OwnedProcessFailureCode =
  | "launch_invalid"
  | "helper_invalid"
  | "spawn_failed"
  | "control_failed"
  | "protocol_failed"
  | "helper_reported_failure"
  | "helper_exit_failed"
  | "stdio_failed"
  | "termination_failed"
  | "drain_failed";

const FAILURE_MESSAGES: Readonly<Record<OwnedProcessFailureCode, string>> =
  Object.freeze({
    launch_invalid: "Owned agent process launch contract is invalid.",
    helper_invalid: "Windows job helper artifact validation failed.",
    spawn_failed: "Owned agent process could not be started.",
    control_failed: "Windows owned-process control channel failed.",
    protocol_failed: "Windows owned-process protocol failed.",
    helper_reported_failure: "Windows job helper reported a fixed failure.",
    helper_exit_failed: "Windows job helper exited unexpectedly.",
    stdio_failed: "Owned agent process standard I/O failed.",
    termination_failed: "Owned agent process termination failed.",
    drain_failed: "Owned agent process did not drain cleanly.",
  });

export class OwnedProcessFailure extends Error {
  public readonly code: OwnedProcessFailureCode;
  public readonly helperStage?: string;
  public readonly secondaryCodes: readonly OwnedProcessFailureCode[];

  public constructor(
    code: OwnedProcessFailureCode,
    options: {
      helperStage?: string;
      secondaryCodes?: readonly OwnedProcessFailureCode[];
    } = {},
  ) {
    super(FAILURE_MESSAGES[code]);
    this.name = "OwnedProcessFailure";
    this.code = code;
    if (options.helperStage !== undefined) {
      this.helperStage = options.helperStage;
    }
    this.secondaryCodes = Object.freeze([...(options.secondaryCodes ?? [])]);
  }
}

export async function spawnOwnedAgentProcess(
  request: SpawnOwnedAgentProcessRequest,
): Promise<OwnedAgentProcess> {
  if (process.platform !== "win32") {
    throw new OwnedProcessFailure("launch_invalid");
  }
  const { spawnWindowsOwnedAgentProcess } =
    await import("./windows-owned-agent-process.js");
  return spawnWindowsOwnedAgentProcess(request);
}
