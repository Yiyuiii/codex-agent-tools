export type TaskKind = "review" | "delegate";

export type RuntimeKind = "kimi-acp" | "pi-rpc";

export type NetworkPolicy = "direct" | "proxy-10808" | "proxy-11808";

export interface QualityGate {
  status: "pending" | "passed";
  evidence?: string;
}

export interface LlmProfile {
  id: string;
  displayName: string;
  runtime: RuntimeKind;
  provider?: string;
  model: string;
  network: NetworkPolicy;
  capabilities: Readonly<Record<TaskKind, boolean>>;
  qualityGates: Readonly<Record<TaskKind, QualityGate>>;
  credentialEnv: readonly string[];
  credentialTargetEnv?: string;
  timeoutMs: number;
  maxConcurrency: number;
  concurrencyKey?: string;
}
