import { describe, expect, it } from "vitest";

import {
  main,
  parseCapabilityVerifierArguments,
} from "../../scripts/verify-capabilities.js";

describe("capability verifier maintainer CLI", () => {
  it("accepts only verify-by-default or help", () => {
    expect(parseCapabilityVerifierArguments([])).toEqual({ kind: "verify" });
    expect(parseCapabilityVerifierArguments(["--help"])).toEqual({
      kind: "help",
    });
    for (const args of [
      ["--index", "../outside.json"],
      ["--llm", "ark-coding-plan"],
      ["--refresh"],
      ["--write"],
      ["--help", "--verbose"],
    ]) {
      expect(() => parseCapabilityVerifierArguments(args)).toThrowError(
        "Invalid capability verifier arguments",
      );
    }
  });

  it("prints fixed help without entering verification", async () => {
    let calls = 0;
    let stdout = "";
    let stderr = "";

    await expect(
      main({
        args: ["--help"],
        verify: async () => {
          calls += 1;
          throw new Error("must not run");
        },
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      }),
    ).resolves.toBe(0);
    expect(calls).toBe(0);
    expect(stdout).toBe("Usage: npm run verify:capabilities\n");
    expect(stderr).toBe("");
  });

  it("prints a minimal success summary", async () => {
    let receivedRoot = "";
    let stdout = "";
    let stderr = "";

    await expect(
      main({
        args: [],
        repositoryRoot: "D:/isolated/repository",
        verify: async ({ repositoryRoot }) => {
          receivedRoot = repositoryRoot;
          return {
            verified: true,
            indexPath: "docs/smoke/evidence/capabilities.json",
            entryCount: 8,
            legacyEntryCount: 0,
          };
        },
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      }),
    ).resolves.toBe(0);
    expect(receivedRoot).toMatch(/[\\/]isolated[\\/]repository$/u);
    expect(JSON.parse(stdout)).toEqual({
      verified: true,
      indexPath: "docs/smoke/evidence/capabilities.json",
      entryCount: 8,
      legacyEntryCount: 0,
    });
    expect(stderr).toBe("");
  });

  it("fails closed without exposing verifier errors", async () => {
    const secret = "CAPABILITY_VERIFIER_SECRET_SENTINEL";
    let stdout = "";
    let stderr = "";

    await expect(
      main({
        args: [],
        verify: async () => {
          throw new Error(secret);
        },
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      }),
    ).resolves.toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Capability qualification verification failed\n");
    expect(stderr).not.toContain(secret);
  });
});
