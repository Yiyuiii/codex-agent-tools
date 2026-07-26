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
  path: string;
  sha256: string;
}

export interface FrozenLogicalLlmIdentity {
  llm: string;
  runtime: "kimi-acp" | "pi-rpc";
  model: string;
  provider: string | null;
  route: "direct" | "proxy-10808";
}

export interface FrozenCredentialMatch {
  llm: string;
  environmentVariableName: string | null;
}

export interface FrozenPreflightRecord {
  schemaVersion: 1;
  repositoryCommit: string;
  repositoryBranch: string;
  repositoryDirty: false;
  packageVersion: string;
  packageLockSha256: string;
  buildArtifacts: readonly BuildArtifactIdentity[];
  buildIdentitySha256: string;
  runtimeVersions: Readonly<{
    node: string;
    codex: string;
    kimi: string;
    pi: string;
  }>;
  piConfigSha256: string;
  logicalLlms: readonly FrozenLogicalLlmIdentity[];
  credentialMatches: readonly FrozenCredentialMatch[];
  proxy10808: Readonly<{
    host: "127.0.0.1";
    port: 10808;
    listening: true;
  }>;
  targetProcesses: TargetAgentProcessCounts;
}

export type QualificationTask = "review" | "delegate";
export type QualificationCaseResult = "passed" | "failed";
export type QualificationManifestStatus = "passed" | "blocked" | "interrupted";

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

export type QualificationFailureReason =
  | "missing_credential"
  | "google_free_tier_quota"
  | "account_quota_exceeded"
  | "adapter_failure"
  | "adapter_auth_or_model_unavailable"
  | "acceptance_failed"
  | "process_residual"
  | "infrastructure_failure"
  | null;

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

export interface QualificationTerminalManifest {
  schemaVersion: 1;
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
