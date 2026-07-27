import { describe, expect, it } from "vitest";

import {
  commandsFromObservations,
  extractCommandObservations,
  type CommandObservation,
} from "../../src/tasks/command-observations.js";

interface ObservationCase {
  name: string;
  events: readonly unknown[];
  expected: readonly CommandObservation[];
}

const observationCases: readonly ObservationCase[] = [
  {
    name: "uses an initial raw command",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "Run tests",
        rawInput: { command: "npm test" },
      },
    ],
    expected: [{ source: "raw_input", command: "npm test" }],
  },
  {
    name: "falls back to an initial title",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "Run tests",
      },
    ],
    expected: [{ source: "title_fallback", command: "Run tests" }],
  },
  {
    name: "reports an unextractable execute call",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "",
      },
    ],
    expected: [{ source: "unextractable", command: null }],
  },
  {
    name: "uses a raw command from a late update",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "Run",
      },
      {
        type: "tool_call_update",
        toolCallId: "a",
        rawInput: { command: "git status --short" },
      },
    ],
    expected: [{ source: "late_update", command: "git status --short" }],
  },
  {
    name: "folds an update that arrives before its initial call",
    events: [
      {
        type: "tool_call_update",
        toolCallId: "a",
        rawInput: { command: "git status --short" },
      },
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "Run",
      },
    ],
    expected: [{ source: "late_update", command: "git status --short" }],
  },
  {
    name: "ignores an orphan update",
    events: [
      {
        type: "tool_call_update",
        toolCallId: "orphan",
        kind: "execute",
        rawInput: { command: "npm test" },
      },
    ],
    expected: [],
  },
  {
    name: "ignores a non-execute final call",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "read",
        title: "Read tests",
        rawInput: { command: "npm test" },
      },
    ],
    expected: [],
  },
  {
    name: "uses the final value from repeated updates",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "Run",
      },
      {
        type: "tool_call_update",
        toolCallId: "a",
        rawInput: { command: "first" },
      },
      {
        type: "tool_call_update",
        toolCallId: "a",
        rawInput: { command: "final" },
      },
    ],
    expected: [{ source: "late_update", command: "final" }],
  },
  {
    name: "orders by the first initial call rather than pending updates",
    events: [
      {
        type: "tool_call_update",
        toolCallId: "second",
        rawInput: { command: "second command" },
      },
      {
        type: "tool_call_update",
        toolCallId: "orphan",
        kind: "execute",
        rawInput: { command: "orphan command" },
      },
      {
        type: "tool_call",
        toolCallId: "first",
        kind: "execute",
        rawInput: { command: "first command" },
      },
      {
        type: "tool_call",
        toolCallId: "second",
        kind: "execute",
        title: "Second",
      },
    ],
    expected: [
      { source: "raw_input", command: "first command" },
      { source: "late_update", command: "second command" },
    ],
  },
  {
    name: "marks a late execute kind as a late update",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: null,
        title: "Run tests",
      },
      {
        type: "tool_call_update",
        toolCallId: "a",
        kind: "execute",
      },
    ],
    expected: [{ source: "late_update", command: "Run tests" }],
  },
  {
    name: "treats undefined update fields as not provided",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "Run tests",
        rawInput: { command: "npm test" },
      },
      {
        type: "tool_call_update",
        toolCallId: "a",
        kind: undefined,
        title: undefined,
        rawInput: undefined,
      },
    ],
    expected: [{ source: "raw_input", command: "npm test" }],
  },
  {
    name: "treats null update fields as explicit clears",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "Run tests",
        rawInput: { command: "npm test" },
      },
      {
        type: "tool_call_update",
        toolCallId: "a",
        rawInput: null,
      },
    ],
    expected: [{ source: "late_update", command: "Run tests" }],
  },
  {
    name: "uses the final title supplied by an update",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "Initial title",
      },
      {
        type: "tool_call_update",
        toolCallId: "a",
        title: "Final title",
      },
    ],
    expected: [{ source: "late_update", command: "Final title" }],
  },
  {
    name: "ignores unrelated late fields when the initial command remains final",
    events: [
      {
        type: "tool_call",
        toolCallId: "a",
        kind: "execute",
        title: "Initial title",
        rawInput: { command: "npm test" },
      },
      {
        type: "tool_call_update",
        toolCallId: "a",
        title: "Updated title",
      },
    ],
    expected: [{ source: "raw_input", command: "npm test" }],
  },
];

