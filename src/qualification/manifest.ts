import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { types as nodeUtilTypes } from "node:util";

import { resolveLlm, supportedLlmIds } from "../llms/registry.js";
import {
  defaultSmokeEvidenceFileOperations,
  publishImmutableJson,
} from "../smoke/evidence.js";
import { readQualificationLockOwner } from "./lock.js";
import type {
  BuildArtifactIdentity,
  FrozenCredentialMatch,
  FrozenLogicalLlmIdentity,
  FrozenPreflightRecord,
  QualificationCaseIdentity,
  QualificationCaseManifestEntry,
  QualificationCaseResult,
  QualificationCheckpointReference,
  QualificationEvidenceReference,
  QualificationFailureReason,
  QualificationManifestStatus,
  QualificationStopReason,
  QualificationTask,
  QualificationTerminalInspection,
  QualificationTerminalManifest,
  QualificationUncommittedEvidence,
} from "./types.js";
import { QUALIFICATION_CASES } from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const BATCH_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const SAFE_RELATIVE_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const MAX_LEDGER_FILE_BYTES = 1_048_576;
const REQUIRED_BUILD_ARTIFACTS = [
  "dist/ark-smoke.js",
  "dist/kimi-smoke.js",
  "dist/pi-smoke.js",
  "dist/smoke-evidence.js",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
] as const;
const PREFLIGHT_KEYS = [
  "buildArtifacts",
  "buildIdentitySha256",
  "credentialMatches",
  "logicalLlms",
  "packageLockSha256",
  "packageVersion",
  "piConfigSha256",
  "proxy10808",
  "repositoryBranch",
  "repositoryCommit",
  "repositoryDirty",
  "runtimeVersions",
  "schemaVersion",
  "targetProcesses",
] as const;

export class QualificationLedgerError extends Error {
  readonly category = "infrastructure";
  readonly stage = "qualification_ledger";
  readonly count = 1;

  constructor() {
    super("Qualification ledger operation failed");
    this.name = "QualificationLedgerError";
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validBatchId(value: string): boolean {
  return (
    BATCH_ID_PATTERN.test(value) &&
    value !== "." &&
    value !== ".." &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value)
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function plainRecord(
  value: unknown,
  expectedKeys?: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new QualificationLedgerError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new QualificationLedgerError();
    }
  }
  const record = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
  if (expectedKeys !== undefined) {
    const actual = Object.keys(record).sort();
    const expected = [...expectedKeys].sort();
    if (
      actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])
    ) {
      throw new QualificationLedgerError();
    }
  }
  return record;
}

function safeText(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizeArtifact(value: unknown): BuildArtifactIdentity {
  const record = plainRecord(value, ["path", "sha256"]);
  if (
    typeof record.path !== "string" ||
    !isSafeRepositoryRelativePath(record.path) ||
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256)
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    path: record.path.replaceAll("\\", "/"),
    sha256: record.sha256,
  });
}

function normalizeLogicalIdentity(value: unknown): FrozenLogicalLlmIdentity {
  const record = plainRecord(value, [
    "llm",
    "model",
    "provider",
    "route",
    "runtime",
  ]);
  if (
    typeof record.llm !== "string" ||
    typeof record.runtime !== "string" ||
    typeof record.model !== "string" ||
    (record.provider !== null && typeof record.provider !== "string") ||
    typeof record.route !== "string"
  ) {
    throw new QualificationLedgerError();
  }
  const profile = resolveLlm(record.llm);
  if (
    record.runtime !== profile.runtime ||
    record.model !== profile.model ||
    record.provider !== (profile.provider ?? null) ||
    record.route !== profile.network
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    llm: record.llm,
    runtime: record.runtime as FrozenLogicalLlmIdentity["runtime"],
    model: record.model,
    provider: record.provider,
    route: record.route as FrozenLogicalLlmIdentity["route"],
  });
}

function normalizeCredentialMatch(value: unknown): FrozenCredentialMatch {
  const record = plainRecord(value, ["environmentVariableName", "llm"]);
  if (
    typeof record.llm !== "string" ||
    (record.environmentVariableName !== null &&
      typeof record.environmentVariableName !== "string")
  ) {
    throw new QualificationLedgerError();
  }
  const profile = resolveLlm(record.llm);
  if (
    (profile.credentialEnv.length === 0 &&
      record.environmentVariableName !== null) ||
    (profile.credentialEnv.length > 0 &&
      (typeof record.environmentVariableName !== "string" ||
        !profile.credentialEnv.includes(record.environmentVariableName)))
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    llm: record.llm,
    environmentVariableName: record.environmentVariableName,
  });
}

function normalizeTargetProcesses(value: unknown) {
  const record = plainRecord(value, ["kimi", "piRpc", "realSmoke"]);
  const normalizeCount = (candidate: unknown) => {
    const countRecord = plainRecord(candidate, ["count"]);
    if (countRecord.count !== 0) throw new QualificationLedgerError();
    return Object.freeze({ count: 0 });
  };
  return Object.freeze({
    kimi: normalizeCount(record.kimi),
    piRpc: normalizeCount(record.piRpc),
    realSmoke: normalizeCount(record.realSmoke),
  });
}

export function freezePreflightRecord(value: unknown): FrozenPreflightRecord {
  try {
    const record = plainRecord(value, PREFLIGHT_KEYS);
    if (
      record.schemaVersion !== 1 ||
      typeof record.repositoryCommit !== "string" ||
      !COMMIT_PATTERN.test(record.repositoryCommit) ||
      !safeText(record.repositoryBranch) ||
      record.repositoryDirty !== false ||
      !safeText(record.packageVersion, 128) ||
      typeof record.packageLockSha256 !== "string" ||
      !SHA256_PATTERN.test(record.packageLockSha256) ||
      !Array.isArray(record.buildArtifacts) ||
      typeof record.buildIdentitySha256 !== "string" ||
      !SHA256_PATTERN.test(record.buildIdentitySha256) ||
      typeof record.piConfigSha256 !== "string" ||
      !SHA256_PATTERN.test(record.piConfigSha256) ||
      !Array.isArray(record.logicalLlms) ||
      !Array.isArray(record.credentialMatches)
    ) {
      throw new QualificationLedgerError();
    }
    const buildArtifacts = record.buildArtifacts.map(normalizeArtifact);
    if (
      buildArtifacts.length !== REQUIRED_BUILD_ARTIFACTS.length ||
      buildArtifacts.some(
        (artifact, index) => artifact.path !== REQUIRED_BUILD_ARTIFACTS[index],
      )
    ) {
      throw new QualificationLedgerError();
    }
    const runtimeVersions = plainRecord(record.runtimeVersions, [
      "codex",
      "kimi",
      "node",
      "pi",
    ]);
    if (
      !safeText(runtimeVersions.node, 128) ||
      !safeText(runtimeVersions.codex, 128) ||
      !safeText(runtimeVersions.kimi, 128) ||
      !safeText(runtimeVersions.pi, 128)
    ) {
      throw new QualificationLedgerError();
    }
    const logicalLlms = record.logicalLlms.map(normalizeLogicalIdentity);
    const expectedIds = supportedLlmIds();
    if (
      logicalLlms.length !== expectedIds.length ||
      logicalLlms.some((identity, index) => identity.llm !== expectedIds[index])
    ) {
      throw new QualificationLedgerError();
    }
    const credentialMatches = record.credentialMatches.map(
      normalizeCredentialMatch,
    );
    if (
      credentialMatches.length !== expectedIds.length ||
      credentialMatches.some((match, index) => match.llm !== expectedIds[index])
    ) {
      throw new QualificationLedgerError();
    }
    const proxy = plainRecord(record.proxy10808, ["host", "listening", "port"]);
    if (
      proxy.host !== "127.0.0.1" ||
      proxy.port !== 10808 ||
      proxy.listening !== true
    ) {
      throw new QualificationLedgerError();
    }
    return Object.freeze({
      schemaVersion: 1,
      repositoryCommit: record.repositoryCommit,
      repositoryBranch: record.repositoryBranch,
      repositoryDirty: false,
      packageVersion: record.packageVersion,
      packageLockSha256: record.packageLockSha256,
      buildArtifacts: Object.freeze(buildArtifacts),
      buildIdentitySha256: record.buildIdentitySha256,
      runtimeVersions: Object.freeze({
        node: runtimeVersions.node,
        codex: runtimeVersions.codex,
        kimi: runtimeVersions.kimi,
        pi: runtimeVersions.pi,
      }),
      piConfigSha256: record.piConfigSha256,
      logicalLlms: Object.freeze(logicalLlms),
      credentialMatches: Object.freeze(credentialMatches),
      proxy10808: Object.freeze({
        host: "127.0.0.1",
        port: 10808,
        listening: true,
      }),
      targetProcesses: normalizeTargetProcesses(record.targetProcesses),
    });
  } catch {
    throw new QualificationLedgerError();
  }
}

