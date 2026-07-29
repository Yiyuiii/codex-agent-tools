import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectDoctorReport } from "../../src/cli/doctor.js";
import { buildIsolatedPiConfig } from "../../src/adapters/pi/config.js";

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-agent-doctor-"));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe("doctor diagnostics", () => {
  it("reports external runtimes, fixed routes, tools, and qualified gates without secrets", async () => {
    const secret = "must-not-appear";
    const report = await collectDoctorReport({
      environment: {
        PATH: "x",
        SOME_SECRET: secret,
        API_KEY_DOUBAO_CODING: "local-ark-coding-secret",
        OPENAI_API_KEY_DOUBAO: "agent-ark-secret",
      },
      locateKimiExecutable: async () =>
        "C:\\Users\\test\\.kimi-code\\bin\\kimi.exe",
      runCommand: async (command, args) => {
        if (args.includes("--list-models")) {
          return {
            ok: true,
            output: [
              "pi 0.80.10",
              "provider model context max-output reasoning images",
              "ark-agent-plan ark-code-latest 200K 32K yes no",
              "ark-agent-plan deepseek-v4-flash 200K 32K yes no",
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
          version: "0.1.0-beta.0",
          providers: ["ark"],
        }),
    });

    expect(report.checks.find((check) => check.name === "Kimi executable")).toMatchObject({
      level: "ok",
      detail: "C:\\Users\\test\\.kimi-code\\bin\\kimi.exe",
    });
    expect(report.checks.find((check) => check.name === "Kimi version")?.detail).toContain("0.27.0");
    expect(report.checks.find((check) => check.name === "MCP registration")).toBeUndefined();
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
      path.join(tempDirectory, "pi", "0.1.0-beta.0"),
    );
    expect(report.checks.find((check) => check.name === "Ark Pi models")).toMatchObject({
      ok: true,
      level: "ok",
    });
    expect(report.checks.find((check) => check.name === "Ark Pi models")?.detail).toContain(
      "ark.cn-beijing.volces.com; models=3; sha256=",
    );
    expect(report.checks.some(({ name }) => /Gemini/u.test(name))).toBe(false);
    expect(report.checks.find((check) => check.name === "Ark Coding authentication")?.detail).toBe(
      "credential environment: API_KEY_DOUBAO_CODING -> CODEX_AGENT_ARK_CODING_KEY",
    );
    expect(report.checks.find((check) => check.name === "Ark Agent authentication")?.detail).toBe(
      "credential environment: OPENAI_API_KEY_DOUBAO -> CODEX_AGENT_ARK_AGENT_KEY",
    );
    expect(
      report.checks.filter((check) => check.name.startsWith("LLM ")),
    ).toHaveLength(4);
    expect(
      report.checks.find((check) => check.name === "LLM ark-coding-plan"),
    ).toMatchObject({
      ok: true,
      level: "ok",
      detail:
        "ark-code-latest via pi-rpc; route=direct; review=passed; delegate=passed",
    });
    expect(
      report.checks.find((check) => check.name === "LLM ark-agent-plan"),
    ).toMatchObject({
      ok: true,
      level: "ok",
      detail:
        "ark-code-latest via pi-rpc; route=direct; review=passed; delegate=passed",
    });
    expect(
      report.checks.find(
        (check) => check.name === "LLM ark-agent-deepseek-v4-flash",
      ),
    ).toMatchObject({
      ok: true,
      level: "ok",
      detail:
        "deepseek-v4-flash via pi-rpc; route=direct; review=passed; delegate=passed",
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("rejects an Ark model listing that contains an extra provider/model", async () => {
    const report = await collectDoctorReport({
      environment: {
        ARK_API_KEY: "coding",
        OPENAI_API_KEY_DOUBAO: "agent",
      },
      locateKimiExecutable: async () => "kimi.exe",
      locatePiExecutable: async () => "pi.cmd",
      buildPiConfig: () =>
        buildIsolatedPiConfig({
          root: tempDirectory,
          version: "rogue-listing",
          providers: ["ark"],
        }),
      runCommand: async (_command, args) => ({
        ok: true,
        output: args.includes("--list-models")
          ? [
              "pi 0.80.10",
              "provider model context max-output reasoning images",
              "ark-agent-plan ark-code-latest 200K 32K yes no",
              "ark-agent-plan deepseek-v4-flash 200K 32K yes no",
              "ark-coding-plan ark-code-latest 200K 32K yes no",
              "ark-rogue rogue-model 200K 32K yes no",
            ].join("\n")
          : "0.80.10",
      }),
    });

    expect(
      report.checks.find((check) => check.name === "Ark Pi models"),
    ).toMatchObject({
      ok: false,
      level: "error",
      detail: "Pi model listing does not match the approved Ark model set",
    });
  });

  it("returns an error check instead of throwing when Kimi is missing", async () => {
    const report = await collectDoctorReport({
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
      environment: {
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

  it("does not inspect Codex config even when the dependency environment defines CODEX_HOME", async () => {
    const codexHome = path.join(tempDirectory, "codex-home-must-not-be-read");
    await writeFile(codexHome, "not a directory", "utf8");

    const report = await collectDoctorReport({
      environment: { CODEX_HOME: codexHome },
      locateKimiExecutable: async () => {
        throw new Error("not needed");
      },
      locatePiExecutable: async () => {
        throw new Error("not needed");
      },
      buildPiConfig: async () => {
        throw new Error("not needed");
      },
    });

    expect(report.checks.find((check) => check.name === "MCP registration")).toBeUndefined();
    expect(report.checks.find((check) => check.name === "Public MCP tools")?.detail).toBe(
      "external_review, external_delegate",
    );
  });
});
