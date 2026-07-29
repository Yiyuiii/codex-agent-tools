import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { types as nodeUtilTypes } from "node:util";

import type {
  LlmProfile,
  RuntimeKind,
  TaskKind,
} from "../domain/types.js";
import { resolveLlm } from "../llms/registry.js";
import {
  verifyQualification,
  type QualificationVerificationResult,
} from "./verifier.js";

const MAX_RUNTIME_INPUT_BYTES = 4 * 1024 * 1024;

const SHARED_RUNTIME_INPUT_ROOTS = Object.freeze([
  "package-lock.json",
  "src/adapters/adapter.ts",
  "src/mcp",
  "src/runtime",
  "src/tasks",
  "src/qualification",
  "src/smoke/evidence.ts",
  "src/smoke/command-observation.ts",
  "src/smoke/result-file-evidence.ts",
  "tsup.plugin.config.ts",
] as const);

const PI_RUNTIME_INPUT_ROOTS = Object.freeze([
  ...SHARED_RUNTIME_INPUT_ROOTS,
  "scripts/real-ark-smoke.mjs",
  "scripts/real-smoke-main.mjs",
  "src/adapters/pi",
  "src/smoke/ark.ts",
  "src/smoke/pi.ts",
  "src/smoke/pi-write-command-observation.ts",
] as const);

const KIMI_RUNTIME_INPUT_ROOTS = Object.freeze([
  ...SHARED_RUNTIME_INPUT_ROOTS,
  "scripts/real-kimi-smoke.mjs",
  "scripts/real-smoke-main.mjs",
  "src/adapters/kimi",
  "src/smoke/kimi.ts",
] as const);

export interface CapabilityRuntimeInput {
  readonly path: string;
  readonly content: string;
}

export interface CapabilityFingerprintProfile {
  readonly id: string;
  readonly runtime: RuntimeKind;
  readonly provider?: string;
  readonly model: string;
  readonly network: "direct";
  readonly credentialEnv: readonly string[];
  readonly credentialTargetEnv?: string;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly concurrencyKey?: string;
}

export interface CapabilityFingerprintSnapshot {
  readonly llm: string;
  readonly task: TaskKind;
  readonly profile: CapabilityFingerprintProfile;
  readonly inputs: readonly CapabilityRuntimeInput[];
}

export interface BatchCaseCapabilitySource {
  readonly kind: "batch-case";
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  readonly frozenCommit: string;
  readonly buildIdentitySha256: string;
}

export interface LegacyStandaloneCapabilitySource {
  readonly kind: "legacy-standalone";
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  readonly evidenceSchemaVersion: 1;
  readonly observedAt: string;
}

export interface CapabilityQualificationEntry {
  readonly llm: string;
  readonly task: TaskKind;
  readonly runtimeFingerprintSha256: string;
  readonly source:
    | BatchCaseCapabilitySource
    | LegacyStandaloneCapabilitySource;
}

export interface CapabilityEvidenceVerificationResult {
  readonly sourceKind: "batch-case" | "legacy-standalone";
}

export interface CapabilityEvidenceVerifierDependencies {
  verifyBatchManifest?: (
    manifestPath: string,
  ) => Promise<QualificationVerificationResult>;
}

function capabilityInputError(): Error {
  return new Error("Capability runtime inputs are invalid");
}

function capabilityQualificationError(): Error {
  return new Error("Capability qualification evidence is invalid");
}

function normalizedRelativePath(value: string): string {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\0")
  ) {
    throw capabilityInputError();
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw capabilityInputError();
  }
  return segments.join("/");
}

function resolvedRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
): string {
  const root = path.resolve(repositoryRoot);
  const normalized = normalizedRelativePath(relativePath);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw capabilityInputError();
  }
  return resolved;
}

function normalizeText(content: string): string {
  if (content.includes("\0")) throw capabilityInputError();
  return content.replace(/\r\n?/gu, "\n");
}