export function hashFrozenPreflightRecord(
  record: FrozenPreflightRecord,
): string {
  return sha256(JSON.stringify(freezePreflightRecord(record)));
}

function isSafeRepositoryRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      SAFE_RELATIVE_SEGMENT.test(segment),
  );
}

function batchDirectory(repositoryRoot: string, batchId: string): string {
  if (!validBatchId(batchId)) throw new QualificationLedgerError();
  const root = path.resolve(repositoryRoot);
  const destination = path.resolve(
    root,
    "docs",
    "smoke",
    "evidence",
    "batches",
    batchId,
  );
  const expectedParent = path.resolve(
    root,
    "docs",
    "smoke",
    "evidence",
    "batches",
  );
  if (path.dirname(destination) !== expectedParent) {
    throw new QualificationLedgerError();
  }
  return destination;
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function validateLedgerDirectoryChain(
  repositoryRoot: string,
  targetDirectory: string,
  createMissing: boolean,
): Promise<boolean> {
  const root = path.resolve(repositoryRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new QualificationLedgerError();
  }
  const canonicalRoot = await realpath(root);
  const target = path.resolve(targetDirectory);
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new QualificationLedgerError();
  }
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (!SAFE_RELATIVE_SEGMENT.test(segment)) {
      throw new QualificationLedgerError();
    }
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new QualificationLedgerError();
      }
      if (!createMissing) return false;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new QualificationLedgerError();
        }
      }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new QualificationLedgerError();
    }
    const canonicalCurrent = await realpath(current);
    const expected = path.join(canonicalRoot, ...segments.slice(0, index + 1));
    if (!sameFilesystemPath(canonicalCurrent, expected)) {
      throw new QualificationLedgerError();
    }
  }
  return true;
}

async function publishLedgerJson(
  repositoryRoot: string,
  destination: string,
  value: unknown,
): Promise<void> {
  const directory = path.dirname(destination);
  await publishImmutableJson(destination, value, {
    ...defaultSmokeEvidenceFileOperations,
    ensureDirectory: async () => {
      await validateLedgerDirectoryChain(repositoryRoot, directory, true);
    },
    writeExclusive: async (filePath, contents) => {
      if (
        path.dirname(filePath) !== directory ||
        !(await validateLedgerDirectoryChain(repositoryRoot, directory, false))
      ) {
        throw new QualificationLedgerError();
      }
      await defaultSmokeEvidenceFileOperations.writeExclusive(
        filePath,
        contents,
      );
    },
    publishExclusive: async (source, target) => {
      if (
        target !== destination ||
        path.dirname(source) !== directory ||
        !(await validateLedgerDirectoryChain(repositoryRoot, directory, false))
      ) {
        throw new QualificationLedgerError();
      }
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new QualificationLedgerError();
      }
      await defaultSmokeEvidenceFileOperations.publishExclusive(source, target);
    },
  });
}

interface ImmutableBytes {
  raw: Buffer;
  sha256: string;
}

interface ImmutableFile extends ImmutableBytes {
  value: unknown;
}

async function readImmutableBytes(filePath: string): Promise<ImmutableBytes> {
  let handle;
  try {
    const before = await lstat(filePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_LEDGER_FILE_BYTES
    ) {
      throw new QualificationLedgerError();
    }
    handle = await open(filePath, "r");
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new QualificationLedgerError();
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
      if (result.bytesRead === 0) throw new QualificationLedgerError();
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new QualificationLedgerError();
    }
    return { raw, sha256: sha256(raw) };
  } catch {
    throw new QualificationLedgerError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readImmutableJson(filePath: string): Promise<ImmutableFile> {
  try {
    return parseImmutableBytes(await readImmutableBytes(filePath));
  } catch {
    throw new QualificationLedgerError();
  }
}

function parseImmutableBytes(file: ImmutableBytes): ImmutableFile {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.raw);
    return { ...file, value: JSON.parse(text) as unknown };
  } catch {
    throw new QualificationLedgerError();
  }
}

async function readLedgerBytes(
  repositoryRoot: string,
  filePath: string,
): Promise<ImmutableBytes> {
  if (
    !(await validateLedgerDirectoryChain(
      repositoryRoot,
      path.dirname(filePath),
      false,
    ))
  ) {
    throw new QualificationLedgerError();
  }
  return readImmutableBytes(filePath);
}

async function readLedgerJson(
  repositoryRoot: string,
  filePath: string,
): Promise<ImmutableFile> {
  if (
    !(await validateLedgerDirectoryChain(
      repositoryRoot,
      path.dirname(filePath),
      false,
    ))
  ) {
    throw new QualificationLedgerError();
  }
  return readImmutableJson(filePath);
}

async function readLedgerDirectory(
  repositoryRoot: string,
  directory: string,
): Promise<Dirent<string>[]> {
  if (!(await validateLedgerDirectoryChain(repositoryRoot, directory, false))) {
    throw Object.assign(new QualificationLedgerError(), {
      code: "ENOENT",
    });
  }
  return readdir(directory, { withFileTypes: true });
}

function normalizeCaseIdentity(value: unknown): QualificationCaseIdentity {
  const record = plainRecord(value, ["llm", "ordinal", "task"]);
  if (
    typeof record.ordinal !== "number" ||
    !Number.isSafeInteger(record.ordinal) ||
    record.ordinal < 1 ||
    record.ordinal > 10 ||
    typeof record.llm !== "string" ||
    !supportedLlmIds().includes(record.llm) ||
    (record.task !== "review" && record.task !== "delegate")
  ) {
    throw new QualificationLedgerError();
  }
  const identity = Object.freeze({
    ordinal: record.ordinal,
    llm: record.llm,
    task: record.task,
  });
  const fixed = QUALIFICATION_CASES[identity.ordinal - 1];
  if (fixed === undefined || !identitiesEqual(identity, fixed)) {
    throw new QualificationLedgerError();
  }
  return identity;
}

function identitiesEqual(
  left: QualificationCaseIdentity,
  right: QualificationCaseIdentity,
): boolean {
  return (
    left.ordinal === right.ordinal &&
    left.llm === right.llm &&
    left.task === right.task
  );
}

