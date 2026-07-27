import { describe, expect, it } from "vitest";

import {
  sanitizeCommandObservations,
  type SanitizedCommandObservation,
} from "../../src/smoke/command-observation.js";

const validObservation: SanitizedCommandObservation = {
  source: "raw_input",
  match: "exact",
};

const invalidSource: SanitizedCommandObservation = {
  // @ts-expect-error Sanitized observations only accept known internal sources.
  source: "model_prose",
  match: "exact",
};

const invalidMatch: SanitizedCommandObservation = {
  source: "raw_input",
  // @ts-expect-error Sanitized observations only accept the closed match enum.
  match: "substring",
};

const invalidCommandShape: SanitizedCommandObservation = {
  source: "raw_input",
  match: "exact",
  // @ts-expect-error Sanitized observations must not contain raw command text.
  command: "git status --short",
};

void validObservation;
void invalidSource;
void invalidMatch;
void invalidCommandShape;

describe("sanitizeCommandObservations", () => {
  it("classifies observations without retaining command text", () => {
    expect(
      sanitizeCommandObservations(
        [
          { source: "raw_input", command: "git status --short" },
          { source: "raw_input", command: " git status --short\n" },
          {
            source: "late_update",
            command: "echo ok && git status --short",
          },
          { source: "unextractable", command: null },
        ],
        "git status --short",
      ),
    ).toEqual([
      { source: "raw_input", match: "exact" },
      { source: "raw_input", match: "trim_only" },
      { source: "late_update", match: "embedded" },
      { source: "unextractable", match: "other" },
    ]);
  });
});
