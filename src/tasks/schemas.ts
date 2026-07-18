import { statSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const cwdSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => path.isAbsolute(value), "cwd must be an absolute path")
  .refine((value) => {
    try {
      return statSync(value).isDirectory();
    } catch {
      return false;
    }
  }, "cwd must be an existing directory");

const commonShape = {
  llm: z.string().trim().min(1),
  prompt: z.string().trim().min(1).max(200_000),
  cwd: cwdSchema,
  timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
} as const;

export const externalReviewInputSchema = z
  .object({
    ...commonShape,
    task: z.enum([
      "review_plan",
      "review_diff",
      "review_doc",
      "adversarial_review",
    ]),
    includeGitDiff: z.boolean().optional(),
    includeUntracked: z.boolean().optional(),
    context: z.string().max(100_000).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(10_000)).max(100).optional(),
  })
  .strict();

export const externalDelegateInputSchema = z
  .object({
    ...commonShape,
    sessionId: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export type ExternalReviewInput = z.infer<typeof externalReviewInputSchema>;
export type ExternalDelegateInput = z.infer<typeof externalDelegateInputSchema>;
