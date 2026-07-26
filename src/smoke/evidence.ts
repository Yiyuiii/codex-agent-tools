import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { types as nodeUtilTypes } from "node:util";

import { resolveLlm } from "../llms/registry.js";

export type SmokeKind = "kimi" | "pi" | "ark";
export type SmokeTask = "review" | "delegate";

export interface SmokeQualificationContext {
  batchId: string;
  ordinal: number;
  repositoryCommit: string;
  buildIdentitySha256: string;
  authorizationReferenceSha256: string;
  orchestratorFallbackUsed: false;
}

export type SmokeInfrastructureStage =
  | "runtime_setup"
  | "workspace_setup"
  | "fixture_setup"
  | "version_probe"
  | "pre_process_snapshot"
  | "task_execution"
  | "acceptance_check"
  | "post_process_snapshot"
  | "workspace_cleanup"
  | "smoke_execution";

export interface SmokeInfrastructureCounts {
  processIdsBefore?: number;
  processIdsAfter?: number;
}

export interface SmokeEvidenceFileOperations {
  ensureDirectory(directory: string): Promise<void>;
  writeExclusive(filePath: string, contents: string): Promise<void>;
  publishExclusive(source: string, destination: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

export const defaultSmokeEvidenceFileOperations: SmokeEvidenceFileOperations =
  Object.freeze({
    ensureDirectory: async (directory: string) => {
      await mkdir(directory, { recursive: true });
    },
    writeExclusive: async (filePath: string, contents: string) => {
      await writeFile(filePath, contents, {
        encoding: "utf8",
        flag: "wx",
      });
    },
    publishExclusive: async (source: string, destination: string) => {
      await link(source, destination);
    },
    remove: async (filePath: string) => {
      await rm(filePath, { force: true });
    },
  });

export class SmokeInfrastructureError extends Error {
  readonly stage: SmokeInfrastructureStage;
  readonly counts: SmokeInfrastructureCounts;

  constructor(
    stage: SmokeInfrastructureStage,
    counts: SmokeInfrastructureCounts = {},
    cause?: unknown,
  ) {
    super("Smoke infrastructure failure", { cause });
    this.name = "SmokeInfrastructureError";
    this.stage = stage;
    this.counts = { ...counts };
  }
}

export async function inSmokeInfrastructureStage<T>(
  stage: SmokeInfrastructureStage,
  operation: () => Promise<T>,
  counts: SmokeInfrastructureCounts = {},
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SmokeInfrastructureError) throw error;
    throw new SmokeInfrastructureError(stage, counts, error);
  }
}

interface ParsedSmokeArguments {
  llm: string;
  task: SmokeTask;
}

interface SmokeEvidence {
  schemaVersion: 2;
  timestamp: string;
  passed: boolean;
  qualification: SmokeQualificationContext | null;
  [key: string]: unknown;
}

export interface SmokeEntrypointOptions<
  TOptions extends ParsedSmokeArguments,
  TEvidence extends SmokeEvidence,
> {
  kind: SmokeKind;
  args: readonly string[];
  parseArguments: (args: readonly string[]) => TOptions;
  runSmoke: (
    options: TOptions & {
      onProgress: (message: string) => void;
      qualificationContext?: SmokeQualificationContext;
    },
  ) => Promise<TEvidence>;
  evidenceDirectory: string;
  reportedEvidenceDirectory?: string;
  qualificationContext?: unknown;
  now?: () => Date;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  fileOperations?: SmokeEvidenceFileOperations;
}

function evidenceFileName(
  kind: SmokeKind,
  timestamp: string,
  options: ParsedSmokeArguments,
): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp) ||
    new Date(timestamp).toISOString() !== timestamp ||
    !/^[A-Za-z0-9._-]+$/u.test(options.llm)
  ) {
    throw new Error("Invalid smoke evidence filename");
  }
  const suffix = kind === "kimi" ? "" : `-${kind}`;
  return `${timestamp.replaceAll(":", "-")}-${options.llm}-${options.task}${suffix}.json`;
}

