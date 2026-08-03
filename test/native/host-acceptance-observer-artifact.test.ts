import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseObserverBuildConfig,
  parseObserverBuildInputsManifest,
} from "../../src/release/release-validation.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const observerRoot = resolve(repositoryRoot, "host-acceptance");
const observerBuildScript = resolve(observerRoot, "build.ps1");
const observerArtifactPath = resolve(
  observerRoot,
  "win32-x64",
  "codex-host-acceptance-observer.exe",
);
const observerManifestPath = resolve(
  observerRoot,
  "observer-build-inputs.v1.json",
);
const windowsIt = it.runIf(
  process.platform === "win32" && process.arch === "x64",
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function repositoryPath(relativePath: string): string {
  return resolve(repositoryRoot, ...relativePath.split("/"));
}

describe("host acceptance observer artifact", () => {
  it("exposes only fixed current-host observer build commands", () => {
    const packageJson = readJson(resolve(repositoryRoot, "package.json")) as {
      scripts: Record<string, string>;
      files: string[];
    };
    expect(packageJson.scripts).toMatchObject({
      "observer:test:managed":
        "node scripts/host-acceptance-observer.mjs test-managed",
      "observer:test:kernel":
        "node scripts/host-acceptance-observer.mjs test-kernel",
      "observer:verify": "node scripts/host-acceptance-observer.mjs verify",
      "observer:update-artifact":
        "node scripts/host-acceptance-observer.mjs update-artifact",
    });
    expect(packageJson.files).not.toContain(
      "host-acceptance/win32-x64/codex-host-acceptance-observer.exe",
    );
    expect(packageJson.files).not.toContain(
      "host-acceptance/observer-build-inputs.v1.json",
    );
  });

  windowsIt("rejects command and argument overrides", () => {
    for (const arguments_ of [[], ["Verify"], ["verify", "extra"]]) {
      const result = spawnSync(
        process.execPath,
        ["scripts/host-acceptance-observer.mjs", ...arguments_],
        { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("host-acceptance: unsupported command\n");
    }
  });

  it("binds the checked-in artifact to the exact strict build-input closure", () => {
    const buildConfigValue = readJson(resolve(observerRoot, "build.config.json"));
    const buildConfig = parseObserverBuildConfig(buildConfigValue);
    const manifestBytes = readFileSync(observerManifestPath);
    expect(manifestBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
      false,
    );
    expect(manifestBytes.toString("utf8")).not.toContain("\r");
    expect(manifestBytes.toString("utf8").endsWith("\n")).toBe(true);

    const manifest = parseObserverBuildInputsManifest(
      JSON.parse(manifestBytes.toString("utf8")),
      buildConfigValue,
    );
    const expectedPaths = [
      "host-acceptance/build.config.json",
      "host-acceptance/build.ps1",
      "host-acceptance/protocol/observer-protocol.v1.json",
      "native/windows-job-helper/build.config.json",
      "native/windows-job-helper/restore-toolchain.ps1",
      "native/windows-job-helper/toolchain.lock.json",
      ...buildConfig.sourcePaths,
    ].sort();
    expect(manifest.inputs.map((input) => input.path)).toEqual(expectedPaths);
    for (const input of manifest.inputs) {
      const metadata = lstatSync(repositoryPath(input.path));
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(input.sha256).toBe(sha256(readFileSync(repositoryPath(input.path))));
    }
    expect(manifest.protocol).toEqual({
      path: "host-acceptance/protocol/observer-protocol.v1.json",
      sha256: sha256(
        readFileSync(
          repositoryPath(
            "host-acceptance/protocol/observer-protocol.v1.json",
          ),
        ),
      ),
    });
    expect(manifest.inputsDigestSha256).toBe(
      sha256(JSON.stringify({ schemaVersion: 1, inputs: manifest.inputs })),
    );
    expect(lstatSync(observerArtifactPath).isFile()).toBe(true);
  });

  windowsIt(
    "rebuilds the observer deterministically and verifies exact checked-in bytes",
    () => {
      const result = spawnSync(
        process.execPath,
        ["scripts/host-acceptance-observer.mjs", "verify"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          windowsHide: true,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(
        /host-acceptance: verified canonical observer sha256=[a-f0-9]{64}\r?\n$/u,
      );
    },
    120_000,
  );
});
