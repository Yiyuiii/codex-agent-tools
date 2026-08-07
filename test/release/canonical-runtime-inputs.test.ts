import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CANONICAL_RUNTIME_TYPESCRIPT_WRAPPER_PATHS,
  collectCanonicalRuntimeInputIdentity,
  collectCanonicalRuntimeInputManifest,
  digestCanonicalRuntimeInputManifest,
  serializeCanonicalRuntimeInputManifest,
} from "../../src/release/canonical-runtime-inputs.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const temporaryRoots: string[] = [];
const nativeRoot = "native/windows-job-helper";
const helperRoot =
  "plugins/codex-external-agents/native/win32-x64";
const helperName = "codex-agent-job-helper.exe";

const serializeUnknown = serializeCanonicalRuntimeInputManifest as (
  value: unknown,
) => string;
const digestUnknown = digestCanonicalRuntimeInputManifest as (
  value: unknown,
) => string;

interface FixtureSourceSets {
  production: string[];
  preflight: string[];
  managedTests: string[];
  kernelTests: string[];
  fixtures: string[];
}

async function copyRepositoryFile(
  targetRoot: string,
  relativePath: string,
): Promise<void> {
  const destination = path.join(targetRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(repositoryRoot, relativePath), destination);
}

async function fixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "canonical-runtime-inputs-")),
  );
  temporaryRoots.push(root);
  const buildConfig = JSON.parse(
    await readFile(
      path.join(repositoryRoot, nativeRoot, "build.config.json"),
      "utf8",
    ),
  ) as { sourceSets: { production: string[] } };
  for (const relativePath of [
    `${nativeRoot}/build.config.json`,
    `${nativeRoot}/protocol.v1.json`,
    ...buildConfig.sourceSets.production.map(
      (entry) => `${nativeRoot}/${entry}`,
    ),
    ...CANONICAL_RUNTIME_TYPESCRIPT_WRAPPER_PATHS,
    `${helperRoot}/${helperName}`,
    `${helperRoot}/${helperName}.sha256`,
  ]) {
    await copyRepositoryFile(root, relativePath);
  }
  return root;
}

async function readBuildConfig(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(root, nativeRoot, "build.config.json"), "utf8"),
  ) as Record<string, unknown>;
}

