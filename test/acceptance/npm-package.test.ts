import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

import {
  assertDoctorAcceptance,
  assertInstalledPackageContract,
  assertInstalledCapabilityProjection,
  assertNpmRegistryMetadata,
  buildIsolatedNpmEnvironment,
  establishInstalledMcpSession,
  npmAcceptanceReportRelativePath,
  parseNpmPackageAcceptanceArguments,
  PUBLIC_NPM_REGISTRY,
  renderNpmPackageAcceptanceReport,
} from "../../src/acceptance/npm-package.js";
import { DOCTOR_CHECK_NAMES } from "../../src/cli/doctor.js";

const repositoryUrl =
  "git+https://github.com/Yiyuiii/codex-agent-tools.git";

function acceptedDoctorChecks() {
  return DOCTOR_CHECK_NAMES.map((name) => ({
    name,
    ok: true,
    level:
      name === "Windows native helper" && process.platform !== "win32"
        ? "warn"
        : "ok",
    detail:
      name === "Host runtime"
        ? `platform=${process.platform}; arch=${process.arch}; os=${os.release()}; node=${process.versions.node}; libuv=${process.versions.uv}`
        : name === "Windows native helper" && process.platform !== "win32"
          ? `not applicable on ${process.platform}`
          : name === "Public MCP tools"
            ? "external_review, external_delegate"
            : name.startsWith("LLM ")
              ? "route=direct; review=passed; delegate=passed"
              : "fixture",
  }));
}

function packageManifest(version = "0.1.0-beta.1") {
  return {
    name: "codex-agent-tools",
    version,
    repository: { type: "git", url: repositoryUrl },
    homepage: "https://github.com/Yiyuiii/codex-agent-tools#readme",
    bugs: {
      url: "https://github.com/Yiyuiii/codex-agent-tools/issues",
    },
    publishConfig: {
      access: "public",
      registry: PUBLIC_NPM_REGISTRY,
    },
  };
}

