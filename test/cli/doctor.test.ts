import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installCodexConfigText } from "../../src/cli/config.js";
import { collectDoctorReport } from "../../src/cli/doctor.js";

let tempDirectory: string;
let configPath: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-agent-doctor-"));
  configPath = path.join(tempDirectory, "config.toml");
  await writeFile(
    configPath,
    installCodexConfigText("", {
      nodePath: "C:\\node.exe",
      mcpPath: "D:\\tools\\dist\\mcp.js",
    }),
    "utf8",
  );
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe("doctor diagnostics", () => {
  it("reports Kimi, MCP ownership, fixed routes, and qualified gates without secrets", async () => {
    const secret = "must-not-appear";
    const report = await collectDoctorReport({
      configPath,
      environment: { PATH: "x", SOME_SECRET: secret },
      locateKimiExecutable: async () =>
        "C:\\Users\\test\\.kimi-code\\bin\\kimi.exe",
      runCommand: async (_command, args) => ({
        ok: true,
        output:
          args[0] === "--version"
            ? "kimi-code 0.27.0"
            : `Kimi doctor valid ${secret}`,
      }),
    });

    expect(report.checks.find((check) => check.name === "Kimi executable")).toMatchObject({
      level: "ok",
      detail: "C:\\Users\\test\\.kimi-code\\bin\\kimi.exe",
    });
    expect(report.checks.find((check) => check.name === "Kimi version")?.detail).toContain("0.27.0");
    expect(report.checks.find((check) => check.name === "MCP registration")?.level).toBe("ok");
    expect(report.checks.find((check) => check.name === "Public MCP tools")?.detail).toBe(
      "external_review, external_delegate",
    );
    expect(report.checks.find((check) => check.name === "LLM kimi-k3")?.detail).toContain(
      "kimi-code/k3 via kimi-acp; route=direct; review=passed; delegate=passed",
    );
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("returns an error check instead of throwing when Kimi is missing", async () => {
    const report = await collectDoctorReport({
      configPath,
      locateKimiExecutable: async () => {
        throw new Error("Kimi Code executable not found");
      },
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "Kimi executable")).toMatchObject({
      ok: false,
      level: "error",
    });
  });

  it("warns when the owned MCP registration is absent", async () => {
    await writeFile(configPath, "[mcp_servers.other]\ncommand = \"x\"\n", "utf8");
    const report = await collectDoctorReport({
      configPath,
      locateKimiExecutable: async () => "kimi.exe",
      runCommand: async () => ({ ok: true, output: "0.27.0" }),
    });
    expect(report.checks.find((check) => check.name === "MCP registration")).toMatchObject({
      level: "warn",
      ok: false,
    });
  });
});