async function writeBuildConfig(
  root: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    path.join(root, nativeRoot, "build.config.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function sourceSets(config: Record<string, unknown>): FixtureSourceSets {
  return config.sourceSets as FixtureSourceSets;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("canonical runtime input identity", () => {
  it("derives production sources once and is deterministic across source order and EOLs", async () => {
    const root = await fixture();
    const first = await collectCanonicalRuntimeInputIdentity(root);
    const config = await readBuildConfig(root);
    sourceSets(config).production.reverse();
    await writeBuildConfig(root, config);
    const sourcePath = path.join(
      root,
      nativeRoot,
      sourceSets(config).production[0]!,
    );
    await writeFile(
      sourcePath,
      (await readFile(sourcePath, "utf8")).replaceAll("\n", "\r\n"),
      "utf8",
    );
    const wrapperPath = path.join(
      root,
      CANONICAL_RUNTIME_TYPESCRIPT_WRAPPER_PATHS[0],
    );
    await writeFile(
      wrapperPath,
      (await readFile(wrapperPath, "utf8")).replaceAll("\n", "\r\n"),
      "utf8",
    );

    const second = await collectCanonicalRuntimeInputIdentity(root);
    expect(second).toEqual(first);
    expect(first.manifest.schemaVersion).toBe(1);
    expect(first.manifest.nativeSources).toHaveLength(9);
    expect(first.manifest.nativeSources.map((entry) => entry.path)).toEqual(
      [...first.manifest.nativeSources.map((entry) => entry.path)].sort(),
    );
    expect(first.serialized.endsWith("\n")).toBe(false);
    expect(first.digestSha256).toBe(
      createHash("sha256").update(first.serialized).digest("hex"),
    );
  });

  it("ignores non-production native, tooling, documentation, CI, marker, and POSIX inputs", async () => {
    const root = await fixture();
    const before = await collectCanonicalRuntimeInputIdentity(root);
    const config = await readBuildConfig(root);
    sourceSets(config).preflight = ["changed/preflight.cs"];
    sourceSets(config).managedTests = ["changed/managed.cs"];
    sourceSets(config).kernelTests = ["changed/kernel.cs"];
    sourceSets(config).fixtures = ["changed/fixture.cs"];
    config.output = { ignored: true };
    await writeBuildConfig(root, config);
    for (const relativePath of [
      `${nativeRoot}/src/Fd3Preflight.cs`,
      `${nativeRoot}/tests/ManagedTests.cs`,
      `${nativeRoot}/fixtures/Fixture.cs`,
      `${nativeRoot}/generated/ProtocolV1.g.cs`,
      `${nativeRoot}/build.ps1`,
      "src/runtime/posix-owned-agent-process.ts",
      "docs/evidence.json",
      ".github/workflows/release.yml",
      ".release-validation/v0.0.0.json",
    ]) {
      const absolute = path.join(root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, "excluded change\n", "utf8");
    }

    await expect(collectCanonicalRuntimeInputIdentity(root)).resolves.toEqual(
      before,
    );
  });

  it("changes when a production source or the actual helper bytes change", async () => {
    const sourceRoot = await fixture();
    const helperRootFixture = await fixture();
    const baseline = await collectCanonicalRuntimeInputIdentity(sourceRoot);
    const sourceConfig = await readBuildConfig(sourceRoot);
    const productionPath = path.join(
      sourceRoot,
      nativeRoot,
      sourceSets(sourceConfig).production[0]!,
    );
    await writeFile(
      productionPath,
      `${await readFile(productionPath, "utf8")}\n// production change\n`,
      "utf8",
    );
    expect(
      (await collectCanonicalRuntimeInputIdentity(sourceRoot)).digestSha256,
    ).not.toBe(baseline.digestSha256);

    const helperPath = path.join(
      helperRootFixture,
      helperRoot,
      helperName,
    );
    const helperBytes = await readFile(helperPath);
    helperBytes[helperBytes.length - 1] =
      (helperBytes[helperBytes.length - 1] ?? 0) ^ 1;
    await writeFile(helperPath, helperBytes);
    const helperDigest = createHash("sha256")
      .update(helperBytes)
      .digest("hex");
    await writeFile(
      `${helperPath}.sha256`,
      `${helperDigest}  ${helperName}\n`,
      "utf8",
    );
    expect(
      (await collectCanonicalRuntimeInputIdentity(helperRootFixture))
        .digestSha256,
    ).not.toBe(baseline.digestSha256);
  });

  it("binds the generated protocol constants contract but not the generated file bytes", async () => {
    const root = await fixture();
    const baseline = await collectCanonicalRuntimeInputIdentity(root);
    const generatedPath = path.join(
      root,
      nativeRoot,
      "generated/ProtocolV1.g.cs",
    );
    await mkdir(path.dirname(generatedPath), { recursive: true });
    await writeFile(generatedPath, "excluded generated bytes\n", "utf8");
    await expect(collectCanonicalRuntimeInputIdentity(root)).resolves.toEqual(
      baseline,
    );

    const config = await readBuildConfig(root);
    config.generatedProtocolConstants = {
      relativePath: "generated/ProtocolV1.g.cs",
      sha256: "0".repeat(64),
    };
    await writeBuildConfig(root, config);
    expect(
      (await collectCanonicalRuntimeInputIdentity(root)).digestSha256,
    ).not.toBe(baseline.digestSha256);
  });

  it("binds the fixed protocol projection", async () => {
    const root = await fixture();
    const baseline = await collectCanonicalRuntimeInputIdentity(root);
    const protocolPath = path.join(root, nativeRoot, "protocol.v1.json");
    const protocol = JSON.parse(
      await readFile(protocolPath, "utf8"),
    ) as { reason: { timedOut: number } };
    protocol.reason.timedOut += 1;
    await writeFile(
      protocolPath,
      `${JSON.stringify(protocol, null, 2)}\n`,
      "utf8",
    );
    expect(
      (await collectCanonicalRuntimeInputIdentity(root)).digestSha256,
    ).not.toBe(baseline.digestSha256);
  });

  it.each(["unsafe", "missing", "invalid-utf8", "duplicate"] as const)(
    "fails closed for %s production inputs",
    async (kind) => {
      const root = await fixture();
      const config = await readBuildConfig(root);
      const first = sourceSets(config).production[0]!;
      if (kind === "unsafe") {
        sourceSets(config).production[0] = "../outside.cs";
        await writeBuildConfig(root, config);
      } else if (kind === "missing") {
        await rm(path.join(root, nativeRoot, first));
      } else if (kind === "invalid-utf8") {
        await writeFile(
          path.join(root, nativeRoot, first),
          Buffer.from([0x66, 0x6f, 0x80]),
        );
      } else {
        sourceSets(config).production.push(first.replaceAll("/", "\\"));
        await writeBuildConfig(root, config);
      }
      await expect(
        collectCanonicalRuntimeInputManifest(root),
      ).rejects.toThrow("Canonical runtime inputs are invalid.");
    },
  );

  it("rejects a reparse point anywhere in a production input path", async () => {
    const root = await fixture();
    const sourceDirectory = path.join(root, nativeRoot, "src");
    const realSourceDirectory = path.join(root, "real-native-source");
    await rename(sourceDirectory, realSourceDirectory);
    await symlink(realSourceDirectory, sourceDirectory, "junction");

    await expect(
      collectCanonicalRuntimeInputManifest(root),
    ).rejects.toThrow("Canonical runtime inputs are invalid.");
  });

  it("serializes with one fixed compact projection and hashes exactly those bytes", async () => {
    const root = await fixture();
    const manifest = await collectCanonicalRuntimeInputManifest(root);
    const serialized = serializeCanonicalRuntimeInputManifest(manifest);
    expect(serialized).toBe(JSON.stringify(manifest));
    expect(digestCanonicalRuntimeInputManifest(manifest)).toBe(
      createHash("sha256").update(serialized).digest("hex"),
    );
  });

  it("rebuilds fixed key order and normalizes semantically unordered path arrays", async () => {
    const root = await fixture();
    const manifest = await collectCanonicalRuntimeInputManifest(root);
    const clonedBuildContract = structuredClone(manifest.buildContract);
    const buildContract = {
      ...clonedBuildContract,
      productionSourcePaths: [
        ...clonedBuildContract.productionSourcePaths,
      ].reverse(),
      references: [...clonedBuildContract.references].reverse(),
    };
    const reordered = {
      helperArtifact: {
        sha256: manifest.helperArtifact.sha256,
        path: manifest.helperArtifact.path,
      },
      typescriptWrappers: [...manifest.typescriptWrappers]
        .reverse()
        .map((entry) => ({ sha256: entry.sha256, path: entry.path })),
      nativeSources: [...manifest.nativeSources]
        .reverse()
        .map((entry) => ({ sha256: entry.sha256, path: entry.path })),
      protocol: {
        stage: manifest.protocol.stage,
        reason: manifest.protocol.reason,
        messageType: manifest.protocol.messageType,
        limits: manifest.protocol.limits,
        frame: manifest.protocol.frame,
        mode: manifest.protocol.mode,
        schemaVersion: manifest.protocol.schemaVersion,
      },
      buildContract,
      schemaVersion: manifest.schemaVersion,
    };

    expect(serializeUnknown(reordered)).toBe(
      serializeCanonicalRuntimeInputManifest(manifest),
    );
  });

  it.each([
    ["extra key", (value: Record<string, unknown>) => {
      value.extra = true;
    }],
    ["missing key", (value: Record<string, unknown>) => {
      delete value.protocol;
    }],
    ["nested extra key", (value: Record<string, unknown>) => {
      (value.buildContract as Record<string, unknown>).extra = true;
    }],
    ["duplicate source", (value: Record<string, unknown>) => {
      const sources = value.nativeSources as Array<Record<string, unknown>>;
      sources.push(structuredClone(sources[0]!));
    }],
    ["source mismatch", (value: Record<string, unknown>) => {
      const sources = value.nativeSources as Array<Record<string, unknown>>;
      sources.pop();
    }],
    ["invalid digest", (value: Record<string, unknown>) => {
      const sources = value.nativeSources as Array<Record<string, unknown>>;
      sources[0]!.sha256 = "A".repeat(64);
    }],
    ["wrong wrapper", (value: Record<string, unknown>) => {
      const wrappers = value.typescriptWrappers as Array<
        Record<string, unknown>
      >;
      wrappers[0]!.path = "src/runtime/credentials.ts";
    }],
    ["wrong helper path", (value: Record<string, unknown>) => {
      (value.helperArtifact as Record<string, unknown>).path =
        "plugins/codex-external-agents/native/win32-x64/other.exe";
    }],
  ] as const)("rejects non-canonical manifest input with %s", async (_name, mutate) => {
    const root = await fixture();
    const candidate = structuredClone(
      await collectCanonicalRuntimeInputManifest(root),
    ) as unknown as Record<string, unknown>;
    mutate(candidate);

    expect(() => serializeUnknown(candidate)).toThrow(
      "Canonical runtime inputs are invalid.",
    );
    expect(() => digestUnknown(candidate)).toThrow(
      "Canonical runtime inputs are invalid.",
    );
  });

  it.each([
    ["nested array proxy", (value: Record<string, unknown>) => {
      const build = value.buildContract as Record<string, unknown>;
      build.references = new Proxy(
        [...(build.references as string[])],
        {},
      );
    }],
    ["nested index getter", (value: Record<string, unknown>) => {
      const build = value.buildContract as Record<string, unknown>;
      const references = build.references as string[];
      const first = references[0]!;
      Object.defineProperty(references, "0", {
        configurable: true,
        enumerable: true,
        get: () => first,
      });
    }],
    ["nested array symbol", (value: Record<string, unknown>) => {
      const references = (
        value.buildContract as Record<string, unknown>
      ).references as string[] & Record<symbol, unknown>;
      references[Symbol("hidden")] = true;
    }],
    ["text-input array named property", (value: Record<string, unknown>) => {
      const sources = value.nativeSources as Array<unknown> & {
        extra?: unknown;
      };
      sources.extra = true;
    }],
    ["text-input array non-enumerable property", (value: Record<string, unknown>) => {
      Object.defineProperty(value.nativeSources as unknown[], "hidden", {
        configurable: true,
        enumerable: false,
        value: true,
      });
    }],
    ["sparse text-input array", (value: Record<string, unknown>) => {
      delete (value.nativeSources as unknown[])[0];
    }],
  ] as const)("rejects hostile array shape with %s", async (_name, mutate) => {
    const root = await fixture();
    const candidate = structuredClone(
      await collectCanonicalRuntimeInputManifest(root),
    ) as unknown as Record<string, unknown>;
    mutate(candidate);

    expect(() => serializeUnknown(candidate)).toThrow(
      "Canonical runtime inputs are invalid.",
    );
    expect(() => digestUnknown(candidate)).toThrow(
      "Canonical runtime inputs are invalid.",
    );
  });
});
