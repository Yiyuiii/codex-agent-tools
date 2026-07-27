import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main as verifierMain } from "../../scripts/verify-qualification.js";
import {
  createQualificationLedger,
  freezePreflightRecord,
} from "../../src/qualification/manifest.js";
import {
  ACTIVE_QUALIFICATION_CASES,
  ACTIVE_QUALIFICATION_PLAN_ID,
} from "../../src/qualification/protocol.js";
import {
  type FrozenPreflightRecord,
  type QualificationCaseIdentity,
} from "../../src/qualification/types.js";
import {
  QualificationVerificationError,
  verifyQualification,
  type FrozenCandidateSnapshot,
} from "../../src/qualification/verifier.js";

const roots: string[] = [];
const batchId = "batch-verifier-2026-07-26";
const authorizationHash = "a".repeat(64);
const repositoryCommit = "b".repeat(40);
const historicalBatchId =
  "2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRepository(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-verifier-test-${process.pid}-${Date.now()}-${roots.length}`,
  );
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function frozenPreflight(): FrozenPreflightRecord {
  const buildArtifacts = [
    { path: "dist/ark-smoke.js", sha256: "1".repeat(64) },
    { path: "dist/kimi-smoke.js", sha256: "2".repeat(64) },
    { path: "dist/smoke-evidence.js", sha256: "3".repeat(64) },
    {
      path: "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
      sha256: "4".repeat(64),
    },
  ];
  return freezePreflightRecord({
    schemaVersion: 2,
    qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
    repositoryCommit,
    repositoryBranch: "codex/ark-cutover",
    repositoryDirty: false,
    packageVersion: "0.1.0-alpha.1",
    packageLockSha256: "d".repeat(64),
    buildArtifacts,
    buildIdentitySha256: sha256(JSON.stringify(buildArtifacts)),
    runtimeVersions: {
      node: "v24.0.0",
      codex: "codex-cli 0.135.0",
      kimi: "0.27.0",
      pi: "0.80.10",
    },
    piConfigSha256: "e".repeat(64),
    logicalLlms: [
      {
        llm: "ark-agent-deepseek-v4-flash",
        runtime: "pi-rpc",
        model: "deepseek-v4-flash",
        provider: "ark-agent-plan",
        route: "direct",
      },
      {
        llm: "ark-agent-plan",
        runtime: "pi-rpc",
        model: "ark-code-latest",
        provider: "ark-agent-plan",
        route: "direct",
      },
      {
        llm: "ark-coding-plan",
        runtime: "pi-rpc",
        model: "ark-code-latest",
        provider: "ark-coding-plan",
        route: "direct",
      },
      {
        llm: "kimi-k3",
        runtime: "kimi-acp",
        model: "kimi-code/k3",
        provider: null,
        route: "direct",
      },
    ],
    credentialMatches: [
      {
        llm: "ark-agent-deepseek-v4-flash",
        environmentVariableName: "OPENAI_API_KEY_DOUBAO",
      },
      {
        llm: "ark-agent-plan",
        environmentVariableName: "OPENAI_API_KEY_DOUBAO",
      },
      {
        llm: "ark-coding-plan",
        environmentVariableName: "API_KEY_DOUBAO_CODING",
      },
      { llm: "kimi-k3", environmentVariableName: null },
    ],
    targetProcesses: {
      kimi: { count: 0 },
      piRpc: { count: 0 },
      realSmoke: { count: 0 },
    },
  });
}

function frozenCandidate(
  preflight: FrozenPreflightRecord = frozenPreflight(),
): FrozenCandidateSnapshot {
  return {
    repositoryCommit: preflight.repositoryCommit,
    packageVersion: preflight.packageVersion,
    packageLockSha256: preflight.packageLockSha256,
    buildArtifacts: preflight.buildArtifacts,
    buildIdentitySha256: preflight.buildIdentitySha256,
    runtimeVersions: preflight.runtimeVersions,
    piConfigSha256: preflight.piConfigSha256,
    logicalLlms: preflight.logicalLlms,
    credentialMatches: preflight.credentialMatches,
  };
}

function expectedResultLine(identity: QualificationCaseIdentity): string {
  if (identity.llm === "kimi-k3") return "KIMI_SMOKE_OK";
  return `ARK_SMOKE_OK:${identity.llm}`;
}

async function copyHistoricalBatch(repositoryRoot: string): Promise<string> {
  const relative = path.join(
    "docs",
    "smoke",
    "evidence",
    "batches",
    historicalBatchId,
  );
  const destination = path.join(repositoryRoot, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(process.cwd(), relative), destination, {
    recursive: true,
  });
  return path.join(destination, "manifest.json");
}

