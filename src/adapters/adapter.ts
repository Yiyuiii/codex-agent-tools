import type { LlmProfile, TaskKind } from "../domain/types.js";

export interface AdapterRunRequest {
  profile: LlmProfile;
  task: TaskKind;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  sessionId?: string;
  signal?: AbortSignal;
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
}

export interface ExternalAgentAdapter {
  readonly runtime: LlmProfile["runtime"];
  run(request: AdapterRunRequest): Promise<AdapterRunResult>;
}
