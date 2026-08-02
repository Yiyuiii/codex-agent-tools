import type { LlmProfile, TaskKind } from "../domain/types.js";

export interface AdapterExecutionTelemetry {
  /**
   * Counts prompt submissions visible at the ACP/RPC client boundary.
   * These fields do not claim visibility into provider-side or SDK-internal
   * HTTP retries and fallback.
   */
  adapterClientInvocationCount: number;
  adapterRetryCount: number;
  runtimeReportedAutoRetryCount: number;
  adapterReportedFallbackUsed: boolean;
  source: "kimi-acp-observable" | "pi-rpc-observable";
}

export interface AdapterRunRequest {
  profile: LlmProfile;
  task: TaskKind;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  sessionId?: string;
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
  onProgress?: (message: string) => void;
  parentEnvironment: NodeJS.ProcessEnv;
}

export interface AdapterRunResult {
  status: "completed" | "failed" | "cancelled" | "timed_out";
  text: string;
  actualModel?: string;
  sessionId?: string;
  stopReason?: string;
  elapsedMs: number;
  events: readonly unknown[];
  diagnostics: readonly string[];
  executionTelemetry: AdapterExecutionTelemetry | null;
}

export interface ExternalAgentAdapter {
  readonly runtime: LlmProfile["runtime"];
  run(request: AdapterRunRequest): Promise<AdapterRunResult>;
}