interface BatchStartedCheckpoint {
  schemaVersion: 1;
  sequence: 0;
  kind: "batch_started";
  batchId: string;
  recordedAt: string;
  authorizationReferenceSha256: string;
  preflightSha256: string;
  preflight: FrozenPreflightRecord;
}

interface CaseRunningCheckpoint extends QualificationCaseIdentity {
  schemaVersion: 1;
  sequence: number;
  kind: "case_running";
  batchId: string;
  recordedAt: string;
  repositoryCommit: string;
  buildIdentitySha256: string;
  preflightSha256: string;
}

interface CaseCompletedCheckpoint extends QualificationCaseIdentity {
  schemaVersion: 1;
  sequence: number;
  kind: "case_completed";
  batchId: string;
  recordedAt: string;
  repositoryCommit: string;
  buildIdentitySha256: string;
  preflightSha256: string;
  result: QualificationCaseResult;
  evidence: QualificationEvidenceReference;
  adapterClientInvocationCount: number | null;
  adapterRetryCount: number | null;
  runtimeReportedAutoRetryCount: number | null;
  adapterReportedFallbackUsed: boolean | null;
  orchestratorFallbackUsed: false;
  executionTelemetrySource: "kimi-acp-observable" | "pi-rpc-observable" | null;
  failureReason: QualificationFailureReason;
}

type QualificationCheckpoint =
  BatchStartedCheckpoint | CaseRunningCheckpoint | CaseCompletedCheckpoint;

interface LoadedCheckpoint {
  checkpoint: QualificationCheckpoint;
  reference: QualificationCheckpointReference;
}

function normalizeEvidenceReference(
  value: unknown,
): QualificationEvidenceReference {
  const record = plainRecord(value, ["path", "sha256"]);
  if (
    typeof record.path !== "string" ||
    !isSafeRepositoryRelativePath(record.path) ||
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256)
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    path: record.path.replaceAll("\\", "/"),
    sha256: record.sha256,
  });
}

interface NormalizedExecutionTelemetry {
  adapterClientInvocationCount: number | null;
  adapterRetryCount: number | null;
  runtimeReportedAutoRetryCount: number | null;
  adapterReportedFallbackUsed: boolean | null;
  orchestratorFallbackUsed: false;
  executionTelemetrySource: "kimi-acp-observable" | "pi-rpc-observable" | null;
}

function normalizeExecutionTelemetry(
  record: Record<string, unknown>,
): NormalizedExecutionTelemetry {
  const normalizeCount = (value: unknown): number | null => {
    if (value === null) return null;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new QualificationLedgerError();
    }
    return value;
  };
  const normalizeBoolean = (value: unknown): boolean | null => {
    if (value === null || typeof value === "boolean") return value;
    throw new QualificationLedgerError();
  };
  if (
    record.orchestratorFallbackUsed !== false ||
    (record.executionTelemetrySource !== null &&
      record.executionTelemetrySource !== "kimi-acp-observable" &&
      record.executionTelemetrySource !== "pi-rpc-observable")
  ) {
    throw new QualificationLedgerError();
  }
  const normalized = Object.freeze({
    adapterClientInvocationCount: normalizeCount(
      record.adapterClientInvocationCount,
    ),
    adapterRetryCount: normalizeCount(record.adapterRetryCount),
    runtimeReportedAutoRetryCount: normalizeCount(
      record.runtimeReportedAutoRetryCount,
    ),
    adapterReportedFallbackUsed: normalizeBoolean(
      record.adapterReportedFallbackUsed,
    ),
    orchestratorFallbackUsed: false,
    executionTelemetrySource: record.executionTelemetrySource,
  });
  const values = [
    normalized.adapterClientInvocationCount,
    normalized.adapterRetryCount,
    normalized.runtimeReportedAutoRetryCount,
    normalized.adapterReportedFallbackUsed,
  ];
  if (
    (normalized.executionTelemetrySource === null &&
      values.some((value) => value !== null)) ||
    (normalized.executionTelemetrySource !== null &&
      values.some((value) => value === null))
  ) {
    throw new QualificationLedgerError();
  }
  return normalized;
}

function normalizeCheckpoint(
  value: unknown,
  expectedSequence: number,
  expectedBatchId: string,
): QualificationCheckpoint {
  const base = plainRecord(value);
  if (
    base.schemaVersion !== 1 ||
    base.sequence !== expectedSequence ||
    base.batchId !== expectedBatchId ||
    !validTimestamp(base.recordedAt)
  ) {
    throw new QualificationLedgerError();
  }
  if (base.kind === "batch_started") {
    plainRecord(value, [
      "authorizationReferenceSha256",
      "batchId",
      "kind",
      "preflight",
      "preflightSha256",
      "recordedAt",
      "schemaVersion",
      "sequence",
    ]);
    const preflight = freezePreflightRecord(base.preflight);
    if (
      expectedSequence !== 0 ||
      typeof base.authorizationReferenceSha256 !== "string" ||
      !SHA256_PATTERN.test(base.authorizationReferenceSha256) ||
      base.preflightSha256 !== hashFrozenPreflightRecord(preflight)
    ) {
      throw new QualificationLedgerError();
    }
    return Object.freeze({
      schemaVersion: 1,
      sequence: 0,
      kind: "batch_started",
      batchId: expectedBatchId,
      recordedAt: base.recordedAt,
      authorizationReferenceSha256: base.authorizationReferenceSha256,
      preflightSha256: base.preflightSha256,
      preflight,
    });
  }
  const identity = normalizeCaseIdentity({
    ordinal: base.ordinal,
    llm: base.llm,
    task: base.task,
  });
  const commonKeys = [
    "batchId",
    "buildIdentitySha256",
    "kind",
    "llm",
    "ordinal",
    "preflightSha256",
    "recordedAt",
    "repositoryCommit",
    "schemaVersion",
    "sequence",
    "task",
  ];
  if (
    typeof base.repositoryCommit !== "string" ||
    !COMMIT_PATTERN.test(base.repositoryCommit) ||
    typeof base.buildIdentitySha256 !== "string" ||
    !SHA256_PATTERN.test(base.buildIdentitySha256) ||
    typeof base.preflightSha256 !== "string" ||
    !SHA256_PATTERN.test(base.preflightSha256)
  ) {
    throw new QualificationLedgerError();
  }
  if (base.kind === "case_running") {
    plainRecord(value, commonKeys);
    return Object.freeze({
      schemaVersion: 1,
      sequence: expectedSequence,
      kind: "case_running",
      batchId: expectedBatchId,
      recordedAt: base.recordedAt,
      repositoryCommit: base.repositoryCommit,
      buildIdentitySha256: base.buildIdentitySha256,
      preflightSha256: base.preflightSha256,
      ...identity,
    });
  }
  if (base.kind === "case_completed") {
    if (base.result !== "passed" && base.result !== "failed") {
      throw new QualificationLedgerError();
    }
    const telemetry = normalizeExecutionTelemetry(base);
    plainRecord(value, [
      ...commonKeys,
      "adapterClientInvocationCount",
      "adapterReportedFallbackUsed",
      "adapterRetryCount",
      "evidence",
      "executionTelemetrySource",
      "failureReason",
      "orchestratorFallbackUsed",
      "result",
      "runtimeReportedAutoRetryCount",
    ]);
    return Object.freeze({
      schemaVersion: 1,
      sequence: expectedSequence,
      kind: "case_completed",
      batchId: expectedBatchId,
      recordedAt: base.recordedAt,
      repositoryCommit: base.repositoryCommit,
      buildIdentitySha256: base.buildIdentitySha256,
      preflightSha256: base.preflightSha256,
      ...identity,
      result: base.result,
      evidence: normalizeEvidenceReference(base.evidence),
      ...telemetry,
      failureReason: normalizeFailureReason(
        base.failureReason,
        base.result === "passed",
      ),
    });
  }
  throw new QualificationLedgerError();
}