function acceptanceChecks(identity: QualificationCaseIdentity) {
  if (identity.task === "review") {
    return identity.llm === "kimi-k3"
      ? {
          actualModelMatches: true,
          noNewKimiProcesses: true,
          workspaceUnchanged: true,
          knownDefectFound: true,
          executionTelemetryValid: true,
        }
      : {
          actualModelMatches: true,
          environmentIsolated: true,
          noNewPiRpcProcesses: true,
          workspaceUnchanged: true,
          knownDefectFound: true,
          executionTelemetryValid: true,
        };
  }
  return identity.llm === "kimi-k3"
    ? {
        actualModelMatches: true,
        noNewKimiProcesses: true,
        resultFileValid: true,
        resultFileObserved: true,
        onlyExpectedFileChanged: true,
        requiredCommandObserved: true,
        executionTelemetryValid: true,
      }
    : {
        actualModelMatches: true,
        environmentIsolated: true,
        noNewPiRpcProcesses: true,
        resultFileValid: true,
        resultFileObserved: true,
        onlyExpectedFileChanged: true,
        requiredCommandObserved: true,
        executionTelemetryValid: true,
      };
}

function evidenceForCase(
  identity: QualificationCaseIdentity,
  preflight: FrozenPreflightRecord,
): Record<string, unknown> {
  const logicalIdentity = preflight.logicalLlms.find(
    (candidate) => candidate.llm === identity.llm,
  )!;
  const expectedLine = expectedResultLine(identity);
  return {
    schemaVersion: 3,
    qualification: {
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
      batchId,
      ordinal: identity.ordinal,
      llm: identity.llm,
      task: identity.task,
      frozenCommit: repositoryCommit,
      frozenBuildIdentity: preflight.buildIdentitySha256,
      authorizationReferenceSha256: authorizationHash,
      orchestratorFallbackUsed: false,
    },
    timestamp: "2026-07-26T00:00:00.000Z",
    llm: identity.llm,
    task: identity.task,
    status: "completed",
    actualModel: logicalIdentity.model,
    expectedModel: logicalIdentity.model,
    runtime: logicalIdentity.runtime,
    ...(logicalIdentity.provider === null
      ? {}
      : { provider: logicalIdentity.provider }),
    route: logicalIdentity.route,
    ...(logicalIdentity.runtime === "pi-rpc"
      ? {
          configSha256: preflight.piConfigSha256,
          credentialEnv:
            identity.llm === "ark-coding-plan"
              ? "CODEX_AGENT_ARK_CODING_KEY"
              : "CODEX_AGENT_ARK_AGENT_KEY",
        }
      : {}),
    passed: true,
    failureReason: null,
    adapterClientInvocationCount: 1,
    adapterRetryCount: 0,
    runtimeReportedAutoRetryCount: 0,
    adapterReportedFallbackUsed: false,
    orchestratorFallbackUsed: false,
    executionTelemetrySource:
      logicalIdentity.runtime === "kimi-acp"
        ? "kimi-acp-observable"
        : "pi-rpc-observable",
    ...(identity.llm === "kimi-k3" && identity.task === "delegate"
      ? {
          commandCount: 1,
          commandObservations: [{ source: "raw_input", match: "exact" }],
        }
      : {}),
    checks: acceptanceChecks(identity),
    ...(identity.task === "delegate"
      ? {
          resultFileReadStatus: "read",
          resultFileByteLength: Buffer.byteLength(`${expectedLine}\n`),
          resultFileRawSha256: sha256(`${expectedLine}\n`),
          resultFileNormalizedSha256: sha256(expectedLine),
          expectedResultNormalizedSha256: sha256(expectedLine),
          resultFileNormalizedLineCount: 1,
          resultFileContainsExpectedLine: true,
        }
      : {}),
  };
}

interface PassedBatchOptions {
  mutateEvidence?: (
    evidence: Record<string, unknown>,
    identity: QualificationCaseIdentity,
  ) => void;
}

