import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeCapabilityIndex,
  capabilityDependencyInputFromPackageLock,
  capabilityRuntimeInputExclusions,
  capabilityRuntimeInputRoots,
  collectCapabilityRuntimeInputs,
  computeCapabilityRuntimeFingerprint,
  fingerprintCapabilitySnapshot,
  verifyCapabilityEvidenceSource,
  verifyCapabilityIndex,
  type BatchCaseCapabilitySource,
  type CapabilityQualificationEntry,
  type LegacyStandaloneCapabilitySource,
} from "../../src/qualification/capability-index.js";
import { collectCanonicalRuntimeInputIdentity } from "../../src/release/canonical-runtime-inputs.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-agent-capability-index-"),
  );
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("capability qualification runtime fingerprint", () => {
  it("uses code-owned runtime input roots and excludes mutable gate metadata", () => {
    const piRoots = capabilityRuntimeInputRoots("pi-rpc");
    const kimiRoots = capabilityRuntimeInputRoots("kimi-acp");

    expect(piRoots).toContain("src/adapters/pi");
    expect(piRoots).toContain("src/smoke/deepseek.ts");
    expect(piRoots).toContain("scripts/real-deepseek-smoke.mjs");
    expect(piRoots).toContain("src/qualification/verifier.ts");
    expect(piRoots).toContain(
      "host-acceptance/protocol/observer-protocol.v1.json",
    );
    expect(kimiRoots).toContain("src/adapters/kimi");
    expect(kimiRoots).toContain("src/qualification/verifier.ts");
    expect(kimiRoots).toContain(
      "host-acceptance/protocol/observer-protocol.v1.json",
    );
    expect(piRoots).not.toContain("package-lock.json");
    expect(kimiRoots).not.toContain("package-lock.json");
    expect(piRoots).not.toContain("src/qualification");
    expect(kimiRoots).not.toContain("src/qualification");
    expect(piRoots).not.toContain("src/qualification/capability-index.ts");
    expect(kimiRoots).not.toContain("src/qualification/capability-index.ts");
    expect(piRoots).not.toContain("src/llms/registry.ts");
    expect(kimiRoots).not.toContain("src/llms/registry.ts");
    expect(capabilityRuntimeInputExclusions()).toEqual([
      "src/runtime/owned-agent-process.ts",
      "src/runtime/windows-owned-agent-process.ts",
      "src/runtime/windows-job-helper.ts",
      "src/runtime/windows-job-protocol.ts",
    ]);
    expect(piRoots.some((entry) => entry.startsWith("docs/"))).toBe(false);
    expect(kimiRoots.some((entry) => entry.startsWith("docs/"))).toBe(false);
    expect(Object.isFrozen(piRoots)).toBe(true);
    expect(Object.isFrozen(kimiRoots)).toBe(true);
  });

  it("fingerprints only the locked dependency closure used by each model runtime", () => {
    const packageLock = {
      name: "codex-agent-tools",
      version: "0.1.0-alpha.1",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "codex-agent-tools",
          version: "0.1.0-alpha.1",
          dependencies: {
            "@agentclientprotocol/sdk": "1.2.1",
            "@modelcontextprotocol/sdk": "1.30.0",
            execa: "9.6.0",
            zod: "4.0.0",
          },
        },
        "node_modules/@agentclientprotocol/sdk": {
          version: "1.2.1",
          integrity: "sha512-acp",
          dependencies: { "acp-child": "1.0.0" },
        },
        "node_modules/acp-child": {
          version: "1.0.0",
          integrity: "sha512-acp-child",
        },
        "node_modules/@modelcontextprotocol/sdk": {
          version: "1.30.0",
          integrity: "sha512-mcp",
          dependencies: { "@hono/node-server": "^2.0.5" },
        },
        "node_modules/@hono/node-server": {
          version: "2.0.12",
          integrity: "sha512-hono",
        },
        "node_modules/execa": {
          version: "9.6.0",
          integrity: "sha512-execa",
          dependencies: { "execa-child": "1.0.0" },
        },
        "node_modules/execa-child": {
          version: "1.0.0",
          integrity: "sha512-execa-child",
        },
        "node_modules/zod": {
          version: "4.0.0",
          integrity: "sha512-zod",
        },
      },
    };

    const pi = capabilityDependencyInputFromPackageLock(packageLock, "pi-rpc");
    const kimi = capabilityDependencyInputFromPackageLock(
      packageLock,
      "kimi-acp",
    );
    const packagingOnlyChange = structuredClone(packageLock);
    packagingOnlyChange.version = "0.1.0-beta.0";
    packagingOnlyChange.packages[""].version = "0.1.0-beta.0";
    packagingOnlyChange.packages[
      "node_modules/@modelcontextprotocol/sdk"
    ].version = "1.31.0";
    packagingOnlyChange.packages[
      "node_modules/@modelcontextprotocol/sdk"
    ].integrity = "sha512-mcp-new";
    packagingOnlyChange.packages["node_modules/@hono/node-server"].version =
      "2.1.0";
    packagingOnlyChange.packages["node_modules/@hono/node-server"].integrity =
      "sha512-hono-new";

    expect(
      capabilityDependencyInputFromPackageLock(packagingOnlyChange, "pi-rpc"),
    ).toEqual(pi);
    expect(
      capabilityDependencyInputFromPackageLock(packagingOnlyChange, "kimi-acp"),
    ).toEqual(kimi);
    expect(pi.content).not.toContain("modelcontextprotocol");
    expect(kimi.content).not.toContain("modelcontextprotocol");
    expect(pi.content).not.toContain("agentclientprotocol");
    expect(kimi.content).toContain("agentclientprotocol");

    const sharedRuntimeChange = structuredClone(packageLock);
    sharedRuntimeChange.packages["node_modules/execa"].integrity =
      "sha512-execa-changed";
    expect(
      capabilityDependencyInputFromPackageLock(sharedRuntimeChange, "pi-rpc"),
    ).not.toEqual(pi);
    expect(
      capabilityDependencyInputFromPackageLock(sharedRuntimeChange, "kimi-acp"),
    ).not.toEqual(kimi);

    const kimiRuntimeChange = structuredClone(packageLock);
    kimiRuntimeChange.packages[
      "node_modules/@agentclientprotocol/sdk"
    ].integrity = "sha512-acp-changed";
    expect(
      capabilityDependencyInputFromPackageLock(kimiRuntimeChange, "pi-rpc"),
    ).toEqual(pi);
    expect(
      capabilityDependencyInputFromPackageLock(kimiRuntimeChange, "kimi-acp"),
    ).not.toEqual(kimi);
  });

  it("fails closed when a required runtime dependency cannot be resolved", () => {
    expect(() =>
      capabilityDependencyInputFromPackageLock(
        {
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/execa": {
              version: "9.6.0",
              integrity: "sha512-execa",
            },
          },
        },
        "pi-rpc",
      ),
    ).toThrow(/capability runtime inputs/iu);
  });

  it("fingerprints normalized profile identity, task, paths, and contents", () => {
    const base = {
      llm: "ark-coding-plan",
      task: "review" as const,
      profile: {
        id: "ark-coding-plan",
        runtime: "pi-rpc" as const,
        provider: "ark-coding-plan",
        model: "ark-code-latest",
        network: "direct" as const,
        credentialEnv: [
          "ARK_API_KEY",
          "VOLCENGINE_API_KEY",
          "API_KEY_DOUBAO_CODING",
        ],
        credentialTargetEnv: "CODEX_AGENT_ARK_CODING_KEY",
        maxConcurrency: 1,
        concurrencyKey: "ark-coding-plan",
      },
      canonicalRuntimeInputDigestSha256: "c".repeat(64),
      inputs: [
        { path: "src/a.ts", content: "export const a = 1;\r\n" },
        { path: "src/b.ts", content: "export const b = 2;\n" },
      ],
    };

    const fingerprint = fingerprintCapabilitySnapshot(base);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      fingerprintCapabilitySnapshot({
        ...base,
        inputs: [
          { path: "src/a.ts", content: "export const a = 1;\n" },
          { path: "src/b.ts", content: "export const b = 2;\n" },
        ],
      }),
    ).toBe(fingerprint);
    expect(
      fingerprintCapabilitySnapshot({ ...base, task: "delegate" }),
    ).not.toBe(fingerprint);
    expect(
      fingerprintCapabilitySnapshot({
        ...base,
        canonicalRuntimeInputDigestSha256: "e".repeat(64),
      }),
    ).not.toBe(fingerprint);
    expect(
      fingerprintCapabilitySnapshot({
        ...base,
        profile: { ...base.profile, model: "changed-model" },
      }),
    ).not.toBe(fingerprint);
    expect(
      fingerprintCapabilitySnapshot({
        ...base,
        inputs: [
          { path: "src/a.ts", content: "export const a = 9;\n" },
          { path: "src/b.ts", content: "export const b = 2;\n" },
        ],
      }),
    ).not.toBe(fingerprint);
  });

  it("injects one shared canonical digest into all eight schema-2 fingerprints while keeping runtime-specific inputs local", () => {
    const llms = [
      "ark-agent-deepseek-v4-flash",
      "ark-agent-plan",
      "ark-coding-plan",
      "kimi-k3",
    ] as const;
    const tasks = ["delegate", "review"] as const;
    const canonicalDigest = "a".repeat(64);
    const snapshots = llms.flatMap((llm) =>
      tasks.map((task) => ({
        llm,
        task,
        canonicalRuntimeInputDigestSha256: canonicalDigest,
        profile: {
          id: llm,
          runtime:
            llm === "kimi-k3" ? ("kimi-acp" as const) : ("pi-rpc" as const),
          model: `${llm}-model`,
          network: "direct" as const,
          credentialEnv: [`${llm}_KEY`],
          maxConcurrency: 1,
        },
        inputs: [
          { path: "src/shared.ts", content: "shared\n" },
          {
            path:
              llm === "kimi-k3"
                ? "src/adapters/kimi/runtime.ts"
                : "src/adapters/pi/runtime.ts",
            content: llm === "kimi-k3" ? "kimi\n" : "pi\n",
          },
        ],
      })),
    );
    const baseline = snapshots.map(fingerprintCapabilitySnapshot);
    const canonicalChanged = snapshots.map((snapshot) =>
      fingerprintCapabilitySnapshot({
        ...snapshot,
        canonicalRuntimeInputDigestSha256: "b".repeat(64),
      }),
    );
    const kimiChanged = snapshots.map((snapshot) =>
      fingerprintCapabilitySnapshot({
        ...snapshot,
        inputs: snapshot.inputs.map((input) =>
          input.path.includes("/kimi/")
            ? { ...input, content: "kimi changed\n" }
            : input,
        ),
      }),
    );

    expect(
      canonicalChanged.every((value, index) => value !== baseline[index]),
    ).toBe(true);
    expect(
      kimiChanged.map((value, index) => value !== baseline[index]),
    ).toEqual([false, false, false, false, false, false, true, true]);
  });

  it("computes deterministic and task-scoped fingerprints for current inputs", async () => {
    const repositoryRoot = process.cwd();

    const first = await computeCapabilityRuntimeFingerprint({
      repositoryRoot,
      llm: "ark-coding-plan",
      task: "review",
    });
    const second = await computeCapabilityRuntimeFingerprint({
      repositoryRoot,
      llm: "ark-coding-plan",
      task: "review",
    });
    const delegate = await computeCapabilityRuntimeFingerprint({
      repositoryRoot,
      llm: "ark-coding-plan",
      task: "delegate",
    });
    const kimi = await computeCapabilityRuntimeFingerprint({
      repositoryRoot,
      llm: "kimi-k3",
      task: "review",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
    expect(delegate).not.toBe(first);
    expect(kimi).not.toBe(first);
  });

  it("collects files in stable repository-relative order and normalizes line endings", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "inputs", "nested"), { recursive: true });
    await writeFile(path.join(root, "inputs", "z.ts"), "z\r\n", "utf8");
    await writeFile(path.join(root, "inputs", "nested", "a.ts"), "a\n", "utf8");

    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["inputs"],
      }),
    ).resolves.toEqual([
      { path: "inputs/nested/a.ts", content: "a\n" },
      { path: "inputs/z.ts", content: "z\n" },
    ]);
  });

  it("excludes the four canonical wrappers only from the ordinary runtime input set", async () => {
    const inputs = await collectCapabilityRuntimeInputs({
      repositoryRoot: process.cwd(),
      roots: ["src/runtime"],
      excludePaths: capabilityRuntimeInputExclusions(),
    });
    const paths = inputs.map((input) => input.path);
    expect(paths).toContain("src/runtime/credentials.ts");
    expect(
      paths.some((entry) => capabilityRuntimeInputExclusions().includes(entry)),
    ).toBe(false);
  });

  it("fails closed for unsafe, missing, binary, or symbolic-link inputs", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "safe.ts"), "safe\n", "utf8");
    await writeFile(
      path.join(root, "inputs", "binary.ts"),
      Buffer.from([0x66, 0x6f, 0x80]),
    );

    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["../outside"],
      }),
    ).rejects.toThrow(/capability runtime inputs/iu);
    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["missing"],
      }),
    ).rejects.toThrow(/capability runtime inputs/iu);
    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["inputs"],
      }),
    ).rejects.toThrow(/capability runtime inputs/iu);

    await rm(path.join(root, "inputs", "binary.ts"));
    const linkPath = path.join(root, "inputs", "linked.ts");
    try {
      await symlink(path.join(root, "inputs", "safe.ts"), linkPath);
    } catch {
      return;
    }
    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["inputs"],
      }),
    ).rejects.toThrow(/capability runtime inputs/iu);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(
  root: string,
  relativePath: string,
  value: unknown,
): Promise<string> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, serialized, "utf8");
  return sha256(serialized);
}