async function collectPath(
  repositoryRoot: string,
  relativePath: string,
  collected: Map<string, CapabilityRuntimeInput>,
): Promise<void> {
  const normalized = normalizedRelativePath(relativePath);
  const absolute = resolvedRepositoryPath(repositoryRoot, normalized);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch {
    throw capabilityInputError();
  }
  if (metadata.isSymbolicLink()) throw capabilityInputError();
  if (metadata.isDirectory()) {
    let names: string[];
    try {
      names = await readdir(absolute);
    } catch {
      throw capabilityInputError();
    }
    names.sort((left, right) => left.localeCompare(right, "en"));
    for (const name of names) {
      await collectPath(
        repositoryRoot,
        `${normalized}/${name}`,
        collected,
      );
    }
    return;
  }
  if (!metadata.isFile() || metadata.size > MAX_RUNTIME_INPUT_BYTES) {
    throw capabilityInputError();
  }
  let raw: Buffer;
  try {
    raw = await readFile(absolute);
  } catch {
    throw capabilityInputError();
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw capabilityInputError();
  }
  if (collected.has(normalized)) throw capabilityInputError();
  collected.set(
    normalized,
    Object.freeze({ path: normalized, content: normalizeText(content) }),
  );
}

export function capabilityRuntimeInputRoots(
  runtime: RuntimeKind,
): readonly string[] {
  return runtime === "pi-rpc"
    ? PI_RUNTIME_INPUT_ROOTS
    : KIMI_RUNTIME_INPUT_ROOTS;
}

export async function collectCapabilityRuntimeInputs(options: {
  repositoryRoot: string;
  roots: readonly string[];
}): Promise<readonly CapabilityRuntimeInput[]> {
  const collected = new Map<string, CapabilityRuntimeInput>();
  for (const root of options.roots) {
    await collectPath(options.repositoryRoot, root, collected);
  }
  return Object.freeze(
    [...collected.values()].sort((left, right) =>
      left.path.localeCompare(right.path, "en"),
    ),
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_QUALIFICATION_FILE_BYTES = 1024 * 1024;

interface LoadedQualificationJson {
  readonly value: unknown;
  readonly sha256: string;
}

async function readQualificationJson(
  repositoryRoot: string,
  relativePath: string,
): Promise<LoadedQualificationJson> {
  let normalized: string;
  let absolute: string;
  try {
    normalized = normalizedRelativePath(relativePath);
    absolute = resolvedRepositoryPath(repositoryRoot, normalized);
  } catch {
    throw capabilityQualificationError();
  }
  try {
    const metadata = await lstat(absolute);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_QUALIFICATION_FILE_BYTES
    ) {
      throw capabilityQualificationError();
    }
    const raw = await readFile(absolute);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return Object.freeze({
      value: JSON.parse(content) as unknown,
      sha256: sha256(raw),
    });
  } catch {
    throw capabilityQualificationError();
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw capabilityQualificationError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw capabilityQualificationError();
    }
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactTrueChecks(
  value: unknown,
  expectedKeys: readonly string[],
): void {
  const checks = plainRecord(value);
  const actualKeys = Object.keys(checks).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index]) ||
    Object.values(checks).some((check) => check !== true)
  ) {
    throw capabilityQualificationError();
  }
}

function expectedBatchCheckKeys(
  profile: LlmProfile,
  task: TaskKind,
): readonly string[] {
  const processCheck =
    profile.runtime === "pi-rpc"
      ? "noNewPiRpcProcesses"
      : "noNewKimiProcesses";
  const environmentChecks =
    profile.runtime === "pi-rpc" ? ["environmentIsolated"] : [];
  return task === "review"
    ? [
        "actualModelMatches",
        ...environmentChecks,
        "executionTelemetryValid",
        "knownDefectFound",
        processCheck,
        "workspaceUnchanged",
      ]
    : [
        "actualModelMatches",
        ...environmentChecks,
        "executionTelemetryValid",
        processCheck,
        "onlyExpectedFileChanged",
        "requiredCommandObserved",
        "resultFileObserved",
        "resultFileValid",
      ];
}

