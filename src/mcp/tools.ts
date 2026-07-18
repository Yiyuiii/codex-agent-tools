import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  externalDelegateResultSchema,
  externalReviewResultSchema,
  type ExternalDelegateResult,
  type ExternalReviewResult,
} from "../tasks/results.js";
import {
  externalDelegateInputSchema,
  externalReviewInputSchema,
} from "../tasks/schemas.js";
import type { TaskExecutionContext } from "../tasks/service.js";
import { createMcpProgressReporter } from "./progress.js";

export interface ExternalTaskService {
  review(
    input: unknown,
    context?: TaskExecutionContext,
  ): Promise<ExternalReviewResult>;
  delegate(
    input: unknown,
    context?: TaskExecutionContext,
  ): Promise<ExternalDelegateResult>;
}

function textContent(value: unknown): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

export function registerExternalTools(
  server: McpServer,
  service: ExternalTaskService,
): void {
  server.registerTool(
    "external_review",
    {
      title: "External LLM Review",
      description:
        "Review a plan, diff, or document with one explicitly selected external LLM. The logical llm fixes its backend, model, credentials, and network route.",
      inputSchema: externalReviewInputSchema.shape,
      outputSchema: externalReviewResultSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const progress = createMcpProgressReporter(extra);
      try {
        const output = externalReviewResultSchema.parse(
          await service.review(input, {
            signal: extra.signal,
            onProgress: progress.report,
          }),
        );
        await progress.finish();
        return {
          content: textContent(output),
          structuredContent: output,
        };
      } finally {
        await progress.finish();
      }
    },
  );

  server.registerTool(
    "external_delegate",
    {
      title: "External LLM Delegate",
      description:
        "Run one complete writable task with an explicitly selected external LLM in the caller-provided working directory.",
      inputSchema: externalDelegateInputSchema.shape,
      outputSchema: externalDelegateResultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const progress = createMcpProgressReporter(extra);
      try {
        const output = externalDelegateResultSchema.parse(
          await service.delegate(input, {
            signal: extra.signal,
            onProgress: progress.report,
          }),
        );
        await progress.finish();
        return {
          content: textContent(output),
          structuredContent: output,
        };
      } finally {
        await progress.finish();
      }
    },
  );
}
