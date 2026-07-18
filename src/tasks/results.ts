export type ExternalTaskStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "workspace_changed";

export interface ExternalTaskResultBase {
  ok: boolean;
  status: ExternalTaskStatus;
  llm: string;
  actualModel?: string;
  elapsedMs: number;
  sessionId?: string;
  diagnostics: string[];
  filesChanged: string[];
}

export interface ExternalReviewResult extends ExternalTaskResultBase {
  review: string;
}

export interface ExternalDelegateResult extends ExternalTaskResultBase {
  summary: string;
  commandsRun: string[];
  verification: string[];
  risks: string[];
}