function batchIdFromManifestPath(manifestPath: string): string {
  const match =
    /^docs\/smoke\/evidence\/batches\/([^/]+)\/manifest\.json$/u.exec(
      manifestPath,
    );
  const batchId = match?.[1];
  if (
    batchId === undefined ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u.test(
      batchId,
    )
  ) {
    throw capabilityQualificationError();
  }
  return batchId;
}

function validateBatchEvidence(
  evidenceValue: unknown,
  entry: CapabilityQualificationEntry,
  profile: LlmProfile,
  source: BatchCaseCapabilitySource,
  batchId: string,
): void {
  const evidence = plainRecord(evidenceValue);
  const qualification = plainRecord(evidence.qualification);
  if (
    evidence.schemaVersion !== 3 ||
    evidence.llm !== entry.llm ||
    evidence.task !== entry.task ||
    evidence.runtime !== profile.runtime ||
    evidence.actualModel !== profile.model ||
    evidence.expectedModel !== profile.model ||
    evidence.route !== profile.network ||
    evidence.status !== "completed" ||
    evidence.passed !== true ||
    evidence.failureReason !== null ||
    evidence.adapterClientInvocationCount !== 1 ||
    evidence.adapterRetryCount !== 0 ||
    evidence.runtimeReportedAutoRetryCount !== 0 ||
    evidence.adapterReportedFallbackUsed !== false ||
    evidence.orchestratorFallbackUsed !== false ||
    evidence.executionTelemetrySource !==
      (profile.runtime === "pi-rpc"
        ? "pi-rpc-observable"
        : "kimi-acp-observable") ||
    qualification.qualificationPlanId !== "four-llm-v1" ||
    qualification.batchId !== batchId ||
    qualification.llm !== entry.llm ||
    qualification.task !== entry.task ||
    qualification.frozenCommit !== source.frozenCommit ||
    qualification.frozenBuildIdentity !==
      source.buildIdentitySha256 ||
    qualification.orchestratorFallbackUsed !== false ||
    (profile.provider === undefined
      ? Object.hasOwn(evidence, "provider")
      : evidence.provider !== profile.provider) ||
    (profile.credentialTargetEnv === undefined
      ? Object.hasOwn(evidence, "credentialEnv")
      : evidence.credentialEnv !== profile.credentialTargetEnv)
  ) {
    throw capabilityQualificationError();
  }
  exactTrueChecks(
    evidence.checks,
    expectedBatchCheckKeys(profile, entry.task),
  );
}