function safeProgressLabel(message: string): string {
  if (/^(?:kimi|pi) heartbeat \d+ms$/u.test(message)) return "heartbeat";
  if (/^(?:kimi|pi) process started$/u.test(message)) {
    return "process_started";
  }
  if (/^(?:kimi|pi) prompt started$/u.test(message)) {
    return "prompt_started";
  }
  return "activity";
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const BATCH_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const QUALIFICATION_CONTEXT_KEYS = [
  "authorizationReferenceSha256",
  "batchId",
  "buildIdentitySha256",
  "orchestratorFallbackUsed",
  "ordinal",
  "repositoryCommit",
] as const;

function plainDataDescriptors(
  value: object,
): Record<string, PropertyDescriptor> {
  if (nodeUtilTypes.isProxy(value)) {
    throw new Error("Proxy objects are not allowed");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Expected a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error("Symbol properties are not allowed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new Error("Expected enumerable data properties");
    }
  }
  return descriptors;
}

function freezeQualificationContext(
  context: SmokeQualificationContext,
): SmokeQualificationContext {
  return Object.freeze({
    batchId: context.batchId,
    ordinal: context.ordinal,
    repositoryCommit: context.repositoryCommit,
    buildIdentitySha256: context.buildIdentitySha256,
    authorizationReferenceSha256: context.authorizationReferenceSha256,
    orchestratorFallbackUsed: false,
  });
}

export function normalizeSmokeQualificationContext(
  value: unknown,
): SmokeQualificationContext | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid smoke qualification context");
  }
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = plainDataDescriptors(value);
  } catch {
    throw new Error("Invalid smoke qualification context");
  }
  const keys = Object.keys(descriptors).sort();
  if (
    keys.length !== QUALIFICATION_CONTEXT_KEYS.length ||
    keys.some((key, index) => key !== QUALIFICATION_CONTEXT_KEYS[index])
  ) {
    throw new Error("Invalid smoke qualification context");
  }
  const batchId = descriptors.batchId?.value;
  const ordinal = descriptors.ordinal?.value;
  const repositoryCommit = descriptors.repositoryCommit?.value;
  const buildIdentitySha256 = descriptors.buildIdentitySha256?.value;
  const authorizationReferenceSha256 =
    descriptors.authorizationReferenceSha256?.value;
  const orchestratorFallbackUsed =
    descriptors.orchestratorFallbackUsed?.value;
  if (
    typeof batchId !== "string" ||
    !BATCH_ID_PATTERN.test(batchId) ||
    batchId === "." ||
    batchId === ".." ||
    typeof ordinal !== "number" ||
    !Number.isInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > 10 ||
    typeof repositoryCommit !== "string" ||
    !COMMIT_PATTERN.test(repositoryCommit) ||
    typeof buildIdentitySha256 !== "string" ||
    !SHA256_PATTERN.test(buildIdentitySha256) ||
    typeof authorizationReferenceSha256 !== "string" ||
    !SHA256_PATTERN.test(authorizationReferenceSha256) ||
    orchestratorFallbackUsed !== false
  ) {
    throw new Error("Invalid smoke qualification context");
  }
  return freezeQualificationContext({
    batchId,
    ordinal,
    repositoryCommit,
    buildIdentitySha256,
    authorizationReferenceSha256,
    orchestratorFallbackUsed,
  });
}

function normalizeReportedEvidenceDirectory(value: string): string {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\0")
  ) {
    throw new Error("Invalid smoke evidence destination");
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/u.test(segment),
    )
  ) {
    throw new Error("Invalid smoke evidence destination");
  }
  return segments.join("/");
}

function qualificationContextsEqual(
  left: SmokeQualificationContext | null,
  right: SmokeQualificationContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return QUALIFICATION_CONTEXT_KEYS.every((key) => left[key] === right[key]);
}

const DANGEROUS_EVIDENCE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toJSON",
]);

