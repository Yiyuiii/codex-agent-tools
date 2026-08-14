import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildIsolatedPiConfig } from "../../src/adapters/pi/config.js";
import type { PiInvocation } from "../../src/adapters/pi/locator.js";
import {
  collectDoctorReport,
  DOCTOR_CHECK_NAMES,
  type CollectDoctorOptions,
  type WindowsJobHelperProbeRequest,
} from "../../src/cli/doctor.js";

let tempDirectory: string;

interface PiModelsDocument {
  providers: Record<
    string,
    {
      api: string;
      apiKey: string;
      baseUrl: string;
      models: Array<{ id: string }>;
    }
  >;
}

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-agent-doctor-"));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

function windowsOptions(
  overrides: Partial<CollectDoctorOptions> = {},
): CollectDoctorOptions {
  return {
    environment: {
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      OPENAI_API_KEY_DEEPSEEK: "deepseek-secret",
    },
    platform: "win32",
    architecture: "x64",
    osRelease: () => "10.0.26100",
    nodeVersion: "24.14.1",
    libuvVersion: "1.51.0",
    locatePiInvocation: async () => ({
      executable: process.execPath,
      argvPrefix: [
        "C:\\Users\\fixture\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
      ],
      identity: {
        packageName: "@earendil-works/pi-coding-agent",
        packageVersion: "0.80.10",
        nodeEngine: ">=24.0.0",
      },
    }),
    buildPiConfig: (options) =>
      buildIsolatedPiConfig({ ...options, root: tempDirectory }),
    resolveWindowsJobHelper: async () => ({
      executablePath:
        "C:\\package\\plugins\\codex-external-agents\\native\\win32-x64\\codex-agent-job-helper.exe",
      sha256: "a".repeat(64),
    }),
    runWindowsJobHelperProbe: async () => ({ ok: true, output: "" }),
    ...overrides,
  };
}

