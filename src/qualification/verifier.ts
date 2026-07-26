import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { types as nodeUtilTypes } from "node:util";

import { resolveLlm } from "../llms/registry.js";
import {
  freezePreflightRecord,
  inspectQualificationTerminal,
  QualificationLedgerError,
} from "./manifest.js";
import type {
  BuildArtifactIdentity,
  FrozenCredentialMatch,
  FrozenLogicalLlmIdentity,
  FrozenPreflightRecord,
} from "./types.js";
import { QUALIFICATION_CASES } from "./types.js";

const MAX_VERIFIER_FILE_BYTES = 1_048_576;
const BATCH_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;

export type QualificationVerificationMode =
  "frozen-candidate" | "immutable-evidence";

export interface FrozenCandidateSnapshot {
  repositoryCommit: string;
  packageVersion: string;
  packageLockSha256: string;
  buildArtifacts: readonly BuildArtifactIdentity[];
  buildIdentitySha256: string;
  runtimeVersions: FrozenPreflightRecord["runtimeVersions"];
  piConfigSha256: string;
  logicalLlms: readonly FrozenLogicalLlmIdentity[];
  credentialMatches: readonly FrozenCredentialMatch[];
}

export interface QualificationVerifierDependencies {
  assertFrozenCandidate?: (options: {
    repositoryRoot: string;
    batchId: string;
    preflight: FrozenPreflightRecord;
  }) => Promise<void>;
  collectCurrentCandidate?: (
    repositoryRoot: string,
  ) => Promise<FrozenCandidateSnapshot>;
}

export interface VerifyQualificationOptions {
  repositoryRoot: string;
  manifestPath: string;
  mode: QualificationVerificationMode;
}

export interface QualificationVerificationResult {
  verified: true;
  mode: QualificationVerificationMode;
  batchId: string;
  promotionEligible: true;
}

export class QualificationVerificationError extends Error {
  readonly category = "infrastructure";
  readonly stage = "qualification_verifier";
  readonly count = 1;

  constructor() {
    super("Qualification verification failed");
    this.name = "QualificationVerificationError";
  }
}

interface LoadedJson {
  sha256: string;
  value: unknown;
}

async function readImmutableJson(filePath: string): Promise<LoadedJson> {
  let handle;
  try {
    const before = await lstat(filePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_VERIFIER_FILE_BYTES
    ) {
      throw new QualificationVerificationError();
    }
    handle = await open(filePath, "r");
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new QualificationVerificationError();
    }
    const raw = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < raw.length) {
      const result = await handle.read(
        raw,
        offset,
        raw.length - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        throw new QualificationVerificationError();
      }
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new QualificationVerificationError();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return {
      sha256: createHash("sha256").update(raw).digest("hex"),
      value: JSON.parse(text) as unknown,
    };
  } catch {
    throw new QualificationVerificationError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new QualificationVerificationError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new QualificationVerificationError();
    }
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function resolveManifestLocation(options: VerifyQualificationOptions): {
  manifestPath: string;
  batchId: string;
} {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const manifestPath = path.resolve(repositoryRoot, options.manifestPath);
  const relative = path
    .relative(repositoryRoot, manifestPath)
    .replaceAll("\\", "/");
  const match =
    /^docs\/smoke\/evidence\/batches\/([^/]+)\/manifest\.json$/u.exec(relative);
  const batchId = match?.[1];
  if (
    batchId === undefined ||
    !BATCH_ID_PATTERN.test(batchId) ||
    batchId === "." ||
    batchId === ".."
  ) {
    throw new QualificationVerificationError();
  }
  return { manifestPath, batchId };
}

function validatePassedManifest(
  value: unknown,
  batchId: string,
): Record<string, unknown> {
  const manifest = plainRecord(value);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.batchId !== batchId ||
    manifest.status !== "passed" ||
    manifest.promotionEligible !== true ||
    manifest.stopReason !== null ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== QUALIFICATION_CASES.length ||
    !Array.isArray(manifest.notRun) ||
    manifest.notRun.length !== 0 ||
    manifest.uncommittedEvidence !== null
  ) {
    throw new QualificationVerificationError();
  }
  for (let index = 0; index < QUALIFICATION_CASES.length; index += 1) {
    const expected = QUALIFICATION_CASES[index]!;
    const actual = plainRecord(manifest.cases[index]);
    if (
      actual.ordinal !== expected.ordinal ||
      actual.llm !== expected.llm ||
      actual.task !== expected.task ||
      actual.result !== "passed"
    ) {
      throw new QualificationVerificationError();
    }
  }
  return manifest;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function expectedChecks(
  identity: (typeof QUALIFICATION_CASES)[number],
  runtime: FrozenLogicalLlmIdentity["runtime"],
): readonly string[] {
  const processCheck =
    runtime === "kimi-acp" ? "noNewKimiProcesses" : "noNewPiRpcProcesses";
  const environmentCheck = runtime === "pi-rpc" ? ["environmentIsolated"] : [];
  return identity.task === "review"
    ? [
        "actualModelMatches",
        ...environmentCheck,
        "executionTelemetryValid",
        "knownDefectFound",
        processCheck,
        "workspaceUnchanged",
      ].sort()
    : [
        "actualModelMatches",
        ...environmentCheck,
        "executionTelemetryValid",
        processCheck,
        "onlyExpectedFileChanged",
        "requiredCommandObserved",
        "resultFileObserved",
        "resultFileValid",
      ].sort();
}