function snapshotJsonSafePlainData(
  value: unknown,
  ancestors: Set<object> = new Set(),
  depth = 0,
  root = true,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid JSON number");
    return value;
  }
  if (typeof value !== "object" || depth > 64) {
    throw new Error("Unsupported evidence value");
  }
  if (nodeUtilTypes.isProxy(value)) {
    throw new Error("Proxy evidence is not allowed");
  }
  if (ancestors.has(value)) throw new Error("Cyclic evidence value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        throw new Error("Invalid evidence array");
      }
      const descriptors = Object.getOwnPropertyDescriptors(
        value,
      ) as Record<string, PropertyDescriptor>;
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        typeof lengthDescriptor.value !== "number"
      ) {
        throw new Error("Invalid evidence array");
      }
      const length = lengthDescriptor.value;
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        keys.length !== length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new Error("Sparse or extended evidence array");
      }
      const snapshot = keys.map((key) => {
        const descriptor = descriptors[key]!;
        if (
          descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, "value") ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          throw new Error("Invalid evidence array element");
        }
        return snapshotJsonSafePlainData(
          descriptor.value,
          ancestors,
          depth + 1,
          false,
        );
      });
      return Object.freeze(snapshot);
    }

    const descriptors = plainDataDescriptors(value);
    const snapshot: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        DANGEROUS_EVIDENCE_KEYS.has(key) ||
        (root && key === "evidence")
      ) {
        throw new Error("Reserved evidence key");
      }
      snapshot[key] = snapshotJsonSafePlainData(
        descriptor.value,
        ancestors,
        depth + 1,
        false,
      );
    }
    return Object.freeze(snapshot);
  } finally {
    ancestors.delete(value);
  }
}

function infrastructureEvidence(
  options: ParsedSmokeArguments,
  error: SmokeInfrastructureError,
  timestamp: string,
  qualification: SmokeQualificationContext | null,
): SmokeEvidence {
  const profile = resolveLlm(options.llm);
  return {
    schemaVersion: 2,
    qualification,
    timestamp,
    llm: options.llm,
    actualModel: null,
    expectedModel: profile.model,
    runtime: profile.runtime,
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    route: profile.network,
    task: options.task,
    status: "failed",
    passed: false,
    failureReason: "infrastructure_failure",
    adapterClientInvocationCount: null,
    adapterRetryCount: null,
    runtimeReportedAutoRetryCount: null,
    adapterReportedFallbackUsed: null,
    orchestratorFallbackUsed:
      qualification?.orchestratorFallbackUsed ?? null,
    executionTelemetrySource: null,
    failure: {
      category: "infrastructure",
      stage: error.stage,
      count: 1,
    },
    counts: { ...error.counts },
    checks: {
      postProcessSnapshot:
        error.stage === "post_process_snapshot" ? "unknown" : "not_reached",
      processCleanup: "unknown",
    },
  };
}

export async function publishImmutableJson(
  destination: string,
  value: unknown,
  fileOperations: SmokeEvidenceFileOperations =
    defaultSmokeEvidenceFileOperations,
): Promise<void> {
  const directory = path.dirname(destination);
  const fileName = path.basename(destination);
  const temporaryPath = path.join(
    directory,
    `.${fileName}.${randomUUID()}.tmp`,
  );
  let committed = false;
  let failedBeforeCommit = false;
  try {
    await fileOperations.ensureDirectory(directory);
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) {
      throw new Error("Value is not JSON serializable");
    }
    await fileOperations.writeExclusive(
      temporaryPath,
      `${serialized}\n`,
    );
    await fileOperations.publishExclusive(temporaryPath, destination);
    committed = true;
  } catch {
    failedBeforeCommit = true;
  }
  try {
    await fileOperations.remove(temporaryPath);
  } catch {
    // The hard link is the commit point. Cleanup remains best effort after it.
  }
  if (!committed || failedBeforeCommit) {
    throw new Error("Immutable JSON publication failed");
  }
}

async function writeEvidence(
  evidenceDirectory: string,
  fileName: string,
  evidence: SmokeEvidence,
  fileOperations: SmokeEvidenceFileOperations,
): Promise<void> {
  await publishImmutableJson(
    path.join(evidenceDirectory, fileName),
    evidence,
    fileOperations,
  );
}

export async function runSmokeEntrypoint<
  TOptions extends ParsedSmokeArguments,
  TEvidence extends SmokeEvidence,
