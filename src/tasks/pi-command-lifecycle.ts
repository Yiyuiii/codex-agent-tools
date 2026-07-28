import { types } from "node:util";

export type PiCommandLifecycleSource =
  | "raw_input"
  | "title_fallback"
  | "unextractable";

export type PiCommandLifecycleOrigin = "raw_input" | "title" | null;

export type PiCommandLifecycleOutcome =
  | "success"
  | "error"
  | "missing"
  | "unknown";

export interface PiCommandLifecycleObservation {
  readonly toolCallId: string;
  readonly source: PiCommandLifecycleSource;
  readonly command: string | null;
  readonly origin: PiCommandLifecycleOrigin;
  readonly outcome: PiCommandLifecycleOutcome;
}

interface OwnDataProperty {
  found: boolean;
  value: unknown;
}

interface ParsedToolCall {
  type: "tool_call";
  toolCallId: string;
  kind: unknown;
  title: unknown;
  rawInput: unknown;
}

interface ParsedToolResult {
  type: "tool_result";
  toolCallId: string;
  title: unknown;
  isError: unknown;
}

type ParsedPiToolEvent = ParsedToolCall | ParsedToolResult;

interface FoldedLifecycle {
  started: boolean;
  included: boolean;
  resultBeforeStart: boolean;
  duplicateStart: boolean;
  resultsAfterStart: ParsedToolResult[];
  observation?: Omit<PiCommandLifecycleObservation, "outcome">;
  startTitle?: string;
}

function isOrdinaryRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function readOwnDataProperty(
  record: Record<string, unknown>,
  key: string,
): OwnDataProperty {
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

function parsePiToolEvent(event: unknown): ParsedPiToolEvent | undefined {
  if (!isOrdinaryRecord(event)) return undefined;

  const type = readOwnDataProperty(event, "type").value;
  if (type !== "tool_call" && type !== "tool_result") return undefined;

  const toolCallId = readOwnDataProperty(event, "toolCallId").value;
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return undefined;
  }

  if (type === "tool_call") {
    return {
      type,
      toolCallId,
      kind: readOwnDataProperty(event, "kind").value,
      title: readOwnDataProperty(event, "title").value,
      rawInput: readOwnDataProperty(event, "rawInput").value,
    };
  }

  return {
    type,
    toolCallId,
    title: readOwnDataProperty(event, "title").value,
    isError: readOwnDataProperty(event, "isError").value,
  };
}

function ownRawCommand(rawInput: unknown): string | undefined {
  if (!isOrdinaryRecord(rawInput)) return undefined;
  const command = readOwnDataProperty(rawInput, "command").value;
  return typeof command === "string" ? command : undefined;
}

function nonEmptyTitle(title: unknown): string | undefined {
  return typeof title === "string" && title.length > 0 ? title : undefined;
}

function commandObservation(
  toolCallId: string,
  start: ParsedToolCall,
): Omit<PiCommandLifecycleObservation, "outcome"> {
  const rawCommand = ownRawCommand(start.rawInput);
  if (rawCommand !== undefined) {
    return {
      toolCallId,
      source: "raw_input",
      command: rawCommand,
      origin: "raw_input",
    };
  }

  const title = nonEmptyTitle(start.title);
  if (title !== undefined) {
    return {
      toolCallId,
      source: "title_fallback",
      command: title,
      origin: "title",
    };
  }

  return {
    toolCallId,
    source: "unextractable",
    command: null,
    origin: null,
  };
}

function createFoldedLifecycle(): FoldedLifecycle {
  return {
    started: false,
    included: false,
    resultBeforeStart: false,
    duplicateStart: false,
    resultsAfterStart: [],
  };
}

function outcomeFor(folded: FoldedLifecycle): PiCommandLifecycleOutcome {
  if (folded.resultBeforeStart || folded.duplicateStart) return "unknown";
  if (folded.resultsAfterStart.length === 0) return "missing";
  if (folded.resultsAfterStart.length !== 1) return "unknown";

  const result = folded.resultsAfterStart[0]!;
  const resultTitle = nonEmptyTitle(result.title);
  if (
    folded.startTitle === undefined ||
    resultTitle === undefined ||
    folded.startTitle !== resultTitle ||
    typeof result.isError !== "boolean"
  ) {
    return "unknown";
  }
  return result.isError ? "error" : "success";
}

export function extractPiCommandLifecycleObservations(
  events: readonly unknown[],
): readonly PiCommandLifecycleObservation[] {
  const lifecycles = new Map<string, FoldedLifecycle>();
  const includedOrder: FoldedLifecycle[] = [];

  for (const event of events) {
    const parsed = parsePiToolEvent(event);
    if (parsed === undefined) continue;

    let folded = lifecycles.get(parsed.toolCallId);
    if (folded === undefined) {
      folded = createFoldedLifecycle();
      lifecycles.set(parsed.toolCallId, folded);
    }

    if (parsed.type === "tool_result") {
      if (folded.started) {
        folded.resultsAfterStart.push(parsed);
      } else {
        folded.resultBeforeStart = true;
      }
      continue;
    }

    if (folded.started) {
      folded.duplicateStart = true;
      continue;
    }

    folded.started = true;
    folded.included = parsed.kind === "execute";
    if (!folded.included) continue;

    const startTitle = nonEmptyTitle(parsed.title);
    if (startTitle !== undefined) folded.startTitle = startTitle;
    folded.observation = commandObservation(parsed.toolCallId, parsed);
    includedOrder.push(folded);
  }

  return includedOrder.map((folded) => ({
    ...folded.observation!,
    outcome: outcomeFor(folded),
  }));
}
