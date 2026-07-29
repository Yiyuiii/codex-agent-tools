import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  capabilityRuntimeInputRoots,
  collectCapabilityRuntimeInputs,
  computeCapabilityRuntimeFingerprint,
  fingerprintCapabilitySnapshot,
  verifyCapabilityEvidenceSource,
  type BatchCaseCapabilitySource,
  type CapabilityQualificationEntry,
  type LegacyStandaloneCapabilitySource,
} from "../../src/qualification/capability-index.js";

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
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("capability qualification runtime fingerprint", () => {
  it("uses code-owned runtime input roots and excludes mutable gate metadata", () => {
    const piRoots = capabilityRuntimeInputRoots("pi-rpc");
    const kimiRoots = capabilityRuntimeInputRoots("kimi-acp");

    expect(piRoots).toContain("src/adapters/pi");
    expect(piRoots).toContain("src/qualification");
    expect(kimiRoots).toContain("src/adapters/kimi");
    expect(kimiRoots).toContain("src/qualification");
    expect(piRoots).not.toContain("src/llms/registry.ts");
    expect(kimiRoots).not.toContain("src/llms/registry.ts");
    expect(piRoots.some((entry) => entry.startsWith("docs/"))).toBe(false);
    expect(kimiRoots.some((entry) => entry.startsWith("docs/"))).toBe(false);
    expect(Object.isFrozen(piRoots)).toBe(true);
    expect(Object.isFrozen(kimiRoots)).toBe(true);
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
        timeoutMs: 900_000,
        maxConcurrency: 1,
        concurrencyKey: "ark-coding-plan",
      },
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
    await writeFile(
      path.join(root, "inputs", "nested", "a.ts"),
      "a\n",
      "utf8",
    );

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
    timeoutMs: 900_000,
    maxConcurrency: 1,
    concurrencyKey: "ark-coding-plan",
  };
}

async function batchFixture(root: string): Promise<{
  entry: CapabilityQualificationEntry;
  manifestPath: string;
  evidencePath: string;
  manifest: Record<string, unknown>;
  evidence: Record<string, unknown>;
}> {
  const batchId = "2026-07-29T00-00-00.000Z-batch";
  const manifestPath =
    `docs/smoke/evidence/batches/${batchId}/manifest.json`;
  const evidencePath =
    `docs/smoke/evidence/batches/${batchId}/cases/` +
    "2026-07-29T00-00-01.000Z-ark-coding-plan-review-ark.json";
  const frozenCommit = "a".repeat(40);
  const buildIdentitySha256 = "b".repeat(64);
  const evidence = {
    schemaVersion: 3,
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
    checks: {
      actualModelMatches: true,
      environmentIsolated: true,
      executionTelemetryValid: true,
      knownDefectFound: true,
      noNewPiRpcProcesses: true,
      workspaceUnchanged: true,
    },
  };
  const evidenceSha256 = await writeJson(root, evidencePath, evidence);
  const manifest = {
    schemaVersion: 2,
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
    expect(verifiedManifests).toEqual([
      path.join(root, fixture.manifestPath),
    ]);
  });

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