function expectedResultLine(
  identity: (typeof QUALIFICATION_CASES)[number],
): string {
  if (identity.llm === "kimi-k3") return "KIMI_SMOKE_OK";
  if (identity.llm === "gemini-3.5-flash") return "PI_SMOKE_OK";
  return `ARK_SMOKE_OK:${identity.llm}`;
}

function validateTaskAcceptance(
  evidence: Record<string, unknown>,
  identity: (typeof QUALIFICATION_CASES)[number],
  runtime: FrozenLogicalLlmIdentity["runtime"],
): void {
  const checks = plainRecord(evidence.checks);
  const actualKeys = Object.keys(checks).sort();
  const requiredKeys = expectedChecks(identity, runtime);
  if (
    actualKeys.length !== requiredKeys.length ||
    actualKeys.some((key, index) => key !== requiredKeys[index]) ||
    requiredKeys.some((key) => checks[key] !== true)
  ) {
    throw new QualificationVerificationError();
  }
  if (identity.task === "review") {
    const delegateOnlyKeys = [
      "expectedResultNormalizedSha256",
      "resultFileByteLength",
      "resultFileContainsExpectedLine",
      "resultFileNormalizedLineCount",
      "resultFileNormalizedSha256",
      "resultFileRawSha256",
      "resultFileReadStatus",
    ];
    if (delegateOnlyKeys.some((key) => Object.hasOwn(evidence, key))) {
      throw new QualificationVerificationError();
    }
    return;
  }
  const expectedHash = createHash("sha256")
    .update(expectedResultLine(identity))
    .digest("hex");
  if (
    evidence.resultFileReadStatus !== "read" ||
    typeof evidence.resultFileByteLength !== "number" ||
    !Number.isSafeInteger(evidence.resultFileByteLength) ||
    evidence.resultFileByteLength <= 0 ||
    evidence.resultFileByteLength > 65_536 ||
    typeof evidence.resultFileRawSha256 !== "string" ||
    !SHA256_PATTERN.test(evidence.resultFileRawSha256) ||
    evidence.resultFileNormalizedSha256 !== expectedHash ||
    evidence.expectedResultNormalizedSha256 !== expectedHash ||
    evidence.resultFileNormalizedLineCount !== 1 ||
    evidence.resultFileContainsExpectedLine !== true
  ) {
    throw new QualificationVerificationError();
  }
}

function validateQualificationIdentity(
  evidence: Record<string, unknown>,
  identity: (typeof QUALIFICATION_CASES)[number],
  preflight: FrozenPreflightRecord,
  authorizationReferenceSha256: unknown,
  batchId: string,
): void {
  const qualification = plainRecord(evidence.qualification);
  const qualificationKeys = Object.keys(qualification).sort();
  const expectedQualificationKeys = [
    "authorizationReferenceSha256",
    "batchId",
    "buildIdentitySha256",
    "orchestratorFallbackUsed",
    "ordinal",
    "repositoryCommit",
  ];
  if (
    qualificationKeys.length !== expectedQualificationKeys.length ||
    qualificationKeys.some(
      (key, index) => key !== expectedQualificationKeys[index],
    ) ||
    qualification.batchId !== batchId ||
    qualification.ordinal !== identity.ordinal ||
    qualification.repositoryCommit !== preflight.repositoryCommit ||
    qualification.buildIdentitySha256 !== preflight.buildIdentitySha256 ||
    qualification.authorizationReferenceSha256 !==
      authorizationReferenceSha256 ||
    qualification.orchestratorFallbackUsed !== false
  ) {
    throw new QualificationVerificationError();
  }
}

