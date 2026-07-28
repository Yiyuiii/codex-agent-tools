import type {
  PiCommandLifecycleObservation,
  PiCommandLifecycleOutcome,
  PiCommandLifecycleSource,
} from "../tasks/pi-command-lifecycle.js";

export type PiWriteCommandMatch =
  | "exact"
  | "status_exact"
  | "trim_only"
  | "embedded"
  | "other";

export interface SanitizedPiWriteCommandObservation {
  readonly source: PiCommandLifecycleSource;
  readonly match: PiWriteCommandMatch;
  readonly outcome: PiCommandLifecycleOutcome;
}

function matchCommand(
  command: string,
  target: string,
  statusTarget?: string,
): PiWriteCommandMatch {
  if (command === target) return "exact";
  if (statusTarget !== undefined && command === statusTarget) {
    return "status_exact";
  }
  if (command.trim() === target) return "trim_only";
  if (command.includes(target)) return "embedded";
  return "other";
}

export function sanitizePiWriteCommandObservations(
  observations: readonly PiCommandLifecycleObservation[],
  target: string,
  statusTarget?: string,
): SanitizedPiWriteCommandObservation[] {
  return observations.map((observation) => ({
    source: observation.source,
    match:
      observation.source === "raw_input" &&
      observation.origin === "raw_input" &&
      observation.command !== null
        ? matchCommand(observation.command, target, statusTarget)
        : "other",
    outcome: observation.outcome,
  }));
}
