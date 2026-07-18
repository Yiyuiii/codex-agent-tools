import { z } from "zod";

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

export const externalTaskStatusSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "workspace_changed",
]);

const externalTaskResultBaseShape = {
  ok: z.boolean(),
  status: externalTaskStatusSchema,
  llm: z.string(),
  actualModel: z.string().optional(),
  elapsedMs: z.number().nonnegative(),
  sessionId: z.string().optional(),
  diagnostics: z.array(z.string()),
  filesChanged: z.array(z.string()),
} as const;

export const externalReviewResultSchema = z.object({
  ...externalTaskResultBaseShape,
  review: z.string(),
});

export const externalDelegateResultSchema = z.object({
  ...externalTaskResultBaseShape,
  summary: z.string(),
  commandsRun: z.array(z.string()),
  verification: z.array(z.string()),
  risks: z.array(z.string()),
});