function validateEvidenceIdentityAndAcceptance(
  evidenceValue: unknown,
  identity: (typeof QUALIFICATION_CASES)[number],
  preflight: FrozenPreflightRecord,
  authorizationReferenceSha256: unknown,
  batchId: string,
): void {
  const evidence = plainRecord(evidenceValue);
  const logicalIdentity = preflight.logicalLlms.find(
    (candidate) => candidate.llm === identity.llm,
  );
  const credential = preflight.credentialMatches.find(
    (candidate) => candidate.llm === identity.llm,
  );
  if (logicalIdentity === undefined || credential === undefined) {
    throw new QualificationVerificationError();
  }
  validateQualificationIdentity(
    evidence,
    identity,
    preflight,
    authorizationReferenceSha256,
    batchId,
  );
  const expectedTelemetrySource =
    logicalIdentity.runtime === "kimi-acp"
      ? "kimi-acp-observable"
      : "pi-rpc-observable";
  if (
    evidence.schemaVersion !== 2 ||
    evidence.llm !== identity.llm ||
    evidence.task !== identity.task ||
    evidence.status !== "completed" ||
    evidence.passed !== true ||
    evidence.failureReason !== null ||
    evidence.actualModel !== logicalIdentity.model ||
    evidence.expectedModel !== logicalIdentity.model ||
    evidence.runtime !== logicalIdentity.runtime ||
    evidence.route !== logicalIdentity.route ||
    evidence.adapterClientInvocationCount !== 1 ||
    evidence.adapterRetryCount !== 0 ||
    evidence.runtimeReportedAutoRetryCount !== 0 ||
    evidence.adapterReportedFallbackUsed !== false ||
    evidence.orchestratorFallbackUsed !== false ||
    evidence.executionTelemetrySource !== expectedTelemetrySource
  ) {
    throw new QualificationVerificationError();
  }
  if (logicalIdentity.runtime === "pi-rpc") {
    const profile = resolveLlm(identity.llm);
    const expectedChildCredentialName =
      profile.credentialTargetEnv ?? credential.environmentVariableName;
    if (
      evidence.provider !== logicalIdentity.provider ||
      evidence.configSha256 !== preflight.piConfigSha256 ||
      evidence.credentialEnv !== expectedChildCredentialName
    ) {
      throw new QualificationVerificationError();
    }
  } else if (
    Object.hasOwn(evidence, "provider") ||
    Object.hasOwn(evidence, "configSha256") ||
    Object.hasOwn(evidence, "credentialEnv")
  ) {
    throw new QualificationVerificationError();
  }
  validateTaskAcceptance(evidence, identity, logicalIdentity.runtime);
}

async function validateManifestEvidence(
  repositoryRoot: string,
  batchId: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const preflight = freezePreflightRecord(manifest.preflight);
  const batchCasesDirectory = path.resolve(
    repositoryRoot,
    "docs",
    "smoke",
    "evidence",
    "batches",
    batchId,
    "cases",
  );
  const cases = manifest.cases as unknown[];
  for (let index = 0; index < QUALIFICATION_CASES.length; index += 1) {
    const identity = QUALIFICATION_CASES[index]!;
    const entry = plainRecord(cases[index]);
    const reference = plainRecord(entry.evidence);
    if (
      typeof reference.path !== "string" ||
      typeof reference.sha256 !== "string" ||
      !SHA256_PATTERN.test(reference.sha256)
    ) {
      throw new QualificationVerificationError();
    }
    const evidencePath = path.resolve(repositoryRoot, reference.path);
    if (
      path.dirname(evidencePath) !== batchCasesDirectory ||
      path.extname(evidencePath) !== ".json" ||
      path.basename(evidencePath) === "." ||
      path.basename(evidencePath) === ".."
    ) {
      throw new QualificationVerificationError();
    }
    const loaded = await readImmutableJson(evidencePath);
    if (loaded.sha256 !== reference.sha256) {
      throw new QualificationVerificationError();
    }
    validateEvidenceIdentityAndAcceptance(
      loaded.value,
      identity,
      preflight,
      manifest.authorizationReferenceSha256,
      batchId,
    );
  }
}

const FROZEN_CANDIDATE_KEYS = [
  "buildArtifacts",
  "buildIdentitySha256",
  "credentialMatches",
  "logicalLlms",
  "packageLockSha256",
  "packageVersion",
  "piConfigSha256",
  "repositoryCommit",
  "runtimeVersions",
] as const;

