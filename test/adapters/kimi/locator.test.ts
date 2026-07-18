import { describe, expect, it } from "vitest";

import { locateKimi } from "../../../src/adapters/kimi/locator.js";

describe("locateKimi", () => {
  it("prefers an explicit KIMI_COMMAND", async () => {
    await expect(
      locateKimi({
        environment: { KIMI_COMMAND: "C:\\fake\\kimi.exe" },
        platform: "win32",
        homeDirectory: "C:\\Users\\test",
        pathLookup: async () => "C:\\path\\kimi.exe",
        fileExists: async (candidate) => candidate === "C:\\fake\\kimi.exe",
      }),
    ).resolves.toBe("C:\\fake\\kimi.exe");
  });

  it("uses PATH before the Windows fixed installation path", async () => {
    await expect(
      locateKimi({
        environment: {},
        platform: "win32",
        homeDirectory: "C:\\Users\\test",
        pathLookup: async () => "C:\\path\\kimi.exe",
        fileExists: async () => true,
      }),
    ).resolves.toBe("C:\\path\\kimi.exe");
  });

  it("probes the known Windows user installation path", async () => {
    await expect(
      locateKimi({
        environment: {},
        platform: "win32",
        homeDirectory: "C:\\Users\\test",
        pathLookup: async () => undefined,
        fileExists: async (candidate) =>
          candidate === "C:\\Users\\test\\.kimi-code\\bin\\kimi.exe",
      }),
    ).resolves.toBe("C:\\Users\\test\\.kimi-code\\bin\\kimi.exe");
  });

  it("fails with all non-secret locations checked", async () => {
    await expect(
      locateKimi({
        environment: {},
        platform: "win32",
        homeDirectory: "C:\\Users\\test",
        pathLookup: async () => undefined,
        fileExists: async () => false,
      }),
    ).rejects.toThrow(/Kimi Code executable not found/);
  });
});
