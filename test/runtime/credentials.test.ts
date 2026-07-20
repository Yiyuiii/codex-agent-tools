import { describe, expect, it } from "vitest";

import { resolveCredential } from "../../src/runtime/credentials.js";

describe("credential normalization", () => {
  it("normalizes only the first non-empty Ark Coding credential", () => {
    expect(
      resolveCredential(
        ["ARK_API_KEY", "VOLCENGINE_API_KEY"],
        "CODEX_AGENT_ARK_CODING_KEY",
        {
          ARK_API_KEY: "primary",
          VOLCENGINE_API_KEY: "secondary",
          ANTHROPIC_API_KEY: "forbidden",
        },
      ),
    ).toEqual({
      sourceName: "ARK_API_KEY",
      targetName: "CODEX_AGENT_ARK_CODING_KEY",
      value: "primary",
    });
  });

  it("uses case-insensitive lookup and skips whitespace-only values", () => {
    expect(
      resolveCredential(
        ["ARK_API_KEY", "VOLCENGINE_API_KEY"],
        "CODEX_AGENT_ARK_CODING_KEY",
        { ark_api_key: "  ", volcengine_api_key: "fallback" },
      ),
    ).toMatchObject({
      sourceName: "VOLCENGINE_API_KEY",
      value: "fallback",
    });
  });

  it("reports only candidate names when no credential is available", () => {
    expect(() =>
      resolveCredential(
        ["ARK_API_KEY", "VOLCENGINE_API_KEY"],
        "CODEX_AGENT_ARK_CODING_KEY",
        { ARK_API_KEY: "", VOLCENGINE_API_KEY: "   " },
      ),
    ).toThrow("Missing credential: ARK_API_KEY or VOLCENGINE_API_KEY");
  });

  it("accepts the existing local Ark Coding environment variable as a fallback", () => {
    expect(
      resolveCredential(
        ["ARK_API_KEY", "VOLCENGINE_API_KEY", "API_KEY_DOUBAO_CODING"],
        "CODEX_AGENT_ARK_CODING_KEY",
        { API_KEY_DOUBAO_CODING: "local-coding-plan" },
      ),
    ).toEqual({
      sourceName: "API_KEY_DOUBAO_CODING",
      targetName: "CODEX_AGENT_ARK_CODING_KEY",
      value: "local-coding-plan",
    });
  });
});