async function createPassedBatch(
  repositoryRoot: string,
  options: PassedBatchOptions = {},
): Promise<{ manifestPath: string; preflight: FrozenPreflightRecord }> {
  const preflight = frozenPreflight();
  const ledger = createQualificationLedger({ repositoryRoot, batchId });
  await ledger.publishBatchStarted({
    authorizationReferenceSha256: authorizationHash,
    preflight,
    recordedAt: "2026-07-26T00:00:00.000Z",
  });
  for (const identity of ACTIVE_QUALIFICATION_CASES) {
    await ledger.publishCaseRunning({
      ...identity,
      recordedAt: "2026-07-26T00:00:00.000Z",
    });
    const evidence = evidenceForCase(identity, preflight);
    options.mutateEvidence?.(evidence, identity);
    const evidencePath = path.join(
      repositoryRoot,
      "docs",
      "smoke",
      "evidence",
      "batches",
      batchId,
      "cases",
      `${String(identity.ordinal).padStart(2, "0")}.json`,
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await ledger.publishCaseCompleted({
      ...identity,
      result: "passed",
      evidencePath,
      recordedAt: "2026-07-26T00:00:00.000Z",
    });
  }
  await ledger.publishTerminalManifest({
    status: "passed",
    stopReason: null,
    notRun: [],
    completedAt: "2026-07-26T00:00:00.000Z",
  });
  return {
    manifestPath: path.join(
      repositoryRoot,
      "docs",
      "smoke",
      "evidence",
      "batches",
      batchId,
      "manifest.json",
    ),
    preflight,
  };
}

async function createCurrentBlockedBatch(
  repositoryRoot: string,
  mutateEvidence?: (evidence: Record<string, unknown>) => void,
  failedIdentity: Readonly<QualificationCaseIdentity> =
    ACTIVE_QUALIFICATION_CASES[0],
): Promise<string> {
  const preflight = frozenPreflight();
  const ledger = createQualificationLedger({ repositoryRoot, batchId });
  await ledger.publishBatchStarted({
    authorizationReferenceSha256: authorizationHash,
    preflight,
    recordedAt: "2026-07-26T00:00:00.000Z",
  });
  for (const identity of ACTIVE_QUALIFICATION_CASES.slice(
    0,
    failedIdentity.ordinal,
  )) {
    await ledger.publishCaseRunning({
      ...identity,
      recordedAt: "2026-07-26T00:00:00.000Z",
    });
    const evidence = evidenceForCase(identity, preflight);
    const failed = identity.ordinal === failedIdentity.ordinal;
    if (failed) {
      evidence.status = "completed";
      evidence.passed = false;
      evidence.failureReason = "acceptance_failed";
      evidence.checks = {
        ...acceptanceChecks(identity),
        resultFileValid: false,
      };
      mutateEvidence?.(evidence);
    }
    const evidencePath = path.join(
      repositoryRoot,
      "docs",
      "smoke",
      "evidence",
      "batches",
      batchId,
      "cases",
      `${String(identity.ordinal).padStart(2, "0")}.json`,
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await ledger.publishCaseCompleted({
      ...identity,
      result: failed ? "failed" : "passed",
      evidencePath,
      recordedAt: "2026-07-26T00:00:00.000Z",
    });
  }
  await ledger.publishTerminalManifest({
    status: "blocked",
    stopReason: "case_failed",
    notRun: ACTIVE_QUALIFICATION_CASES.slice(failedIdentity.ordinal),
    completedAt: "2026-07-26T00:00:00.000Z",
  });
  return path.join(
    repositoryRoot,
    "docs",
    "smoke",
    "evidence",
    "batches",
    batchId,
    "manifest.json",
  );
}

async function createCurrentBlockedKimiDelegateBatch(
  repositoryRoot: string,
  mutateEvidence?: (evidence: Record<string, unknown>) => void,
): Promise<string> {
  const identity = ACTIVE_QUALIFICATION_CASES.find(
    (candidate) =>
      candidate.llm === "kimi-k3" && candidate.task === "delegate",
  );
  if (identity === undefined) throw new Error("Missing Kimi delegate case");
  return createCurrentBlockedBatch(repositoryRoot, mutateEvidence, identity);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

async function overwriteJson(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function coherentlyRewriteEvidenceReference(options: {
  repositoryRoot: string;
  manifestPath: string;
  ordinal: number;
  evidencePath?: string;
  mutateEvidence?: (evidence: Record<string, unknown>) => void;
}): Promise<void> {
  const manifest = await readJson(options.manifestPath);
  const manifestCases = manifest.cases as Array<Record<string, unknown>>;
  const caseEntry = manifestCases[options.ordinal - 1]!;
  const oldReference = caseEntry.evidence as Record<string, unknown>;
  const oldEvidencePath = path.resolve(
    options.repositoryRoot,
    oldReference.path as string,
  );
  const evidence = await readJson(oldEvidencePath);
  options.mutateEvidence?.(evidence);
  const newEvidencePath =
    options.evidencePath === undefined
      ? oldEvidencePath
      : path.resolve(options.repositoryRoot, options.evidencePath);
  await mkdir(path.dirname(newEvidencePath), { recursive: true });
  await overwriteJson(newEvidencePath, evidence);
  const evidenceSha256 = sha256(await readFile(newEvidencePath));
  const evidenceRelative = path
    .relative(options.repositoryRoot, newEvidencePath)
    .replaceAll("\\", "/");
  caseEntry.evidence = {
    path: evidenceRelative,
    sha256: evidenceSha256,
  };

  const completedSequence = options.ordinal * 2;
  const checkpointPath = path.join(
    options.repositoryRoot,
    "docs",
    "smoke",
    "evidence",
    "batches",
    batchId,
    "checkpoints",
    `${String(completedSequence).padStart(6, "0")}.json`,
  );
  const checkpoint = await readJson(checkpointPath);
  checkpoint.evidence = {
    path: evidenceRelative,
    sha256: evidenceSha256,
  };
  await overwriteJson(checkpointPath, checkpoint);
  const checkpointSha256 = sha256(await readFile(checkpointPath));
  const checkpointReferences = manifest.checkpoints as Array<
    Record<string, unknown>
  >;
  checkpointReferences[completedSequence]!.sha256 = checkpointSha256;
  await overwriteJson(options.manifestPath, manifest);
}

async function expectVerificationFailure(
  repositoryRoot: string,
  manifestPath: string,
  mode: "frozen-candidate" | "immutable-evidence" = "immutable-evidence",
  currentCandidate?: FrozenCandidateSnapshot,
): Promise<void> {
  await expect(
    verifyQualification(
      { repositoryRoot, manifestPath, mode },
      currentCandidate === undefined
        ? {}
        : {
            collectCurrentCandidate: async () => currentCandidate,
            assertFrozenCandidate: async () => {},
          },
    ),
  ).rejects.toMatchObject({
    name: "QualificationVerificationError",
    message: "Qualification verification failed",
    category: "infrastructure",
    stage: "qualification_verifier",
    count: 1,
  });
}

describe("qualification verifier", () => {
  it("prints protocol identity and terminal state in verifier CLI output", async () => {
    let stdout = "";

    await expect(
      verifierMain({
        args: [
          "--mode",
          "immutable-evidence",
          "--manifest",
          `docs/smoke/evidence/batches/${historicalBatchId}/manifest.json`,
        ],
        repositoryRoot: process.cwd(),
        writeStdout: (text) => {
          stdout += text;
        },
        verify: async () => ({
          verified: true,
          mode: "immutable-evidence",
          batchId: historicalBatchId,
          qualificationPlanId: "five-llm-v1",
          status: "blocked",
          promotionEligible: false,
        }),
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      verified: true,
      mode: "immutable-evidence",
      batchId: historicalBatchId,
      qualificationPlanId: "five-llm-v1",
      status: "blocked",
      promotionEligible: false,
    });
  });

  it("verifies the real historical blocked batch as immutable five-llm-v1 evidence", async () => {
    const repositoryRoot = process.cwd();
    const manifestPath = path.join(
      repositoryRoot,
      "docs",
      "smoke",
      "evidence",
      "batches",
      historicalBatchId,
      "manifest.json",
    );

    await expect(
      verifyQualification({
        repositoryRoot,
        manifestPath,
        mode: "immutable-evidence",
      }),
    ).resolves.toMatchObject({
      verified: true,
      qualificationPlanId: "five-llm-v1",
      status: "blocked",
      promotionEligible: false,
    });
  });

  it("never admits a legacy batch to frozen-candidate promotion", async () => {
    const repositoryRoot = process.cwd();
    const manifestPath = path.join(
      repositoryRoot,
      "docs",
      "smoke",
      "evidence",
      "batches",
      historicalBatchId,
      "manifest.json",
    );
    let candidateCalls = 0;

    await expect(
      verifyQualification(
        {
          repositoryRoot,
          manifestPath,
          mode: "frozen-candidate",
        },
        {
          assertFrozenCandidate: async () => {
            candidateCalls += 1;
          },
          collectCurrentCandidate: async () => {
            candidateCalls += 1;
            return frozenCandidate();
          },
        },
      ),
    ).rejects.toBeInstanceOf(QualificationVerificationError);
    expect(candidateCalls).toBe(0);
  });

  it("keeps exact telemetry locked for coherently rewritten legacy failed evidence", async () => {
    const repositoryRoot = await tempRepository();
    const manifestPath = await copyHistoricalBatch(repositoryRoot);
    const manifest = await readJson(manifestPath);
    const caseEntry = (
      manifest.cases as Array<Record<string, unknown>>
    )[0]!;
    const evidenceReference = caseEntry.evidence as Record<string, unknown>;
    const evidencePath = path.resolve(
      repositoryRoot,
      evidenceReference.path as string,
    );
    const evidence = await readJson(evidencePath);
    evidence.adapterRetryCount = 1;
    await overwriteJson(evidencePath, evidence);
    const evidenceSha256 = sha256(await readFile(evidencePath));
    evidenceReference.sha256 = evidenceSha256;
    caseEntry.adapterRetryCount = 1;

    const checkpointPath = path.join(
      path.dirname(manifestPath),
      "checkpoints",
      "000002.json",
    );
    const checkpoint = await readJson(checkpointPath);
    (checkpoint.evidence as Record<string, unknown>).sha256 = evidenceSha256;
    checkpoint.adapterRetryCount = 1;
    await overwriteJson(checkpointPath, checkpoint);
    (
      (manifest.checkpoints as Array<Record<string, unknown>>)[2]!
    ).sha256 = sha256(await readFile(checkpointPath));
    await overwriteJson(manifestPath, manifest);

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("accepts a current blocked delegate whose failure checks correctly contain false", async () => {
    const repositoryRoot = await tempRepository();
    const manifestPath = await createCurrentBlockedBatch(repositoryRoot);

    await expect(
      verifyQualification({
        repositoryRoot,
        manifestPath,
        mode: "immutable-evidence",
      }),
    ).resolves.toMatchObject({
      verified: true,
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
      status: "blocked",
      promotionEligible: false,
    });
  });

  it("rejects current non-infrastructure failed evidence without task checks", async () => {
    const repositoryRoot = await tempRepository();
    const manifestPath = await createCurrentBlockedBatch(
      repositoryRoot,
      (evidence) => {
        delete evidence.checks;
      },
    );

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects current Pi failed evidence with a drifted config identity", async () => {
    const repositoryRoot = await tempRepository();
    const manifestPath = await createCurrentBlockedBatch(
      repositoryRoot,
      (evidence) => {
        evidence.configSha256 = "9".repeat(64);
      },
    );

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects current Pi failed evidence with a source credential instead of the child target", async () => {
    const repositoryRoot = await tempRepository();
    const manifestPath = await createCurrentBlockedBatch(repositoryRoot);
    await coherentlyRewriteEvidenceReference({
      repositoryRoot,
      manifestPath,
      ordinal: 1,
      mutateEvidence: (evidence) => {
        evidence.credentialEnv = "ARK_API_KEY";
      },
    });

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("accepts a current common-evidence missing credential failure with exact Pi identity and boolean task checks", async () => {
    const repositoryRoot = await tempRepository();
    const manifestPath = await createCurrentBlockedBatch(
      repositoryRoot,
      (evidence) => {
        evidence.status = "failed";
        evidence.failureReason = "missing_credential";
      },
    );

    await expect(
      verifyQualification({
        repositoryRoot,
        manifestPath,
        mode: "immutable-evidence",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      promotionEligible: false,
    });
  });

  it("accepts current infrastructure wrapper checks without Pi config or credential fields", async () => {
    const repositoryRoot = await tempRepository();
    const manifestPath = await createCurrentBlockedBatch(
      repositoryRoot,
      (evidence) => {
        evidence.status = "failed";
        evidence.actualModel = null;
        evidence.failureReason = "infrastructure_failure";
        evidence.adapterClientInvocationCount = null;
        evidence.adapterRetryCount = null;
        evidence.runtimeReportedAutoRetryCount = null;
        evidence.adapterReportedFallbackUsed = null;
        evidence.executionTelemetrySource = null;
        evidence.checks = {
          postProcessSnapshot: "not_reached",
          processCleanup: "unknown",
        };
        delete evidence.configSha256;
        delete evidence.credentialEnv;
        for (const key of [
          "expectedResultNormalizedSha256",
          "resultFileByteLength",
          "resultFileContainsExpectedLine",
          "resultFileNormalizedLineCount",
          "resultFileNormalizedSha256",
          "resultFileRawSha256",
          "resultFileReadStatus",
        ]) {
          delete evidence[key];
        }
      },
    );

    await expect(
      verifyQualification({
        repositoryRoot,
        manifestPath,
        mode: "immutable-evidence",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      promotionEligible: false,
    });
  });

  describe("command observation diagnostics", () => {
    it("accepts a valid Kimi delegate array", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot);

      await expect(
        verifyQualification({
          repositoryRoot,
          manifestPath,
          mode: "immutable-evidence",
        }),
      ).resolves.toMatchObject({
        verified: true,
        status: "passed",
        promotionEligible: true,
      });
    });

    it("accepts title-only diagnostics with zero commands on failed current Kimi evidence", async () => {
      const repositoryRoot = await tempRepository();
      const manifestPath = await createCurrentBlockedKimiDelegateBatch(
        repositoryRoot,
        (evidence) => {
          evidence.commandCount = 0;
          evidence.commandObservations = [
            { source: "title_fallback", match: "other" },
          ];
          const checks = evidence.checks as Record<string, unknown>;
          checks.requiredCommandObserved = false;
        },
      );

      await expect(
        verifyQualification({
          repositoryRoot,
          manifestPath,
          mode: "immutable-evidence",
        }),
      ).resolves.toMatchObject({
        verified: true,
        status: "blocked",
        promotionEligible: false,
      });
    });

    it("counts only raw and late-update observations as commands", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandCount = 2;
          evidence.commandObservations = [
            { source: "raw_input", match: "exact" },
            { source: "late_update", match: "embedded" },
            { source: "title_fallback", match: "other" },
            { source: "unextractable", match: "other" },
          ];
        },
      });

      await expect(
        verifyQualification({
          repositoryRoot,
          manifestPath,
          mode: "immutable-evidence",
        }),
      ).resolves.toMatchObject({
        verified: true,
        status: "passed",
        promotionEligible: true,
      });
    });

    it("keeps historical evidence without the field compatible", async () => {
      const repositoryRoot = await tempRepository();
      const manifestPath = await copyHistoricalBatch(repositoryRoot);

      await expect(
        verifyQualification({
          repositoryRoot,
          manifestPath,
          mode: "immutable-evidence",
        }),
      ).resolves.toMatchObject({
        verified: true,
        qualificationPlanId: "five-llm-v1",
        status: "blocked",
        promotionEligible: false,
      });
    });

    it("rejects a non-array field", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandObservations = {
            source: "raw_input",
            match: "exact",
          };
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects an unknown source", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandObservations = [
            { source: "unknown", match: "exact" },
          ];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects an unknown match", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandObservations = [
            { source: "raw_input", match: "unknown" },
            { source: "late_update", match: "exact" },
          ];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects extra item keys", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandObservations = [
            {
              source: "raw_input",
              match: "exact",
              command: "sensitive command",
            },
          ];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects more than 256 items", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandObservations = Array.from({ length: 257 }, () => ({
            source: "raw_input",
            match: "exact",
          }));
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects an array shorter than commandCount", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandCount = 2;
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects zero commandCount with an extractable observation", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandCount = 0;
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects commandCount below the extractable observation count", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandCount = 1;
          evidence.commandObservations = [
            { source: "raw_input", match: "exact" },
            { source: "late_update", match: "embedded" },
          ];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("accepts an unextractable observation beyond commandCount", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandCount = 1;
          evidence.commandObservations = [
            { source: "raw_input", match: "exact" },
            { source: "unextractable", match: "other" },
          ];
        },
      });

      await expect(
        verifyQualification({
          repositoryRoot,
          manifestPath,
          mode: "immutable-evidence",
        }),
      ).resolves.toMatchObject({
        verified: true,
        status: "passed",
        promotionEligible: true,
      });
    });

    it("rejects unextractable paired with a non-other match", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandObservations = [
            { source: "unextractable", match: "exact" },
          ];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects title fallback paired with exact on passed evidence", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandCount = 0;
          evidence.commandObservations = [
            { source: "title_fallback", match: "exact" },
          ];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects title fallback paired with exact on failed current evidence", async () => {
      const repositoryRoot = await tempRepository();
      const manifestPath = await createCurrentBlockedKimiDelegateBatch(
        repositoryRoot,
        (evidence) => {
          evidence.commandCount = 0;
          evidence.commandObservations = [
            { source: "title_fallback", match: "exact" },
          ];
          const checks = evidence.checks as Record<string, unknown>;
          checks.requiredCommandObserved = true;
        },
      );

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects true requiredCommandObserved without an exact item", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandObservations = [
            { source: "raw_input", match: "embedded" },
          ];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects exact when failed Kimi checks record false", async () => {
      const repositoryRoot = await tempRepository();
      const manifestPath = await createCurrentBlockedKimiDelegateBatch(
        repositoryRoot,
        (evidence) => {
          const checks = evidence.checks as Record<string, unknown>;
          checks.resultFileValid = true;
          checks.requiredCommandObserved = false;
        },
      );

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("accepts valid diagnostics on failed Kimi evidence", async () => {
      const repositoryRoot = await tempRepository();
      const manifestPath =
        await createCurrentBlockedKimiDelegateBatch(repositoryRoot);

      await expect(
        verifyQualification({
          repositoryRoot,
          manifestPath,
          mode: "immutable-evidence",
        }),
      ).resolves.toMatchObject({
        verified: true,
        status: "blocked",
        promotionEligible: false,
      });
    });

    it("rejects the field on Kimi review evidence", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "review") {
            return;
          }
          evidence.commandCount = 0;
          evidence.commandObservations = [];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects the field on Pi evidence", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.ordinal !== 1) return;
          evidence.commandCount = 1;
          evidence.commandObservations = [
            { source: "raw_input", match: "exact" },
          ];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
      "rejects a non-safe non-negative commandCount %s",
      async (commandCount) => {
        const repositoryRoot = await tempRepository();
        const { manifestPath } = await createPassedBatch(repositoryRoot, {
          mutateEvidence: (evidence, identity) => {
            if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
              return;
            }
            evidence.commandCount = commandCount;
          },
        });

        await expectVerificationFailure(repositoryRoot, manifestPath);
      },
    );

    it("rejects a non-record array item", async () => {
      const repositoryRoot = await tempRepository();
      const { manifestPath } = await createPassedBatch(repositoryRoot, {
        mutateEvidence: (evidence, identity) => {
          if (identity.llm !== "kimi-k3" || identity.task !== "delegate") {
            return;
          }
          evidence.commandObservations = [
            { source: "raw_input", match: "exact" },
            "invalid",
          ];
        },
      });

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });

    it("rejects infrastructure failure without delegate checks", async () => {
      const repositoryRoot = await tempRepository();
      const manifestPath = await createCurrentBlockedKimiDelegateBatch(
        repositoryRoot,
        (evidence) => {
          evidence.status = "failed";
          evidence.actualModel = null;
          evidence.failureReason = "infrastructure_failure";
          evidence.adapterClientInvocationCount = null;
          evidence.adapterRetryCount = null;
          evidence.runtimeReportedAutoRetryCount = null;
          evidence.adapterReportedFallbackUsed = null;
          evidence.executionTelemetrySource = null;
          evidence.checks = {
            postProcessSnapshot: "not_reached",
            processCleanup: "unknown",
          };
          for (const key of [
            "expectedResultNormalizedSha256",
            "resultFileByteLength",
            "resultFileContainsExpectedLine",
            "resultFileNormalizedLineCount",
            "resultFileNormalizedSha256",
            "resultFileRawSha256",
            "resultFileReadStatus",
          ]) {
            delete evidence[key];
          }
        },
      );

      await expectVerificationFailure(repositoryRoot, manifestPath);
    });
  });

  it("accepts a valid passed ledger in immutable-evidence mode without collecting current state", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    let currentStateCalls = 0;

    const result = await verifyQualification(
      {
        repositoryRoot,
        manifestPath,
        mode: "immutable-evidence",
      },
      {
        collectCurrentCandidate: async () => {
          currentStateCalls += 1;
          return frozenCandidate();
        },
      },
    );

    expect(result).toEqual({
      verified: true,
      mode: "immutable-evidence",
      batchId,
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
      status: "passed",
      promotionEligible: true,
    });
    expect(currentStateCalls).toBe(0);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      status: "passed",
      promotionEligible: true,
    });
  });

  it("recomputes and matches the frozen candidate state before promotion", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath, preflight } = await createPassedBatch(repositoryRoot);
    let currentStateCalls = 0;
    let frozenCandidateChecks = 0;

    const result = await verifyQualification(
      {
        repositoryRoot,
        manifestPath,
        mode: "frozen-candidate",
      },
      {
        assertFrozenCandidate: async ({ repositoryRoot: receivedRoot }) => {
          expect(receivedRoot).toBe(repositoryRoot);
          frozenCandidateChecks += 1;
        },
        collectCurrentCandidate: async (receivedRoot) => {
          expect(receivedRoot).toBe(repositoryRoot);
          currentStateCalls += 1;
          return frozenCandidate(preflight);
        },
      },
    );

    expect(result).toMatchObject({
      verified: true,
      mode: "frozen-candidate",
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
      status: "passed",
      promotionEligible: true,
    });
    expect(currentStateCalls).toBe(1);
    expect(frozenCandidateChecks).toBe(2);
  });

  it("rejects a same-plan manifest byte replacement during frozen candidate callbacks", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath, preflight } = await createPassedBatch(repositoryRoot);

    await expect(
      verifyQualification(
        {
          repositoryRoot,
          manifestPath,
          mode: "frozen-candidate",
        },
        {
          assertFrozenCandidate: async () => {},
          collectCurrentCandidate: async () => {
            await writeFile(
              manifestPath,
              `${await readFile(manifestPath, "utf8")} `,
              "utf8",
            );
            return frozenCandidate(preflight);
          },
        },
      ),
    ).rejects.toBeInstanceOf(QualificationVerificationError);
  });

  it("fails frozen verification closed when the repository write-set assertion is unavailable", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath, preflight } = await createPassedBatch(repositoryRoot);

    await expect(
      verifyQualification(
        {
          repositoryRoot,
          manifestPath,
          mode: "frozen-candidate",
        },
        {
          collectCurrentCandidate: async () => frozenCandidate(preflight),
        },
      ),
    ).rejects.toBeInstanceOf(QualificationVerificationError);
  });

  it("rejects passed evidence whose task acceptance checks are not all true", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot, {
      mutateEvidence: (evidence, identity) => {
        if (identity.ordinal !== 1) return;
        evidence.checks = {
          ...acceptanceChecks(identity),
          resultFileValid: false,
        };
      },
    });

    await expect(
      verifyQualification({
        repositoryRoot,
        manifestPath,
        mode: "immutable-evidence",
      }),
    ).rejects.toMatchObject({
      name: "QualificationVerificationError",
      message: "Qualification verification failed",
      category: "infrastructure",
      stage: "qualification_verifier",
      count: 1,
    });
  });

  it("rejects current HEAD drift only in frozen-candidate mode", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath, preflight } = await createPassedBatch(repositoryRoot);
    const drifted = {
      ...frozenCandidate(preflight),
      repositoryCommit: "f".repeat(40),
    };

    await expectVerificationFailure(
      repositoryRoot,
      manifestPath,
      "frozen-candidate",
      drifted,
    );
    await expect(
      verifyQualification(
        { repositoryRoot, manifestPath, mode: "immutable-evidence" },
        {
          collectCurrentCandidate: async () => drifted,
        },
      ),
    ).resolves.toMatchObject({ verified: true });
  });

  it("rejects hidden current snapshot fields instead of treating them as recomputed evidence", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath, preflight } = await createPassedBatch(repositoryRoot);
    const current = frozenCandidate(preflight);
    const artifacts = [...current.buildArtifacts];
    Object.defineProperty(artifacts, "0", {
      value: artifacts[0],
      enumerable: false,
      configurable: true,
      writable: true,
    });

    await expectVerificationFailure(
      repositoryRoot,
      manifestPath,
      "frozen-candidate",
      {
        ...current,
        buildArtifacts: artifacts,
      },
    );
  });

  it("rejects drift in every frozen candidate identity family", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath, preflight } = await createPassedBatch(repositoryRoot);
    const current = frozenCandidate(preflight);
    const driftedCandidates: FrozenCandidateSnapshot[] = [
      { ...current, packageVersion: "0.1.0-alpha.2" },
      { ...current, packageLockSha256: "9".repeat(64) },
      {
        ...current,
        buildArtifacts: current.buildArtifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, sha256: "9".repeat(64) } : artifact,
        ),
      },
      { ...current, buildIdentitySha256: "9".repeat(64) },
      {
        ...current,
        runtimeVersions: {
          ...current.runtimeVersions,
          codex: "codex-cli drifted",
        },
      },
      { ...current, piConfigSha256: "9".repeat(64) },
      {
        ...current,
        logicalLlms: current.logicalLlms.map((identity, index) =>
          index === 0 ? { ...identity, model: "drifted-model" } : identity,
        ),
      },
      {
        ...current,
        credentialMatches: current.credentialMatches.map((match, index) =>
          index === 0
            ? { ...match, environmentVariableName: "DRIFTED_ENV" }
            : match,
        ),
      },
    ];

    for (const drifted of driftedCandidates) {
      await expectVerificationFailure(
        repositoryRoot,
        manifestPath,
        "frozen-candidate",
        drifted,
      );
    }
  });

  it("rejects evidence byte tampering in immutable-evidence mode", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    const manifest = await readJson(manifestPath);
    const evidenceReference = (
      (manifest.cases as Array<Record<string, unknown>>)[0]!.evidence as Record<
        string,
        unknown
      >
    ).path as string;
    const evidencePath = path.resolve(repositoryRoot, evidenceReference);
    await writeFile(
      evidencePath,
      `${await readFile(evidencePath, "utf8")} `,
      "utf8",
    );

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects checkpoint hash drift in immutable-evidence mode", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    const checkpointPath = path.join(
      repositoryRoot,
      "docs",
      "smoke",
      "evidence",
      "batches",
      batchId,
      "checkpoints",
      "000002.json",
    );
    await writeFile(
      checkpointPath,
      `${await readFile(checkpointPath, "utf8")} `,
      "utf8",
    );

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects fixed model field drift even when internal references are recomputed", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    await coherentlyRewriteEvidenceReference({
      repositoryRoot,
      manifestPath,
      ordinal: 1,
      mutateEvidence: (evidence) => {
        evidence.expectedModel = "drifted-model";
      },
    });

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects evidence paths outside the batch cases directory", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    await coherentlyRewriteEvidenceReference({
      repositoryRoot,
      manifestPath,
      ordinal: 1,
      evidencePath: `docs/smoke/evidence/batches/${batchId}/outside.json`,
    });

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects mixed legacy v2 evidence in a current v3 batch even when its references are recomputed", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    await coherentlyRewriteEvidenceReference({
      repositoryRoot,
      manifestPath,
      ordinal: 1,
      mutateEvidence: (evidence) => {
        evidence.schemaVersion = 2;
      },
    });

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects telemetry other than 1/0/0/false/false after reference recomputation", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    await coherentlyRewriteEvidenceReference({
      repositoryRoot,
      manifestPath,
      ordinal: 1,
      mutateEvidence: (evidence) => {
        evidence.adapterRetryCount = 1;
      },
    });

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("binds Ark evidence to the child credential target while freezing the matched source name", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    await coherentlyRewriteEvidenceReference({
      repositoryRoot,
      manifestPath,
      ordinal: 1,
      mutateEvidence: (evidence) => {
        evidence.credentialEnv = "ARK_API_KEY";
      },
    });

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects a missing case evidence file", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    const manifest = await readJson(manifestPath);
    const evidenceReference = (
      (manifest.cases as Array<Record<string, unknown>>).at(-1)!
        .evidence as Record<
        string,
        unknown
      >
    ).path as string;
    await rm(path.resolve(repositoryRoot, evidenceReference));

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects extra or duplicate case evidence", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    const extraPath = path.join(
      repositoryRoot,
      "docs",
      "smoke",
      "evidence",
      "batches",
      batchId,
      "cases",
      "99.json",
    );
    await writeFile(extraPath, "{}\n", "utf8");

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects duplicate ordinal identities in the terminal manifest", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    const manifest = await readJson(manifestPath);
    const cases = manifest.cases as Array<Record<string, unknown>>;
    cases[1] = structuredClone(cases[0]!);
    await overwriteJson(manifestPath, manifest);

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects an unknown recorded qualification plan before evidence interpretation", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    const manifest = await readJson(manifestPath);
    manifest.qualificationPlanId = "unknown-plan";
    await overwriteJson(manifestPath, manifest);

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects manifest artifact identity tampering in immutable-evidence mode", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    const manifest = await readJson(manifestPath);
    const preflight = manifest.preflight as Record<string, unknown>;
    const artifacts = preflight.buildArtifacts as Array<
      Record<string, unknown>
    >;
    artifacts[0]!.sha256 = "9".repeat(64);
    await overwriteJson(manifestPath, manifest);

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects promotion field drift and never treats blocked data as eligible", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    const manifest = await readJson(manifestPath);
    manifest.promotionEligible = false;
    await overwriteJson(manifestPath, manifest);

    await expectVerificationFailure(repositoryRoot, manifestPath);
  });

  it("rejects a manifest path that escapes the fixed batch location", async () => {
    const repositoryRoot = await tempRepository();
    const { manifestPath } = await createPassedBatch(repositoryRoot);
    const outside = path.join(repositoryRoot, "manifest.json");
    await writeFile(outside, await readFile(manifestPath));

    await expectVerificationFailure(repositoryRoot, outside);
  });
});
