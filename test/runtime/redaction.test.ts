import { describe, expect, it } from "vitest";

import { redactText } from "../../src/runtime/redaction.js";

describe("redactText", () => {
  it("redacts supplied secret values and authorization headers", () => {
    expect(
      redactText("Authorization: Bearer abc123 endpoint abc123", ["abc123"]),
    ).toBe("Authorization: [REDACTED] endpoint [REDACTED]");
  });

  it("redacts api key header values without dropping surrounding diagnostics", () => {
    expect(redactText("host=x x-api-key: top-secret status=401", [])).toBe(
      "host=x x-api-key: [REDACTED] status=401",
    );
    expect(redactText("x-goog-api-key=google-secret model=gemini", [])).toBe(
      "x-goog-api-key=[REDACTED] model=gemini",
    );
  });

  it("handles overlapping and regular-expression-like secrets literally", () => {
    expect(redactText("token=a+b token=a+b-long", ["a+b", "a+b-long"])).toBe(
      "token=[REDACTED] token=[REDACTED]",
    );
  });
});