function repositoryRelativePath(
  repositoryRoot: string,
  absolutePath: string,
): string {
  const root = path.resolve(repositoryRoot);
  const relative = path.relative(root, path.resolve(absolutePath));
  if (!isSafeRepositoryRelativePath(relative)) {
    throw new QualificationLedgerError();
  }
  return relative.replaceAll("\\", "/");
}

interface ValidatedQualificationEvidence {
  reference: QualificationEvidenceReference;
  passed: boolean;
  telemetry: NormalizedExecutionTelemetry;
  failureReason: QualificationFailureReason;
}

const QUALIFICATION_FAILURE_REASONS = new Set([
  "missing_credential",
  "google_free_tier_quota",
  "account_quota_exceeded",
  "adapter_failure",
  "adapter_auth_or_model_unavailable",
  "acceptance_failed",
  "process_residual",
  "infrastructure_failure",
]);

function normalizeFailureReason(
  value: unknown,
  passed: boolean,
): QualificationFailureReason {
  if (passed) {
    if (value !== null) throw new QualificationLedgerError();
    return null;
  }
  if (typeof value !== "string" || !QUALIFICATION_FAILURE_REASONS.has(value)) {
    throw new QualificationLedgerError();
  }
  return value as Exclude<QualificationFailureReason, null>;
}

async function evidenceForIdentity(
  repositoryRoot: string,
  batchId: string,
  identity: QualificationCaseIdentity,
  evidencePath: string,
  preflight: FrozenPreflightRecord,
  authorizationReferenceSha256: string,
): Promise<ValidatedQualificationEvidence> {
  const expectedDirectory = path.join(
    batchDirectory(repositoryRoot, batchId),
    "cases",
  );
  const resolved = path.resolve(evidencePath);
  if (
    path.dirname(resolved) !== expectedDirectory ||
    path.extname(resolved) !== ".json"
  ) {
    throw new QualificationLedgerError();
  }
  const file = await readLedgerJson(repositoryRoot, resolved);
  return validateEvidenceForIdentity(
    repositoryRoot,
    batchId,
    identity,
    resolved,
    preflight,
    authorizationReferenceSha256,
    file,
  );
}

function validateEvidenceForIdentity(
  repositoryRoot: string,
  batchId: string,
  identity: QualificationCaseIdentity,
  resolvedEvidencePath: string,
  preflight: FrozenPreflightRecord,
  authorizationReferenceSha256: string,
  file: ImmutableFile,
): ValidatedQualificationEvidence {
  const evidence = plainRecord(file.value);
  const qualification = plainRecord(evidence.qualification, [
    "authorizationReferenceSha256",
    "batchId",
    "buildIdentitySha256",
    "orchestratorFallbackUsed",
    "ordinal",
    "repositoryCommit",
  ]);
  if (
    evidence.schemaVersion !== 2 ||
    qualification.batchId !== batchId ||
    qualification.ordinal !== identity.ordinal ||
    qualification.repositoryCommit !== preflight.repositoryCommit ||
    qualification.buildIdentitySha256 !== preflight.buildIdentitySha256 ||
    qualification.authorizationReferenceSha256 !==
      authorizationReferenceSha256 ||
    qualification.orchestratorFallbackUsed !== false ||
    evidence.llm !== identity.llm ||
    evidence.task !== identity.task ||
    typeof evidence.passed !== "boolean"
  ) {
    throw new QualificationLedgerError();
  }
  const telemetry = normalizeExecutionTelemetry(evidence);
  const failureReason = normalizeFailureReason(
    evidence.failureReason,
    evidence.passed,
  );
  const profile = resolveLlm(identity.llm);
  const frozenIdentity = preflight.logicalLlms.find(
    (candidate) => candidate.llm === identity.llm,
  );
  const credentialMatch = preflight.credentialMatches.find(
    (candidate) => candidate.llm === identity.llm,
  );
  const expectedEvidenceCredential =
    profile.credentialTargetEnv ?? credentialMatch?.environmentVariableName;
  const actualModelIsSafeFailureObservation =
    !Object.hasOwn(evidence, "actualModel") ||
    evidence.actualModel === null ||
    (typeof evidence.actualModel === "string" &&
      /^[A-Za-z0-9._/:-]{1,128}$/u.test(evidence.actualModel));
  if (
    frozenIdentity === undefined ||
    credentialMatch === undefined ||
    evidence.expectedModel !== frozenIdentity.model ||
    evidence.runtime !== frozenIdentity.runtime ||
    evidence.route !== frozenIdentity.route ||
    (frozenIdentity.provider === null
      ? Object.hasOwn(evidence, "provider")
      : evidence.provider !== frozenIdentity.provider) ||
    (evidence.passed === true &&
      evidence.actualModel !== frozenIdentity.model) ||
    (evidence.passed === false && !actualModelIsSafeFailureObservation) ||
    (frozenIdentity.runtime === "pi-rpc" &&
      evidence.passed === true &&
      evidence.configSha256 !== preflight.piConfigSha256) ||
    (frozenIdentity.runtime === "pi-rpc"
      ? evidence.passed === true
        ? evidence.credentialEnv !== expectedEvidenceCredential
        : Object.hasOwn(evidence, "credentialEnv") &&
          evidence.credentialEnv !== expectedEvidenceCredential
      : Object.hasOwn(evidence, "credentialEnv"))
  ) {
    throw new QualificationLedgerError();
  }
  const expectedTelemetrySource =
    profile.runtime === "kimi-acp"
      ? "kimi-acp-observable"
      : "pi-rpc-observable";
  if (
    (telemetry.executionTelemetrySource !== null &&
      telemetry.executionTelemetrySource !== expectedTelemetrySource) ||
    (evidence.passed === true &&
      (telemetry.adapterClientInvocationCount !== 1 ||
        telemetry.adapterRetryCount !== 0 ||
        telemetry.runtimeReportedAutoRetryCount !== 0 ||
        telemetry.adapterReportedFallbackUsed !== false ||
        telemetry.orchestratorFallbackUsed !== false ||
        telemetry.executionTelemetrySource !== expectedTelemetrySource))
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    reference: Object.freeze({
      path: repositoryRelativePath(repositoryRoot, resolvedEvidencePath),
      sha256: file.sha256,
    }),
    passed: evidence.passed,
    telemetry,
    failureReason,
  });
}

interface LedgerState {
  loaded: readonly LoadedCheckpoint[];
  started: BatchStartedCheckpoint | null;
  completed: readonly CaseCompletedCheckpoint[];
  running: CaseRunningCheckpoint | null;
}

async function listCheckpointFiles(
  repositoryRoot: string,
  directory: string,
): Promise<string[]> {
  try {
    const entries = await readLedgerDirectory(repositoryRoot, directory);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && /^\d{6}\.json$/u.test(entry.name)) {
        files.push(entry.name);
      } else if (
        entry.isFile() &&
        /^\.\d{6}\.json\.[a-f0-9-]+\.tmp$/iu.test(entry.name)
      ) {
        continue;
      } else {
        throw new QualificationLedgerError();
      }
    }
    return files.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new QualificationLedgerError();
  }
}

async function verifyEvidenceReference(
  repositoryRoot: string,
  reference: QualificationEvidenceReference,
): Promise<void> {
  const absolute = path.resolve(repositoryRoot, reference.path);
  if (
    repositoryRelativePath(repositoryRoot, absolute) !== reference.path ||
    (await readLedgerJson(repositoryRoot, absolute)).sha256 !== reference.sha256
  ) {
    throw new QualificationLedgerError();
  }
}