function codingProfile() {
  return {
    id: "ark-coding-plan",
    displayName: "Ark Coding Plan",
    runtime: "pi-rpc" as const,
    provider: "ark-coding-plan",
    model: "ark-code-latest",
    network: "direct" as const,
    capabilities: { review: true, delegate: true },
    qualityGates: {
      review: { status: "pending" as const },
      delegate: { status: "pending" as const },
    },
    credentialEnv: [
      "ARK_API_KEY",
      "VOLCENGINE_API_KEY",
      "API_KEY_DOUBAO_CODING",
    ],
    credentialTargetEnv: "CODEX_AGENT_ARK_CODING_KEY",
    maxConcurrency: 1,
    concurrencyKey: "ark-coding-plan",
  };
}

function directDeepSeekProfile() {
  return {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    runtime: "pi-rpc" as const,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    network: "direct" as const,
    capabilities: { review: true, delegate: true },
    qualityGates: {
      review: { status: "pending" as const },
      delegate: { status: "pending" as const },
    },
    credentialEnv: ["OPENAI_API_KEY_DEEPSEEK"],
    credentialTargetEnv: "CODEX_AGENT_DEEPSEEK_KEY",
    maxConcurrency: 1,
    concurrencyKey: "deepseek",
  };
}

async function batchFixture(
  root: string,
  currentOwnedEvidence = false,
): Promise<{
  entry: CapabilityQualificationEntry;
  manifestPath: string;
  evidencePath: string;
  manifest: Record<string, unknown>;
  evidence: Record<string, unknown>;
}> {
  const batchId = "2026-07-29T00-00-00.000Z-batch";
  const manifestPath = `docs/smoke/evidence/batches/${batchId}/manifest.json`;
  const evidencePath =
    `docs/smoke/evidence/batches/${batchId}/cases/` +
    "2026-07-29T00-00-01.000Z-ark-coding-plan-review-ark.json";
  const frozenCommit = "a".repeat(40);
  const buildIdentitySha256 = "b".repeat(64);
  const evidence = {
    schemaVersion: currentOwnedEvidence ? 4 : 3,
    qualification: {
      qualificationPlanId: "four-llm-v1",
      batchId,
      ordinal: 2,
      llm: "ark-coding-plan",
      task: "review",
      frozenCommit,
      frozenBuildIdentity: buildIdentitySha256,
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false,
    },
    timestamp: "2026-07-29T00:00:01.000Z",
    llm: "ark-coding-plan",
    actualModel: "ark-code-latest",
    expectedModel: "ark-code-latest",
    runtime: "pi-rpc",
    provider: "ark-coding-plan",
    endpointHost: "ark.cn-beijing.volces.com",
    route: "direct",
    credentialEnv: "CODEX_AGENT_ARK_CODING_KEY",
    task: "review",
    status: "completed",
    passed: true,
    failureReason: null,
    adapterClientInvocationCount: 1,
    adapterRetryCount: 0,
    runtimeReportedAutoRetryCount: 0,
    adapterReportedFallbackUsed: false,
    orchestratorFallbackUsed: false,
    executionTelemetrySource: "pi-rpc-observable",
    ...(currentOwnedEvidence ? { ownedProcessDrained: true } : {}),
    checks: {
      actualModelMatches: true,
      environmentIsolated: true,
      executionTelemetryValid: true,
      knownDefectFound: true,
      ...(currentOwnedEvidence
        ? { ownedProcessDrained: true }
        : { noNewPiRpcProcesses: true }),
      workspaceUnchanged: true,
    },
  };
  const evidenceSha256 = await writeJson(root, evidencePath, evidence);
  const manifest = {
    schemaVersion: currentOwnedEvidence ? 3 : 2,
    qualificationPlanId: "four-llm-v1",
    batchId,
    status: "blocked",
    repositoryCommit: frozenCommit,
    buildIdentitySha256,
    cases: [
      {
        ordinal: 2,
        llm: "ark-coding-plan",
        task: "review",
        result: "passed",
        evidence: {
          path: evidencePath,
          sha256: evidenceSha256,
        },
      },
    ],
    promotionEligible: false,
  };
  const manifestSha256 = await writeJson(root, manifestPath, manifest);
  const source: BatchCaseCapabilitySource = {
    kind: "batch-case",
    manifestPath,
    manifestSha256,
    evidencePath,
    evidenceSha256,
    frozenCommit,
    buildIdentitySha256,
  };
  return {
    entry: {
      llm: "ark-coding-plan",
      task: "review",
      runtimeFingerprintSha256: "d".repeat(64),
      source,
    },
    manifestPath,
    evidencePath,
    manifest,
    evidence,
  };
}