async function verifyBatchCapabilityEvidence(
  options: {
    repositoryRoot: string;
    entry: CapabilityQualificationEntry;
    profile: LlmProfile;
  },
  source: BatchCaseCapabilitySource,
  dependencies: CapabilityEvidenceVerifierDependencies,
): Promise<CapabilityEvidenceVerificationResult> {
  if (
    !SHA256_PATTERN.test(source.manifestSha256) ||
    !SHA256_PATTERN.test(source.evidenceSha256) ||
    !SHA256_PATTERN.test(source.buildIdentitySha256) ||
    !COMMIT_PATTERN.test(source.frozenCommit)
  ) {
    throw capabilityQualificationError();
  }
  const batchId = batchIdFromManifestPath(source.manifestPath);
  const expectedEvidencePrefix =
    `docs/smoke/evidence/batches/${batchId}/cases/`;
  if (
    !source.evidencePath.startsWith(expectedEvidencePrefix) ||
    !source.evidencePath.endsWith(".json")
  ) {
    throw capabilityQualificationError();
  }
  const absoluteManifestPath = resolvedRepositoryPath(
    options.repositoryRoot,
    source.manifestPath,
  );
  let verification: QualificationVerificationResult;
  try {
    verification = await (
      dependencies.verifyBatchManifest ??
      ((manifestPath: string) =>
        verifyQualification({
          repositoryRoot: options.repositoryRoot,
          manifestPath,
          mode: "immutable-evidence",
        }))
    )(absoluteManifestPath);
  } catch {
    throw capabilityQualificationError();
  }
  if (
    verification.verified !== true ||
    verification.mode !== "immutable-evidence" ||
    verification.batchId !== batchId ||
    verification.qualificationPlanId !== "four-llm-v1"
  ) {
    throw capabilityQualificationError();
  }
  const [manifestFile, evidenceFile] = await Promise.all([
    readQualificationJson(options.repositoryRoot, source.manifestPath),
    readQualificationJson(options.repositoryRoot, source.evidencePath),
  ]);
  if (
    manifestFile.sha256 !== source.manifestSha256 ||
    evidenceFile.sha256 !== source.evidenceSha256
  ) {
    throw capabilityQualificationError();
  }
  const manifest = plainRecord(manifestFile.value);
  if (
    manifest.batchId !== batchId ||
    manifest.repositoryCommit !== source.frozenCommit ||
    manifest.buildIdentitySha256 !== source.buildIdentitySha256 ||
    !Array.isArray(manifest.cases)
  ) {
    throw capabilityQualificationError();
  }
  const matchingCases = manifest.cases
    .map((value) => plainRecord(value))
    .filter(
      (candidate) =>
        candidate.llm === options.entry.llm &&
        candidate.task === options.entry.task,
    );
  if (matchingCases.length !== 1) throw capabilityQualificationError();
  const matchingCase = matchingCases[0]!;
  const evidenceReference = plainRecord(matchingCase.evidence);
  if (
    matchingCase.result !== "passed" ||
    evidenceReference.path !== source.evidencePath ||
    evidenceReference.sha256 !== source.evidenceSha256
  ) {
    throw capabilityQualificationError();
  }
  validateBatchEvidence(
    evidenceFile.value,
    options.entry,
    options.profile,
    source,
    batchId,
  );
  return Object.freeze({ sourceKind: "batch-case" });
}

const LEGACY_DEEPSEEK_DELEGATE_EVIDENCE =
  "docs/smoke/evidence/" +
  "2026-07-25T16-10-32.796Z-ark-agent-deepseek-v4-flash-delegate-ark.json";

async function verifyLegacyCapabilityEvidence(
  options: {
    repositoryRoot: string;
    entry: CapabilityQualificationEntry;
    profile: LlmProfile;
  },
  source: LegacyStandaloneCapabilitySource,
): Promise<CapabilityEvidenceVerificationResult> {
  if (
    options.entry.llm !== "ark-agent-deepseek-v4-flash" ||
    options.entry.task !== "delegate" ||
    source.evidencePath !== LEGACY_DEEPSEEK_DELEGATE_EVIDENCE ||
    source.evidenceSchemaVersion !== 1 ||
    !SHA256_PATTERN.test(source.evidenceSha256)
  ) {
    throw capabilityQualificationError();
  }
  const evidenceFile = await readQualificationJson(
    options.repositoryRoot,
    source.evidencePath,
  );
  if (evidenceFile.sha256 !== source.evidenceSha256) {
    throw capabilityQualificationError();
  }
  const evidence = plainRecord(evidenceFile.value);
  if (
    evidence.schemaVersion !== 1 ||
    evidence.timestamp !== source.observedAt ||
    evidence.llm !== options.entry.llm ||
    evidence.task !== options.entry.task ||
    evidence.actualModel !== options.profile.model ||
    evidence.expectedModel !== options.profile.model ||
    evidence.runtime !== "pi-rpc" ||
    evidence.provider !== "ark-agent-plan" ||
    evidence.route !== "direct" ||
    evidence.credentialEnv !== "CODEX_AGENT_ARK_AGENT_KEY" ||
    evidence.status !== "completed" ||
    evidence.passed !== true ||
    evidence.failureReason !== null ||
    !Array.isArray(evidence.filesChanged) ||
    evidence.filesChanged.length !== 1 ||
    evidence.filesChanged[0] !==
      "ark-agent-deepseek-v4-flash-smoke.txt"
  ) {
    throw capabilityQualificationError();
  }
  exactTrueChecks(evidence.checks, [
    "actualModelMatches",
    "environmentIsolated",
    "noNewPiRpcProcesses",
    "resultFileValid",
    "resultFileObserved",
    "onlyExpectedFileChanged",
    "commandObserved",
  ]);
  return Object.freeze({ sourceKind: "legacy-standalone" });
}

