export type TaskKind = "review" | "delegate";

export type RuntimeKind = "kimi-acp" | "pi-rpc";

export type NetworkPolicy = "direct";

export type QualityGate =
  | {
      readonly status: "pending";
    }
  | {
      readonly status: "passed";
      readonly evidence: string;
    };

export interface LlmProfile {
  readonly id: string;
  readonly displayName: string;
  readonly runtime: RuntimeKind;
  readonly provider?: string;
  readonly model: string;
  readonly network: NetworkPolicy;
  readonly capabilities: Readonly<Record<TaskKind, boolean>>;
  readonly qualityGates: Readonly<Record<TaskKind, QualityGate>>;
  readonly credentialEnv: readonly string[];
  readonly credentialTargetEnv?: string;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly concurrencyKey?: string;
}