describe("capability qualification evidence source", () => {
  it("accepts a passed case from an immutable blocked batch without promoting the batch", async () => {
    const root = await temporaryRoot();
    const fixture = await batchFixture(root);
    const verifiedManifests: string[] = [];

    await expect(
      verifyCapabilityEvidenceSource(
        {
          repositoryRoot: root,
          entry: fixture.entry,
          profile: codingProfile(),
        },
        {
          verifyBatchManifest: async (manifestPath) => {
            verifiedManifests.push(manifestPath);
            return {
              verified: true,
              mode: "immutable-evidence",
              batchId: "2026-07-29T00-00-00.000Z-batch",
              qualificationPlanId: "four-llm-v1",
              status: "blocked",
              promotionEligible: false,
            };
          },
        },
      ),
    ).resolves.toEqual({ sourceKind: "batch-case" });
    expect(verifiedManifests).toEqual([path.join(root, fixture.manifestPath)]);
  });

  it("accepts current evidence only with exact owned-process drain proof", async () => {
    const root = await temporaryRoot();
    const fixture = await batchFixture(root, true);

    await expect(
      verifyCapabilityEvidenceSource(
        {
          repositoryRoot: root,
          entry: fixture.entry,
          profile: codingProfile(),
        },
        {
          verifyBatchManifest: async () => ({
            verified: true,
            mode: "immutable-evidence",
            batchId: "2026-07-29T00-00-00.000Z-batch",
            qualificationPlanId: "four-llm-v1",
            status: "blocked",
            promotionEligible: false,
          }),
        },
      ),
    ).resolves.toEqual({ sourceKind: "batch-case" });
  });

  it("accepts Direct DeepSeek evidence only from its isolated plan", async () => {
    const root = await temporaryRoot();
    const fixture = await batchFixture(root, true);
    const qualification = fixture.evidence.qualification as Record<
      string,
      unknown
    >;
    Object.assign(qualification, {
      qualificationPlanId: "direct-deepseek-v1",
      ordinal: 1,
      llm: "deepseek-v4-flash",
    });
    Object.assign(fixture.evidence, {
      llm: "deepseek-v4-flash",
      actualModel: "deepseek-v4-flash",
      expectedModel: "deepseek-v4-flash",
      provider: "deepseek",
      credentialEnv: "CODEX_AGENT_DEEPSEEK_KEY",
    });
    fixture.manifest.qualificationPlanId = "direct-deepseek-v1";
    const manifestCase = (
      fixture.manifest.cases as Array<Record<string, unknown>>
    )[0]!;
    Object.assign(manifestCase, {
      ordinal: 1,
      llm: "deepseek-v4-flash",
    });
    Object.assign(fixture.entry, {
      llm: "deepseek-v4-flash",
    });
    const evidenceSha256 = await writeJson(
      root,
      fixture.evidencePath,
      fixture.evidence,
    );
    manifestCase.evidence = {
      ...(manifestCase.evidence as Record<string, unknown>),
      sha256: evidenceSha256,
    };
    const manifestSha256 = await writeJson(
      root,
      fixture.manifestPath,
      fixture.manifest,
    );
    Object.assign(fixture.entry.source, {
      evidenceSha256,
      manifestSha256,
    });

    await expect(
      verifyCapabilityEvidenceSource(
        {
          repositoryRoot: root,
          entry: fixture.entry,
          profile: directDeepSeekProfile(),
        },
        {
          verifyBatchManifest: async () => ({
            verified: true,
            mode: "immutable-evidence",
            batchId: "2026-07-29T00-00-00.000Z-batch",
            qualificationPlanId: "direct-deepseek-v1",
            status: "passed",
            promotionEligible: true,
          }),
        },
      ),
    ).resolves.toEqual({ sourceKind: "batch-case" });
    await expect(
      verifyCapabilityEvidenceSource(
        {
          repositoryRoot: root,
          entry: fixture.entry,
          profile: directDeepSeekProfile(),
        },
        {
          verifyBatchManifest: async () => ({
            verified: true,
            mode: "immutable-evidence",
            batchId: "2026-07-29T00-00-00.000Z-batch",
            qualificationPlanId: "four-llm-v1",
            status: "passed",
            promotionEligible: true,
          }),
        },
      ),
    ).rejects.toThrow(/capability qualification/iu);
  });

  it.each([
    [
      "missing top-level drain",
      (evidence: Record<string, unknown>) => {
        delete evidence.ownedProcessDrained;
      },
    ],
    [
      "false top-level drain",
      (evidence: Record<string, unknown>) => {
        evidence.ownedProcessDrained = false;
      },
    ],
    [
      "historical process check",
      (evidence: Record<string, unknown>) => {
        evidence.checks = {
          ...(evidence.checks as Record<string, unknown>),
          noNewPiRpcProcesses: true,
        };
        delete (evidence.checks as Record<string, unknown>).ownedProcessDrained;
      },
    ],
  ] as const)(
    "rejects current capability evidence with %s",
    async (_name, mutate) => {
      const root = await temporaryRoot();
      const fixture = await batchFixture(root, true);
      mutate(fixture.evidence);
      const evidenceSha256 = await writeJson(
        root,
        fixture.evidencePath,
        fixture.evidence,
      );
      const manifestCase = (
        fixture.manifest.cases as Array<Record<string, unknown>>
      )[0]!;
      manifestCase.evidence = {
        ...(manifestCase.evidence as Record<string, unknown>),
        sha256: evidenceSha256,
      };
      const manifestSha256 = await writeJson(
        root,
        fixture.manifestPath,
        fixture.manifest,
      );
      Object.assign(fixture.entry.source, {
        evidenceSha256,
        manifestSha256,
      });

      await expect(
        verifyCapabilityEvidenceSource(
          {
            repositoryRoot: root,
            entry: fixture.entry,
            profile: codingProfile(),
          },
          {
            verifyBatchManifest: async () => ({
              verified: true,
              mode: "immutable-evidence",
              batchId: "2026-07-29T00-00-00.000Z-batch",
              qualificationPlanId: "four-llm-v1",
              status: "blocked",
              promotionEligible: false,
            }),
          },
        ),
      ).rejects.toThrow(/capability qualification/iu);
    },
  );

  it.each([
    {
      name: "manifest hash drift",
      mutate: (fixture: Awaited<ReturnType<typeof batchFixture>>) => {
        (
          fixture.entry.source as {
            manifestSha256: string;
          }
        ).manifestSha256 = "0".repeat(64);
      },
    },
    {
      name: "evidence hash drift",
      mutate: (fixture: Awaited<ReturnType<typeof batchFixture>>) => {
        (
          fixture.entry.source as {
            evidenceSha256: string;
          }
        ).evidenceSha256 = "0".repeat(64);
      },
    },
    {
      name: "identity mismatch",
      mutate: (fixture: Awaited<ReturnType<typeof batchFixture>>) => {
        (fixture.entry as { llm: string }).llm = "kimi-k3";
      },
    },
  ])("rejects batch evidence with $name", async ({ mutate }) => {
    const root = await temporaryRoot();
    const fixture = await batchFixture(root);
    mutate(fixture);

    await expect(
      verifyCapabilityEvidenceSource(
        {
          repositoryRoot: root,
          entry: fixture.entry,
          profile: codingProfile(),
        },
        {
          verifyBatchManifest: async () => ({
            verified: true,
            mode: "immutable-evidence",
            batchId: "2026-07-29T00-00-00.000Z-batch",
            qualificationPlanId: "four-llm-v1",
            status: "blocked",
            promotionEligible: false,
          }),
        },
      ),
    ).rejects.toThrow(/capability qualification/iu);
  });

  it("rejects a failed case even when its surrounding manifest is immutable", async () => {
    const root = await temporaryRoot();
    const fixture = await batchFixture(root);
    const failedManifest = {
      ...fixture.manifest,
      cases: [
        {
          ...(fixture.manifest.cases as Array<Record<string, unknown>>)[0],
          result: "failed",
        },
      ],
    };
    const manifestSha256 = await writeJson(
      root,
      fixture.manifestPath,
      failedManifest,
    );
    (
      fixture.entry.source as {
        manifestSha256: string;
      }
    ).manifestSha256 = manifestSha256;

    await expect(
      verifyCapabilityEvidenceSource(
        {
          repositoryRoot: root,
          entry: fixture.entry,
          profile: codingProfile(),
        },
        {
          verifyBatchManifest: async () => ({
            verified: true,
            mode: "immutable-evidence",
            batchId: "2026-07-29T00-00-00.000Z-batch",
            qualificationPlanId: "four-llm-v1",
            status: "blocked",
            promotionEligible: false,
          }),
        },
      ),
    ).rejects.toThrow(/capability qualification/iu);
  });

  it("accepts only the one grandfathered legacy standalone capability", async () => {
    const root = await temporaryRoot();
    const evidencePath =
      "docs/smoke/evidence/" +
      "2026-07-25T16-10-32.796Z-ark-agent-deepseek-v4-flash-delegate-ark.json";
    const evidence = {
      schemaVersion: 1,
      timestamp: "2026-07-25T16:10:32.796Z",
      llm: "ark-agent-deepseek-v4-flash",
      actualModel: "deepseek-v4-flash",
      expectedModel: "deepseek-v4-flash",
      runtime: "pi-rpc",
      provider: "ark-agent-plan",
      endpointHost: "ark.cn-beijing.volces.com",
      route: "direct",
      credentialEnv: "CODEX_AGENT_ARK_AGENT_KEY",
      task: "delegate",
      status: "completed",
      passed: true,
      failureReason: null,
      filesChanged: ["ark-agent-deepseek-v4-flash-smoke.txt"],
      checks: {
        actualModelMatches: true,
        environmentIsolated: true,
        noNewPiRpcProcesses: true,
        resultFileValid: true,
        resultFileObserved: true,
        onlyExpectedFileChanged: true,
        commandObserved: true,
      },
    };
    const evidenceSha256 = await writeJson(root, evidencePath, evidence);
    const source: LegacyStandaloneCapabilitySource = {
      kind: "legacy-standalone",
      evidencePath,
      evidenceSha256,
      evidenceSchemaVersion: 1,
      observedAt: evidence.timestamp,
    };
    const entry: CapabilityQualificationEntry = {
      llm: "ark-agent-deepseek-v4-flash",
      task: "delegate",
      runtimeFingerprintSha256: "d".repeat(64),
      source,
    };
    const profile = {
      ...codingProfile(),
      id: "ark-agent-deepseek-v4-flash",
      displayName: "Ark Agent Plan DeepSeek V4 Flash",
      provider: "ark-agent-plan",
      model: "deepseek-v4-flash",
      credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
      credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
      concurrencyKey: "ark-agent-plan",
    };

    await expect(
      verifyCapabilityEvidenceSource({
        repositoryRoot: root,
        entry,
        profile,
      }),
    ).resolves.toEqual({ sourceKind: "legacy-standalone" });

    (entry as { task: "review" | "delegate" }).task = "review";
    await expect(
      verifyCapabilityEvidenceSource({
        repositoryRoot: root,
        entry,
        profile,
      }),
    ).rejects.toThrow(/capability qualification/iu);
  });

  it("rejects legacy standalone evidence with weakened or extra checks", async () => {
    const root = await temporaryRoot();
    const evidencePath =
      "docs/smoke/evidence/" +
      "2026-07-25T16-10-32.796Z-ark-agent-deepseek-v4-flash-delegate-ark.json";
    const evidence = {
      schemaVersion: 1,
      timestamp: "2026-07-25T16:10:32.796Z",
      llm: "ark-agent-deepseek-v4-flash",
      actualModel: "deepseek-v4-flash",
      expectedModel: "deepseek-v4-flash",
      runtime: "pi-rpc",
      provider: "ark-agent-plan",
      endpointHost: "ark.cn-beijing.volces.com",
      route: "direct",
      credentialEnv: "CODEX_AGENT_ARK_AGENT_KEY",
      task: "delegate",
      status: "completed",
      passed: true,
      failureReason: null,
      filesChanged: ["ark-agent-deepseek-v4-flash-smoke.txt"],
      checks: {
        actualModelMatches: true,
        environmentIsolated: true,
        noNewPiRpcProcesses: true,
        resultFileValid: true,
        resultFileObserved: true,
        onlyExpectedFileChanged: true,
        commandObserved: false,
        unexpected: true,
      },
    };
    const evidenceSha256 = await writeJson(root, evidencePath, evidence);
    const entry: CapabilityQualificationEntry = {
      llm: "ark-agent-deepseek-v4-flash",
      task: "delegate",
      runtimeFingerprintSha256: "d".repeat(64),
      source: {
        kind: "legacy-standalone",
        evidencePath,
        evidenceSha256,
        evidenceSchemaVersion: 1,
        observedAt: evidence.timestamp,
      },
    };
    const profile = {
      ...codingProfile(),
      id: "ark-agent-deepseek-v4-flash",
      displayName: "Ark Agent Plan DeepSeek V4 Flash",
      provider: "ark-agent-plan",
      model: "deepseek-v4-flash",
      credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
      credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
      concurrencyKey: "ark-agent-plan",
    };

    await expect(
      verifyCapabilityEvidenceSource({
        repositoryRoot: root,
        entry,
        profile,
      }),
    ).rejects.toThrow(/capability qualification/iu);
  });
});

