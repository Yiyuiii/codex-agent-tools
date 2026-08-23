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

import {
  defaultSmokeEvidenceFileOperations,
  publishImmutableJson,
} from "../smoke/evidence.js";
import { readQualificationLockOwner } from "./lock.js";
import { validateCurrentEvidenceContract } from "./evidence-contract.js";
import {
  ACTIVE_QUALIFICATION_CASES,
  ACTIVE_QUALIFICATION_PLAN_ID,
  CAPABILITY_REFRESH_QUALIFICATION_CASES,
  CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID,
  DIRECT_DEEPSEEK_QUALIFICATION_CASES,
  DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
  LEGACY_QUALIFICATION_CASES,
  LEGACY_QUALIFICATION_PLAN_ID,
  type CurrentQualificationPlanId,
  type QualificationPlanId,
} from "./protocol.js";
import type {
  BuildArtifactIdentity,
  CurrentV3FrozenPreflightRecord,
  FrozenCredentialMatch,
  FrozenLogicalLlmIdentity,
  FrozenPreflightRecord,
  LegacyFrozenPreflightRecord,
  HistoricalCurrentFrozenPreflightRecord,
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

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const BATCH_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const SAFE_RELATIVE_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const MAX_LEDGER_FILE_BYTES = 1_048_576;
const LEGACY_REQUIRED_BUILD_ARTIFACTS = [
  "dist/ark-smoke.js",
  "dist/kimi-smoke.js",
  "dist/pi-smoke.js",
  "dist/smoke-evidence.js",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
] as const;
const CURRENT_REQUIRED_BUILD_ARTIFACTS = [
  "dist/ark-smoke.js",
  "dist/kimi-smoke.js",
  "dist/smoke-evidence.js",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
] as const;
const DIRECT_DEEPSEEK_REQUIRED_BUILD_ARTIFACTS = [
  "dist/deepseek-smoke.js",
  "dist/smoke-evidence.js",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
] as const;
const COMMON_PREFLIGHT_KEYS = [
  "buildArtifacts",
  "buildIdentitySha256",
  "credentialMatches",
  "logicalLlms",
  "packageLockSha256",
  "packageVersion",
  "piConfigSha256",
  "repositoryBranch",
  "repositoryCommit",
  "repositoryDirty",
  "runtimeVersions",
] as const;
const LEGACY_PREFLIGHT_KEYS = [
  ...COMMON_PREFLIGHT_KEYS,
  "proxy10808",
  "schemaVersion",
  "targetProcesses",
] as const;
const HISTORICAL_CURRENT_PREFLIGHT_KEYS = [
  ...COMMON_PREFLIGHT_KEYS,
  "qualificationPlanId",
  "schemaVersion",
  "targetProcesses",
] as const;
const CURRENT_PREFLIGHT_KEYS = [
  ...COMMON_PREFLIGHT_KEYS,
  "qualificationPlanId",
  "schemaVersion",
] as const;

const LEGACY_LOGICAL_LLMS = Object.freeze([
  Object.freeze({
    llm: "ark-agent-deepseek-v4-flash",
    runtime: "pi-rpc",
    model: "deepseek-v4-flash",
    provider: "ark-agent-plan",
    route: "direct",
  }),
  Object.freeze({
    llm: "ark-agent-plan",
    runtime: "pi-rpc",
    model: "ark-code-latest",
    provider: "ark-agent-plan",
    route: "direct",
  }),
  Object.freeze({
    llm: "ark-coding-plan",
    runtime: "pi-rpc",
    model: "ark-code-latest",
    provider: "ark-coding-plan",
    route: "direct",
  }),
  Object.freeze({
    llm: "gemini-3.5-flash",
    runtime: "pi-rpc",
    model: "gemini-3.5-flash",
    provider: "google",
    route: "proxy-10808",
  }),
  Object.freeze({
    llm: "kimi-k3",
    runtime: "kimi-acp",
    model: "kimi-code/k3",
    provider: null,
    route: "direct",
  }),
] as const satisfies readonly FrozenLogicalLlmIdentity[]);
const CURRENT_LOGICAL_LLMS = Object.freeze([
  Object.freeze({
    llm: "ark-agent-deepseek-v4-flash",
    runtime: "pi-rpc",
    model: "deepseek-v4-flash",
    provider: "ark-agent-plan",
    route: "direct",
  }),
  Object.freeze({
    llm: "ark-agent-plan",
    runtime: "pi-rpc",
    model: "ark-code-latest",
    provider: "ark-agent-plan",
    route: "direct",
  }),
  Object.freeze({
    llm: "ark-coding-plan",
    runtime: "pi-rpc",
    model: "ark-code-latest",
    provider: "ark-coding-plan",
    route: "direct",
  }),
  Object.freeze({
    llm: "kimi-k3",
    runtime: "kimi-acp",
    model: "kimi-code/k3",
    provider: null,
    route: "direct",
  }),
] as const satisfies readonly FrozenLogicalLlmIdentity[]);
const DIRECT_DEEPSEEK_LOGICAL_LLMS = Object.freeze([
  Object.freeze({
    llm: "deepseek-v4-flash",
    runtime: "pi-rpc",
    model: "deepseek-v4-flash",
    provider: "deepseek",
    route: "direct",
  }),
] as const satisfies readonly FrozenLogicalLlmIdentity[]);

interface PreflightCredentialRule {
  readonly llm: string;
  readonly environmentVariableNames: readonly (string | null)[];
}

function frozenCredentialRule(
  llm: string,
  environmentVariableNames: readonly (string | null)[],
): PreflightCredentialRule {
  return Object.freeze({
    llm,
    environmentVariableNames: Object.freeze([...environmentVariableNames]),
  });
}

const LEGACY_CREDENTIAL_ENVIRONMENT_NAMES = Object.freeze([
  frozenCredentialRule("ark-agent-deepseek-v4-flash", [
    "OPENAI_API_KEY_DOUBAO",
  ]),
  frozenCredentialRule("ark-agent-plan", ["OPENAI_API_KEY_DOUBAO"]),
  frozenCredentialRule("ark-coding-plan", [
    "ARK_API_KEY",
    "VOLCENGINE_API_KEY",
    "API_KEY_DOUBAO_CODING",
  ]),
  frozenCredentialRule("gemini-3.5-flash", [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ]),
  frozenCredentialRule("kimi-k3", [null]),
]);
const CURRENT_CREDENTIAL_ENVIRONMENT_NAMES = Object.freeze([
  frozenCredentialRule("ark-agent-deepseek-v4-flash", [
    "OPENAI_API_KEY_DOUBAO",
  ]),
  frozenCredentialRule("ark-agent-plan", ["OPENAI_API_KEY_DOUBAO"]),
  frozenCredentialRule("ark-coding-plan", [
    "ARK_API_KEY",
    "VOLCENGINE_API_KEY",
    "API_KEY_DOUBAO_CODING",
  ]),
  frozenCredentialRule("kimi-k3", [null]),
]);
const DIRECT_DEEPSEEK_CREDENTIAL_ENVIRONMENT_NAMES = Object.freeze([
  frozenCredentialRule("deepseek-v4-flash", [
    "OPENAI_API_KEY_DEEPSEEK",
  ]),
]);

interface QualificationProtocol {
  readonly planId: QualificationPlanId;
  readonly manifestSchemaVersion: 1 | 2 | 3;
  readonly checkpointSchemaVersion: 1 | 2 | 3;
  readonly evidenceSchemaVersion: 2 | 3 | 4;
  readonly schedule: readonly QualificationCaseIdentity[];
  readonly allowGoogleFreeTierQuota: boolean;
  readonly freezePreflight: (value: unknown) => FrozenPreflightRecord;
}

const LEGACY_PROTOCOL: QualificationProtocol = Object.freeze({
  planId: LEGACY_QUALIFICATION_PLAN_ID,
  manifestSchemaVersion: 1,
  checkpointSchemaVersion: 1,
  evidenceSchemaVersion: 2,
  schedule: LEGACY_QUALIFICATION_CASES,
  allowGoogleFreeTierQuota: true,
  freezePreflight: freezeLegacyPreflightRecord,
});

const HISTORICAL_CURRENT_PROTOCOL: QualificationProtocol = Object.freeze({
  planId: ACTIVE_QUALIFICATION_PLAN_ID,
  manifestSchemaVersion: 2,
  checkpointSchemaVersion: 2,
  evidenceSchemaVersion: 3,
  schedule: ACTIVE_QUALIFICATION_CASES,
  allowGoogleFreeTierQuota: false,
  freezePreflight: freezeHistoricalCurrentPreflightRecord,
});

const CURRENT_PROTOCOL: QualificationProtocol = Object.freeze({
  planId: ACTIVE_QUALIFICATION_PLAN_ID,
  manifestSchemaVersion: 3,
  checkpointSchemaVersion: 3,
  evidenceSchemaVersion: 4,
  schedule: ACTIVE_QUALIFICATION_CASES,
  allowGoogleFreeTierQuota: false,
  freezePreflight: freezeCurrentPreflightRecord,
});

const DIRECT_DEEPSEEK_PROTOCOL: QualificationProtocol = Object.freeze({
  planId: DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
  manifestSchemaVersion: 3,
  checkpointSchemaVersion: 3,
  evidenceSchemaVersion: 4,
  schedule: DIRECT_DEEPSEEK_QUALIFICATION_CASES,
  allowGoogleFreeTierQuota: false,
  freezePreflight: freezeCurrentPreflightRecord,
});

const CAPABILITY_REFRESH_PROTOCOL: QualificationProtocol = Object.freeze({
  planId: CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID,
  manifestSchemaVersion: 3,
  checkpointSchemaVersion: 3,
  evidenceSchemaVersion: 4,
  schedule: CAPABILITY_REFRESH_QUALIFICATION_CASES,
  allowGoogleFreeTierQuota: false,
  freezePreflight: freezeCurrentPreflightRecord,
});

function isCurrentProtocol(
  protocol: QualificationProtocol,
): boolean {
  return (
    protocol === CURRENT_PROTOCOL ||
    protocol === DIRECT_DEEPSEEK_PROTOCOL ||
    protocol === CAPABILITY_REFRESH_PROTOCOL
  );
}

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

function protocolForEnvelope(value: unknown): QualificationProtocol {
  const envelope = plainRecord(value);
  const hasPlan = Object.hasOwn(envelope, "qualificationPlanId");
  if (envelope.schemaVersion === 1 && !hasPlan) {
    return LEGACY_PROTOCOL;
  }
  if (
    envelope.schemaVersion === 2 &&
    envelope.qualificationPlanId === ACTIVE_QUALIFICATION_PLAN_ID
  ) {
    return HISTORICAL_CURRENT_PROTOCOL;
  }
  if (
    envelope.schemaVersion === 3 &&
    envelope.qualificationPlanId === ACTIVE_QUALIFICATION_PLAN_ID
  ) {
    return CURRENT_PROTOCOL;
  }
  if (
    envelope.schemaVersion === 3 &&
    envelope.qualificationPlanId === DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID
  ) {
    return DIRECT_DEEPSEEK_PROTOCOL;
  }
  if (
    envelope.schemaVersion === 3 &&
    envelope.qualificationPlanId === CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID
  ) {
    return CAPABILITY_REFRESH_PROTOCOL;
  }
  throw new QualificationLedgerError();
}

function protocolForPlanId(planId: unknown): QualificationProtocol {
  if (planId === LEGACY_QUALIFICATION_PLAN_ID) return LEGACY_PROTOCOL;
  if (planId === ACTIVE_QUALIFICATION_PLAN_ID) return CURRENT_PROTOCOL;
  if (planId === DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID) {
    return DIRECT_DEEPSEEK_PROTOCOL;
  }
  if (planId === CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID) {
    return CAPABILITY_REFRESH_PROTOCOL;
  }
  throw new QualificationLedgerError();
}

function protocolEnvelope(
  protocol: QualificationProtocol,
): Readonly<
  | { schemaVersion: 1 }
  | { schemaVersion: 2; qualificationPlanId: "four-llm-v1" }
  | { schemaVersion: 3; qualificationPlanId: CurrentQualificationPlanId }
> {
  if (protocol === LEGACY_PROTOCOL) {
    return Object.freeze({ schemaVersion: 1 as const });
  }
  if (protocol === HISTORICAL_CURRENT_PROTOCOL) {
    return Object.freeze({
      schemaVersion: 2 as const,
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
    });
  }
  return Object.freeze({
    schemaVersion: 3 as const,
    qualificationPlanId: protocol.planId as CurrentQualificationPlanId,
  });
}

function assertProtocol(
  actual: QualificationProtocol,
  expected: QualificationProtocol,
): void {
  if (actual !== expected) throw new QualificationLedgerError();
}

function assertPreflightProtocol(
  preflight: FrozenPreflightRecord,
  protocol: QualificationProtocol,
): void {
  if (
    (protocol === LEGACY_PROTOCOL && preflight.schemaVersion === 1) ||
    (protocol === HISTORICAL_CURRENT_PROTOCOL &&
      preflight.schemaVersion === 2 &&
      preflight.qualificationPlanId === ACTIVE_QUALIFICATION_PLAN_ID) ||
    (isCurrentProtocol(protocol) &&
      preflight.schemaVersion === 3 &&
      preflight.qualificationPlanId === protocol.planId)
  ) {
    return;
  }
  throw new QualificationLedgerError();
}

function keysForProtocol(
  protocol: QualificationProtocol,
  keys: readonly string[],
): readonly string[] {
  return protocol === LEGACY_PROTOCOL ? keys : [...keys, "qualificationPlanId"];
}

function densePlainArray(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new QualificationLedgerError();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(?:0|[1-9]\d*)$/u.test(key) ||
          Number(key) >= value.length),
    )
  ) {
    throw new QualificationLedgerError();
  }
  const dense: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!Object.hasOwn(value, key)) throw new QualificationLedgerError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new QualificationLedgerError();
    }
    dense.push(descriptor.value);
  }
  return dense;
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

