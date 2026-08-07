import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { QualificationCaseIdentity } from "./types.js";

export type CurrentEvidenceRuntime = "kimi-acp" | "pi-rpc";

export class CurrentEvidenceContractError extends Error {
  constructor() {
    super("Current qualification evidence contract failed");
    this.name = "CurrentEvidenceContractError";
  }
}

function fail(): never {
  throw new CurrentEvidenceContractError();
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
    fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      fail();
    }
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

export function currentEvidenceCheckKeys(
  runtime: CurrentEvidenceRuntime,
  task: QualificationCaseIdentity["task"],
): readonly string[] {
  const environment = runtime === "pi-rpc" ? ["environmentIsolated"] : [];
  return (task === "review"
    ? [
        "actualModelMatches",
        ...environment,
        "executionTelemetryValid",
        "knownDefectFound",
        "ownedProcessDrained",
        "workspaceUnchanged",
      ]
    : [
        "actualModelMatches",
        ...environment,
        "executionTelemetryValid",
        "onlyExpectedFileChanged",
        "ownedProcessDrained",
        "requiredCommandObserved",
        "resultFileObserved",
        "resultFileValid",
      ]).sort();
}

function exactBooleanChecks(
  evidence: Record<string, unknown>,
  runtime: CurrentEvidenceRuntime,
  task: QualificationCaseIdentity["task"],
): Record<string, unknown> {
  const checks = plainRecord(evidence.checks);
  const actual = Object.keys(checks).sort();
  const expected = currentEvidenceCheckKeys(runtime, task);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    expected.some((key) => typeof checks[key] !== "boolean")
  ) {
    fail();
  }
  return checks;
}

const RESULT_ARTIFACT_KEYS = [
  "expectedResultNormalizedSha256",
  "resultFileByteLength",
  "resultFileContainsExpectedLine",
  "resultFileNormalizedLineCount",
  "resultFileNormalizedSha256",
  "resultFileRawSha256",
  "resultFileReadStatus",
] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function expectedResultLine(llm: string): string {
  return llm === "kimi-k3" ? "KIMI_SMOKE_OK" : `ARK_SMOKE_OK:${llm}`;
}

function validatePassedResultArtifact(
  evidence: Record<string, unknown>,
  llm: string,
): void {
  const expectedHash = createHash("sha256")
    .update(expectedResultLine(llm))
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
    fail();
  }
}

const KIMI_COMMAND_SOURCES = new Set([
  "raw_input",
  "title_fallback",
  "late_update",
  "unextractable",
]);
const KIMI_COMMAND_MATCHES = new Set([
  "exact",
  "trim_only",
  "embedded",
  "other",
]);

function denseArray(value: unknown, maximum = 256): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    value.length > maximum
  ) {
    fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const length = descriptors.length;
  const keys = Object.keys(descriptors).filter((key) => key !== "length");
  if (
    length === undefined ||
    !Object.hasOwn(length, "value") ||
    length.value !== value.length ||
    length.enumerable !== false ||
    length.configurable !== false ||
    length.writable !== true ||
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index))
  ) {
    fail();
  }
  return keys.map((key) => {
    const descriptor = descriptors[key]!;
    if (
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      fail();
    }
    return descriptor.value;
  });
}

function safeCommandCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail();
  }
  return value;
}

function validateKimiCommandDiagnostics(
  evidence: Record<string, unknown>,
  checks: Record<string, unknown>,
  required: boolean,
): void {
  if (!Object.hasOwn(evidence, "commandObservations")) {
    if (required) fail();
    return;
  }
  const observations = denseArray(evidence.commandObservations);
  const commandCount = safeCommandCount(evidence.commandCount);
  if (observations.length < commandCount) fail();
  let observedCommands = 0;
  let hasExact = false;
  for (const value of observations) {
    const observation = plainRecord(value);
    const keys = Object.keys(observation).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "match" ||
      keys[1] !== "source" ||
      typeof observation.source !== "string" ||
      !KIMI_COMMAND_SOURCES.has(observation.source) ||
      typeof observation.match !== "string" ||
      !KIMI_COMMAND_MATCHES.has(observation.match) ||
      ((observation.source === "title_fallback" ||
        observation.source === "unextractable") &&
        observation.match !== "other")
    ) {
      fail();
    }
    if (
      observation.source === "raw_input" ||
      observation.source === "late_update"
    ) {
      observedCommands += 1;
    }
    if (observation.match === "exact") hasExact = true;
  }
  if (
    observedCommands !== commandCount ||
    hasExact !== checks.requiredCommandObserved
  ) {
    fail();
  }
}

const PI_WRITE_SOURCES = new Set(["raw_input", "title_fallback", "unextractable"]);
const PI_WRITE_MATCHES = new Set([
  "exact",
  "status_exact",
  "trim_only",
  "embedded",
  "other",
]);
const PI_WRITE_OUTCOMES = new Set(["success", "error", "missing", "unknown"]);