async function loadLedgerState(
  repositoryRoot: string,
  batchId: string,
): Promise<LedgerState> {
  const directory = path.join(
    batchDirectory(repositoryRoot, batchId),
    "checkpoints",
  );
  const files = await listCheckpointFiles(repositoryRoot, directory);
  const loaded: LoadedCheckpoint[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const expected = `${String(index).padStart(6, "0")}.json`;
    if (files[index] !== expected) throw new QualificationLedgerError();
    const absolute = path.join(directory, expected);
    const file = await readLedgerJson(repositoryRoot, absolute);
    const checkpoint = normalizeCheckpoint(file.value, index, batchId);
    loaded.push({
      checkpoint,
      reference: Object.freeze({
        sequence: index,
        path: repositoryRelativePath(repositoryRoot, absolute),
        sha256: file.sha256,
      }),
    });
  }
  if (loaded.length === 0) {
    return {
      loaded: Object.freeze([]),
      started: null,
      completed: Object.freeze([]),
      running: null,
    };
  }
  const first = loaded[0]!.checkpoint;
  if (first.kind !== "batch_started") throw new QualificationLedgerError();
  const completed: CaseCompletedCheckpoint[] = [];
  let running: CaseRunningCheckpoint | null = null;
  for (const { checkpoint } of loaded.slice(1)) {
    if (checkpoint.kind === "batch_started") {
      throw new QualificationLedgerError();
    }
    if (
      checkpoint.repositoryCommit !== first.preflight.repositoryCommit ||
      checkpoint.buildIdentitySha256 !== first.preflight.buildIdentitySha256 ||
      checkpoint.preflightSha256 !== first.preflightSha256
    ) {
      throw new QualificationLedgerError();
    }
    if (checkpoint.kind === "case_running") {
      if (
        running !== null ||
        checkpoint.ordinal !== completed.length + 1 ||
        completed.some((item) => item.result !== "passed")
      ) {
        throw new QualificationLedgerError();
      }
      running = checkpoint;
    } else {
      if (running === null || !identitiesEqual(running, checkpoint)) {
        throw new QualificationLedgerError();
      }
      const validatedEvidence = await evidenceForIdentity(
        repositoryRoot,
        batchId,
        checkpoint,
        path.resolve(repositoryRoot, checkpoint.evidence.path),
        first.preflight,
        first.authorizationReferenceSha256,
      );
      if (
        validatedEvidence.reference.path !== checkpoint.evidence.path ||
        validatedEvidence.reference.sha256 !== checkpoint.evidence.sha256 ||
        validatedEvidence.passed !== (checkpoint.result === "passed") ||
        validatedEvidence.failureReason !== checkpoint.failureReason ||
        JSON.stringify(validatedEvidence.telemetry) !==
          JSON.stringify({
            adapterClientInvocationCount:
              checkpoint.adapterClientInvocationCount,
            adapterRetryCount: checkpoint.adapterRetryCount,
            runtimeReportedAutoRetryCount:
              checkpoint.runtimeReportedAutoRetryCount,
            adapterReportedFallbackUsed: checkpoint.adapterReportedFallbackUsed,
            orchestratorFallbackUsed: false,
            executionTelemetrySource: checkpoint.executionTelemetrySource,
          })
      ) {
        throw new QualificationLedgerError();
      }
      completed.push(checkpoint);
      running = null;
    }
  }
  return Object.freeze({
    loaded: Object.freeze(loaded),
    started: first,
    completed: Object.freeze(completed),
    running,
  });
}

async function ledgerPathExists(
  repositoryRoot: string,
  filePath: string,
): Promise<boolean> {
  try {
    if (
      !(await validateLedgerDirectoryChain(
        repositoryRoot,
        path.dirname(filePath),
        false,
      ))
    ) {
      return false;
    }
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new QualificationLedgerError();
  }
}

async function assertNoTerminal(repositoryRoot: string, batchId: string) {
  if (
    await ledgerPathExists(
      repositoryRoot,
      path.join(batchDirectory(repositoryRoot, batchId), "manifest.json"),
    )
  ) {
    throw new QualificationLedgerError();
  }
}

function checkpointPath(
  repositoryRoot: string,
  batchId: string,
  sequence: number,
): string {
  return path.join(
    batchDirectory(repositoryRoot, batchId),
    "checkpoints",
    `${String(sequence).padStart(6, "0")}.json`,
  );
}

function caseEntry(
  checkpoint: CaseCompletedCheckpoint,
): QualificationCaseManifestEntry {
  return Object.freeze({
    ordinal: checkpoint.ordinal,
    llm: checkpoint.llm,
    task: checkpoint.task,
    result: checkpoint.result,
    evidence: checkpoint.evidence,
    failureReason: checkpoint.failureReason,
    adapterClientInvocationCount: checkpoint.adapterClientInvocationCount,
    adapterRetryCount: checkpoint.adapterRetryCount,
    runtimeReportedAutoRetryCount: checkpoint.runtimeReportedAutoRetryCount,
    adapterReportedFallbackUsed: checkpoint.adapterReportedFallbackUsed,
    orchestratorFallbackUsed: false,
    executionTelemetrySource: checkpoint.executionTelemetrySource,
  });
}

function normalizeNotRun(
  values: readonly QualificationCaseIdentity[],
): readonly QualificationCaseIdentity[] {
  const normalized = values.map(normalizeCaseIdentity);
  for (let index = 0; index < normalized.length; index += 1) {
    if (
      index > 0 &&
      normalized[index - 1]!.ordinal >= normalized[index]!.ordinal
    ) {
      throw new QualificationLedgerError();
    }
  }
  return Object.freeze(normalized);
}

function buildManifest(
  state: LedgerState,
  options: {
    batchId: string;
    authorizationReferenceSha256: string;
    status: QualificationManifestStatus;
    stopReason: QualificationStopReason | null;
    notRun: readonly QualificationCaseIdentity[];
    completedAt: string;
    uncommittedEvidence: QualificationUncommittedEvidence | null;
  },
): QualificationTerminalManifest {
  if (
    !validTimestamp(options.completedAt) ||
    !SHA256_PATTERN.test(options.authorizationReferenceSha256)
  ) {
    throw new QualificationLedgerError();
  }
  const notRun = normalizeNotRun(options.notRun);
  const cases = Object.freeze(state.completed.map(caseEntry));
  const notRunStart =
    state.completed.length +
    ((options.status === "interrupted" ||
      (options.status === "blocked" &&
        options.stopReason === "infrastructure_failure")) &&
    state.running !== null
      ? 1
      : 0);
  const expectedNotRun =
    options.status === "passed" ? [] : QUALIFICATION_CASES.slice(notRunStart);
  if (
    JSON.stringify(notRun) !== JSON.stringify(expectedNotRun) ||
    (options.status === "blocked" &&
      state.running !== null &&
      options.stopReason !== "infrastructure_failure")
  ) {
    throw new QualificationLedgerError();
  }
  const passed =
    options.status === "passed" &&
    cases.length === 10 &&
    cases.every(
      (entry, index) =>
        entry.result === "passed" &&
        identitiesEqual(entry, QUALIFICATION_CASES[index]!),
    ) &&
    notRun.length === 0 &&
    state.running === null &&
    options.stopReason === null &&
    options.uncommittedEvidence === null;
  if (
    (options.status === "passed" && !passed) ||
    (options.status === "blocked" &&
      options.stopReason !== "case_failed" &&
      options.stopReason !== "infrastructure_failure") ||
    (options.stopReason === "case_failed" &&
      state.completed.at(-1)?.result !== "failed") ||
    (options.status === "interrupted" &&
      options.stopReason !== "process_interrupted")
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    schemaVersion: 1,
    batchId: options.batchId,
    status: options.status,
    authorizationReferenceSha256: options.authorizationReferenceSha256,
    repositoryCommit: state.started?.preflight.repositoryCommit ?? null,
    buildIdentitySha256: state.started?.preflight.buildIdentitySha256 ?? null,
    preflightSha256: state.started?.preflightSha256 ?? null,
    preflight: state.started?.preflight ?? null,
    cases,
    uncommittedEvidence: options.uncommittedEvidence,
    checkpoints: Object.freeze(state.loaded.map((entry) => entry.reference)),
    stopReason: options.stopReason,
    notRun,
    promotionEligible: passed,
    completedAt: options.completedAt,
  });
}

