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
          {
            source: "raw_input",
            command: "git status --short",
            origin: "raw_input",
          },
          {
            source: "raw_input",
            command: " git status --short\n",
            origin: "raw_input",
          },
          {
            source: "late_update",
            command: "echo ok && git status --short",
            origin: "raw_input",
          },
          { source: "unextractable", command: null, origin: null },
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

  it("downgrades every title-derived observation without leaking its origin or text", () => {
    const sanitized = sanitizeCommandObservations(
      [
        {
          source: "title_fallback",
          command: "git status --short",
          origin: "title",
        },
        {
          source: "late_update",
          command: "git status --short",
          origin: "title",
        },
        {
          source: "late_update",
          command: "git status --short",
          origin: "raw_input",
        },
      ],
      "git status --short",
    );

    expect(sanitized).toEqual([
      { source: "title_fallback", match: "other" },
      { source: "title_fallback", match: "other" },
      { source: "late_update", match: "exact" },
    ]);
    expect(
      sanitized.every(
        (observation) =>
          Object.keys(observation).sort().join(",") === "match,source",
      ),
    ).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain("git status --short");
    expect(JSON.stringify(sanitized)).not.toContain("origin");
  });
});
