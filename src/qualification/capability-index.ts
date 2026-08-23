import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { types as nodeUtilTypes } from "node:util";

import type { LlmProfile, RuntimeKind, TaskKind } from "../domain/types.js";
import { resolveLlm, supportedLlmIds } from "../llms/registry.js";
import {
  verifyQualification,
  type QualificationVerificationResult,
} from "./verifier.js";
import {
  currentEvidenceCheckKeys,
  validateCurrentEvidenceContract,
} from "./evidence-contract.js";
import {
  CANONICAL_RUNTIME_TYPESCRIPT_WRAPPER_PATHS,
  collectCanonicalRuntimeInputIdentity,
  type CanonicalRuntimeInputIdentity,
} from "../release/canonical-runtime-inputs.js";
import {
  ACTIVE_QUALIFICATION_PLAN_ID,
  CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID,
  DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
  type CurrentQualificationPlanId,
  type QualificationPlanId,
} from "./protocol.js";

const MAX_RUNTIME_INPUT_BYTES = 4 * 1024 * 1024;

const QUALIFICATION_RUNTIME_INPUT_ROOTS = Object.freeze([
  "src/qualification/coordinator.ts",
  "src/qualification/lock.ts",
  "src/qualification/manifest.ts",
  "src/qualification/preflight.ts",
  "src/qualification/protocol.ts",
  "src/qualification/types.ts",
  "src/qualification/verifier.ts",
] as const);
const CAPABILITY_REFRESH_TARGETS_PATH =
  "src/qualification/capability-refresh-targets.ts" as const;

const SHARED_RUNTIME_INPUT_ROOTS = Object.freeze([
  "host-acceptance/protocol/observer-protocol.v1.json",
  "src/adapters/adapter.ts",
  "src/mcp",
  "src/runtime",
  "src/tasks",
  ...QUALIFICATION_RUNTIME_INPUT_ROOTS,
  "src/smoke/evidence.ts",
  "src/smoke/command-observation.ts",
  "src/smoke/result-file-evidence.ts",
  "tsup.plugin.config.ts",
] as const);

const PI_RUNTIME_INPUT_ROOTS = Object.freeze([
  ...SHARED_RUNTIME_INPUT_ROOTS,
  "scripts/real-ark-smoke.mjs",
  "scripts/real-deepseek-smoke.mjs",
  "scripts/real-smoke-main.mjs",
  "src/adapters/pi",
  "src/smoke/ark.ts",
  "src/smoke/deepseek.ts",
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

const SHARED_RUNTIME_DEPENDENCIES = Object.freeze(["execa", "zod"]);
const KIMI_RUNTIME_DEPENDENCIES = Object.freeze([
  ...SHARED_RUNTIME_DEPENDENCIES,
  "@agentclientprotocol/sdk",
]);

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
  readonly maxConcurrency: number;
  readonly concurrencyKey?: string;
}

export interface CapabilityFingerprintSnapshot {
  readonly llm: string;
  readonly task: TaskKind;
  readonly profile: CapabilityFingerprintProfile;
  readonly canonicalRuntimeInputDigestSha256: string;
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
  readonly source: BatchCaseCapabilitySource | LegacyStandaloneCapabilitySource;
}

export interface CapabilityEvidenceVerificationResult {
  readonly sourceKind: "batch-case" | "legacy-standalone";
}

export interface CapabilityEvidenceVerifierDependencies {
  verifyBatchManifest?: (
    manifestPath: string,
  ) => Promise<QualificationVerificationResult>;
}

export const CAPABILITY_INDEX_RELATIVE_PATH =
  "docs/smoke/evidence/capabilities.json" as const;

export interface CapabilityIndexVerificationResult {
  readonly verified: true;
  readonly indexPath: typeof CAPABILITY_INDEX_RELATIVE_PATH;
  readonly entryCount: number;
  readonly legacyEntryCount: number;
}

function capabilityInputError(): Error {
  return new Error("Capability runtime inputs are invalid");
}

function capabilityQualificationError(): Error {
  return new Error("Capability qualification evidence is invalid");
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw capabilityInputError();
  }
  return value as Record<string, unknown>;
}

