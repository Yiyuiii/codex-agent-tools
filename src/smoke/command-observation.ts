import type {
  CommandObservation,
  CommandObservationSource,
} from "../tasks/command-observations.js";

export type CommandMatchClass =
  | "exact"
  | "trim_only"
  | "embedded"
  | "other";

export interface SanitizedCommandObservation {
  readonly source: CommandObservationSource;
  readonly match: CommandMatchClass;
}

function classifyCommand(
  command: string | null,
  target: string,
): CommandMatchClass {
  if (command === target) return "exact";
  if (command !== null && command.trim() === target) return "trim_only";
  if (command !== null && command.includes(target)) return "embedded";
  return "other";
}

export function sanitizeCommandObservations(
  observations: readonly CommandObservation[],
  target: string,
): SanitizedCommandObservation[] {
  return observations.map((observation) => ({
    source: observation.source,
    match: classifyCommand(observation.command, target),
  }));
}
