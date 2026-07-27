import { types } from "node:util";

export type CommandObservationSource =
  | "raw_input"
  | "title_fallback"
  | "late_update"
  | "unextractable";

export interface CommandObservation {
  source: CommandObservationSource;
  command: string | null;
}

type FieldSource = "initial" | "update";

interface FieldPatch {
  provided: boolean;
  value: unknown;
}

interface ToolCallPatch {
  kind: FieldPatch;
  title: FieldPatch;
  rawInput: FieldPatch;
}

interface FoldedField {
  source: FieldSource;
  value: unknown;
}

interface FoldedToolCall {
  seenInitial: boolean;
  pendingUpdates: ToolCallPatch[];
  kind?: FoldedField;
  title?: FoldedField;
  rawInput?: FoldedField;
  initialRawCommand?: string;
}

interface DataProperty {
  found: boolean;
  value: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function readDataProperty(
  record: Record<string, unknown>,
  key: string,
): DataProperty {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return { found: false, value: undefined };
    }
    return { found: true, value: descriptor.value };
  } catch {
    return { found: false, value: undefined };
  }
}

function readPatchField(
  record: Record<string, unknown>,
  key: string,
): FieldPatch {
  const property = readDataProperty(record, key);
  return {
    provided: property.found && property.value !== undefined,
    value: property.value,
  };
}

function parseToolEvent(
  event: unknown,
):
  | {
      type: "tool_call" | "tool_call_update";
      toolCallId: string;
      patch: ToolCallPatch;
    }
  | undefined {
  if (!isPlainRecord(event)) return undefined;

  const typeProperty = readDataProperty(event, "type");
  if (
    typeProperty.value !== "tool_call" &&
    typeProperty.value !== "tool_call_update"
  ) {
    return undefined;
  }
  const idProperty = readDataProperty(event, "toolCallId");
  if (typeof idProperty.value !== "string") return undefined;

  return {
    type: typeProperty.value,
    toolCallId: idProperty.value,
    patch: {
      kind: readPatchField(event, "kind"),
      title: readPatchField(event, "title"),
      rawInput: readPatchField(event, "rawInput"),
    },
  };
}

function safeRawCommand(rawInput: unknown): string | undefined {
  if (!isPlainRecord(rawInput)) return undefined;
  const commandProperty = readDataProperty(rawInput, "command");
  return typeof commandProperty.value === "string"
    ? commandProperty.value
    : undefined;
}

function applyPatch(
  folded: FoldedToolCall,
  patch: ToolCallPatch,
  source: FieldSource,
): void {
  if (patch.kind.provided) {
    folded.kind = { source, value: patch.kind.value };
  }
  if (patch.title.provided) {
    folded.title = { source, value: patch.title.value };
  }
  if (patch.rawInput.provided) {
    folded.rawInput = { source, value: patch.rawInput.value };
  }
}

function createFoldedToolCall(): FoldedToolCall {
  return {
    seenInitial: false,
    pendingUpdates: [],
  };
}

function observationFor(
  folded: FoldedToolCall,
): CommandObservation | undefined {
  if (folded.kind?.value !== "execute") return undefined;

  const rawCommand = safeRawCommand(folded.rawInput?.value);
  const title =
    typeof folded.title?.value === "string" && folded.title.value.length > 0
      ? folded.title.value
      : undefined;

  if (rawCommand !== undefined) {
    return {
      source:
        folded.kind.source === "update" ||
        folded.rawInput?.source === "update"
          ? "late_update"
          : "raw_input",
      command: rawCommand,
    };
  }

  if (title !== undefined) {
    return {
      source:
        folded.kind.source === "update" ||
        folded.title?.source === "update" ||
        (folded.rawInput?.source === "update" &&
          folded.initialRawCommand !== undefined)
          ? "late_update"
          : "title_fallback",
      command: title,
    };
  }

  return { source: "unextractable", command: null };
}

export function extractCommandObservations(
  events: readonly unknown[],
): readonly CommandObservation[] {
  const calls = new Map<string, FoldedToolCall>();
  const initialOrder: FoldedToolCall[] = [];

  for (const event of events) {
    const parsed = parseToolEvent(event);
    if (parsed === undefined) continue;

    let folded = calls.get(parsed.toolCallId);
    if (folded === undefined) {
      folded = createFoldedToolCall();
      calls.set(parsed.toolCallId, folded);
    }

    if (parsed.type === "tool_call_update") {
      if (folded.seenInitial) {
        applyPatch(folded, parsed.patch, "update");
      } else {
        folded.pendingUpdates.push(parsed.patch);
      }
      continue;
    }

    if (folded.seenInitial) continue;
    folded.seenInitial = true;
    initialOrder.push(folded);
    applyPatch(folded, parsed.patch, "initial");
    const initialRawCommand = safeRawCommand(folded.rawInput?.value);
    if (initialRawCommand !== undefined) {
      folded.initialRawCommand = initialRawCommand;
    }
    for (const update of folded.pendingUpdates) {
      applyPatch(folded, update, "update");
    }
    folded.pendingUpdates = [];
  }

  const observations: CommandObservation[] = [];
  for (const folded of initialOrder) {
    const observation = observationFor(folded);
    if (observation !== undefined) observations.push(observation);
  }
  return observations;
}

export function commandsFromObservations(
  observations: readonly CommandObservation[],
): string[] {
  const commands: string[] = [];
  for (const observation of observations) {
    if (observation.command !== null) commands.push(observation.command);
  }
  return commands;
}