describe("DeepSeek-only doctor diagnostics", () => {
  it("checks only the fixed Direct DeepSeek route and one targetless helper probe", async () => {
    const secret = "must-not-appear";
    const locatePiInvocation = vi.fn(async (): Promise<PiInvocation> => ({
      executable: process.execPath,
      argvPrefix: [
        "C:\\Users\\private-user\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
      ] as const,
      identity: {
        packageName: "@earendil-works/pi-coding-agent",
        packageVersion: "0.80.10",
        nodeEngine: ">=24.0.0",
      },
    }));
    const runWindowsJobHelperProbe = vi.fn(
      async (_request: WindowsJobHelperProbeRequest) => ({
        ok: true,
        output: "",
      }),
    );

    const report = await collectDoctorReport(
      windowsOptions({
        environment: {
          path: "C:\\Windows\\System32",
          systemroot: "C:\\Windows",
          SOME_SECRET: secret,
          openai_api_key_deepseek: "direct-deepseek-secret",
        },
        locatePiInvocation,
        runWindowsJobHelperProbe,
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.checks.map(({ name }) => name)).toEqual(DOCTOR_CHECK_NAMES);
    expect(locatePiInvocation).toHaveBeenCalledOnce();
    expect(runWindowsJobHelperProbe).toHaveBeenCalledWith({
      executablePath:
        "C:\\package\\plugins\\codex-external-agents\\native\\win32-x64\\codex-agent-job-helper.exe",
      args: ["--probe-v1"],
      environment: {
        PATH: "C:\\Windows\\System32",
        SYSTEMROOT: "C:\\Windows",
      },
      extendEnv: false,
    });
    expect(
      report.checks.find(({ name }) => name === "Pi models")?.detail,
    ).toBe("static route passed; providers=1; models=1");
    expect(
      report.checks.find(({ name }) => name === "Public MCP tools")?.detail,
    ).toBe("external_review, external_delegate");
    expect(
      report.checks.filter(({ name }) => name.startsWith("LLM ")),
    ).toEqual([
      expect.objectContaining({
        name: "LLM deepseek-v4-flash",
        ok: true,
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("private-user");
  });

  it("reports POSIX native support as the sole warning", async () => {
    const locatePiExecutable = vi.fn(async () => "/usr/local/bin/pi");
    const report = await collectDoctorReport({
      environment: { OPENAI_API_KEY_DEEPSEEK: "deepseek" },
      platform: "linux",
      architecture: "arm64",
      osRelease: () => "6.8.0",
      nodeVersion: "24.14.1",
      libuvVersion: "1.51.0",
      locatePiExecutable,
      buildPiConfig: (options) =>
        buildIsolatedPiConfig({ ...options, root: tempDirectory }),
      resolveWindowsJobHelper: async () => {
        throw new Error("must not resolve on POSIX");
      },
      runWindowsJobHelperProbe: async () => {
        throw new Error("must not probe on POSIX");
      },
    });

    expect(report.ok).toBe(true);
    expect(locatePiExecutable).toHaveBeenCalledOnce();
    expect(report.checks.filter(({ level }) => level === "warn")).toEqual([
      {
        name: "Windows native helper",
        ok: true,
        level: "warn",
        detail: "not applicable on linux",
      },
    ]);
  });

  it("fails closed for an unsupported Windows host", async () => {
    const resolveWindowsJobHelper = vi.fn(async () => ({
      executablePath: "helper.exe",
      sha256: "a".repeat(64),
    }));
    const report = await collectDoctorReport(
      windowsOptions({
        architecture: "arm64",
        nodeVersion: "23.11.0",
        resolveWindowsJobHelper,
      }),
    );
    expect(report.ok).toBe(false);
    expect(
      report.checks.find(({ name }) => name === "Host runtime"),
    ).toMatchObject({ ok: false, level: "error" });
    expect(resolveWindowsJobHelper).not.toHaveBeenCalled();
  });

  it("redacts helper probe failures", async () => {
    const secret = "helper-super-secret";
    const report = await collectDoctorReport(
      windowsOptions({
        environment: {
          OPENAI_API_KEY_DEEPSEEK: "deepseek",
          HELPER_AUTH_TOKEN: secret,
        },
        runWindowsJobHelperProbe: async () => ({
          ok: false,
          output: secret,
        }),
      }),
    );
    const helper = report.checks.find(
      ({ name }) => name === "Windows native helper",
    );
    expect(helper).toMatchObject({
      ok: false,
      level: "error",
      detail: "Windows job helper probe failed",
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("rejects a DeepSeek config whose content no longer matches its hash", async () => {
    const report = await collectDoctorReport(
      windowsOptions({
        buildPiConfig: async (options) => {
          const config = await buildIsolatedPiConfig({
            ...options,
            root: tempDirectory,
          });
          await writeFile(config.modelsPath, '{"providers":{}}\n', "utf8");
          return config;
        },
      }),
    );
    expect(
      report.checks.find(({ name }) => name === "Pi models"),
    ).toMatchObject({
      ok: false,
      level: "error",
      detail: "isolated Pi configuration hash mismatch",
    });
  });

  it.each([
    ["endpoint", (models: PiModelsDocument) => {
      models.providers.deepseek!.baseUrl = "https://example.invalid/v1";
    }],
    ["protocol", (models: PiModelsDocument) => {
      models.providers.deepseek!.api = "openai-responses";
    }],
    ["credential target", (models: PiModelsDocument) => {
      models.providers.deepseek!.apiKey = "$WRONG_KEY";
    }],
    ["model set", (models: PiModelsDocument) => {
      models.providers.deepseek!.models.push({ id: "deepseek-chat" });
    }],
    ["provider set", (models: PiModelsDocument) => {
      models.providers.rogue = {
        api: "openai-completions",
        apiKey: "$CODEX_AGENT_DEEPSEEK_KEY",
        baseUrl: "https://api.deepseek.com",
        models: [{ id: "deepseek-v4-flash" }],
      };
    }],
  ] as const)("rejects hash-consistent DeepSeek %s drift", async (_name, mutate) => {
    const report = await collectDoctorReport(
      windowsOptions({
        buildPiConfig: async (options) => {
          const config = await buildIsolatedPiConfig({
            ...options,
            root: tempDirectory,
          });
          const models = JSON.parse(
            await readFile(config.modelsPath, "utf8"),
          ) as PiModelsDocument;
          mutate(models);
          const modelsText = `${JSON.stringify(models, null, 2)}\n`;
          await writeFile(config.modelsPath, modelsText, "utf8");
          const settingsText = await readFile(config.settingsPath, "utf8");
          return {
            ...config,
            contentSha256: createHash("sha256")
              .update(settingsText)
              .update("\0")
              .update(modelsText)
              .digest("hex"),
          };
        },
      }),
    );
    expect(
      report.checks.find(({ name }) => name === "Pi models"),
    ).toMatchObject({ ok: false, level: "error" });
  });

  it("returns an error check when Pi is missing", async () => {
    const report = await collectDoctorReport(
      windowsOptions({
        locatePiInvocation: async () => {
          throw new Error("Pi executable not found");
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(
      report.checks.find(({ name }) => name === "Pi executable"),
    ).toMatchObject({ ok: false, level: "error" });
  });
});