export async function verifyCapabilityEvidenceSource(
  options: {
    repositoryRoot: string;
    entry: CapabilityQualificationEntry;
    profile: LlmProfile;
  },
  dependencies: CapabilityEvidenceVerifierDependencies = {},
): Promise<CapabilityEvidenceVerificationResult> {
  if (
    options.profile.id !== options.entry.llm ||
    !options.profile.capabilities[options.entry.task]
  ) {
    throw capabilityQualificationError();
  }
  return options.entry.source.kind === "batch-case"
    ? verifyBatchCapabilityEvidence(
        options,
        options.entry.source,
        dependencies,
      )
    : verifyLegacyCapabilityEvidence(options, options.entry.source);
}

function normalizedFingerprintProfile(
  profile: CapabilityFingerprintProfile,
): Record<string, unknown> {
  return {
    id: profile.id,
    runtime: profile.runtime,
    provider: profile.provider ?? null,
    model: profile.model,
    network: profile.network,
    credentialEnv: [...profile.credentialEnv],
    credentialTargetEnv: profile.credentialTargetEnv ?? null,
    timeoutMs: profile.timeoutMs,
    maxConcurrency: profile.maxConcurrency,
    concurrencyKey: profile.concurrencyKey ?? null,
  };
}

export function fingerprintCapabilitySnapshot(
  snapshot: CapabilityFingerprintSnapshot,
): string {
  const inputs = [...snapshot.inputs]
    .map((input) => ({
      path: normalizedRelativePath(input.path),
      sha256: sha256(normalizeText(input.content)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (
    inputs.some(
      (input, index) =>
        index > 0 && input.path === inputs[index - 1]?.path,
    )
  ) {
    throw capabilityInputError();
  }
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      llm: snapshot.llm,
      task: snapshot.task,
      profile: normalizedFingerprintProfile(snapshot.profile),
      inputs,
    }),
  );
}

function fingerprintProfile(profile: LlmProfile): CapabilityFingerprintProfile {
  return Object.freeze({
    id: profile.id,
    runtime: profile.runtime,
    ...(profile.provider === undefined
      ? {}
      : { provider: profile.provider }),
    model: profile.model,
    network: profile.network,
    credentialEnv: Object.freeze([...profile.credentialEnv]),
    ...(profile.credentialTargetEnv === undefined
      ? {}
      : { credentialTargetEnv: profile.credentialTargetEnv }),
    timeoutMs: profile.timeoutMs,
    maxConcurrency: profile.maxConcurrency,
    ...(profile.concurrencyKey === undefined
      ? {}
      : { concurrencyKey: profile.concurrencyKey }),
  });
}

export async function computeCapabilityRuntimeFingerprint(options: {
  repositoryRoot: string;
  llm: string;
  task: TaskKind;
}): Promise<string> {
  const profile = resolveLlm(options.llm);
  if (!profile.capabilities[options.task]) throw capabilityInputError();
  const inputs = await collectCapabilityRuntimeInputs({
    repositoryRoot: options.repositoryRoot,
    roots: capabilityRuntimeInputRoots(profile.runtime),
  });
  return fingerprintCapabilitySnapshot({
    llm: options.llm,
    task: options.task,
    profile: fingerprintProfile(profile),
    inputs,
  });
}
