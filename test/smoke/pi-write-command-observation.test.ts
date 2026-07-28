import { describe, expect, it } from "vitest";

import { sanitizePiWriteCommandObservations } from "../../src/smoke/pi-write-command-observation.js";

describe("Pi write command observation sanitizer", () => {
  it("retains only enum-only source, match, and outcome diagnostics", () => {
    const privateSentinels = {
      id: "PI_SANITIZER_PRIVATE_ID_SENTINEL",
      toolCallId: "PI_SANITIZER_PRIVATE_TOOL_CALL_ID_SENTINEL",
      cwd: "PI_SANITIZER_PRIVATE_CWD_SENTINEL",
      path: "PI_SANITIZER_PRIVATE_PATH_SENTINEL",
      rawInput: "PI_SANITIZER_PRIVATE_RAW_INPUT_SENTINEL",
      rawOutput: "PI_SANITIZER_PRIVATE_RAW_OUTPUT_SENTINEL",
      output: "PI_SANITIZER_PRIVATE_OUTPUT_SENTINEL",
      fileName: "PI_SANITIZER_PRIVATE_FILE_NAME_SENTINEL",
      base64: "PI_SANITIZER_PRIVATE_BASE64_SENTINEL",
      modelText: "PI_SANITIZER_PRIVATE_MODEL_TEXT_SENTINEL",
    } as const;
    const sanitized = sanitizePiWriteCommandObservations(
      [
        Object.assign(
          {
            source: "raw_input",
            command: "write",
            origin: "raw_input",
            outcome: "success",
          } as const,
          {
            id: privateSentinels.id,
            toolCallId: privateSentinels.toolCallId,
          },
        ),
        {
          source: "title_fallback",
          command: "write",
          origin: "raw_input",
          outcome: "success",
        },
        {
          source: "unextractable",
          command: "write",
          origin: "raw_input",
          outcome: "error",
        },
        Object.assign(
          {
            source: "raw_input",
            command: " write\n",
            origin: "raw_input",
            outcome: "error",
          } as const,
          {
            cwd: privateSentinels.cwd,
            path: privateSentinels.path,
          },
        ),
        Object.assign(
          {
            source: "raw_input",
            command: "echo before && write",
            origin: "raw_input",
            outcome: "unknown",
          } as const,
          {
            rawInput: privateSentinels.rawInput,
            rawOutput: privateSentinels.rawOutput,
          },
        ),
        Object.assign(
          {
            source: "title_fallback",
            command: "write",
            origin: "title",
            outcome: "missing",
          } as const,
          {
            output: privateSentinels.output,
            fileName: privateSentinels.fileName,
          },
        ),
        Object.assign(
          {
            source: "unextractable",
            command: null,
            origin: null,
            outcome: "unknown",
          } as const,
          {
            base64: privateSentinels.base64,
            modelText: privateSentinels.modelText,
          },
        ),
      ],
      "write",
    );

    expect(sanitized).toEqual([
      { source: "raw_input", match: "exact", outcome: "success" },
      { source: "title_fallback", match: "other", outcome: "success" },
      { source: "unextractable", match: "other", outcome: "error" },
      { source: "raw_input", match: "trim_only", outcome: "error" },
      { source: "raw_input", match: "embedded", outcome: "unknown" },
      { source: "title_fallback", match: "other", outcome: "missing" },
      { source: "unextractable", match: "other", outcome: "unknown" },
    ]);
    for (const observation of sanitized) {
      expect(Object.keys(observation).sort()).toEqual([
        "match",
        "outcome",
        "source",
      ]);
      const serializedObservation = JSON.stringify(observation);
      for (const sentinel of Object.values(privateSentinels)) {
        expect(serializedObservation).not.toContain(sentinel);
      }
    }
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("echo before");
  });
});