describe("npm-installed package acceptance contract", () => {
  it("builds an npm environment that cannot inherit active homes, config, cache, or credentials", () => {
    const environment = buildIsolatedNpmEnvironment({
      sourceEnvironment: {
        PATH: "system-bin",
        HOME: "/active/home",
        USERPROFILE: "C:\\active-home",
        CODEX_HOME: "C:\\active-codex",
        NPM_TOKEN: "real-npm-token",
        NPM_CONFIG_REGISTRY: "https://registry.example.test/",
        ARK_API_KEY: "real-model-key",
      },
      isolatedUserHome: "C:\\temp\\user-home",
      isolatedCodexHome: "C:\\temp\\codex-home",
      isolatedLocalAppData: "C:\\temp\\local-app-data",
      isolatedAppData: "C:\\temp\\app-data",
      temporaryRoot: "C:\\temp",
      npmUserConfig: "C:\\temp\\npm-userconfig",
      npmGlobalConfig: "C:\\temp\\npm-globalconfig",
      npmCache: "C:\\temp\\npm-cache",
    });

    expect(environment).toMatchObject({
      PATH: "system-bin",
      HOME: "C:\\temp\\user-home",
      USERPROFILE: "C:\\temp\\user-home",
      CODEX_HOME: "C:\\temp\\codex-home",
      LOCALAPPDATA: "C:\\temp\\local-app-data",
      APPDATA: "C:\\temp\\app-data",
      TEMP: "C:\\temp",
      TMP: "C:\\temp",
      TMPDIR: "C:\\temp",
      NPM_CONFIG_USERCONFIG: "C:\\temp\\npm-userconfig",
      NPM_CONFIG_GLOBALCONFIG: "C:\\temp\\npm-globalconfig",
      NPM_CONFIG_CACHE: "C:\\temp\\npm-cache",
    });
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("NPM_CONFIG_REGISTRY");
    expect(environment).not.toHaveProperty("ARK_API_KEY");
  });

  it("pins consumer installation to the public npm registry", () => {
    expect(PUBLIC_NPM_REGISTRY).toBe("https://registry.npmjs.org/");
  });

  it("fails closed at the entrypoint before registry access without an exact version", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts", "npm-package-acceptance.mjs")],
      {
        cwd: resolve("."),
        encoding: "utf8",
        windowsHide: true,
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /Invalid npm package acceptance arguments/iu,
    );
  });

  it("accepts one exact semver version and rejects ambiguous arguments", () => {
    expect(
      parseNpmPackageAcceptanceArguments(["--version", "0.1.0-beta.1"]),
    ).toEqual({ version: "0.1.0-beta.1" });
    expect(
      parseNpmPackageAcceptanceArguments(["--version=0.1.0"]),
    ).toEqual({ version: "0.1.0" });

    for (const args of [
      [],
      ["0.1.0-beta.1"],
      ["--version", "latest"],
      ["--version", "0.1.0", "--version", "0.1.1"],
      ["--version", "0.1.0", "--registry", "https://example.invalid"],
    ]) {
      expect(() => parseNpmPackageAcceptanceArguments(args)).toThrow(
        /acceptance arguments/iu,
      );
    }
  });

  it("derives a safe repository-relative evidence path", () => {
    expect(npmAcceptanceReportRelativePath("0.1.0-beta.1")).toBe(
      "docs/release/0.1.0-beta.1-npm-acceptance.md",
    );
    expect(() => npmAcceptanceReportRelativePath("../outside")).toThrow(
      /acceptance arguments/iu,
    );
  });

  it("requires the exact public registry identity and immutable dist metadata", () => {
    expect(
      assertNpmRegistryMetadata(
        {
          version: "0.1.0-beta.1",
          "dist.integrity": "sha512-ZmFrZS1pbnRlZ3JpdHk=",
          "dist.shasum": "0123456789abcdef0123456789abcdef01234567",
          "repository.url": repositoryUrl,
        },
        "0.1.0-beta.1",
      ),
    ).toEqual({
      integrity: "sha512-ZmFrZS1pbnRlZ3JpdHk=",
      shasum: "0123456789abcdef0123456789abcdef01234567",
    });

    for (const drift of [
      { version: "0.1.0-beta.2" },
      { "repository.url": "git+https://github.com/other/repo.git" },
      { "dist.integrity": "sha1-weak" },
      { "dist.shasum": "not-a-sha1" },
    ]) {
      expect(() =>
        assertNpmRegistryMetadata(
          {
            version: "0.1.0-beta.1",
            "dist.integrity": "sha512-ZmFrZS1pbnRlZ3JpdHk=",
            "dist.shasum":
              "0123456789abcdef0123456789abcdef01234567",
            "repository.url": repositoryUrl,
            ...drift,
          },
          "0.1.0-beta.1",
        ),
      ).toThrow(/registry metadata/iu);
    }
  });

  it("binds installed package, runtime, and plugin to the requested version", () => {
    expect(() =>
      assertInstalledPackageContract({
        packageManifest: packageManifest(),
        pluginManifest: {
          name: "codex-external-agents",
          version: "0.1.0-beta.1",
        },
        expectedVersion: "0.1.0-beta.1",
      }),
    ).not.toThrow();

    expect(() =>
      assertInstalledPackageContract({
        packageManifest: packageManifest(),
        pluginManifest: {
          name: "codex-external-agents",
          version: "0.1.0-beta.0",
        },
        expectedVersion: "0.1.0-beta.1",
      }),
    ).toThrow(/installed package contract/iu);
  });

  it("accepts only an all-green doctor report with the four qualified llms", () => {
    const checks = acceptedDoctorChecks();

    expect(() =>
      assertDoctorAcceptance({ ok: true, checks }),
    ).not.toThrow();
    expect(() =>
      assertDoctorAcceptance({
        ok: true,
        checks: checks.filter(({ name }) => name !== "LLM kimi-k3"),
      }),
    ).toThrow(/doctor acceptance/iu);
    expect(() =>
      assertDoctorAcceptance({
        ok: false,
        checks: checks.map((check) =>
          check.name === "Ark Pi models"
            ? { ...check, ok: false, level: "error" }
            : check,
        ),
      }),
    ).toThrow(/doctor acceptance/iu);

    const mismatchedPlatform = process.platform === "linux" ? "darwin" : "linux";
    expect(() =>
      assertDoctorAcceptance({
        ok: true,
        checks: checks.map((check) =>
          check.name === "Host runtime"
            ? {
                ...check,
                detail: `platform=${mismatchedPlatform}; arch=${process.arch}; os=${os.release()}; node=${process.versions.node}; libuv=${process.versions.uv}`,
              }
            : check.name === "Windows native helper"
              ? {
                  ...check,
                  level: "warn",
                  detail: `not applicable on ${mismatchedPlatform}`,
                }
            : check,
        ),
      }),
    ).toThrow(/doctor acceptance/iu);

    if (process.platform === "win32") {
      expect(() =>
        assertDoctorAcceptance({
          ok: true,
          checks: checks.map((check) =>
            check.name === "Windows native helper"
              ? {
                  ...check,
                  level: "warn",
                  detail: "not applicable on linux",
                }
              : check,
          ),
        }),
      ).toThrow(/doctor acceptance/iu);
    } else {
      expect(
        checks.find(({ name }) => name === "Windows native helper"),
      ).toMatchObject({
        ok: true,
        level: "warn",
        detail: `not applicable on ${process.platform}`,
      });
    }
  });

  it("verifies the installed capability index and its exact evidence projection", async () => {
    const digest = (content: Buffer) =>
      createHash("sha256").update(content).digest("hex");
    const batchEvidencePath =
      "docs/smoke/evidence/batches/current/cases/review.json";
    const manifestPath =
      "docs/smoke/evidence/batches/current/manifest.json";
    const legacyPath = "docs/smoke/evidence/legacy.json";
    const batchEvidence = Buffer.from('{"passed":true}\n');
    const legacyEvidence = Buffer.from('{"passed":true}\n');
    const manifest = Buffer.from(
      `${JSON.stringify({
        cases: [
          {
            llm: "ark-coding-plan",
            task: "review",
            result: "passed",
            evidence: {
              path: batchEvidencePath,
              sha256: digest(batchEvidence),
            },
          },
        ],
      })}\n`,
    );
    const index = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            llm: "ark-coding-plan",
            task: "review",
            source: {
              kind: "batch-case",
              manifestPath,
              manifestSha256: digest(manifest),
              evidencePath: batchEvidencePath,
              evidenceSha256: digest(batchEvidence),
            },
          },
          {
            llm: "ark-agent-deepseek-v4-flash",
            task: "delegate",
            source: {
              kind: "legacy-standalone",
              evidencePath: legacyPath,
              evidenceSha256: digest(legacyEvidence),
            },
          },
        ],
      })}\n`,
    );
    const files = new Map<string, Buffer>([
      [manifestPath, manifest],
      [batchEvidencePath, batchEvidence],
      [legacyPath, legacyEvidence],
    ]);
    const readInstalledFile = async (relativePath: string) => {
      const content = files.get(relativePath);
      if (content === undefined) throw new Error("missing fixture");
      return content;
    };

    await expect(
      assertInstalledCapabilityProjection({
        repositoryIndex: index,
        installedIndex: index,
        readInstalledFile,
      }),
    ).resolves.toEqual({
      sourcePaths: [legacyPath, manifestPath, batchEvidencePath].sort(),
    });
    await expect(
      assertInstalledCapabilityProjection({
        repositoryIndex: index,
        installedIndex: Buffer.from(index.toString("utf8") + " "),
        readInstalledFile,
      }),
    ).rejects.toThrow(/Installed capability projection is invalid/u);

    files.set(batchEvidencePath, Buffer.from('{"passed":false}\n'));
    await expect(
      assertInstalledCapabilityProjection({
        repositoryIndex: index,
        installedIndex: index,
        readInstalledFile,
      }),
    ).rejects.toThrow(/Installed capability projection is invalid/u);
  });

  it("proves only owned cleanup and ships the current-host native helper", () => {
    const entrypoint = readFileSync(
      resolve("scripts", "npm-package-acceptance.mjs"),
      "utf8",
    );

    expect(entrypoint).not.toMatch(
      /classifyAgentProcesses|assertNoAgentProcesses|tasklist|Get-CimInstance|Win32_Process|\bpgrep\b/u,
    );
    expect(entrypoint).toContain("cleanupOwnedMcpTransport");
    expect(entrypoint).toContain("assertNoQualificationLocks");
    expect(entrypoint).toContain("codex-agent-job-helper.exe");
    expect(entrypoint).toContain("codex-agent-job-helper.exe.sha256");
  });

  it("cleans up an owned MCP transport when connect or tool validation fails", async () => {
    const transport = { id: "owned" };
    const cleanup = vi.fn(async () => undefined);
    const connectFailure = new Error("connect failed");

    await expect(
      establishInstalledMcpSession({
        client: {
          connect: vi.fn(async () => {
            throw connectFailure;
          }),
          listTools: vi.fn(),
        },
        transport,
        cleanup,
      }),
    ).rejects.toBe(connectFailure);
    expect(cleanup).toHaveBeenCalledOnce();

    cleanup.mockClear();
    await expect(
      establishInstalledMcpSession({
        client: {
          connect: vi.fn(async () => undefined),
          listTools: vi.fn(async () => ({ tools: [] })),
        },
        transport,
        cleanup,
      }),
    ).rejects.toThrow(/Unexpected MCP tools/iu);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("accepts exactly the installed public tools and safety annotations", async () => {
    const transport = { id: "owned" };
    const client = {
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: "external_review",
            inputSchema: { required: ["llm", "prompt", "cwd", "task"] },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
            },
          },
          {
            name: "external_delegate",
            inputSchema: { required: ["llm", "prompt", "cwd"] },
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
            },
          },
        ],
      })),
    };

    await expect(
      establishInstalledMcpSession({
        client,
        transport,
        cleanup: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({ client, transport });
  });

  it("renders a redacted, machine-readable beta acceptance record", () => {
    const report = renderNpmPackageAcceptanceReport({
      version: "0.1.0-beta.1",
      observedAt: "2026-07-29T11:00:00.000Z",
      integrity: "sha512-ZmFrZS1pbnRlZ3JpdHk=",
      shasum: "0123456789abcdef0123456789abcdef01234567",
      nodeVersion: "v24.14.1",
      npmVersion: "11.11.0",
    });

    for (const marker of [
      "Doctor: pass",
      "Local-Npm-Smoke: pass",
      "MCP-Smoke: pass",
      "Plugin-Isolated: pass",
      "Capability-Index: pass",
      "Owned-MCP-Cleanup: pass",
      "真实模型调用：`0`",
    ]) {
      expect(report).toContain(marker);
    }
    expect(report).not.toContain("C:\\");
    expect(report).not.toContain("CODEX_HOME=");
  });
});