function validatePiWriteDiagnostics(
  evidence: Record<string, unknown>,
  checks: Record<string, unknown>,
  required: boolean,
): void {
  if (!Object.hasOwn(evidence, "writeCommandObservations")) {
    if (required) fail();
    return;
  }
  const observations = denseArray(evidence.writeCommandObservations);
  const commandCount = safeCommandCount(evidence.commandCount);
  let extractable = 0;
  const writeMatches: Array<Record<string, unknown>> = [];
  const statusMatches: Array<Record<string, unknown>> = [];
  for (const value of observations) {
    const observation = plainRecord(value);
    const keys = Object.keys(observation).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "match" ||
      keys[1] !== "outcome" ||
      keys[2] !== "source" ||
      typeof observation.source !== "string" ||
      !PI_WRITE_SOURCES.has(observation.source) ||
      typeof observation.match !== "string" ||
      !PI_WRITE_MATCHES.has(observation.match) ||
      typeof observation.outcome !== "string" ||
      !PI_WRITE_OUTCOMES.has(observation.outcome) ||
      ((observation.source === "title_fallback" ||
        observation.source === "unextractable") &&
        observation.match !== "other")
    ) {
      fail();
    }
    if (observation.source !== "unextractable") extractable += 1;
    if (observation.match === "exact") writeMatches.push(observation);
    if (observation.match === "status_exact") statusMatches.push(observation);
  }
  if (extractable !== commandCount) fail();
  const succeeded =
    writeMatches.length === 1 &&
    writeMatches[0]?.outcome === "success" &&
    statusMatches.length === 1 &&
    statusMatches[0]?.outcome === "success";
  if (
    (statusMatches.length > 0 &&
      checks.requiredCommandObserved !== succeeded) ||
    (required && (!succeeded || checks.requiredCommandObserved !== true))
  ) {
    fail();
  }
}

const COMMON_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "workspace_changed",
]);

export function validateCurrentEvidenceContract(
  evidenceValue: unknown,
  options: Readonly<{
    llm: string;
    task: QualificationCaseIdentity["task"];
    runtime: CurrentEvidenceRuntime;
  }>,
): void {
  const evidence = plainRecord(evidenceValue);
  if (
    evidence.schemaVersion !== 4 ||
    evidence.llm !== options.llm ||
    evidence.task !== options.task ||
    evidence.runtime !== options.runtime ||
    typeof evidence.passed !== "boolean" ||
    (evidence.ownedProcessDrained !== true &&
      evidence.ownedProcessDrained !== null)
  ) {
    fail();
  }
  const passed = evidence.passed;
  const failureReason = evidence.failureReason;
  if (passed ? failureReason !== null : typeof failureReason !== "string") {
    fail();
  }
  if (failureReason === "infrastructure_failure") {
    const checks = plainRecord(evidence.checks);
    const keys = Object.keys(checks);
    if (
      passed ||
      evidence.status !== "failed" ||
      evidence.ownedProcessDrained !== null ||
      keys.length !== 1 ||
      keys[0] !== "ownedProcessDrained" ||
      checks.ownedProcessDrained !== "unknown"
    ) {
      fail();
    }
    return;
  }
  const checks = exactBooleanChecks(evidence, options.runtime, options.task);
  if (
    checks.ownedProcessDrained !==
    (evidence.ownedProcessDrained === true)
  ) {
    fail();
  }
  if (passed) {
    if (
      evidence.status !== "completed" ||
      evidence.ownedProcessDrained !== true ||
      Object.values(checks).some((value) => value !== true)
    ) {
      fail();
    }
  } else {
    if (!COMMON_STATUSES.has(String(evidence.status))) fail();
    if (
      failureReason === "acceptance_failed"
        ? evidence.status !== "completed" ||
          Object.values(checks).every((value) => value === true)
        : failureReason === "adapter_auth_or_model_unavailable"
          ? options.runtime !== "kimi-acp" || evidence.status === "completed"
          : failureReason === "adapter_failure"
            ? options.runtime !== "pi-rpc" || evidence.status === "completed"
            : failureReason === "missing_credential" ||
                failureReason === "account_quota_exceeded"
              ? options.runtime !== "pi-rpc"
              : true
    ) {
      fail();
    }
  }
  if (options.task === "review") {
    if (
      RESULT_ARTIFACT_KEYS.some((key) => Object.hasOwn(evidence, key)) ||
      Object.hasOwn(evidence, "commandObservations") ||
      Object.hasOwn(evidence, "writeCommandObservations") ||
      Object.hasOwn(evidence, "commandCount")
    ) {
      fail();
    }
    return;
  }
  if (passed) validatePassedResultArtifact(evidence, options.llm);
  if (options.runtime === "kimi-acp") {
    if (Object.hasOwn(evidence, "writeCommandObservations")) fail();
    validateKimiCommandDiagnostics(evidence, checks, passed);
  } else {
    if (Object.hasOwn(evidence, "commandObservations")) fail();
    validatePiWriteDiagnostics(evidence, checks, passed);
  }
}
