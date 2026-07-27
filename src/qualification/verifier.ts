import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { types as nodeUtilTypes } from "node:util";

import {
  freezePreflightRecord,
  inspectQualificationTerminal,
  QualificationLedgerError,
} from "./manifest.js";
import {
  ACTIVE_QUALIFICATION_CASES,
  ACTIVE_QUALIFICATION_PLAN_ID,
  LEGACY_QUALIFICATION_CASES,
  LEGACY_QUALIFICATION_PLAN_ID,
  type QualificationPlanId,
} from "./protocol.js";
import type {
  BuildArtifactIdentity,
  FrozenCredentialMatch,
  FrozenLogicalLlmIdentity,
  FrozenPreflightRecord,
  QualificationCaseIdentity,
  QualificationManifestStatus,
} from "./types.js";

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
  qualificationPlanId: QualificationPlanId;
  status: QualificationManifestStatus;
  promotionEligible: boolean;
}

interface VerifierProtocol {
  readonly planId: QualificationPlanId;
  readonly manifestSchemaVersion: 1 | 2;
  readonly evidenceSchemaVersion: 2 | 3;
  readonly schedule: readonly Readonly<QualificationCaseIdentity>[];
}

const LEGACY_VERIFIER_PROTOCOL: VerifierProtocol = Object.freeze({
  planId: LEGACY_QUALIFICATION_PLAN_ID,
  manifestSchemaVersion: 1,
  evidenceSchemaVersion: 2,
  schedule: LEGACY_QUALIFICATION_CASES,
});

const CURRENT_VERIFIER_PROTOCOL: VerifierProtocol = Object.freeze({
  planId: ACTIVE_QUALIFICATION_PLAN_ID,
  manifestSchemaVersion: 2,
  evidenceSchemaVersion: 3,
  schedule: ACTIVE_QUALIFICATION_CASES,
});

