import { describe, expect, it } from "vitest";

import {
  extractPiCommandLifecycleObservations,
  type PiCommandLifecycleObservation,
} from "../../src/tasks/pi-command-lifecycle.js";

function executeCall(
  toolCallId: string,
  title: string,
  command?: unknown,
): Record<string, unknown> {
  return {
    type: "tool_call",
    toolCallId,
    kind: "execute",
    title,
    ...(command === undefined ? {} : { rawInput: { command } }),
  };
}

function toolResult(
  toolCallId: string,
  title: string,
  isError?: unknown,
): Record<string, unknown> {
  return {
    type: "tool_result",
    toolCallId,
    title,
    ...(isError === undefined ? {} : { isError }),
  };
}

describe("extractPiCommandLifecycleObservations", () => {
  it("extracts commands, outcomes, and first-start order for two IDs", () => {
    expect(
      extractPiCommandLifecycleObservations([
        executeCall("second", "Second title", "second command"),
        executeCall("first", "First title"),
        toolResult("first", "First title", false),
        toolResult("second", "Second title", true),
      ]),
    ).toEqual([
      {
        toolCallId: "second",
        source: "raw_input",
        command: "second command",
        origin: "raw_input",
        outcome: "error",
      },
      {
        toolCallId: "first",
        source: "title_fallback",
        command: "First title",
        origin: "title",
        outcome: "success",
      },
    ] satisfies readonly PiCommandLifecycleObservation[]);
  });

  it("accepts an own string command, including an empty string", () => {
    expect(
      extractPiCommandLifecycleObservations([
        executeCall("empty-command", "Fallback", ""),
      ]),
    ).toEqual([
      {
        toolCallId: "empty-command",
        source: "raw_input",
        command: "",
        origin: "raw_input",
        outcome: "missing",
      },
    ]);
  });

  it.each([
    {
      name: "an absent raw input",
      event: executeCall("fallback", "Fallback title"),
    },
    {
      name: "a non-string command",
      event: executeCall("fallback", "Fallback title", 42),
    },
    {
      name: "an inherited command",
      event: {
        ...executeCall("fallback", "Fallback title"),
        rawInput: Object.create({ command: "inherited" }),
      },
    },
  ])("falls back to a non-empty title for $name", ({ event }) => {
    expect(extractPiCommandLifecycleObservations([event])).toEqual([
      {
        toolCallId: "fallback",
        source: "title_fallback",
        command: "Fallback title",
        origin: "title",
        outcome: "missing",
      },
    ]);
  });

  it.each([
    {
      name: "a missing title",
      event: {
        type: "tool_call",
        toolCallId: "unextractable",
        kind: "execute",
      },
    },
    {
      name: "an empty title",
      event: executeCall("unextractable", ""),
    },
    {
      name: "a non-string title",
      event: {
        type: "tool_call",
        toolCallId: "unextractable",
        kind: "execute",
        title: 42,
      },
    },
  ])("reports $name as unextractable", ({ event }) => {
    expect(extractPiCommandLifecycleObservations([event])).toEqual([
      {
        toolCallId: "unextractable",
        source: "unextractable",
        command: null,
        origin: null,
        outcome: "missing",
      },
    ]);
  });

  it.each([
    { name: "success", isError: false, outcome: "success" },
    { name: "error", isError: true, outcome: "error" },
  ] as const)(
    "maps one matching boolean result to $name",
    ({ isError, outcome }) => {
      expect(
        extractPiCommandLifecycleObservations([
          executeCall("a", "Run"),
          toolResult("a", "Run", isError),
        ]),
      ).toEqual([
        {
          toolCallId: "a",
          source: "title_fallback",
          command: "Run",
          origin: "title",
          outcome,
        },
      ]);
    },
  );

  it("uses missing when an execute start has no result", () => {
    expect(
      extractPiCommandLifecycleObservations([executeCall("a", "Run")]),
    ).toEqual([
      {
        toolCallId: "a",
        source: "title_fallback",
        command: "Run",
        origin: "title",
        outcome: "missing",
      },
    ]);
  });

  it.each([
    {
      name: "a result before its start",
      events: [toolResult("a", "Run", false), executeCall("a", "Run")],
    },
    {
      name: "equal duplicate starts",
      events: [executeCall("a", "Run"), executeCall("a", "Run")],
    },
    {
      name: "conflicting duplicate starts",
      events: [
        executeCall("a", "Run", "first"),
        executeCall("a", "Changed", "second"),
      ],
      expectedCommand: "first",
      expectedSource: "raw_input",
      expectedOrigin: "raw_input",
    },
    {
      name: "equal duplicate results",
      events: [
        executeCall("a", "Run"),
        toolResult("a", "Run", false),
        toolResult("a", "Run", false),
      ],
    },
    {
      name: "conflicting duplicate results",
      events: [
        executeCall("a", "Run"),
        toolResult("a", "Run", false),
        toolResult("a", "Changed", true),
      ],
    },
    {
      name: "a start without a title",
      events: [
        {
          type: "tool_call",
          toolCallId: "a",
          kind: "execute",
          rawInput: { command: "npm test" },
        },
        toolResult("a", "Run", false),
      ],
      expectedCommand: "npm test",
      expectedSource: "raw_input",
      expectedOrigin: "raw_input",
    },
    {
      name: "a result without a title",
      events: [
        executeCall("a", "Run"),
        { type: "tool_result", toolCallId: "a", isError: false },
      ],
    },
    {
      name: "a result with a different title",
      events: [
        executeCall("a", "Run"),
        toolResult("a", "Changed", false),
      ],
    },
    {
      name: "a result without isError",
      events: [executeCall("a", "Run"), toolResult("a", "Run")],
    },
    {
      name: "a result with non-boolean isError",
      events: [executeCall("a", "Run"), toolResult("a", "Run", "false")],
    },
  ])(
    "uses unknown for $name",
    ({
      events,
      expectedCommand = "Run",
      expectedSource = "title_fallback",
      expectedOrigin = "title",
    }) => {
      expect(extractPiCommandLifecycleObservations(events)).toEqual([
        {
          toolCallId: "a",
          source: expectedSource,
          command: expectedCommand,
          origin: expectedOrigin,
          outcome: "unknown",
        },
      ]);
    },
  );

  it("ignores orphan results, unrelated Pi events, and empty IDs", () => {
    expect(
      extractPiCommandLifecycleObservations([
        toolResult("orphan", "Run", false),
        {
          type: "tool_call_update",
          toolCallId: "update",
          kind: "execute",
          title: "Update",
        },
        { type: "message_start", toolCallId: "message" },
        executeCall("", "Empty ID"),
        toolResult("", "Empty ID", false),
      ]),
    ).toEqual([]);
  });

  it("lets the first non-execute start permanently exclude an ID", () => {
    expect(
      extractPiCommandLifecycleObservations([
        {
          type: "tool_call",
          toolCallId: "a",
          kind: "read",
          title: "Read",
        },
        executeCall("a", "Run"),
        toolResult("a", "Run", false),
      ]),
    ).toEqual([]);
  });

  it("does not execute Proxy traps on event or raw-input wrappers", () => {
    let trapCount = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          trapCount += 1;
          throw new Error("get trap must not run");
        },
        getOwnPropertyDescriptor() {
          trapCount += 1;
          throw new Error("descriptor trap must not run");
        },
        getPrototypeOf() {
          trapCount += 1;
          throw new Error("prototype trap must not run");
        },
      },
    );

    expect(
      extractPiCommandLifecycleObservations([
        hostile,
        {
          ...executeCall("safe", "Safe fallback"),
          rawInput: hostile,
        },
      ]),
    ).toEqual([
      {
        toolCallId: "safe",
        source: "title_fallback",
        command: "Safe fallback",
        origin: "title",
        outcome: "missing",
      },
    ]);
    expect(trapCount).toBe(0);
  });

  it("does not execute accessors or throwing getters", () => {
    let getterCount = 0;
    const accessorEvent = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        getterCount += 1;
        throw new Error("event getter must not run");
      },
    });
    const accessorRawInput = Object.defineProperty({}, "command", {
      enumerable: true,
      get() {
        getterCount += 1;
        throw new Error("command getter must not run");
      },
    });
    const accessorResult = {
      type: "tool_result",
      toolCallId: "safe",
      title: "Safe fallback",
    };
    Object.defineProperty(accessorResult, "isError", {
      enumerable: true,
      get() {
        getterCount += 1;
        throw new Error("result getter must not run");
      },
    });

    expect(
      extractPiCommandLifecycleObservations([
        accessorEvent,
        {
          ...executeCall("safe", "Safe fallback"),
          rawInput: accessorRawInput,
        },
        accessorResult,
      ]),
    ).toEqual([
      {
        toolCallId: "safe",
        source: "title_fallback",
        command: "Safe fallback",
        origin: "title",
        outcome: "unknown",
      },
    ]);
    expect(getterCount).toBe(0);
  });

  it("ignores inherited and symbol-only event fields", () => {
    const inherited = Object.create({
      type: "tool_call",
      toolCallId: "inherited",
      kind: "execute",
      title: "Inherited",
    });
    const symbolType = Symbol("type");
    const symbolId = Symbol("toolCallId");

    expect(
      extractPiCommandLifecycleObservations([
        inherited,
        {
          [symbolType]: "tool_call",
          toolCallId: "symbol-type",
          kind: "execute",
          title: "Symbol type",
        },
        {
          type: "tool_call",
          [symbolId]: "symbol-id",
          kind: "execute",
          title: "Symbol ID",
        },
      ]),
    ).toEqual([]);
  });
});