export interface QualificationLedger {
  readonly batchDirectory: string;
  publishBatchStarted(options: {
    authorizationReferenceSha256: string;
    preflight: FrozenPreflightRecord;
    recordedAt: string;
  }): Promise<void>;
  publishCaseRunning(
    options: QualificationCaseIdentity & { recordedAt: string },
  ): Promise<void>;
  publishCaseCompleted(
    options: QualificationCaseIdentity & {
      result: QualificationCaseResult;
      evidencePath: string;
      recordedAt: string;
    },
  ): Promise<void>;
  publishTerminalManifest(options: {
    status: QualificationManifestStatus;
    stopReason: QualificationStopReason | null;
    notRun: readonly QualificationCaseIdentity[];
    completedAt: string;
  }): Promise<QualificationTerminalManifest>;
}

export function createQualificationLedger(options: {
  repositoryRoot: string;
  batchId: string;
}): QualificationLedger {
  let directory: string;
  try {
    directory = batchDirectory(options.repositoryRoot, options.batchId);
  } catch {
    directory = "";
  }
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      if (directory === "") throw new QualificationLedgerError();
      return await operation();
    } catch {
      throw new QualificationLedgerError();
    }
  };
  return Object.freeze({
    batchDirectory: directory,
    publishBatchStarted: (input: {
      authorizationReferenceSha256: string;
      preflight: FrozenPreflightRecord;
      recordedAt: string;
    }) =>
      run(async () => {
        await assertNoTerminal(options.repositoryRoot, options.batchId);
        const state = await loadLedgerState(
          options.repositoryRoot,
          options.batchId,
        );
        if (
          state.loaded.length !== 0 ||
          !SHA256_PATTERN.test(input.authorizationReferenceSha256) ||
          !validTimestamp(input.recordedAt)
        ) {
          throw new QualificationLedgerError();
        }
        const preflight = freezePreflightRecord(input.preflight);
        await publishLedgerJson(
          options.repositoryRoot,
          checkpointPath(options.repositoryRoot, options.batchId, 0),
          {
            schemaVersion: 1,
            sequence: 0,
            kind: "batch_started",
            batchId: options.batchId,
            recordedAt: input.recordedAt,
            authorizationReferenceSha256: input.authorizationReferenceSha256,
            preflightSha256: hashFrozenPreflightRecord(preflight),
            preflight,
          },
        );
      }),
    publishCaseRunning: (
      input: QualificationCaseIdentity & { recordedAt: string },
    ) =>
      run(async () => {
        await assertNoTerminal(options.repositoryRoot, options.batchId);
        const identity = normalizeCaseIdentity({
          ordinal: input.ordinal,
          llm: input.llm,
          task: input.task,
        });
        if (!validTimestamp(input.recordedAt)) {
          throw new QualificationLedgerError();
        }
        const state = await loadLedgerState(
          options.repositoryRoot,
          options.batchId,
        );
        if (
          state.started === null ||
          state.running !== null ||
          identity.ordinal !== state.completed.length + 1 ||
          state.completed.some((item) => item.result !== "passed")
        ) {
          throw new QualificationLedgerError();
        }
        await publishLedgerJson(
          options.repositoryRoot,
          checkpointPath(
            options.repositoryRoot,
            options.batchId,
            state.loaded.length,
          ),
          {
            schemaVersion: 1,
            sequence: state.loaded.length,
            kind: "case_running",
            batchId: options.batchId,
            recordedAt: input.recordedAt,
            repositoryCommit: state.started.preflight.repositoryCommit,
            buildIdentitySha256: state.started.preflight.buildIdentitySha256,
            preflightSha256: state.started.preflightSha256,
            ...identity,
          },
        );
      }),
    publishCaseCompleted: (
      input: QualificationCaseIdentity & {
        result: QualificationCaseResult;
        evidencePath: string;
        recordedAt: string;
      },
    ) =>
      run(async () => {
        await assertNoTerminal(options.repositoryRoot, options.batchId);
        const identity = normalizeCaseIdentity({
          ordinal: input.ordinal,
          llm: input.llm,
          task: input.task,
        });
        if (
          (input.result !== "passed" && input.result !== "failed") ||
          !validTimestamp(input.recordedAt)
        ) {
          throw new QualificationLedgerError();
        }
        const state = await loadLedgerState(
          options.repositoryRoot,
          options.batchId,
        );
        if (
          state.started === null ||
          state.running === null ||
          !identitiesEqual(identity, state.running)
        ) {
          throw new QualificationLedgerError();
        }
        const evidence = await evidenceForIdentity(
          options.repositoryRoot,
          options.batchId,
          identity,
          input.evidencePath,
          state.started.preflight,
          state.started.authorizationReferenceSha256,
        );
        if ((input.result === "passed") !== evidence.passed) {
          throw new QualificationLedgerError();
        }
        await publishLedgerJson(
          options.repositoryRoot,
          checkpointPath(
            options.repositoryRoot,
            options.batchId,
            state.loaded.length,
          ),
          {
            schemaVersion: 1,
            sequence: state.loaded.length,
            kind: "case_completed",
            batchId: options.batchId,
            recordedAt: input.recordedAt,
            repositoryCommit: state.started.preflight.repositoryCommit,
            buildIdentitySha256: state.started.preflight.buildIdentitySha256,
            preflightSha256: state.started.preflightSha256,
            ...identity,
            result: input.result,
            evidence: evidence.reference,
            ...evidence.telemetry,
            failureReason: evidence.failureReason,
          },
        );
      }),
    publishTerminalManifest: (input: {
      status: QualificationManifestStatus;
      stopReason: QualificationStopReason | null;
      notRun: readonly QualificationCaseIdentity[];
      completedAt: string;
    }) =>
      run(async () => {
        await assertNoTerminal(options.repositoryRoot, options.batchId);
        const state = await loadLedgerState(
          options.repositoryRoot,
          options.batchId,
        );
        if (state.started === null) throw new QualificationLedgerError();
        const manifest = buildManifest(state, {
          batchId: options.batchId,
          authorizationReferenceSha256:
            state.started.authorizationReferenceSha256,
          status: input.status,
          stopReason: input.stopReason,
          notRun: input.notRun,
          completedAt: input.completedAt,
          uncommittedEvidence: await findUncommittedEvidence(
            options.repositoryRoot,
            options.batchId,
            state,
          ),
        });
        await publishLedgerJson(
          options.repositoryRoot,
          path.join(directory, "manifest.json"),
          manifest,
        );
        if ((await inspectQualificationTerminal(options)).state !== "valid") {
          throw new QualificationLedgerError();
        }
        return manifest;
      }),
  });
}