describe("current capability index qualification", () => {
  it("keeps historical evidence valid while shared protocol changes stale all eight indexed capabilities", async () => {
    let canonicalCollections = 0;
    const analysis = await analyzeCapabilityIndex(
      { repositoryRoot: process.cwd() },
      {
        collectCanonicalRuntimeInputIdentity: async (root) => {
          canonicalCollections += 1;
          return collectCanonicalRuntimeInputIdentity(root);
        },
      },
    );

    expect(canonicalCollections).toBe(1);
    expect(analysis.entries).toHaveLength(8);
    expect(analysis.entries.map((entry) => entry.evidenceStatus)).toEqual(
      Array.from({ length: 8 }, () => "valid"),
    );
    expect(
      analysis.entries.map((entry) => entry.runtimeFingerprintStatus),
    ).toEqual(Array.from({ length: 8 }, () => "stale"));
    expect(
      analysis.entries.some(({ llm }) => llm === "deepseek-v4-flash"),
    ).toBe(false);
    expect(
      analysis.entries.every((entry) =>
        /^[a-f0-9]{64}$/u.test(entry.currentRuntimeFingerprintSha256 ?? ""),
      ),
    ).toBe(true);
    await expect(
      verifyCapabilityIndex({ repositoryRoot: process.cwd() }),
    ).rejects.toThrow(/capability qualification/iu);
  });
});