function normalizeLogicalIdentity(
  value: unknown,
  expected: FrozenLogicalLlmIdentity,
): FrozenLogicalLlmIdentity {
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
  if (
    record.llm !== expected.llm ||
    record.runtime !== expected.runtime ||
    record.model !== expected.model ||
    record.provider !== expected.provider ||
    record.route !== expected.route
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

function normalizeCredentialMatchForProtocol(
  value: unknown,
  expected: {
    readonly llm: string;
    readonly environmentVariableNames: readonly (string | null)[];
  },
): FrozenCredentialMatch {
  const record = plainRecord(value, ["environmentVariableName", "llm"]);
  if (
    record.llm !== expected.llm ||
    (record.environmentVariableName !== null &&
      typeof record.environmentVariableName !== "string") ||
    !expected.environmentVariableNames.some(
      (name) => name === record.environmentVariableName,
    )
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    llm: expected.llm,
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

function freezePreflightCommon(
  record: Record<string, unknown>,
  expectedArtifacts: readonly string[],
  expectedLogicalLlms: readonly FrozenLogicalLlmIdentity[],
  expectedCredentialMatches: readonly {
    readonly llm: string;
    readonly environmentVariableNames: readonly (string | null)[];
  }[],
  historicalHostProbes: boolean,
) {
  if (
    typeof record.repositoryCommit !== "string" ||
    !COMMIT_PATTERN.test(record.repositoryCommit) ||
    !safeText(record.repositoryBranch) ||
    record.repositoryDirty !== false ||
    !safeText(record.packageVersion, 128) ||
    typeof record.packageLockSha256 !== "string" ||
    !SHA256_PATTERN.test(record.packageLockSha256) ||
    typeof record.buildIdentitySha256 !== "string" ||
    !SHA256_PATTERN.test(record.buildIdentitySha256) ||
    typeof record.piConfigSha256 !== "string" ||
    !SHA256_PATTERN.test(record.piConfigSha256) ||
    record.logicalLlms === undefined ||
    record.credentialMatches === undefined
  ) {
    throw new QualificationLedgerError();
  }
  const buildArtifacts = densePlainArray(record.buildArtifacts).map(
    normalizeArtifact,
  );
  if (
    buildArtifacts.length !== expectedArtifacts.length ||
    buildArtifacts.some(
      (artifact, index) => artifact.path !== expectedArtifacts[index],
    ) ||
    sha256(JSON.stringify(buildArtifacts)) !== record.buildIdentitySha256
  ) {
    throw new QualificationLedgerError();
  }
  const runtimeVersions = plainRecord(
    record.runtimeVersions,
    historicalHostProbes
      ? ["codex", "kimi", "node", "pi"]
      : ["codex", "node"],
  );
  if (
    !safeText(runtimeVersions.node, 128) ||
    !safeText(runtimeVersions.codex, 128) ||
    (historicalHostProbes &&
      (!safeText(runtimeVersions.kimi, 128) ||
        !safeText(runtimeVersions.pi, 128)))
  ) {
    throw new QualificationLedgerError();
  }
  const rawLogicalLlms = densePlainArray(record.logicalLlms);
  if (rawLogicalLlms.length !== expectedLogicalLlms.length) {
    throw new QualificationLedgerError();
  }
  const logicalLlms = rawLogicalLlms.map((identity, index) =>
    normalizeLogicalIdentity(identity, expectedLogicalLlms[index]!),
  );
  const rawCredentialMatches = densePlainArray(record.credentialMatches);
  if (rawCredentialMatches.length !== expectedCredentialMatches.length) {
    throw new QualificationLedgerError();
  }
  const credentialMatches = rawCredentialMatches.map((match, index) =>
    normalizeCredentialMatchForProtocol(
      match,
      expectedCredentialMatches[index]!,
    ),
  );
  const common = {
    repositoryCommit: record.repositoryCommit,
    repositoryBranch: record.repositoryBranch,
    repositoryDirty: false as const,
    packageVersion: record.packageVersion,
    packageLockSha256: record.packageLockSha256,
    buildArtifacts: Object.freeze(buildArtifacts),
    buildIdentitySha256: record.buildIdentitySha256,
    runtimeVersions: historicalHostProbes
      ? Object.freeze({
          node: runtimeVersions.node as string,
          codex: runtimeVersions.codex as string,
          kimi: runtimeVersions.kimi as string,
          pi: runtimeVersions.pi as string,
        })
      : Object.freeze({
          node: runtimeVersions.node as string,
          codex: runtimeVersions.codex as string,
        }),
    piConfigSha256: record.piConfigSha256,
    logicalLlms: Object.freeze(logicalLlms),
    credentialMatches: Object.freeze(credentialMatches),
  };
  return Object.freeze(common);
}

function freezeLegacyPreflightRecord(
  value: unknown,
): LegacyFrozenPreflightRecord {
  const record = plainRecord(value, LEGACY_PREFLIGHT_KEYS);
  if (record.schemaVersion !== 1) throw new QualificationLedgerError();
  const proxy = plainRecord(record.proxy10808, ["host", "listening", "port"]);
  if (
    proxy.host !== "127.0.0.1" ||
    proxy.port !== 10808 ||
    proxy.listening !== true
  ) {
    throw new QualificationLedgerError();
  }
  const common = freezePreflightCommon(
    record,
    LEGACY_REQUIRED_BUILD_ARTIFACTS,
    LEGACY_LOGICAL_LLMS,
    LEGACY_CREDENTIAL_ENVIRONMENT_NAMES,
    true,
  ) as Omit<
    LegacyFrozenPreflightRecord,
    "schemaVersion" | "proxy10808" | "targetProcesses"
  >;
  return Object.freeze({
    schemaVersion: 1,
    ...common,
    proxy10808: Object.freeze({
      host: "127.0.0.1",
      port: 10808,
      listening: true,
    }),
    targetProcesses: normalizeTargetProcesses(record.targetProcesses),
  });
}

function freezeHistoricalCurrentPreflightRecord(
  value: unknown,
): HistoricalCurrentFrozenPreflightRecord {
  const record = plainRecord(value, HISTORICAL_CURRENT_PREFLIGHT_KEYS);
  if (
    record.schemaVersion !== 2 ||
    record.qualificationPlanId !== ACTIVE_QUALIFICATION_PLAN_ID
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    schemaVersion: 2,
    qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
    ...(freezePreflightCommon(
      record,
      CURRENT_REQUIRED_BUILD_ARTIFACTS,
      CURRENT_LOGICAL_LLMS,
      CURRENT_CREDENTIAL_ENVIRONMENT_NAMES,
      true,
    ) as Omit<
      HistoricalCurrentFrozenPreflightRecord,
      "schemaVersion" | "qualificationPlanId" | "targetProcesses"
    >),
    targetProcesses: normalizeTargetProcesses(record.targetProcesses),
  }) as HistoricalCurrentFrozenPreflightRecord;
}

function freezeCurrentPreflightRecord(
  value: unknown,
): CurrentV3FrozenPreflightRecord {
  const record = plainRecord(value, CURRENT_PREFLIGHT_KEYS);
  const directDeepSeek =
    record.qualificationPlanId === DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID;
  if (
    record.schemaVersion !== 3 ||
    (record.qualificationPlanId !== ACTIVE_QUALIFICATION_PLAN_ID &&
      record.qualificationPlanId !==
        CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID &&
      !directDeepSeek)
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    schemaVersion: 3,
    qualificationPlanId: record.qualificationPlanId,
    ...freezePreflightCommon(
      record,
      directDeepSeek
        ? DIRECT_DEEPSEEK_REQUIRED_BUILD_ARTIFACTS
        : CURRENT_REQUIRED_BUILD_ARTIFACTS,
      directDeepSeek
        ? DIRECT_DEEPSEEK_LOGICAL_LLMS
        : CURRENT_LOGICAL_LLMS,
      directDeepSeek
        ? DIRECT_DEEPSEEK_CREDENTIAL_ENVIRONMENT_NAMES
        : CURRENT_CREDENTIAL_ENVIRONMENT_NAMES,
      false,
    ),
  }) as CurrentV3FrozenPreflightRecord;
}

export function freezePreflightRecord(value: unknown): FrozenPreflightRecord {
  try {
    return protocolForEnvelope(value).freezePreflight(value);
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

function normalizeCaseIdentity(
  value: unknown,
  protocol: QualificationProtocol,
): QualificationCaseIdentity {
  const record = plainRecord(value, ["llm", "ordinal", "task"]);
  if (
    typeof record.ordinal !== "number" ||
    !Number.isSafeInteger(record.ordinal) ||
    record.ordinal < 1 ||
    record.ordinal > protocol.schedule.length ||
    typeof record.llm !== "string" ||
    (record.task !== "review" && record.task !== "delegate")
  ) {
    throw new QualificationLedgerError();
  }
  const identity = Object.freeze({
    ordinal: record.ordinal,
    llm: record.llm,
    task: record.task,
  });
  const fixed = protocol.schedule[identity.ordinal - 1];
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
  schemaVersion: 1 | 2 | 3;
  qualificationPlanId?: CurrentQualificationPlanId;
  sequence: 0;
  kind: "batch_started";
  batchId: string;
  recordedAt: string;
  authorizationReferenceSha256: string;
  preflightSha256: string;
  preflight: FrozenPreflightRecord;
}

interface CaseRunningCheckpoint extends QualificationCaseIdentity {
  schemaVersion: 1 | 2 | 3;
  qualificationPlanId?: CurrentQualificationPlanId;
  sequence: number;
  kind: "case_running";
  batchId: string;
  recordedAt: string;
  repositoryCommit: string;
  buildIdentitySha256: string;
  preflightSha256: string;
}

interface CaseCompletedCheckpoint extends QualificationCaseIdentity {
  schemaVersion: 1 | 2 | 3;
  qualificationPlanId?: CurrentQualificationPlanId;
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
  ownedProcessDrained?: true | null;
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
  ownedProcessDrained?: true | null;
}

function normalizeExecutionTelemetry(
  record: Record<string, unknown>,
  protocol: QualificationProtocol,
  passed: boolean | null,
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
  const common = {
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
  } as const;
  let ownedProcessDrained: true | null | undefined;
  if (isCurrentProtocol(protocol)) {
    if (
      !Object.hasOwn(record, "ownedProcessDrained") ||
      (record.ownedProcessDrained !== true &&
        record.ownedProcessDrained !== null) ||
      (passed === true && record.ownedProcessDrained !== true)
    ) {
      throw new QualificationLedgerError();
    }
    ownedProcessDrained = record.ownedProcessDrained;
  } else if (Object.hasOwn(record, "ownedProcessDrained")) {
    throw new QualificationLedgerError();
  }
  const normalized = Object.freeze(
    isCurrentProtocol(protocol)
      ? { ...common, ownedProcessDrained: ownedProcessDrained! }
      : common,
  );
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
  protocol: QualificationProtocol,
): QualificationCheckpoint {
  const base = plainRecord(value);
  assertProtocol(protocolForEnvelope(value), protocol);
  if (
    base.sequence !== expectedSequence ||
    base.batchId !== expectedBatchId ||
    !validTimestamp(base.recordedAt)
  ) {
    throw new QualificationLedgerError();
  }
  if (base.kind === "batch_started") {
    plainRecord(
      value,
      keysForProtocol(protocol, [
        "authorizationReferenceSha256",
        "batchId",
        "kind",
        "preflight",
        "preflightSha256",
        "recordedAt",
        "schemaVersion",
        "sequence",
      ]),
    );
    const preflight = protocol.freezePreflight(base.preflight);
    assertPreflightProtocol(preflight, protocol);
    if (
      expectedSequence !== 0 ||
      typeof base.authorizationReferenceSha256 !== "string" ||
      !SHA256_PATTERN.test(base.authorizationReferenceSha256) ||
      base.preflightSha256 !== hashFrozenPreflightRecord(preflight)
    ) {
      throw new QualificationLedgerError();
    }
    return Object.freeze({
      ...protocolEnvelope(protocol),
      sequence: 0,
      kind: "batch_started",
      batchId: expectedBatchId,
      recordedAt: base.recordedAt,
      authorizationReferenceSha256: base.authorizationReferenceSha256,
      preflightSha256: base.preflightSha256,
      preflight,
    });
  }
  const identity = normalizeCaseIdentity(
    {
      ordinal: base.ordinal,
      llm: base.llm,
      task: base.task,
    },
    protocol,
  );
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
    plainRecord(value, keysForProtocol(protocol, commonKeys));
    return Object.freeze({
      ...protocolEnvelope(protocol),
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
    const telemetry = normalizeExecutionTelemetry(
      base,
      protocol,
      base.result === "passed",
    );
    plainRecord(
      value,
      keysForProtocol(protocol, [
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
        ...(isCurrentProtocol(protocol) ? ["ownedProcessDrained"] : []),
      ]),
    );
    return Object.freeze({
      ...protocolEnvelope(protocol),
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
        protocol,
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
  protocol: QualificationProtocol,
): QualificationFailureReason {
  if (passed) {
    if (value !== null) throw new QualificationLedgerError();
    return null;
  }
  if (typeof value !== "string" || !QUALIFICATION_FAILURE_REASONS.has(value)) {
    throw new QualificationLedgerError();
  }
  if (
    value === "google_free_tier_quota" &&
    !protocol.allowGoogleFreeTierQuota
  ) {
    throw new QualificationLedgerError();
  }
  if (value === "process_residual" && isCurrentProtocol(protocol)) {
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
  protocol: QualificationProtocol,
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
    protocol,
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
  protocol: QualificationProtocol,
): ValidatedQualificationEvidence {
  const evidence = plainRecord(file.value);
  const qualification =
    protocol === LEGACY_PROTOCOL
      ? plainRecord(evidence.qualification, [
          "authorizationReferenceSha256",
          "batchId",
          "buildIdentitySha256",
          "orchestratorFallbackUsed",
          "ordinal",
          "repositoryCommit",
        ])
      : plainRecord(evidence.qualification, [
          "authorizationReferenceSha256",
          "batchId",
          "frozenBuildIdentity",
          "frozenCommit",
          "llm",
          "orchestratorFallbackUsed",
          "ordinal",
          "qualificationPlanId",
          "task",
        ]);
  const qualificationIdentityMatches =
    protocol === LEGACY_PROTOCOL
      ? qualification.repositoryCommit === preflight.repositoryCommit &&
        qualification.buildIdentitySha256 === preflight.buildIdentitySha256
      : qualification.qualificationPlanId === protocol.planId &&
        qualification.llm === identity.llm &&
        qualification.task === identity.task &&
        qualification.frozenCommit === preflight.repositoryCommit &&
        qualification.frozenBuildIdentity === preflight.buildIdentitySha256;
  if (
    evidence.schemaVersion !== protocol.evidenceSchemaVersion ||
    qualification.batchId !== batchId ||
    qualification.ordinal !== identity.ordinal ||
    !qualificationIdentityMatches ||
    qualification.authorizationReferenceSha256 !==
      authorizationReferenceSha256 ||
    qualification.orchestratorFallbackUsed !== false ||
    evidence.llm !== identity.llm ||
    evidence.task !== identity.task ||
    typeof evidence.passed !== "boolean"
  ) {
    throw new QualificationLedgerError();
  }
  const telemetry = normalizeExecutionTelemetry(
    evidence,
    protocol,
    evidence.passed as boolean,
  );
  const failureReason = normalizeFailureReason(
    evidence.failureReason,
    evidence.passed,
    protocol,
  );
  const frozenIdentity = preflight.logicalLlms.find(
    (candidate) => candidate.llm === identity.llm,
  );
  const credentialMatch = preflight.credentialMatches.find(
    (candidate) => candidate.llm === identity.llm,
  );
  const expectedEvidenceCredential =
    identity.llm === "ark-coding-plan"
      ? "CODEX_AGENT_ARK_CODING_KEY"
      : identity.llm === "deepseek-v4-flash"
        ? "CODEX_AGENT_DEEPSEEK_KEY"
      : identity.llm === "ark-agent-plan" ||
          identity.llm === "ark-agent-deepseek-v4-flash"
        ? "CODEX_AGENT_ARK_AGENT_KEY"
        : credentialMatch?.environmentVariableName;
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
    frozenIdentity.runtime === "kimi-acp"
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
  if (isCurrentProtocol(protocol)) {
    validateCurrentEvidenceContract(evidence, {
      llm: identity.llm,
      task: identity.task,
      runtime: frozenIdentity.runtime,
    });
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
  protocol: QualificationProtocol | null;
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
  expectedProtocol?: QualificationProtocol,
): Promise<LedgerState> {
  const directory = path.join(
    batchDirectory(repositoryRoot, batchId),
    "checkpoints",
  );
  const files = await listCheckpointFiles(repositoryRoot, directory);
  const loaded: LoadedCheckpoint[] = [];
  let protocol: QualificationProtocol | null = expectedProtocol ?? null;
  for (let index = 0; index < files.length; index += 1) {
    const expected = `${String(index).padStart(6, "0")}.json`;
    if (files[index] !== expected) throw new QualificationLedgerError();
    const absolute = path.join(directory, expected);
    const file = await readLedgerJson(repositoryRoot, absolute);
    const fileProtocol = protocolForEnvelope(file.value);
    if (protocol === null) {
      protocol = fileProtocol;
    } else {
      assertProtocol(fileProtocol, protocol);
    }
    const checkpoint = normalizeCheckpoint(
      file.value,
      index,
      batchId,
      protocol,
    );
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
      protocol,
      loaded: Object.freeze([]),
      started: null,
      completed: Object.freeze([]),
      running: null,
    };
  }
  if (protocol === null) throw new QualificationLedgerError();
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
        protocol,
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
            ...(isCurrentProtocol(protocol)
              ? { ownedProcessDrained: checkpoint.ownedProcessDrained! }
              : {}),
          })
      ) {
        throw new QualificationLedgerError();
      }
      completed.push(checkpoint);
      running = null;
    }
  }
  return Object.freeze({
    protocol,
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
    ...(Object.hasOwn(checkpoint, "ownedProcessDrained")
      ? { ownedProcessDrained: checkpoint.ownedProcessDrained! }
      : {}),
  });
}

function normalizeNotRun(
  values: readonly QualificationCaseIdentity[],
  protocol: QualificationProtocol,
): readonly QualificationCaseIdentity[] {
  const normalized = values.map((value) =>
    normalizeCaseIdentity(value, protocol),
  );
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
  protocol: QualificationProtocol,
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
    !SHA256_PATTERN.test(options.authorizationReferenceSha256) ||
    (state.protocol !== null && state.protocol !== protocol)
  ) {
    throw new QualificationLedgerError();
  }
  const notRun = normalizeNotRun(options.notRun, protocol);
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
    options.status === "passed" ? [] : protocol.schedule.slice(notRunStart);
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
    cases.length === protocol.schedule.length &&
    cases.every(
      (entry, index) =>
        entry.result === "passed" &&
        identitiesEqual(entry, protocol.schedule[index]!),
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
    ...protocolEnvelope(protocol),
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
  qualificationPlanId?: CurrentQualificationPlanId;
}): QualificationLedger {
  const protocol = protocolForPlanId(
    options.qualificationPlanId ?? ACTIVE_QUALIFICATION_PLAN_ID,
  );
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
          protocol,
        );
        if (
          state.loaded.length !== 0 ||
          !SHA256_PATTERN.test(input.authorizationReferenceSha256) ||
          !validTimestamp(input.recordedAt)
        ) {
          throw new QualificationLedgerError();
        }
        const preflight = protocol.freezePreflight(input.preflight);
        assertPreflightProtocol(preflight, protocol);
        await publishLedgerJson(
          options.repositoryRoot,
          checkpointPath(options.repositoryRoot, options.batchId, 0),
          {
            ...protocolEnvelope(protocol),
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
        const identity = normalizeCaseIdentity(
          {
            ordinal: input.ordinal,
            llm: input.llm,
            task: input.task,
          },
          protocol,
        );
        if (!validTimestamp(input.recordedAt)) {
          throw new QualificationLedgerError();
        }
        const state = await loadLedgerState(
          options.repositoryRoot,
          options.batchId,
          protocol,
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
            ...protocolEnvelope(protocol),
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
        const identity = normalizeCaseIdentity(
          {
            ordinal: input.ordinal,
            llm: input.llm,
            task: input.task,
          },
          protocol,
        );
        if (
          (input.result !== "passed" && input.result !== "failed") ||
          !validTimestamp(input.recordedAt)
        ) {
          throw new QualificationLedgerError();
        }
        const state = await loadLedgerState(
          options.repositoryRoot,
          options.batchId,
          protocol,
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
          protocol,
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
            ...protocolEnvelope(protocol),
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
          protocol,
        );
        if (state.started === null) throw new QualificationLedgerError();
        const manifest = buildManifest(state, protocol, {
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
            protocol,
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

function normalizeCaseEntry(
  value: unknown,
  protocol: QualificationProtocol,
): QualificationCaseManifestEntry {
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
    ...(isCurrentProtocol(protocol) ? ["ownedProcessDrained"] : []),
  ]);
  const identity = normalizeCaseIdentity(
    {
      ordinal: record.ordinal,
      llm: record.llm,
      task: record.task,
    },
    protocol,
  );
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
      protocol,
    ),
    ...normalizeExecutionTelemetry(
      record,
      protocol,
      record.result === "passed",
    ),
  });
}

function normalizeUncommittedEvidence(
  value: unknown,
  protocol: QualificationProtocol,
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
    ...(isCurrentProtocol(protocol) ? ["ownedProcessDrained"] : []),
  ] as const;
  if (base.validationStatus === "valid") {
    const record = plainRecord(value, commonKeys);
    if (typeof record.observedPassed !== "boolean") {
      throw new QualificationLedgerError();
    }
    return Object.freeze({
      validationStatus: "valid",
      ...normalizeCaseIdentity(
        {
          ordinal: record.ordinal,
          llm: record.llm,
          task: record.task,
        },
        protocol,
      ),
      evidence: normalizeEvidenceReference(record.evidence),
      observedPassed: record.observedPassed,
      failureReason: normalizeFailureReason(
        record.failureReason,
        record.observedPassed,
        protocol,
      ),
      ...normalizeExecutionTelemetry(
        record,
        protocol,
        record.observedPassed,
      ),
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
    record.executionTelemetrySource !== null ||
    (isCurrentProtocol(protocol) && record.ownedProcessDrained !== null)
  ) {
    throw new QualificationLedgerError();
  }
  return Object.freeze({
    validationStatus: "invalid",
    ...normalizeCaseIdentity(
      {
        ordinal: record.ordinal,
        llm: record.llm,
        task: record.task,
      },
      protocol,
    ),
    evidence: normalizeEvidenceReference(record.evidence),
    observedPassed: null,
    failureReason: "infrastructure_failure",
    adapterClientInvocationCount: null,
    adapterRetryCount: null,
    runtimeReportedAutoRetryCount: null,
    adapterReportedFallbackUsed: null,
    orchestratorFallbackUsed: null,
    executionTelemetrySource: null,
    ...(isCurrentProtocol(protocol) ? { ownedProcessDrained: null } : {}),
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
  const protocol = protocolForEnvelope(file.value);
  const record = plainRecord(
    file.value,
    keysForProtocol(protocol, MANIFEST_KEYS),
  );
  if (
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
  const state = await loadLedgerState(repositoryRoot, batchId, protocol);
  const preflight =
    record.preflight === null
      ? null
      : protocol.freezePreflight(record.preflight);
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
  const manifestCases = record.cases.map((entry) =>
    normalizeCaseEntry(entry, protocol),
  );
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
  const notRun = normalizeNotRun(record.notRun, protocol);
  const uncommittedEvidence =
    record.uncommittedEvidence === null
      ? null
      : normalizeUncommittedEvidence(record.uncommittedEvidence, protocol);
  const expectedUncommittedEvidence = await findUncommittedEvidence(
    repositoryRoot,
    batchId,
    state,
    protocol,
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
  const rebuilt = buildManifest(state, protocol, {
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
      qualificationPlanId:
        manifest.schemaVersion === 1
          ? LEGACY_QUALIFICATION_PLAN_ID
          : manifest.qualificationPlanId,
    });
  } catch {
    throw new QualificationLedgerError();
  }
}

async function findUncommittedEvidence(
  repositoryRoot: string,
  batchId: string,
  state: LedgerState,
  protocol: QualificationProtocol,
): Promise<QualificationUncommittedEvidence | null> {
  if (state.protocol !== null && state.protocol !== protocol) {
    throw new QualificationLedgerError();
  }
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
      protocol,
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
      ...(isCurrentProtocol(protocol) ? { ownedProcessDrained: null } : {}),
    });
  }
}

export async function recoverInterruptedQualificationBatch(options: {
  repositoryRoot: string;
  batchId: string;
  authorizationReferenceSha256: string;
  qualificationPlanId: QualificationPlanId;
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
    if (options.qualificationPlanId === undefined) {
      throw new QualificationLedgerError();
    }
    const defaultProtocol = protocolForPlanId(options.qualificationPlanId);
    const terminal = await inspectQualificationTerminal(options);
    if (terminal.state === "valid") {
      if (
        terminal.batchId !== options.batchId ||
        terminal.authorizationReferenceSha256 !==
          options.authorizationReferenceSha256 ||
        terminal.qualificationPlanId !== options.qualificationPlanId
      ) {
        throw new QualificationLedgerError();
      }
      return await readAndValidateManifest(
        options.repositoryRoot,
        options.batchId,
      );
    }
    const state = await loadLedgerState(options.repositoryRoot, options.batchId);
    const protocol = state.protocol ?? defaultProtocol;
    if (
      protocol.planId !== options.qualificationPlanId ||
      (state.started !== null &&
        state.started.authorizationReferenceSha256 !==
          options.authorizationReferenceSha256)
    ) {
      throw new QualificationLedgerError();
    }
    const uncommittedEvidence = await findUncommittedEvidence(
      options.repositoryRoot,
      options.batchId,
      state,
      protocol,
    );
    const inferredNotRun = protocol.schedule.slice(
      state.completed.length + (state.running === null ? 0 : 1),
    );
    const manifest = buildManifest(state, protocol, {
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