function verifierProtocol(planId: QualificationPlanId): VerifierProtocol {
  return planId === LEGACY_QUALIFICATION_PLAN_ID
    ? LEGACY_VERIFIER_PROTOCOL
    : CURRENT_VERIFIER_PROTOCOL;
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

function validateTerminalManifest(
  value: unknown,
  batchId: string,
  protocol: VerifierProtocol,
  mode: QualificationVerificationMode,
): Record<string, unknown> {
  const manifest = plainRecord(value);
  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  const notRun = Array.isArray(manifest.notRun) ? manifest.notRun : [];
  const status = manifest.status;
  if (
    manifest.schemaVersion !== protocol.manifestSchemaVersion ||
    (protocol === LEGACY_VERIFIER_PROTOCOL
      ? Object.hasOwn(manifest, "qualificationPlanId")
      : manifest.qualificationPlanId !== ACTIVE_QUALIFICATION_PLAN_ID) ||
    manifest.batchId !== batchId ||
    (status !== "passed" &&
      status !== "blocked" &&
      status !== "interrupted") ||
    !Array.isArray(manifest.cases) ||
    !Array.isArray(manifest.notRun) ||
    typeof manifest.promotionEligible !== "boolean"
  ) {
    throw new QualificationVerificationError();
  }
  for (let index = 0; index < cases.length; index += 1) {
    const expected = protocol.schedule[index];
    const actual = plainRecord(cases[index]);
    if (
      expected === undefined ||
      actual.ordinal !== expected.ordinal ||
      actual.llm !== expected.llm ||
      actual.task !== expected.task
    ) {
      throw new QualificationVerificationError();
    }
  }
  if (mode === "frozen-candidate") {
    if (
      protocol !== CURRENT_VERIFIER_PROTOCOL ||
      status !== "passed" ||
      manifest.promotionEligible !== true ||
      manifest.stopReason !== null ||
      cases.length !== protocol.schedule.length ||
      cases.some((entry) => plainRecord(entry).result !== "passed") ||
      notRun.length !== 0 ||
      manifest.uncommittedEvidence !== null
    ) {
      throw new QualificationVerificationError();
    }
  } else if (
    status === "passed" &&
    (manifest.promotionEligible !== true ||
      cases.length !== protocol.schedule.length ||
      notRun.length !== 0)
  ) {
    throw new QualificationVerificationError();
  }
  return manifest;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function expectedChecks(
  identity: Readonly<QualificationCaseIdentity>,
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
  protocol: VerifierProtocol,
  identity: Readonly<QualificationCaseIdentity>,
): string {
  if (identity.llm === "kimi-k3") return "KIMI_SMOKE_OK";
  if (
    protocol === LEGACY_VERIFIER_PROTOCOL &&
    identity.llm === "gemini-3.5-flash"
  ) {
    return "PI_SMOKE_OK";
  }
  return `ARK_SMOKE_OK:${identity.llm}`;
}

function validateTaskCheckShape(
  evidence: Record<string, unknown>,
  identity: Readonly<QualificationCaseIdentity>,
  runtime: FrozenLogicalLlmIdentity["runtime"],
): Record<string, unknown> {
  const checks = plainRecord(evidence.checks);
  const actualKeys = Object.keys(checks).sort();
  const requiredKeys = expectedChecks(identity, runtime);
  if (
    actualKeys.length !== requiredKeys.length ||
    actualKeys.some((key, index) => key !== requiredKeys[index]) ||
    requiredKeys.some((key) => typeof checks[key] !== "boolean")
  ) {
    throw new QualificationVerificationError();
  }
  return checks;
}

function validatePassedTaskAcceptance(
  evidence: Record<string, unknown>,
  protocol: VerifierProtocol,
  identity: Readonly<QualificationCaseIdentity>,
  runtime: FrozenLogicalLlmIdentity["runtime"],
): void {
  const checks = validateTaskCheckShape(evidence, identity, runtime);
  if (Object.values(checks).some((value) => value !== true)) {
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
    .update(expectedResultLine(protocol, identity))
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

const COMMAND_OBSERVATION_SOURCES = new Set([
  "raw_input",
  "title_fallback",
  "late_update",
  "unextractable",
]);
const COMMAND_OBSERVATION_MATCHES = new Set([
  "exact",
  "trim_only",
  "embedded",
  "other",
]);

function validateCommandObservationDiagnostics(
  evidence: Record<string, unknown>,
  identity: Readonly<QualificationCaseIdentity>,
  runtime: FrozenLogicalLlmIdentity["runtime"],
): void {
  if (!Object.hasOwn(evidence, "commandObservations")) return;
  if (
    identity.llm !== "kimi-k3" ||
    identity.task !== "delegate" ||
    runtime !== "kimi-acp"
  ) {
    throw new QualificationVerificationError();
  }

  const observations = evidence.commandObservations;
  if (
    !Array.isArray(observations) ||
    nodeUtilTypes.isProxy(observations) ||
    Object.getPrototypeOf(observations) !== Array.prototype ||
    Object.getOwnPropertySymbols(observations).length !== 0 ||
    observations.length > 256
  ) {
    throw new QualificationVerificationError();
  }
  const commandCount = evidence.commandCount;
  const descriptors = Object.getOwnPropertyDescriptors(observations) as Record<
    string,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  const itemKeys = Object.keys(descriptors).filter((key) => key !== "length");
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    lengthDescriptor.value !== observations.length ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false ||
    lengthDescriptor.writable !== true ||
    itemKeys.length !== observations.length ||
    itemKeys.some((key, index) => key !== String(index)) ||
    itemKeys.some((key) => {
      const descriptor = descriptors[key]!;
      return (
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      );
    }) ||
    typeof commandCount !== "number" ||
    !Number.isSafeInteger(commandCount) ||
    commandCount < 0 ||
    observations.length < commandCount
  ) {
    throw new QualificationVerificationError();
  }

  let hasExact = false;
  let commandObservationCount = 0;
  for (const key of itemKeys) {
    const observation = plainRecord(descriptors[key]!.value);
    const observationKeys = Object.keys(observation).sort();
    if (
      observationKeys.length !== 2 ||
      observationKeys[0] !== "match" ||
      observationKeys[1] !== "source" ||
      typeof observation.source !== "string" ||
      !COMMAND_OBSERVATION_SOURCES.has(observation.source) ||
      typeof observation.match !== "string" ||
      !COMMAND_OBSERVATION_MATCHES.has(observation.match) ||
      ((observation.source === "title_fallback" ||
        observation.source === "unextractable") &&
        observation.match !== "other")
    ) {
      throw new QualificationVerificationError();
    }
    if (
      observation.source === "raw_input" ||
      observation.source === "late_update"
    ) {
      commandObservationCount += 1;
    }
    if (observation.match === "exact") hasExact = true;
  }

  const checks = plainRecord(evidence.checks);
  if (
    commandObservationCount !== commandCount ||
    typeof checks.requiredCommandObserved !== "boolean" ||
    hasExact !== checks.requiredCommandObserved
  ) {
    throw new QualificationVerificationError();
  }
}

function validateQualificationIdentity(
  evidence: Record<string, unknown>,
  protocol: VerifierProtocol,
  identity: Readonly<QualificationCaseIdentity>,
  preflight: FrozenPreflightRecord,
  authorizationReferenceSha256: unknown,
  batchId: string,
): void {
  const qualification = plainRecord(evidence.qualification);
  const qualificationKeys = Object.keys(qualification).sort();
  const expectedQualificationKeys =
    protocol === LEGACY_VERIFIER_PROTOCOL
      ? [
          "authorizationReferenceSha256",
          "batchId",
          "buildIdentitySha256",
          "orchestratorFallbackUsed",
          "ordinal",
          "repositoryCommit",
        ]
      : [
          "authorizationReferenceSha256",
          "batchId",
          "frozenBuildIdentity",
          "frozenCommit",
          "llm",
          "orchestratorFallbackUsed",
          "ordinal",
          "qualificationPlanId",
          "task",
        ];
  const frozenIdentityMatches =
    protocol === LEGACY_VERIFIER_PROTOCOL
      ? qualification.repositoryCommit === preflight.repositoryCommit &&
        qualification.buildIdentitySha256 === preflight.buildIdentitySha256
      : qualification.qualificationPlanId === ACTIVE_QUALIFICATION_PLAN_ID &&
        qualification.llm === identity.llm &&
        qualification.task === identity.task &&
        qualification.frozenCommit === preflight.repositoryCommit &&
        qualification.frozenBuildIdentity === preflight.buildIdentitySha256;
  if (
    qualificationKeys.length !== expectedQualificationKeys.length ||
    qualificationKeys.some(
      (key, index) => key !== expectedQualificationKeys[index],
    ) ||
    qualification.batchId !== batchId ||
    qualification.ordinal !== identity.ordinal ||
    !frozenIdentityMatches ||
    qualification.authorizationReferenceSha256 !==
      authorizationReferenceSha256 ||
    qualification.orchestratorFallbackUsed !== false
  ) {
    throw new QualificationVerificationError();
  }
}

function validateEvidenceIdentityAndAcceptance(
  evidenceValue: unknown,
  manifestEntry: Record<string, unknown>,
  protocol: VerifierProtocol,
  identity: Readonly<QualificationCaseIdentity>,
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
    protocol,
    identity,
    preflight,
    authorizationReferenceSha256,
    batchId,
  );
  const expectedTelemetrySource =
    logicalIdentity.runtime === "kimi-acp"
      ? "kimi-acp-observable"
      : "pi-rpc-observable";
  const requiresExactTelemetry =
    protocol === LEGACY_VERIFIER_PROTOCOL ||
    manifestEntry.result === "passed";
  const isPassed = manifestEntry.result === "passed";
  const isCurrentInfrastructureFailure =
    protocol === CURRENT_VERIFIER_PROTOCOL &&
    !isPassed &&
    evidence.failureReason === "infrastructure_failure";
  const statusMatchesProtocol =
    isPassed
      ? evidence.status === "completed"
      : protocol === LEGACY_VERIFIER_PROTOCOL
        ? evidence.status === "failed"
        : true;
  if (
    evidence.schemaVersion !== protocol.evidenceSchemaVersion ||
    evidence.llm !== identity.llm ||
    evidence.task !== identity.task ||
    evidence.passed !== isPassed ||
    evidence.failureReason !== manifestEntry.failureReason ||
    !statusMatchesProtocol ||
    (isPassed && evidence.actualModel !== logicalIdentity.model) ||
    evidence.expectedModel !== logicalIdentity.model ||
    evidence.runtime !== logicalIdentity.runtime ||
    evidence.route !== logicalIdentity.route ||
    (requiresExactTelemetry &&
      (evidence.adapterClientInvocationCount !== 1 ||
        evidence.adapterRetryCount !== 0 ||
        evidence.runtimeReportedAutoRetryCount !== 0 ||
        evidence.adapterReportedFallbackUsed !== false ||
        evidence.orchestratorFallbackUsed !== false ||
        evidence.executionTelemetrySource !== expectedTelemetrySource))
  ) {
    throw new QualificationVerificationError();
  }
  if (logicalIdentity.runtime === "pi-rpc") {
    const expectedChildCredentialName =
      identity.llm === "ark-coding-plan"
        ? "CODEX_AGENT_ARK_CODING_KEY"
        : identity.llm === "ark-agent-plan" ||
            identity.llm === "ark-agent-deepseek-v4-flash"
          ? "CODEX_AGENT_ARK_AGENT_KEY"
          : credential.environmentVariableName;
    if (
      evidence.provider !== logicalIdentity.provider ||
      (!isCurrentInfrastructureFailure &&
        (evidence.configSha256 !== preflight.piConfigSha256 ||
          evidence.credentialEnv !== expectedChildCredentialName)) ||
      (isCurrentInfrastructureFailure &&
        ((Object.hasOwn(evidence, "configSha256") &&
          evidence.configSha256 !== preflight.piConfigSha256) ||
          (Object.hasOwn(evidence, "credentialEnv") &&
            evidence.credentialEnv !== expectedChildCredentialName)))
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
  if (isPassed || protocol === LEGACY_VERIFIER_PROTOCOL) {
    validatePassedTaskAcceptance(
      evidence,
      protocol,
      identity,
      logicalIdentity.runtime,
    );
  } else {
    validateCurrentFailedSemantics(
      evidence,
      identity,
      logicalIdentity.runtime,
    );
  }
  validateCommandObservationDiagnostics(
    evidence,
    identity,
    logicalIdentity.runtime,
  );
}

const COMMON_EVIDENCE_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "workspace_changed",
]);

function validateInfrastructureChecks(
  evidence: Record<string, unknown>,
): void {
  const checks = plainRecord(evidence.checks);
  const keys = Object.keys(checks).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "postProcessSnapshot" ||
    keys[1] !== "processCleanup" ||
    (checks.postProcessSnapshot !== "unknown" &&
      checks.postProcessSnapshot !== "not_reached") ||
    checks.processCleanup !== "unknown"
  ) {
    throw new QualificationVerificationError();
  }
}

function validateCurrentFailedSemantics(
  evidence: Record<string, unknown>,
  identity: Readonly<QualificationCaseIdentity>,
  runtime: FrozenLogicalLlmIdentity["runtime"],
): void {
  const failureReason = evidence.failureReason;
  if (failureReason === "infrastructure_failure") {
    if (evidence.status !== "failed") {
      throw new QualificationVerificationError();
    }
    validateInfrastructureChecks(evidence);
    return;
  }
  if (!COMMON_EVIDENCE_STATUSES.has(String(evidence.status))) {
    throw new QualificationVerificationError();
  }
  const checks = validateTaskCheckShape(evidence, identity, runtime);
  if (failureReason === "acceptance_failed") {
    if (
      evidence.status !== "completed" ||
      Object.values(checks).every((value) => value === true)
    ) {
      throw new QualificationVerificationError();
    }
    return;
  }
  if (failureReason === "process_residual") {
    if (
      runtime !== "kimi-acp" ||
      checks.noNewKimiProcesses !== false
    ) {
      throw new QualificationVerificationError();
    }
    return;
  }
  if (
    (failureReason === "adapter_auth_or_model_unavailable" &&
      (runtime !== "kimi-acp" || evidence.status === "completed")) ||
    (failureReason === "adapter_failure" &&
      (runtime !== "pi-rpc" || evidence.status === "completed")) ||
    ((failureReason === "missing_credential" ||
      failureReason === "account_quota_exceeded") &&
      runtime !== "pi-rpc")
  ) {
    throw new QualificationVerificationError();
  }
}

async function validateManifestEvidence(
  repositoryRoot: string,
  batchId: string,
  manifest: Record<string, unknown>,
  protocol: VerifierProtocol,
): Promise<void> {
  const preflight = freezePreflightRecord(manifest.preflight);
  if (
    (protocol === LEGACY_VERIFIER_PROTOCOL
      ? preflight.schemaVersion !== 1
      : preflight.schemaVersion !== 2 ||
        preflight.qualificationPlanId !== ACTIVE_QUALIFICATION_PLAN_ID)
  ) {
    throw new QualificationVerificationError();
  }
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
  for (let index = 0; index < cases.length; index += 1) {
    const identity = protocol.schedule[index];
    if (identity === undefined) {
      throw new QualificationVerificationError();
    }
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
      entry,
      protocol,
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

async function assertTerminalStable(options: {
  repositoryRoot: string;
  location: { readonly manifestPath: string; readonly batchId: string };
  qualificationPlanId: QualificationPlanId;
  authorizationReferenceSha256: string;
  manifestSha256: string;
}): Promise<void> {
  const finalInspection = await inspectQualificationTerminal({
    repositoryRoot: options.repositoryRoot,
    batchId: options.location.batchId,
  });
  if (
    finalInspection.state !== "valid" ||
    finalInspection.batchId !== options.location.batchId ||
    finalInspection.authorizationReferenceSha256 !==
      options.authorizationReferenceSha256 ||
    finalInspection.qualificationPlanId !== options.qualificationPlanId
  ) {
    throw new QualificationVerificationError();
  }
  const finalManifest = await readImmutableJson(options.location.manifestPath);
  if (finalManifest.sha256 !== options.manifestSha256) {
    throw new QualificationVerificationError();
  }
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
    const protocol = verifierProtocol(firstInspection.qualificationPlanId);
    const manifestFile = await readImmutableJson(location.manifestPath);
    const manifest = validateTerminalManifest(
      manifestFile.value,
      location.batchId,
      protocol,
      options.mode,
    );
    if (
      firstInspection.batchId !== location.batchId ||
      manifest.authorizationReferenceSha256 !==
        firstInspection.authorizationReferenceSha256
    ) {
      throw new QualificationVerificationError();
    }
    await validateManifestEvidence(
      options.repositoryRoot,
      location.batchId,
      manifest,
      protocol,
    );
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
    await assertTerminalStable({
      repositoryRoot: options.repositoryRoot,
      location,
      qualificationPlanId: protocol.planId,
      authorizationReferenceSha256:
        firstInspection.authorizationReferenceSha256,
      manifestSha256: manifestFile.sha256,
    });
    return Object.freeze({
      verified: true,
      mode: options.mode,
      batchId: location.batchId,
      qualificationPlanId: protocol.planId,
      status: manifest.status as QualificationManifestStatus,
      promotionEligible: manifest.promotionEligible as boolean,
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