function dependencyRanges(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const record = inputRecord(value);
  const entries = Object.entries(record)
    .map(([name, range]) => {
      if (typeof range !== "string" || name.length === 0) {
        throw capabilityInputError();
      }
      return [name, range] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  return Object.freeze(Object.fromEntries(entries));
}

function resolveLockedDependencyPath(
  packages: Readonly<Record<string, unknown>>,
  fromPackagePath: string,
  dependencyName: string,
): string | undefined {
  let current = fromPackagePath;
  while (true) {
    const candidate =
      current === ""
        ? `node_modules/${dependencyName}`
        : `${current}/node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;

    const nestedBoundary = current.lastIndexOf("/node_modules/");
    if (nestedBoundary >= 0) {
      current = current.slice(0, nestedBoundary);
      continue;
    }
    if (current.startsWith("node_modules/")) {
      current = "";
      continue;
    }
    return undefined;
  }
}

export function capabilityDependencyInputFromPackageLock(
  value: unknown,
  runtime: RuntimeKind,
): CapabilityRuntimeInput {
  const lock = inputRecord(value);
  if (lock.lockfileVersion !== 3) throw capabilityInputError();
  const packages = inputRecord(lock.packages);
  const seeds =
    runtime === "kimi-acp"
      ? KIMI_RUNTIME_DEPENDENCIES
      : SHARED_RUNTIME_DEPENDENCIES;
  const pending = seeds.map((dependencyName) => {
    const resolved = resolveLockedDependencyPath(packages, "", dependencyName);
    if (resolved === undefined) throw capabilityInputError();
    return resolved;
  });
  const visited = new Set<string>();
  const snapshot: Array<{
    path: string;
    version: string;
    integrity: string;
    dependencies: Readonly<Record<string, string>>;
    optionalDependencies: Readonly<Record<string, string>>;
    peerDependencies: Readonly<Record<string, string>>;
  }> = [];

  while (pending.length > 0) {
    const packagePath = pending.shift();
    if (packagePath === undefined || visited.has(packagePath)) continue;
    visited.add(packagePath);
    const packageEntry = inputRecord(packages[packagePath]);
    const version = packageEntry.version;
    const integrity = packageEntry.integrity;
    if (typeof version !== "string" || typeof integrity !== "string") {
      throw capabilityInputError();
    }
    const dependencies = dependencyRanges(packageEntry.dependencies);
    const optionalDependencies = dependencyRanges(
      packageEntry.optionalDependencies,
    );
    const peerDependencies = dependencyRanges(packageEntry.peerDependencies);
    snapshot.push({
      path: packagePath,
      version,
      integrity,
      dependencies,
      optionalDependencies,
      peerDependencies,
    });

    for (const dependencyName of [
      ...Object.keys(dependencies),
      ...Object.keys(optionalDependencies),
      ...Object.keys(peerDependencies),
    ]) {
      const resolved = resolveLockedDependencyPath(
        packages,
        packagePath,
        dependencyName,
      );
      if (resolved !== undefined) pending.push(resolved);
      else if (Object.hasOwn(dependencies, dependencyName)) {
        throw capabilityInputError();
      }
    }
  }

  snapshot.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return Object.freeze({
    path: "package-lock.capability-runtime.json",
    content: JSON.stringify({
      schemaVersion: 1,
      runtime,
      packages: snapshot,
    }),
  });
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
      (segment) => segment.length === 0 || segment === "." || segment === "..",
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
  excluded: ReadonlySet<string>,
): Promise<void> {
  const normalized = normalizedRelativePath(relativePath);
  if (excluded.has(normalized)) return;
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
        excluded,
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

export function capabilityRuntimeInputExclusions(): readonly string[] {
  return Object.freeze([
    ...CANONICAL_RUNTIME_TYPESCRIPT_WRAPPER_PATHS,
    CAPABILITY_REFRESH_TARGETS_PATH,
  ]);
}

export async function collectCapabilityRuntimeInputs(options: {
  repositoryRoot: string;
  roots: readonly string[];
  excludePaths?: readonly string[];
}): Promise<readonly CapabilityRuntimeInput[]> {
  const collected = new Map<string, CapabilityRuntimeInput>();
  const excluded = new Set(
    (options.excludePaths ?? []).map(normalizedRelativePath),
  );
  if (excluded.size !== (options.excludePaths ?? []).length) {
    throw capabilityInputError();
  }
  for (const root of options.roots) {
    await collectPath(options.repositoryRoot, root, collected, excluded);
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

function exactRecordKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw capabilityQualificationError();
  }
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
  currentOwnedEvidence: boolean,
): readonly string[] {
  if (currentOwnedEvidence) {
    return currentEvidenceCheckKeys(profile.runtime, task);
  }
  const ownershipCheck = currentOwnedEvidence
    ? "ownedProcessDrained"
    : profile.runtime === "pi-rpc"
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
        ownershipCheck,
        "workspaceUnchanged",
      ]
    : [
        "actualModelMatches",
        ...environmentChecks,
        "executionTelemetryValid",
        ownershipCheck,
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
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u.test(batchId)
  ) {
    throw capabilityQualificationError();
  }
  return batchId;
}

function qualificationPlanAllowedForEntry(
  entry: CapabilityQualificationEntry,
  planId: QualificationPlanId,
): planId is CurrentQualificationPlanId {
  if (entry.llm === "deepseek-v4-flash") {
    return planId === DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID;
  }
  return (
    planId === ACTIVE_QUALIFICATION_PLAN_ID ||
    planId === CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID
  );
}

function validateBatchEvidence(
  evidenceValue: unknown,
  entry: CapabilityQualificationEntry,
  profile: LlmProfile,
  source: BatchCaseCapabilitySource,
  batchId: string,
  currentOwnedEvidence: boolean,
  qualificationPlanId: CurrentQualificationPlanId,
): void {
  const evidence = plainRecord(evidenceValue);
  const qualification = plainRecord(evidence.qualification);
  if (
    evidence.schemaVersion !== (currentOwnedEvidence ? 4 : 3) ||
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
    (currentOwnedEvidence
      ? evidence.ownedProcessDrained !== true
      : Object.hasOwn(evidence, "ownedProcessDrained")) ||
    qualification.qualificationPlanId !== qualificationPlanId ||
    qualification.batchId !== batchId ||
    qualification.llm !== entry.llm ||
    qualification.task !== entry.task ||
    qualification.frozenCommit !== source.frozenCommit ||
    qualification.frozenBuildIdentity !== source.buildIdentitySha256 ||
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
  if (currentOwnedEvidence) {
    try {
      validateCurrentEvidenceContract(evidence, {
        llm: entry.llm,
        task: entry.task,
        runtime: profile.runtime,
      });
    } catch {
      throw capabilityQualificationError();
    }
  }
  exactTrueChecks(
    evidence.checks,
    expectedBatchCheckKeys(profile, entry.task, currentOwnedEvidence),
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
  const expectedEvidencePrefix = `docs/smoke/evidence/batches/${batchId}/cases/`;
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
    !qualificationPlanAllowedForEntry(
      options.entry,
      verification.qualificationPlanId,
    )
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
  const qualificationPlanId = verification.qualificationPlanId;
  const currentOwnedEvidence = manifest.schemaVersion === 3;
  if (
    (manifest.schemaVersion !== 2 && manifest.schemaVersion !== 3) ||
    manifest.qualificationPlanId !== qualificationPlanId ||
    (qualificationPlanId === DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID &&
      manifest.schemaVersion !== 3) ||
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
    currentOwnedEvidence,
    qualificationPlanId,
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
    evidence.filesChanged[0] !== "ark-agent-deepseek-v4-flash-smoke.txt"
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
    ? verifyBatchCapabilityEvidence(options, options.entry.source, dependencies)
    : verifyLegacyCapabilityEvidence(options, options.entry.source);
}

function parseBatchSource(value: unknown): BatchCaseCapabilitySource {
  const source = plainRecord(value);
  exactRecordKeys(source, [
    "buildIdentitySha256",
    "evidencePath",
    "evidenceSha256",
    "frozenCommit",
    "kind",
    "manifestPath",
    "manifestSha256",
  ]);
  if (
    source.kind !== "batch-case" ||
    typeof source.manifestPath !== "string" ||
    typeof source.manifestSha256 !== "string" ||
    typeof source.evidencePath !== "string" ||
    typeof source.evidenceSha256 !== "string" ||
    typeof source.frozenCommit !== "string" ||
    typeof source.buildIdentitySha256 !== "string"
  ) {
    throw capabilityQualificationError();
  }
  return Object.freeze({
    kind: "batch-case",
    manifestPath: source.manifestPath,
    manifestSha256: source.manifestSha256,
    evidencePath: source.evidencePath,
    evidenceSha256: source.evidenceSha256,
    frozenCommit: source.frozenCommit,
    buildIdentitySha256: source.buildIdentitySha256,
  });
}

function parseLegacySource(value: unknown): LegacyStandaloneCapabilitySource {
  const source = plainRecord(value);
  exactRecordKeys(source, [
    "evidencePath",
    "evidenceSchemaVersion",
    "evidenceSha256",
    "kind",
    "observedAt",
  ]);
  if (
    source.kind !== "legacy-standalone" ||
    typeof source.evidencePath !== "string" ||
    typeof source.evidenceSha256 !== "string" ||
    source.evidenceSchemaVersion !== 1 ||
    typeof source.observedAt !== "string"
  ) {
    throw capabilityQualificationError();
  }
  return Object.freeze({
    kind: "legacy-standalone",
    evidencePath: source.evidencePath,
    evidenceSha256: source.evidenceSha256,
    evidenceSchemaVersion: 1,
    observedAt: source.observedAt,
  });
}

function parseCapabilityEntry(value: unknown): CapabilityQualificationEntry {
  const entry = plainRecord(value);
  exactRecordKeys(entry, ["llm", "runtimeFingerprintSha256", "source", "task"]);
  if (
    typeof entry.llm !== "string" ||
    (entry.task !== "review" && entry.task !== "delegate") ||
    typeof entry.runtimeFingerprintSha256 !== "string" ||
    !SHA256_PATTERN.test(entry.runtimeFingerprintSha256)
  ) {
    throw capabilityQualificationError();
  }
  const sourceRecord = plainRecord(entry.source);
  const source =
    sourceRecord.kind === "batch-case"
      ? parseBatchSource(entry.source)
      : parseLegacySource(entry.source);
  return Object.freeze({
    llm: entry.llm,
    task: entry.task,
    runtimeFingerprintSha256: entry.runtimeFingerprintSha256,
    source,
  });
}

function capabilityEvidenceAnchor(llm: string, task: TaskKind): string {
  return `${CAPABILITY_INDEX_RELATIVE_PATH}#${llm}-${task}`;
}

export interface CapabilityIndexAnalysisEntry {
  readonly llm: string;
  readonly task: TaskKind;
  readonly gateStatus: "valid" | "invalid";
  readonly evidenceStatus: "valid" | "invalid";
  readonly runtimeFingerprintStatus: "current" | "stale" | "invalid";
  readonly currentRuntimeFingerprintSha256: string | null;
}

export interface CapabilityIndexAnalysisResult {
  readonly indexPath: typeof CAPABILITY_INDEX_RELATIVE_PATH;
  readonly entries: readonly CapabilityIndexAnalysisEntry[];
  readonly legacyEntryCount: number;
}

export interface CapabilityIndexAnalysisDependencies {
  collectCanonicalRuntimeInputIdentity?: (
    repositoryRoot: string,
  ) => Promise<CanonicalRuntimeInputIdentity>;
}

async function loadCapabilityIndexEntries(
  repositoryRoot: string,
): Promise<readonly CapabilityQualificationEntry[]> {
  const indexFile = await readQualificationJson(
    repositoryRoot,
    CAPABILITY_INDEX_RELATIVE_PATH,
  );
  const index = plainRecord(indexFile.value);
  exactRecordKeys(index, ["entries", "schemaVersion"]);
  if (index.schemaVersion !== 1 || !Array.isArray(index.entries)) {
    throw capabilityQualificationError();
  }
  const entries = index.entries.map(parseCapabilityEntry);
  const expectedKeys = supportedLlmIds()
    .flatMap((llm) => {
      const profile = resolveLlm(llm);
      return (["delegate", "review"] as const)
        .filter((task) => profile.qualityGates[task].status === "passed")
        .map((task) => `${llm}/${task}`);
    })
    .sort((left, right) => left.localeCompare(right, "en"));
  const actualKeys = entries.map((entry) => `${entry.llm}/${entry.task}`);
  const legacyEntryCount = entries.filter(
    (entry) => entry.source.kind === "legacy-standalone",
  ).length;
  if (
    entries.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    legacyEntryCount > 1
  ) {
    throw capabilityQualificationError();
  }
  return Object.freeze(entries);
}

export async function analyzeCapabilityIndex(
  options: {
    repositoryRoot: string;
  },
  dependencies: CapabilityIndexAnalysisDependencies = {},
): Promise<CapabilityIndexAnalysisResult> {
  const entries = await loadCapabilityIndexEntries(options.repositoryRoot);
  const canonicalIdentity = await (
    dependencies.collectCanonicalRuntimeInputIdentity ??
    collectCanonicalRuntimeInputIdentity
  )(options.repositoryRoot);
  const manifestVerificationCache = new Map<
    string,
    Promise<QualificationVerificationResult>
  >();
  const verifyBatchManifest = (
    manifestPath: string,
  ): Promise<QualificationVerificationResult> => {
    let pending = manifestVerificationCache.get(manifestPath);
    if (pending === undefined) {
      pending = verifyQualification({
        repositoryRoot: options.repositoryRoot,
        manifestPath,
        mode: "immutable-evidence",
      });
      manifestVerificationCache.set(manifestPath, pending);
    }
    return pending;
  };
  const runtimeInputCache = new Map<
    RuntimeKind,
    Promise<readonly CapabilityRuntimeInput[]>
  >();
  const runtimeInputs = (
    runtime: RuntimeKind,
  ): Promise<readonly CapabilityRuntimeInput[]> => {
    let pending = runtimeInputCache.get(runtime);
    if (pending === undefined) {
      pending = collectCapabilityFingerprintInputs({
        repositoryRoot: options.repositoryRoot,
        runtime,
      });
      runtimeInputCache.set(runtime, pending);
    }
    return pending;
  };

  const analyzed = await Promise.all(
    entries.map(async (entry): Promise<CapabilityIndexAnalysisEntry> => {
      const profile = resolveLlm(entry.llm);
      const gate = profile.qualityGates[entry.task];
      const gateStatus =
        gate.status === "passed" &&
        gate.evidence === capabilityEvidenceAnchor(entry.llm, entry.task)
          ? "valid"
          : "invalid";
      const fingerprintResult = runtimeInputs(profile.runtime)
        .then((inputs) =>
          computeCapabilityRuntimeFingerprintWithIdentity(
            {
              repositoryRoot: options.repositoryRoot,
              llm: entry.llm,
              task: entry.task,
            },
            canonicalIdentity,
            inputs,
          ),
        )
        .then((currentFingerprint) =>
          Object.freeze({
            status:
              currentFingerprint === entry.runtimeFingerprintSha256
                ? ("current" as const)
                : ("stale" as const),
            currentFingerprint,
          }),
        )
        .catch(() =>
          Object.freeze({
            status: "invalid" as const,
            currentFingerprint: null,
          }),
        );
      const evidenceResult = verifyCapabilityEvidenceSource(
        {
          repositoryRoot: options.repositoryRoot,
          entry,
          profile,
        },
        { verifyBatchManifest },
      )
        .then(() => "valid" as const)
        .catch(() => "invalid" as const);
      const [fingerprint, evidenceStatus] = await Promise.all([
        fingerprintResult,
        evidenceResult,
      ]);
      return Object.freeze({
        llm: entry.llm,
        task: entry.task,
        gateStatus,
        evidenceStatus,
        runtimeFingerprintStatus: fingerprint.status,
        currentRuntimeFingerprintSha256: fingerprint.currentFingerprint,
      });
    }),
  );
  return Object.freeze({
    indexPath: CAPABILITY_INDEX_RELATIVE_PATH,
    entries: Object.freeze(analyzed),
    legacyEntryCount: entries.filter(
      (entry) => entry.source.kind === "legacy-standalone",
    ).length,
  });
}

export async function verifyCapabilityIndex(options: {
  repositoryRoot: string;
}): Promise<CapabilityIndexVerificationResult> {
  let analysis: CapabilityIndexAnalysisResult;
  try {
    analysis = await analyzeCapabilityIndex(options);
  } catch {
    throw capabilityQualificationError();
  }
  if (
    analysis.entries.some(
      (entry) =>
        entry.gateStatus !== "valid" ||
        entry.evidenceStatus !== "valid" ||
        entry.runtimeFingerprintStatus !== "current",
    )
  ) {
    throw capabilityQualificationError();
  }

  return Object.freeze({
    verified: true,
    indexPath: CAPABILITY_INDEX_RELATIVE_PATH,
    entryCount: analysis.entries.length,
    legacyEntryCount: analysis.legacyEntryCount,
  });
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
    maxConcurrency: profile.maxConcurrency,
    concurrencyKey: profile.concurrencyKey ?? null,
  };
}

export function fingerprintCapabilitySnapshot(
  snapshot: CapabilityFingerprintSnapshot,
): string {
  if (!SHA256_PATTERN.test(snapshot.canonicalRuntimeInputDigestSha256)) {
    throw capabilityInputError();
  }
  const inputs = [...snapshot.inputs]
    .map((input) => ({
      path: normalizedRelativePath(input.path),
      sha256: sha256(normalizeText(input.content)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (
    inputs.some(
      (input, index) => index > 0 && input.path === inputs[index - 1]?.path,
    )
  ) {
    throw capabilityInputError();
  }
  return sha256(
    JSON.stringify({
      schemaVersion: 2,
      llm: snapshot.llm,
      task: snapshot.task,
      profile: normalizedFingerprintProfile(snapshot.profile),
      canonicalRuntimeInputDigestSha256:
        snapshot.canonicalRuntimeInputDigestSha256,
      inputs,
    }),
  );
}

function fingerprintProfile(profile: LlmProfile): CapabilityFingerprintProfile {
  return Object.freeze({
    id: profile.id,
    runtime: profile.runtime,
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    model: profile.model,
    network: profile.network,
    credentialEnv: Object.freeze([...profile.credentialEnv]),
    ...(profile.credentialTargetEnv === undefined
      ? {}
      : { credentialTargetEnv: profile.credentialTargetEnv }),
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
  const canonicalIdentity = await collectCanonicalRuntimeInputIdentity(
    options.repositoryRoot,
  );
  return computeCapabilityRuntimeFingerprintWithIdentity(
    options,
    canonicalIdentity,
  );
}

async function collectCapabilityFingerprintInputs(options: {
  repositoryRoot: string;
  runtime: RuntimeKind;
}): Promise<readonly CapabilityRuntimeInput[]> {
  const inputs = await collectCapabilityRuntimeInputs({
    repositoryRoot: options.repositoryRoot,
    roots: capabilityRuntimeInputRoots(options.runtime),
    excludePaths: capabilityRuntimeInputExclusions(),
  });
  const [packageLockInput] = await collectCapabilityRuntimeInputs({
    repositoryRoot: options.repositoryRoot,
    roots: ["package-lock.json"],
  });
  if (packageLockInput === undefined) throw capabilityInputError();
  let packageLock: unknown;
  try {
    packageLock = JSON.parse(packageLockInput.content);
  } catch {
    throw capabilityInputError();
  }
  const dependencyInput = capabilityDependencyInputFromPackageLock(
    packageLock,
    options.runtime,
  );
  return Object.freeze([...inputs, dependencyInput]);
}

async function computeCapabilityRuntimeFingerprintWithIdentity(
  options: {
    repositoryRoot: string;
    llm: string;
    task: TaskKind;
  },
  canonicalIdentity: CanonicalRuntimeInputIdentity,
  runtimeInputs?: readonly CapabilityRuntimeInput[],
): Promise<string> {
  const profile = resolveLlm(options.llm);
  if (!profile.capabilities[options.task]) throw capabilityInputError();
  const inputs =
    runtimeInputs ??
    (await collectCapabilityFingerprintInputs({
      repositoryRoot: options.repositoryRoot,
      runtime: profile.runtime,
    }));
  return fingerprintCapabilitySnapshot({
    llm: options.llm,
    task: options.task,
    profile: fingerprintProfile(profile),
    canonicalRuntimeInputDigestSha256: canonicalIdentity.digestSha256,
    inputs,
  });
}