describe("extractCommandObservations", () => {
  it.each(observationCases)("$name", ({ events, expected }) => {
    expect(extractCommandObservations(events)).toEqual(expected);
  });

  it("does not invoke Proxy traps on event wrappers or raw input", () => {
    let eventTrapCount = 0;
    let rawInputTrapCount = 0;
    const hostileEvent = new Proxy(
      {},
      {
        get() {
          eventTrapCount += 1;
          throw new Error("event trap must not run");
        },
        getOwnPropertyDescriptor() {
          eventTrapCount += 1;
          throw new Error("event descriptor trap must not run");
        },
        getPrototypeOf() {
          eventTrapCount += 1;
          throw new Error("event prototype trap must not run");
        },
      },
    );
    const hostileRawInput = new Proxy(
      {},
      {
        get() {
          rawInputTrapCount += 1;
          throw new Error("raw input trap must not run");
        },
        getOwnPropertyDescriptor() {
          rawInputTrapCount += 1;
          throw new Error("raw input descriptor trap must not run");
        },
        getPrototypeOf() {
          rawInputTrapCount += 1;
          throw new Error("raw input prototype trap must not run");
        },
      },
    );

    expect(
      extractCommandObservations([
        hostileEvent,
        {
          type: "tool_call",
          toolCallId: "safe",
          kind: "execute",
          title: "Safe fallback",
          rawInput: hostileRawInput,
        },
      ]),
    ).toEqual([{ source: "title_fallback", command: "Safe fallback" }]);
    expect(eventTrapCount).toBe(0);
    expect(rawInputTrapCount).toBe(0);
  });

  it("marks a hostile late raw-input replacement as a late title fallback", () => {
    let trapCount = 0;
    const hostileRawInput = new Proxy(
      {},
      {
        get() {
          trapCount += 1;
          throw new Error("raw input trap must not run");
        },
        getOwnPropertyDescriptor() {
          trapCount += 1;
          throw new Error("raw input descriptor trap must not run");
        },
        getPrototypeOf() {
          trapCount += 1;
          throw new Error("raw input prototype trap must not run");
        },
      },
    );

    expect(
      extractCommandObservations([
        {
          type: "tool_call",
          toolCallId: "a",
          kind: "execute",
          title: "Safe fallback",
          rawInput: { command: "initial command" },
        },
        {
          type: "tool_call_update",
          toolCallId: "a",
          rawInput: hostileRawInput,
        },
      ]),
    ).toEqual([{ source: "late_update", command: "Safe fallback" }]);
    expect(trapCount).toBe(0);
  });

  it("does not invoke accessors on event wrappers or command fields", () => {
    let eventGetterCount = 0;
    let commandGetterCount = 0;
    const eventWithAccessor = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        eventGetterCount += 1;
        throw new Error("event getter must not run");
      },
    });
    const rawInputWithAccessor = Object.defineProperty({}, "command", {
      enumerable: true,
      get() {
        commandGetterCount += 1;
        throw new Error("command getter must not run");
      },
    });

    expect(
      extractCommandObservations([
        eventWithAccessor,
        {
          type: "tool_call",
          toolCallId: "safe",
          kind: "execute",
          title: "Accessor fallback",
          rawInput: rawInputWithAccessor,
        },
      ]),
    ).toEqual([{ source: "title_fallback", command: "Accessor fallback" }]);
    expect(eventGetterCount).toBe(0);
    expect(commandGetterCount).toBe(0);
  });

  it.each([
    {
      name: "inherited command",
      rawInput: Object.create({ command: "inherited" }),
    },
    {
      name: "non-string command",
      rawInput: {
        command: {
          toString() {
            throw new Error("toString must not run");
          },
          *[Symbol.iterator]() {
            throw new Error("iterator must not run");
          },
        },
      },
    },
    {
      name: "non-plain raw input",
      rawInput: new (class RawInput {
        public command = "class command";
      })(),
    },
  ])("fails closed for $name", ({ rawInput }) => {
    expect(
      extractCommandObservations([
        {
          type: "tool_call",
          toolCallId: "a",
          kind: "execute",
          title: "Safe fallback",
          rawInput,
        },
      ]),
    ).toEqual([{ source: "title_fallback", command: "Safe fallback" }]);
  });

  it("returns unextractable when unsafe raw input has no non-empty title", () => {
    const rawInput = Object.defineProperty({}, "command", {
      get() {
        throw new Error("command getter must not run");
      },
    });

    expect(
      extractCommandObservations([
        {
          type: "tool_call",
          toolCallId: "a",
          kind: "execute",
          title: "",
          rawInput,
        },
      ]),
    ).toEqual([{ source: "unextractable", command: null }]);
  });
});

describe("commandsFromObservations", () => {
  it("keeps non-null commands in order without trimming or deduplicating", () => {
    expect(
      commandsFromObservations([
        { source: "raw_input", command: "npm test" },
        { source: "unextractable", command: null },
        { source: "late_update", command: " npm test " },
        { source: "title_fallback", command: "npm test" },
      ]),
    ).toEqual(["npm test", " npm test ", "npm test"]);
  });
});
