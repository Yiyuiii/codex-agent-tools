import type { AgentProcessCounts } from "../runtime/agent-processes.js";

export interface QualificationLockOwner {
  schemaVersion: 1;
  repositoryRealpathSha256: string;
  processId: number;
  processStartTime: string;
  nonce: string;
  batchId: string;
  authorizationReferenceSha256: string;
  acquiredAt: string;
}

export interface QualificationLockHandle {
  lockDirectory: string;
  owner: QualificationLockOwner;
}

export interface QualificationRecoveryReference {
  batchId: string;
  authorizationReferenceSha256: string;
}

export type QualificationTerminalInspection =
  | Readonly<{ state: "missing" }>
  | Readonly<{
      state: "valid";
      batchId: string;
      authorizationReferenceSha256: string;
    }>;

export type TargetAgentProcessCounts = AgentProcessCounts;

export interface BuildArtifactIdentity {
  readonly path: string;
  readonly sha256: string;
}

export interface FrozenLogicalLlmIdentity {
  readonly llm: string;
  readonly runtime: "kimi-acp" | "pi-rpc";
  readonly model: string;
  readonly provider: string | null;
  readonly route: "direct" | "proxy-10808";
}

export interface FrozenCredentialMatch {
  readonly llm: string;
  readonly environmentVariableName: string | null;
}

interface FrozenPreflightRecordCommon {
  readonly repositoryCommit: string;
  readonly repositoryBranch: string;
  readonly repositoryDirty: false;
  readonly packageVersion: string;
  readonly packageLockSha256: string;
  readonly buildArtifacts: readonly BuildArtifactIdentity[];
  readonly buildIdentitySha256: string;
  readonly runtimeVersions: Readonly<{
    readonly node: string;
    readonly codex: string;
    readonly kimi: string;
    readonly pi: string;
  }>;
  readonly piConfigSha256: string;
  readonly logicalLlms: readonly FrozenLogicalLlmIdentity[];
  readonly credentialMatches: readonly FrozenCredentialMatch[];
  readonly targetProcesses: Readonly<{
    readonly kimi: Readonly<{ readonly count: 0 }>;
    readonly piRpc: Readonly<{ readonly count: 0 }>;
    readonly realSmoke: Readonly<{ readonly count: 0 }>;
  }>;
}

export interface LegacyFrozenPreflightRecord
  extends FrozenPreflightRecordCommon {
  readonly schemaVersion: 1;
  readonly proxy10808: Readonly<{
    readonly host: "127.0.0.1";
    readonly port: 10808;
    readonly listening: true;
  }>;
}

export interface CurrentFrozenPreflightRecord
  extends FrozenPreflightRecordCommon {
  readonly schemaVersion: 2;
  readonly qualificationPlanId: "four-llm-v1";
}

export type FrozenPreflightRecord =
  | LegacyFrozenPreflightRecord
  | CurrentFrozenPreflightRecord;

export type QualificationTask = "review" | "delegate";
export type QualificationCaseResult = "passed" | "failed";
export type QualificationManifestStatus = "passed" | "blocked" | "interrupted";

export interface LegacyQualificationProtocolIdentity {
  readonly schemaVersion: 1;
}

export interface CurrentQualificationProtocolIdentity {
  readonly schemaVersion: 2;
  readonly qualificationPlanId: "four-llm-v1";
}

export type QualificationProtocolIdentity =
  | LegacyQualificationProtocolIdentity
  | CurrentQualificationProtocolIdentity;

export interface QualificationEvidenceReference {
  path: string;
  sha256: string;
}

export interface QualificationCaseIdentity {
  ordinal: number;
  llm: string;
  task: QualificationTask;
}

export interface QualificationCaseManifestEntry
  extends QualificationCaseIdentity, QualificationExecutionTelemetry {
  result: QualificationCaseResult;
  evidence: QualificationEvidenceReference;
  failureReason: QualificationFailureReason;
}

export interface QualificationExecutionTelemetry {
  adapterClientInvocationCount: number | null;
  adapterRetryCount: number | null;
  runtimeReportedAutoRetryCount: number | null;
  adapterReportedFallbackUsed: boolean | null;
  orchestratorFallbackUsed: false;
  executionTelemetrySource: "kimi-acp-observable" | "pi-rpc-observable" | null;
}

export type CurrentQualificationFailureReason =
  | "missing_credential"
  | "account_quota_exceeded"
  | "adapter_failure"
  | "adapter_auth_or_model_unavailable"
  | "acceptance_failed"
  | "process_residual"
  | "infrastructure_failure"
  | null;

export type LegacyQualificationFailureReason =
  | CurrentQualificationFailureReason
  | "google_free_tier_quota";

export type QualificationFailureReason =
  LegacyQualificationFailureReason;

export interface QualificationValidUncommittedEvidence
  extends QualificationCaseIdentity, QualificationExecutionTelemetry {
  validationStatus: "valid";
  evidence: QualificationEvidenceReference;
  observedPassed: boolean;
  failureReason: QualificationFailureReason;
}

export interface QualificationInvalidUncommittedEvidence extends QualificationCaseIdentity {
  validationStatus: "invalid";
  evidence: QualificationEvidenceReference;
  observedPassed: null;
  failureReason: "infrastructure_failure";
  adapterClientInvocationCount: null;
  adapterRetryCount: null;
  runtimeReportedAutoRetryCount: null;
  adapterReportedFallbackUsed: null;
  orchestratorFallbackUsed: null;
  executionTelemetrySource: null;
}

export type QualificationUncommittedEvidence =
  | QualificationValidUncommittedEvidence
  | QualificationInvalidUncommittedEvidence;

export interface QualificationCheckpointReference {
  sequence: number;
  path: string;
  sha256: string;
}

export type QualificationStopReason =
  "case_failed" | "infrastructure_failure" | "process_interrupted";

interface QualificationTerminalManifestCommon {
  batchId: string;
  status: QualificationManifestStatus;
  authorizationReferenceSha256: string;
  repositoryCommit: string | null;
  buildIdentitySha256: string | null;
  preflightSha256: string | null;
  preflight: FrozenPreflightRecord | null;
  cases: readonly QualificationCaseManifestEntry[];
  uncommittedEvidence: QualificationUncommittedEvidence | null;
  checkpoints: readonly QualificationCheckpointReference[];
  stopReason: QualificationStopReason | null;
  notRun: readonly QualificationCaseIdentity[];
  promotionEligible: boolean;
  completedAt: string;
}

export type LegacyQualificationTerminalManifest =
  QualificationTerminalManifestCommon &
    Readonly<{
      schemaVersion: 1;
    }>;

export type CurrentQualificationTerminalManifest =
  QualificationTerminalManifestCommon &
    Readonly<{
      schemaVersion: 2;
      qualificationPlanId: "four-llm-v1";
    }>;

export type QualificationTerminalManifest =
  | LegacyQualificationTerminalManifest
  | CurrentQualificationTerminalManifest;
