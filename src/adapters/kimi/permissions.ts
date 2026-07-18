import path from "node:path";

import type { TaskKind } from "../../domain/types.js";

export interface PermissionLocation {
  path: string;
}

export interface PermissionIntent {
  kind?: string | null;
  locations?: readonly PermissionLocation[] | null;
}

export type PermissionDecision = "allow" | "deny";

export interface PermissionOption {
  optionId: string;
  kind: string;
}

export type PermissionResponse =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

function pathApiFor(cwd: string, candidate: string): typeof path.win32 | typeof path {
  return /^[A-Za-z]:[\\/]/u.test(cwd) || /^[A-Za-z]:[\\/]/u.test(candidate)
    ? path.win32
    : path;
}

function isWithin(cwd: string, candidate: string): boolean {
  const pathApi = pathApiFor(cwd, candidate);
  const normalizedCwd = pathApi.resolve(cwd);
  const normalizedCandidate = pathApi.resolve(candidate);
  const relative = pathApi.relative(normalizedCwd, normalizedCandidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${pathApi.sep}`) &&
      relative !== ".." &&
      !pathApi.isAbsolute(relative))
  );
}

export function decidePermission(
  task: TaskKind,
  cwd: string,
  intent: PermissionIntent,
): PermissionDecision {
  if (task === "delegate") {
    return "allow";
  }

  if (intent.kind !== "read" && intent.kind !== "search") {
    return "deny";
  }

  const locations = intent.locations ?? [];
  if (locations.length === 0) {
    return "deny";
  }

  return locations.every((location) => isWithin(cwd, location.path))
    ? "allow"
    : "deny";
}

export function selectPermissionResponse(
  decision: PermissionDecision,
  options: readonly PermissionOption[],
): PermissionResponse {
  const preferredKinds =
    decision === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];

  for (const kind of preferredKinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) {
      return {
        outcome: { outcome: "selected", optionId: option.optionId },
      };
    }
  }

  return { outcome: { outcome: "cancelled" } };
}