const MANIFEST_KEYS = [
  "authorizationReferenceSha256",
  "batchId",
  "buildIdentitySha256",
  "cases",
  "checkpoints",
  "completedAt",
  "uncommittedEvidence",
  "notRun",
  "preflight",
  "preflightSha256",
  "promotionEligible",
  "repositoryCommit",
  "schemaVersion",
  "status",
  "stopReason",
] as const;

function normalizeCaseEntry(value: unknown): QualificationCaseManifestEntry {
  const record = plainRecord(value, [
    "adapterClientInvocationCount",
    "adapterReportedFallbackUsed",
    "adapterRetryCount",
    "evidence",
    "executionTelemetrySource",
    "failureReason",
    "llm",
    "ordinal",
    "orchestratorFallbackUsed",
    "result",
    "runtimeReportedAutoRetryCount",
    "task",
  ]);
  const identity = normalizeCaseIdentity({
    ordinal: record.ordinal,
    llm: record.llm,
    task: record.task,
  });
  if (record.result !== "passed" && record.result !== "failed") {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    ...identity,
    result: record.result,
    evidence: normalizeEvidenceReference(record.evidence),
    failureReason: normalizeFailureReason(
      record.failureReason,
      record.result === "passed",
    ),
    ...normalizeExecutionTelemetry(record),
  });
}

function normalizeUncommittedEvidence(
  value: unknown,
): QualificationUncommittedEvidence {
  const base = plainRecord(value);
  const commonKeys = [
    "adapterClientInvocationCount",
    "adapterReportedFallbackUsed",
    "adapterRetryCount",
    "evidence",
    "executionTelemetrySource",
    "failureReason",
    "llm",
    "observedPassed",
    "ordinal",
    "orchestratorFallbackUsed",
    "runtimeReportedAutoRetryCount",
    "task",
    "validationStatus",
  ] as const;
  if (base.validationStatus === "valid") {
    const record = plainRecord(value, commonKeys);
    if (typeof record.observedPassed !== "boolean") {
      throw new QualificationLedgerError();
    }
    return Object.freeze({
      validationStatus: "valid",
      ...normalizeCaseIdentity({
        ordinal: record.ordinal,
        llm: record.llm,
        task: record.task,
      }),
      evidence: normalizeEvidenceReference(record.evidence),
      observedPassed: record.observedPassed,
      failureReason: normalizeFailureReason(
        record.failureReason,
        record.observedPassed,
      ),
      ...normalizeExecutionTelemetry(record),
    });
  }
  const record = plainRecord(value, commonKeys);
  if (
    record.validationStatus !== "invalid" ||
    record.observedPassed !== null ||
    record.failureReason !== "infrastructure_failure" ||
    record.adapterClientInvocationCount !== null ||
    record.adapterRetryCount !== null ||
    record.runtimeReportedAutoRetryCount !== null ||
    record.adapterReportedFallbackUsed !== null ||
    record.orchestratorFallbackUsed !== null ||
    record.executionTelemetrySource !== null
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    validationStatus: "invalid",
    ...normalizeCaseIdentity({
      ordinal: record.ordinal,
      llm: record.llm,
      task: record.task,
    }),
    evidence: normalizeEvidenceReference(record.evidence),
    observedPassed: null,
    failureReason: "infrastructure_failure",
    adapterClientInvocationCount: null,
    adapterRetryCount: null,
    runtimeReportedAutoRetryCount: null,
    adapterReportedFallbackUsed: null,
    orchestratorFallbackUsed: null,
    executionTelemetrySource: null,
  });
}

function normalizeCheckpointReference(
  value: unknown,
): QualificationCheckpointReference {
  const record = plainRecord(value, ["path", "sequence", "sha256"]);
  if (
    typeof record.sequence !== "number" ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 0
  ) {
    throw new QualificationLedgerError();
  }
  const evidence = normalizeEvidenceReference({
    path: record.path,
    sha256: record.sha256,
  });
  return Object.freeze({
    sequence: record.sequence,
    ...evidence,
  });
}

async function readAndValidateManifest(
  repositoryRoot: string,
  batchId: string,
): Promise<QualificationTerminalManifest> {
  const file = await readLedgerJson(
    repositoryRoot,
    path.join(batchDirectory(repositoryRoot, batchId), "manifest.json"),
  );
  const record = plainRecord(file.value, MANIFEST_KEYS);
  if (
    record.schemaVersion !== 1 ||
    record.batchId !== batchId ||
    (record.status !== "passed" &&
      record.status !== "blocked" &&
      record.status !== "interrupted") ||
    typeof record.authorizationReferenceSha256 !== "string" ||
    !SHA256_PATTERN.test(record.authorizationReferenceSha256) ||
    !Array.isArray(record.cases) ||
    !Array.isArray(record.checkpoints) ||
    !Array.isArray(record.notRun) ||
    !validTimestamp(record.completedAt) ||
    typeof record.promotionEligible !== "boolean"
  ) {
    throw new QualificationLedgerError();
  }
  const state = await loadLedgerState(repositoryRoot, batchId);
  const preflight =
    record.preflight === null ? null : freezePreflightRecord(record.preflight);
  if (
    (preflight?.repositoryCommit ?? null) !== record.repositoryCommit ||
    (preflight?.buildIdentitySha256 ?? null) !== record.buildIdentitySha256 ||
    (preflight === null ? null : hashFrozenPreflightRecord(preflight)) !==
      record.preflightSha256 ||
    (state.started?.authorizationReferenceSha256 ??
      record.authorizationReferenceSha256) !==
      record.authorizationReferenceSha256
  ) {
    throw new QualificationLedgerError();
  }
  const manifestCases = record.cases.map(normalizeCaseEntry);
  const expectedCases = state.completed.map(caseEntry);
  if (JSON.stringify(manifestCases) !== JSON.stringify(expectedCases)) {
    throw new QualificationLedgerError();
  }
  const checkpointReferences = record.checkpoints.map(
    normalizeCheckpointReference,
  );
  if (
    JSON.stringify(checkpointReferences) !==
    JSON.stringify(state.loaded.map((item) => item.reference))
  ) {
    throw new QualificationLedgerError();
  }
  const notRun = normalizeNotRun(record.notRun);
  const uncommittedEvidence =
    record.uncommittedEvidence === null
      ? null
      : normalizeUncommittedEvidence(record.uncommittedEvidence);
  const expectedUncommittedEvidence = await findUncommittedEvidence(
    repositoryRoot,
    batchId,
    state,
  );
  if (
    JSON.stringify(uncommittedEvidence) !==
      JSON.stringify(expectedUncommittedEvidence) ||
    (uncommittedEvidence !== null &&
      record.status !== "interrupted" &&
      !(
        record.status === "blocked" &&
        record.stopReason === "infrastructure_failure"
      ))
  ) {
    throw new QualificationLedgerError();
  }
  const rebuilt = buildManifest(state, {
    batchId,
    authorizationReferenceSha256: record.authorizationReferenceSha256,
    status: record.status,
    stopReason: record.stopReason as QualificationStopReason | null,
    notRun,
    completedAt: record.completedAt,
    uncommittedEvidence,
  });
  if (
    JSON.stringify(rebuilt) !==
    JSON.stringify({
      ...record,
      preflight,
      cases: manifestCases,
      checkpoints: checkpointReferences,
      notRun,
      uncommittedEvidence,
    })
  ) {
    throw new QualificationLedgerError();
  }
  return rebuilt;
}