function frozenCandidateFromPreflight(
  preflight: FrozenPreflightRecord,
): FrozenCandidateSnapshot {
  return Object.freeze({
    repositoryCommit: preflight.repositoryCommit,
    packageVersion: preflight.packageVersion,
    packageLockSha256: preflight.packageLockSha256,
    buildArtifacts: preflight.buildArtifacts,
    buildIdentitySha256: preflight.buildIdentitySha256,
    runtimeVersions: preflight.runtimeVersions,
    piConfigSha256: preflight.piConfigSha256,
    logicalLlms: preflight.logicalLlms,
    credentialMatches: preflight.credentialMatches,
  });
}

function snapshotPlainJson(
  value: unknown,
  ancestors: Set<object> = new Set(),
  depth = 0,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new QualificationVerificationError();
    }
    return value;
  }
  if (typeof value !== "object" || depth > 32 || nodeUtilTypes.isProxy(value)) {
    throw new QualificationVerificationError();
  }
  if (ancestors.has(value)) throw new QualificationVerificationError();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        throw new QualificationVerificationError();
      }
      const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
        string,
        PropertyDescriptor
      >;
      const lengthDescriptor = descriptors.length;
      const values = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        lengthDescriptor.value !== value.length ||
        values.length !== value.length ||
        values.some((key, index) => key !== String(index)) ||
        values.some((key) => {
          const descriptor = descriptors[key]!;
          return (
            descriptor.enumerable !== true ||
            !Object.hasOwn(descriptor, "value") ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined
          );
        })
      ) {
        throw new QualificationVerificationError();
      }
      return values.map((key) =>
        snapshotPlainJson(
          (descriptors[key] as PropertyDescriptor).value,
          ancestors,
          depth + 1,
        ),
      );
    }
    const record = plainRecord(value);
    if (Object.hasOwn(record, "toJSON")) {
      throw new QualificationVerificationError();
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        snapshotPlainJson(item, ancestors, depth + 1),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function normalizeCurrentCandidate(value: unknown): FrozenCandidateSnapshot {
  const record = plainRecord(value);
  const keys = Object.keys(record).sort();
  if (
    keys.length !== FROZEN_CANDIDATE_KEYS.length ||
    keys.some((key, index) => key !== FROZEN_CANDIDATE_KEYS[index])
  ) {
    throw new QualificationVerificationError();
  }
  return snapshotPlainJson(record) as FrozenCandidateSnapshot;
}

export async function verifyQualification(
  options: VerifyQualificationOptions,
  dependencies: QualificationVerifierDependencies = {},
): Promise<QualificationVerificationResult> {
  try {
    if (
      options.mode !== "frozen-candidate" &&
      options.mode !== "immutable-evidence"
    ) {
      throw new QualificationVerificationError();
    }
    const location = resolveManifestLocation(options);
    const firstInspection = await inspectQualificationTerminal({
      repositoryRoot: options.repositoryRoot,
      batchId: location.batchId,
    });
    if (firstInspection.state !== "valid") {
      throw new QualificationVerificationError();
    }
    const manifest = validatePassedManifest(
      (await readImmutableJson(location.manifestPath)).value,
      location.batchId,
    );
    await validateManifestEvidence(
      options.repositoryRoot,
      location.batchId,
      manifest,
    );
    const secondInspection = await inspectQualificationTerminal({
      repositoryRoot: options.repositoryRoot,
      batchId: location.batchId,
    });
    if (secondInspection.state !== "valid") {
      throw new QualificationVerificationError();
    }
    if (options.mode === "frozen-candidate") {
      if (
        dependencies.assertFrozenCandidate === undefined ||
        dependencies.collectCurrentCandidate === undefined
      ) {
        throw new QualificationVerificationError();
      }
      const preflight = freezePreflightRecord(manifest.preflight);
      await dependencies.assertFrozenCandidate({
        repositoryRoot: options.repositoryRoot,
        batchId: location.batchId,
        preflight,
      });
      const current = normalizeCurrentCandidate(
        await dependencies.collectCurrentCandidate(options.repositoryRoot),
      );
      await dependencies.assertFrozenCandidate({
        repositoryRoot: options.repositoryRoot,
        batchId: location.batchId,
        preflight,
      });
      const expected = snapshotPlainJson(
        frozenCandidateFromPreflight(preflight),
      );
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new QualificationVerificationError();
      }
    }
    return Object.freeze({
      verified: true,
      mode: options.mode,
      batchId: location.batchId,
      promotionEligible: true,
    });
  } catch (error) {
    if (
      error instanceof QualificationVerificationError ||
      error instanceof QualificationLedgerError
    ) {
      throw new QualificationVerificationError();
    }
    throw new QualificationVerificationError();
  }
}