>(
  config: SmokeEntrypointOptions<TOptions, TEvidence>,
): Promise<number> {
  const writeStdout = config.writeStdout ?? ((text) => process.stdout.write(text));
  const writeStderr = config.writeStderr ?? ((text) => process.stderr.write(text));
  let qualification: SmokeQualificationContext | null;
  try {
    qualification = normalizeSmokeQualificationContext(
      config.qualificationContext,
    );
  } catch {
    writeStderr("Smoke qualification context is invalid.\n");
    return 1;
  }
  const batchReportedEvidenceDirectory =
    qualification === null
      ? null
      : `docs/smoke/evidence/batches/${qualification.batchId}/cases`;
  let reportedEvidenceDirectory: string;
  try {
    reportedEvidenceDirectory = normalizeReportedEvidenceDirectory(
      config.reportedEvidenceDirectory ??
        batchReportedEvidenceDirectory ??
        "docs/smoke/evidence",
    );
    if (
      batchReportedEvidenceDirectory !== null &&
      reportedEvidenceDirectory !== batchReportedEvidenceDirectory
    ) {
      throw new Error("Invalid smoke evidence destination");
    }
  } catch {
    writeStderr("Smoke evidence destination is invalid.\n");
    return 1;
  }
  if (qualification !== null) {
    const qualificationEvidenceDirectory = path.resolve(
      config.evidenceDirectory,
    );
    if (
      path.basename(qualificationEvidenceDirectory) !== "cases" ||
      path.basename(path.dirname(qualificationEvidenceDirectory)) !==
        qualification.batchId ||
      path.basename(
        path.dirname(path.dirname(qualificationEvidenceDirectory)),
      ) !== "batches"
    ) {
      writeStderr("Smoke evidence destination is invalid.\n");
      return 1;
    }
  }
  let options: TOptions;
  try {
    options = config.parseArguments(config.args);
  } catch {
    writeStderr("Smoke arguments are invalid.\n");
    return 1;
  }

  const now = config.now ?? (() => new Date());
  let evidence: SmokeEvidence;
  let infrastructureFailure = false;
  try {
    const runnerQualification =
      qualification === null
        ? null
        : freezeQualificationContext(qualification);
    const result = await config.runSmoke({
      ...options,
      onProgress: (message) =>
        writeStderr(
          `[${config.kind} smoke] ${safeProgressLabel(message)}\n`,
        ),
      ...(qualification === null
        ? {}
        : { qualificationContext: runnerQualification! }),
    });
    const resultSnapshot = snapshotJsonSafePlainData(result);
    if (
      typeof resultSnapshot !== "object" ||
      resultSnapshot === null ||
      Array.isArray(resultSnapshot)
    ) {
      throw new Error("Smoke evidence must be an object");
    }
    const resultRecord = resultSnapshot as Record<string, unknown>;
    const resultQualification = normalizeSmokeQualificationContext(
      resultRecord.qualification,
    );
    if (
      resultRecord.schemaVersion !== 2 ||
      !qualificationContextsEqual(resultQualification, qualification) ||
      resultRecord.orchestratorFallbackUsed !==
        (qualification?.orchestratorFallbackUsed ?? null)
    ) {
      throw new Error("Smoke evidence identity mismatch");
    }
    evidence = Object.freeze({
      ...resultRecord,
      schemaVersion: 2,
      qualification:
        qualification === null
          ? null
          : freezeQualificationContext(qualification),
      orchestratorFallbackUsed:
        qualification?.orchestratorFallbackUsed ?? null,
    }) as unknown as SmokeEvidence;
  } catch (error) {
    infrastructureFailure = true;
    const sanitized =
      error instanceof SmokeInfrastructureError
        ? error
        : new SmokeInfrastructureError("smoke_execution", {}, error);
    evidence = infrastructureEvidence(
      options,
      sanitized,
      now().toISOString(),
      qualification,
    );
  }

  let fileName: string;
  try {
    fileName = evidenceFileName(
      config.kind,
      evidence.timestamp,
      options,
    );
    const evidenceDirectory = path.resolve(config.evidenceDirectory);
    const destination = path.resolve(evidenceDirectory, fileName);
    const relativeDestination = path.relative(
      evidenceDirectory,
      destination,
    );
    if (
      relativeDestination === "" ||
      path.isAbsolute(relativeDestination) ||
      relativeDestination === ".." ||
      relativeDestination.startsWith(`..${path.sep}`) ||
      path.dirname(destination) !== evidenceDirectory
    ) {
      throw new Error("Smoke evidence path escaped its directory");
    }
    await writeEvidence(
      evidenceDirectory,
      fileName,
      evidence,
      config.fileOperations ?? defaultSmokeEvidenceFileOperations,
    );
  } catch {
    writeStderr(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
    return 1;
  }

  writeStdout(
    `${JSON.stringify(
      {
        ...evidence,
        evidence: `${reportedEvidenceDirectory}/${fileName}`,
      },
      null,
      2,
    )}\n`,
  );
  if (infrastructureFailure || !evidence.passed) {
    writeStderr("Smoke failed; sanitized evidence was written.\n");
    return 1;
  }
  return 0;
}