export async function inspectQualificationTerminal(options: {
  repositoryRoot: string;
  batchId: string;
}): Promise<QualificationTerminalInspection> {
  try {
    const manifestPath = path.join(
      batchDirectory(options.repositoryRoot, options.batchId),
      "manifest.json",
    );
    if (!(await ledgerPathExists(options.repositoryRoot, manifestPath))) {
      await validateLedgerDirectoryChain(
        options.repositoryRoot,
        path.dirname(manifestPath),
        false,
      );
      return Object.freeze({ state: "missing" });
    }
    const manifest = await readAndValidateManifest(
      options.repositoryRoot,
      options.batchId,
    );
    return Object.freeze({
      state: "valid",
      batchId: manifest.batchId,
      authorizationReferenceSha256: manifest.authorizationReferenceSha256,
    });
  } catch {
    throw new QualificationLedgerError();
  }
}

async function findUncommittedEvidence(
  repositoryRoot: string,
  batchId: string,
  state: LedgerState,
): Promise<QualificationUncommittedEvidence | null> {
  const directory = path.join(batchDirectory(repositoryRoot, batchId), "cases");
  let entries;
  try {
    entries = await readLedgerDirectory(repositoryRoot, directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new QualificationLedgerError();
  }
  const completedPaths = new Set(
    state.completed.map((item) => item.evidence.path),
  );
  const uncommitted: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9._-]+\.json$/u.test(entry.name)) {
      if (
        entry.isFile() &&
        /^\..+\.json\.[a-f0-9-]+\.tmp$/iu.test(entry.name)
      ) {
        continue;
      }
      throw new QualificationLedgerError();
    }
    const absolute = path.join(directory, entry.name);
    const relative = repositoryRelativePath(repositoryRoot, absolute);
    if (!completedPaths.has(relative)) uncommitted.push(absolute);
  }
  if (uncommitted.length === 0) return null;
  if (
    uncommitted.length !== 1 ||
    state.running === null ||
    state.started === null
  ) {
    throw new QualificationLedgerError();
  }
  const evidencePath = uncommitted[0]!;
  const beforeValidation = await readLedgerBytes(repositoryRoot, evidencePath);
  try {
    const validated = validateEvidenceForIdentity(
      repositoryRoot,
      batchId,
      state.running,
      evidencePath,
      state.started.preflight,
      state.started.authorizationReferenceSha256,
      parseImmutableBytes(beforeValidation),
    );
    return Object.freeze({
      validationStatus: "valid",
      ordinal: state.running.ordinal,
      llm: state.running.llm,
      task: state.running.task,
      evidence: validated.reference,
      observedPassed: validated.passed,
      failureReason: validated.failureReason,
      ...validated.telemetry,
    });
  } catch {
    return Object.freeze({
      validationStatus: "invalid",
      ordinal: state.running.ordinal,
      llm: state.running.llm,
      task: state.running.task,
      evidence: Object.freeze({
        path: repositoryRelativePath(repositoryRoot, evidencePath),
        sha256: beforeValidation.sha256,
      }),
      observedPassed: null,
      failureReason: "infrastructure_failure",
      adapterClientInvocationCount: null,
      adapterRetryCount: null,
      runtimeReportedAutoRetryCount: null,
      adapterReportedFallbackUsed: null,
      orchestratorFallbackUsed: null,
      executionTelemetrySource: null,
    });
  }
}

export async function recoverInterruptedQualificationBatch(options: {
  repositoryRoot: string;
  batchId: string;
  authorizationReferenceSha256: string;
  notRun?: readonly QualificationCaseIdentity[];
  completedAt: string;
}): Promise<QualificationTerminalManifest> {
  try {
    if (
      !validBatchId(options.batchId) ||
      !SHA256_PATTERN.test(options.authorizationReferenceSha256)
    ) {
      throw new QualificationLedgerError();
    }
    const terminal = await inspectQualificationTerminal(options);
    if (terminal.state === "valid") {
      if (
        terminal.batchId !== options.batchId ||
        terminal.authorizationReferenceSha256 !==
          options.authorizationReferenceSha256
      ) {
        throw new QualificationLedgerError();
      }
      return await readAndValidateManifest(
        options.repositoryRoot,
        options.batchId,
      );
    }
    const state = await loadLedgerState(
      options.repositoryRoot,
      options.batchId,
    );
    if (
      state.started !== null &&
      state.started.authorizationReferenceSha256 !==
        options.authorizationReferenceSha256
    ) {
      throw new QualificationLedgerError();
    }
    const uncommittedEvidence = await findUncommittedEvidence(
      options.repositoryRoot,
      options.batchId,
      state,
    );
    const inferredNotRun = QUALIFICATION_CASES.slice(
      state.completed.length + (state.running === null ? 0 : 1),
    );
    const manifest = buildManifest(state, {
      batchId: options.batchId,
      authorizationReferenceSha256: options.authorizationReferenceSha256,
      status: "interrupted",
      stopReason: "process_interrupted",
      notRun: options.notRun ?? inferredNotRun,
      completedAt: options.completedAt,
      uncommittedEvidence,
    });
    await publishLedgerJson(
      options.repositoryRoot,
      path.join(
        batchDirectory(options.repositoryRoot, options.batchId),
        "manifest.json",
      ),
      manifest,
    );
    await readAndValidateManifest(options.repositoryRoot, options.batchId);
    return manifest;
  } catch {
    throw new QualificationLedgerError();
  }
}

export async function assertAuthorizationReferenceUnused(options: {
  repositoryRoot: string;
  authorizationReferenceSha256: string;
  lockDirectory?: string;
  currentOwnerNonce?: string;
}): Promise<void> {
  try {
    if (!SHA256_PATTERN.test(options.authorizationReferenceSha256)) {
      throw new QualificationLedgerError();
    }
    const batchesRoot = path.resolve(
      options.repositoryRoot,
      "docs",
      "smoke",
      "evidence",
      "batches",
    );
    let entries: Dirent<string>[];
    try {
      entries = await readLedgerDirectory(options.repositoryRoot, batchesRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new QualificationLedgerError();
      }
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !validBatchId(entry.name)) {
        throw new QualificationLedgerError();
      }
      const state = await loadLedgerState(options.repositoryRoot, entry.name);
      const terminalPath = path.join(batchesRoot, entry.name, "manifest.json");
      let terminalAuthorization: string | null = null;
      if (await ledgerPathExists(options.repositoryRoot, terminalPath)) {
        terminalAuthorization = (
          await readAndValidateManifest(options.repositoryRoot, entry.name)
        ).authorizationReferenceSha256;
      }
      const checkpointAuthorization =
        state.started?.authorizationReferenceSha256 ?? null;
      if (
        terminalAuthorization !== null &&
        checkpointAuthorization !== null &&
        terminalAuthorization !== checkpointAuthorization
      ) {
        throw new QualificationLedgerError();
      }
      const recorded = terminalAuthorization ?? checkpointAuthorization;
      if (recorded === null) throw new QualificationLedgerError();
      if (recorded === options.authorizationReferenceSha256) {
        throw new QualificationLedgerError();
      }
    }
    if (options.lockDirectory !== undefined) {
      const owner = await readQualificationLockOwner(options.lockDirectory);
      if (options.currentOwnerNonce !== undefined) {
        if (
          owner.nonce !== options.currentOwnerNonce ||
          owner.authorizationReferenceSha256 !==
            options.authorizationReferenceSha256
        ) {
          throw new QualificationLedgerError();
        }
      } else if (
        owner.authorizationReferenceSha256 ===
        options.authorizationReferenceSha256
      ) {
        throw new QualificationLedgerError();
      }
    }
  } catch {
    throw new QualificationLedgerError();
  }
}
