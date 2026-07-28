import { describe, expect, it } from "vitest";

import { sanitizePiWriteCommandObservations } from "../../src/smoke/pi-write-command-observation.js";

describe("Pi write command observation sanitizer", () => {
  it("retains only enum-only source, match, and outcome diagnostics", () => {
    const sanitized = sanitizePiWriteCommandObservations(
      [
        {
          source: "raw_input",
          command: "write",
          origin: "raw_input",
          outcome: "success",
        },
        {
          source: "raw_input",
          command: " write\n",
          origin: "raw_input",
          outcome: "error",
        },
        {
          source: "raw_input",
          command: "echo before && write",
          origin: "raw_input",
          outcome: "unknown",
        },
        {
          source: "title_fallback",
          command: "write",
          origin: "title",
          outcome: "missing",
        },
        {
          source: "unextractable",
          command: null,
          origin: null,
          outcome: "unknown",
        },
      ],
      "write",
    );

    expect(sanitized).toEqual([
      { source: "raw_input", match: "exact", outcome: "success" },
      { source: "raw_input", match: "trim_only", outcome: "error" },
      { source: "raw_input", match: "embedded", outcome: "unknown" },
      { source: "title_fallback", match: "other", outcome: "missing" },
      { source: "unextractable", match: "other", outcome: "unknown" },
    ]);
    expect(Object.keys(sanitized[0]!).sort()).toEqual([
      "match",
      "outcome",
      "source",
    ]);
    expect(JSON.stringify(sanitized)).not.toContain("echo before");
  });
});
