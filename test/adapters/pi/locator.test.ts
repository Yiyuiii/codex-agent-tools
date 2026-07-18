import { describe, expect, it } from "vitest";

import { locatePi } from "../../../src/adapters/pi/locator.js";

describe("locatePi", () => {
  it("prefers an explicit PI_COMMAND", async () => {
    await expect(
      locatePi({
        environment: { PI_COMMAND: "C:\\fake\\pi.cmd" },
        platform: "win32",
        homeDirectory: "C:\\Users\\test",
        pathLookup: async () => "C:\\path\\pi.cmd",
        fileExists: async (candidate) => candidate === "C:\\fake\\pi.cmd",
      }),
    ).resolves.toBe("C:\\fake\\pi.cmd");
  });

  it("resolves Pi from PATH before the npm fallback", async () => {
    await expect(
      locatePi({
        environment: {},
        platform: "win32",
        homeDirectory: "C:\\Users\\test",
        pathLookup: async (command) =>
          command === "pi.cmd" ? "C:\\path\\pi.cmd" : undefined,
        fileExists: async () => true,
      }),
    ).resolves.toBe("C:\\path\\pi.cmd");
  });

  it("probes the Windows global npm bin fallback", async () => {
    await expect(
      locatePi({
        environment: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
        platform: "win32",
        homeDirectory: "C:\\Users\\test",
        pathLookup: async () => undefined,
        fileExists: async (candidate) =>
          candidate === "C:\\Users\\test\\AppData\\Roaming\\npm\\pi.cmd",
      }),
    ).resolves.toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\pi.cmd");
  });

  it("fails with the checked non-secret locations", async () => {
    await expect(
      locatePi({
        environment: {},
        platform: "linux",
        homeDirectory: "/home/test",
        pathLookup: async () => undefined,
        fileExists: async () => false,
      }),
    ).rejects.toThrow(/Pi executable not found/u);
  });
});
