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
      API_KEY_DOUBAO_CODING: "coding-secret",
      OPENAI_API_KEY_DOUBAO: "agent-secret",
      OPENAI_API_KEY_DEEPSEEK: "deepseek-secret",
    },
    platform: "win32",
    architecture: "x64",
    osRelease: () => "10.0.26100",
    nodeVersion: "24.14.1",
    libuvVersion: "1.51.0",
    locateKimiExecutable: async () =>
      "C:\\Users\\fixture\\.kimi-code\\bin\\kimi.exe",
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
      buildIsolatedPiConfig({
        ...options,
        root: tempDirectory,
      }),
    resolveWindowsJobHelper: async () => ({
      executablePath:
        "C:\\package\\plugins\\codex-external-agents\\native\\win32-x64\\codex-agent-job-helper.exe",
      sha256: "a".repeat(64),
    }),
    runWindowsJobHelperProbe: async () => ({ ok: true, output: "" }),
    ...overrides,
  };
}

describe("doctor diagnostics", () => {
  it("performs only static target checks and one targetless Windows helper probe", async () => {
    const secret = "must-not-appear";
    const locateKimiExecutable = vi.fn(
      async () => "C:\\Users\\private-user\\.kimi-code\\bin\\kimi.exe",
    );
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
          api_key_doubao_coding: "local-ark-coding-secret",
          OpenAI_API_KEY_DOUBAO: "agent-ark-secret",
          openai_api_key_deepseek: "direct-deepseek-secret",
        },
        locateKimiExecutable,
        locatePiInvocation,
        runWindowsJobHelperProbe,
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.checks.map(({ name }) => name)).toEqual(DOCTOR_CHECK_NAMES);
    expect(locateKimiExecutable).toHaveBeenCalledOnce();
    expect(locatePiInvocation).toHaveBeenCalledOnce();
    expect(runWindowsJobHelperProbe).toHaveBeenCalledOnce();
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
      Object.keys(runWindowsJobHelperProbe.mock.calls[0]![0].environment),
    ).not.toContain(expect.stringMatching(/key|token|secret|password|auth/iu));

    expect(
      report.checks.find(({ name }) => name === "Host runtime"),
    ).toMatchObject({
      ok: true,
      level: "ok",
      detail:
        "platform=win32; arch=x64; os=10.0.26100; node=24.14.1; libuv=1.51.0",
    });
    expect(
      report.checks.find(({ name }) => name === "Kimi executable")?.detail,
    ).toBe("strict locator passed; executable=kimi.exe");
    expect(
      report.checks.find(({ name }) => name === "Pi executable")?.detail,
    ).toBe(
      "strict locator passed; package=@earendil-works/pi-coding-agent@0.80.10; node=>=24.0.0",
    );
    expect(
      report.checks.find(({ name }) => name === "Pi models"),
    ).toMatchObject({ ok: true, level: "ok" });
    expect(
      report.checks.find(({ name }) => name === "Windows native helper"),
    ).toMatchObject({
      ok: true,
      level: "ok",
      detail: `managed-x64; sha256=${"a".repeat(12)}; probe-v1=passed`,
    });
    expect(
      report.checks.find(({ name }) => name === "Public MCP tools")?.detail,
    ).toBe("external_review, external_delegate");
    expect(
      report.checks.filter(({ name }) => name.startsWith("LLM ")),
    ).toHaveLength(5);
    expect(
      report.checks.some(({ name }) =>
        ["Kimi version", "Kimi authentication", "Pi version"].includes(name),
      ),
    ).toBe(false);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("private-user");
  });

  it("reports POSIX native support as the sole not-applicable warning without probing it", async () => {
    const resolveWindowsJobHelper = vi.fn(async () => {
      throw new Error("must not resolve on POSIX");
    });
    const runWindowsJobHelperProbe = vi.fn(async () => {
      throw new Error("must not probe on POSIX");
    });
    const locatePiExecutable = vi.fn(async () => "/usr/local/bin/pi");

    const report = await collectDoctorReport({
      environment: {
        ARK_API_KEY: "coding",
        OPENAI_API_KEY_DOUBAO: "agent",
        OPENAI_API_KEY_DEEPSEEK: "deepseek",
      },
      platform: "linux",
      architecture: "arm64",
      osRelease: () => "6.8.0",
      nodeVersion: "24.14.1",
      libuvVersion: "1.51.0",
      locateKimiExecutable: async () => "/usr/local/bin/kimi",
      locatePiExecutable,
      locatePiInvocation: async () => {
        throw new Error("must not use Windows invocation on POSIX");
      },
      buildPiConfig: (options) =>
        buildIsolatedPiConfig({
          ...options,
          root: tempDirectory,
        }),
      resolveWindowsJobHelper,
      runWindowsJobHelperProbe,
    });

    expect(report.ok).toBe(true);
    expect(locatePiExecutable).toHaveBeenCalledOnce();
    expect(resolveWindowsJobHelper).not.toHaveBeenCalled();
    expect(runWindowsJobHelperProbe).not.toHaveBeenCalled();
    expect(
      report.checks.find(({ name }) => name === "Windows native helper"),
    ).toEqual({
      name: "Windows native helper",
      ok: true,
      level: "warn",
      detail: "not applicable on linux",
    });
    expect(report.checks.filter(({ level }) => level === "warn")).toHaveLength(
      2,
    );
  });

  it("fails closed for an unsupported Windows host before resolving the helper", async () => {
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
    expect(
      report.checks.find(({ name }) => name === "Windows native helper"),
    ).toMatchObject({ ok: false, level: "error" });
    expect(resolveWindowsJobHelper).not.toHaveBeenCalled();
  });

  it("redacts and bounds helper validation or probe failures", async () => {
    const secret = "helper-super-secret";
    const report = await collectDoctorReport(
      windowsOptions({
        environment: {
          ARK_API_KEY: "coding",
          OPENAI_API_KEY_DOUBAO: "agent",
          OPENAI_API_KEY_DEEPSEEK: "deepseek",
          HELPER_AUTH_TOKEN: secret,
        },
        runWindowsJobHelperProbe: async () => ({
          ok: false,
          output: `${secret}:${"x".repeat(2_000)}`,
        }),
      }),
    );

    const helper = report.checks.find(
      ({ name }) => name === "Windows native helper",
    );
    expect(helper).toMatchObject({ ok: false, level: "error" });
    expect(helper?.detail).not.toContain(secret);
    expect(helper?.detail).not.toContain("C:\\package");
    expect(helper?.detail).toBe("Windows job helper probe failed");
  });

  it("rejects a Pi config whose content no longer matches its generated hash", async () => {
    const report = await collectDoctorReport(
      windowsOptions({
        buildPiConfig: async (options) => {
          const config = await buildIsolatedPiConfig({
            ...options,
            root: tempDirectory,
          });
          if (options.providers[0] === "deepseek") {
            await writeFile(config.modelsPath, '{"providers":{}}\n', "utf8");
          }
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
    [
      "endpoint",
      (models: PiModelsDocument) => {
        models.providers["ark-coding-plan"]!.baseUrl =
          "https://example.invalid/coding";
      },
    ],
    [
      "protocol",
      (models: PiModelsDocument) => {
        models.providers["ark-coding-plan"]!.api = "openai-responses";
      },
    ],
    [
      "credential target",
      (models: PiModelsDocument) => {
        models.providers["ark-agent-plan"]!.apiKey = "$WRONG_KEY";
      },
    ],
    [
      "provider set",
      (models: PiModelsDocument) => {
        models.providers["ark-rogue"] = {
          api: "anthropic-messages",
          apiKey: "$CODEX_AGENT_ARK_CODING_KEY",
          baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
          models: [{ id: "ark-code-latest" }],
        };
      },
    ],
    [
      "model set",
      (models: PiModelsDocument) => {
        models.providers["ark-agent-plan"]!.models.push({ id: "rogue-model" });
      },
    ],
    [
      "DeepSeek endpoint",
      (models: PiModelsDocument) => {
        models.providers.deepseek!.baseUrl = "https://example.invalid/v1";
      },
    ],
    [
      "DeepSeek model set",
      (models: PiModelsDocument) => {
        models.providers.deepseek!.models.push({ id: "deepseek-chat" });
      },
    ],
  ])("rejects hash-consistent Pi %s drift", async (name, mutate) => {
    const targetProviderSet = name.startsWith("DeepSeek") ? "deepseek" : "ark";
    const report = await collectDoctorReport(
      windowsOptions({
        buildPiConfig: async (options) => {
          const config = await buildIsolatedPiConfig({
            ...options,
            root: tempDirectory,
          });
          if (options.providers[0] !== targetProviderSet) return config;
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

  it("returns an error check instead of throwing when a static locator is missing", async () => {
    const report = await collectDoctorReport(
      windowsOptions({
        locateKimiExecutable: async () => {
          throw new Error("Kimi Code executable not found");
        },
      }),
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find(({ name }) => name === "Kimi executable"),
    ).toMatchObject({ ok: false, level: "error" });
  });
});
