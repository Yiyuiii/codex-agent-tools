import type {
  PiCommandLifecycleObservation,
  PiCommandLifecycleOutcome,
  PiCommandLifecycleSource,
} from "../tasks/pi-command-lifecycle.js";

export type PiWriteCommandMatch = "exact" | "trim_only" | "embedded" | "other";

export interface SanitizedPiWriteCommandObservation {
  readonly source: PiCommandLifecycleSource;
  readonly match: PiWriteCommandMatch;
  readonly outcome: PiCommandLifecycleOutcome;
}

function matchCommand(command: string, target: string): PiWriteCommandMatch {
  if (command === target) return "exact";
  if (command.trim() === target) return "trim_only";
  if (command.includes(target)) return "embedded";
  return "other";
}

export function sanitizePiWriteCommandObservations(
  observations: readonly PiCommandLifecycleObservation[],
  target: string,
): SanitizedPiWriteCommandObservation[] {
  return observations.map((observation) => ({
    source: observation.source,
    match:
      observation.origin === "raw_input" && observation.command !== null
        ? matchCommand(observation.command, target)
        : "other",
    outcome: observation.outcome,
  }));
}
