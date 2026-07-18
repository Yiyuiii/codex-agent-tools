import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installCodexConfigText } from "../../src/cli/config.js";
import { collectDoctorReport } from "../../src/cli/doctor.js";
import { buildIsolatedPiConfig } from "../../src/adapters/pi/config.js";

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
      environment: {
        PATH: "x",
        SOME_SECRET: secret,
        GEMINI_API_KEY: "primary-gemini-secret",
        GOOGLE_API_KEY: "secondary-gemini-secret",
        ARK_API_KEY: "primary-ark-secret",
        VOLCENGINE_API_KEY: "secondary-ark-secret",
        OPENAI_API_KEY_DOUBAO: "agent-ark-secret",
      },
      locateKimiExecutable: async () =>
        "C:\\Users\\test\\.kimi-code\\bin\\kimi.exe",
      runCommand: async (command, args) => {
        if (args.includes("--list-models")) {
          return {
            ok: true,
            output: [
              "ark-agent-plan doubao-seed-2.0-pro 200K 32K yes no",
              "ark-agent-plan glm-5.2 200K 32K yes no",
              "ark-coding-plan ark-code-latest 200K 32K yes no",
            ].join("\n"),
          };
        }
        return {
          ok: true,
          output:
            args[0] === "--version"
              ? command.includes("kimi")
                ? "kimi-code 0.27.0"
                : "0.80.10"
              : `Kimi doctor valid ${secret}`,
        };
      },
      locatePiExecutable: async () => "C:\\Users\\test\\npm\\pi.cmd",
      buildPiConfig: () =>
        buildIsolatedPiConfig({
          root: tempDirectory,
          version: "0.1.0-alpha.1",
          providers: ["ark"],
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
    expect(report.checks.find((check) => check.name === "Pi executable")).toMatchObject({
      level: "ok",
      detail: "C:\\Users\\test\\npm\\pi.cmd",
    });
    expect(report.checks.find((check) => check.name === "Pi isolated config")?.detail).toContain(
      path.join(tempDirectory, "pi", "0.1.0-alpha.1"),
    );
    expect(report.checks.find((check) => check.name === "Ark Pi models")).toMatchObject({
      ok: true,
      level: "ok",
    });
    expect(report.checks.find((check) => check.name === "Ark Pi models")?.detail).toContain(
      "ark.cn-beijing.volces.com; models=3; sha256=",
    );
    expect(report.checks.find((check) => check.name === "Gemini authentication")?.detail).toBe(
      "credential environment: GEMINI_API_KEY",
    );
    expect(report.checks.find((check) => check.name === "LLM gemini-3.5-flash")?.detail).toContain(
      "gemini-3.5-flash via pi-rpc; route=direct; review=passed; delegate=passed",
    );
    expect(report.checks.find((check) => check.name === "Ark Coding authentication")?.detail).toBe(
      "credential environment: ARK_API_KEY -> CODEX_AGENT_ARK_CODING_KEY",
    );
    expect(report.checks.find((check) => check.name === "Ark Agent authentication")?.detail).toBe(
      "credential environment: OPENAI_API_KEY_DOUBAO -> CODEX_AGENT_ARK_AGENT_KEY",
    );
    expect(report.checks.find((check) => check.name === "LLM ark-agent-glm-5.2")?.detail).toContain(
      "glm-5.2 via pi-rpc; route=direct; review=pending; delegate=pending",
    );
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("returns an error check instead of throwing when Kimi is missing", async () => {
    const report = await collectDoctorReport({
      configPath,
      locateKimiExecutable: async () => {
        throw new Error("Kimi Code executable not found");
      },
      locatePiExecutable: async () => "pi.cmd",
      buildPiConfig: async () => ({
        agentDir: "C:\\cache\\pi",
        settingsPath: "C:\\cache\\pi\\settings.json",
        modelsPath: "C:\\cache\\pi\\models.json",
        environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
        contentSha256: "a".repeat(64),
      }),
      runCommand: async () => ({ ok: true, output: "0.80.10" }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "Kimi executable")).toMatchObject({
      ok: false,
      level: "error",
    });
  });

  it("rejects an Ark config whose content no longer matches its generated hash", async () => {
    const report = await collectDoctorReport({
      configPath,
      environment: {
        GEMINI_API_KEY: "gemini",
        ARK_API_KEY: "coding",
        OPENAI_API_KEY_DOUBAO: "agent",
      },
      locateKimiExecutable: async () => "kimi.exe",
      locatePiExecutable: async () => "pi.cmd",
      buildPiConfig: async () => {
        const config = await buildIsolatedPiConfig({
          root: tempDirectory,
          version: "drift-test",
          providers: ["ark"],
        });
        await writeFile(config.modelsPath, '{"providers":{}}\n', "utf8");
        return config;
      },
      runCommand: async () => ({ ok: true, output: "0.80.10" }),
    });

    expect(report.checks.find((check) => check.name === "Ark Pi models")).toMatchObject({
      ok: false,
      level: "error",
      detail: "isolated Pi configuration hash mismatch",
    });
  });

  it("warns when the owned MCP registration is absent", async () => {
    await writeFile(configPath, "[mcp_servers.other]\ncommand = \"x\"\n", "utf8");
    const report = await collectDoctorReport({
      configPath,
      locateKimiExecutable: async () => "kimi.exe",
      runCommand: async () => ({ ok: true, output: "0.27.0" }),
      locatePiExecutable: async () => "pi.cmd",
      buildPiConfig: async () => ({
        agentDir: "C:\\cache\\pi",
        settingsPath: "C:\\cache\\pi\\settings.json",
        modelsPath: "C:\\cache\\pi\\models.json",
        environment: { PI_CODING_AGENT_DIR: "C:\\cache\\pi" },
        contentSha256: "a".repeat(64),
      }),
    });
    expect(report.checks.find((check) => check.name === "MCP registration")).toMatchObject({
      level: "warn",
      ok: false,
    });
  });
});
