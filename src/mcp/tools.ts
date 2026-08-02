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
import { InFlightTasks } from "./in-flight.js";
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

const externalReviewToolDefinition = Object.freeze({
  name: "external_review",
  registration: Object.freeze({
    title: "External LLM Review",
    description:
      "Review a plan, diff, or document with one explicitly selected external LLM. The logical llm fixes its backend, model, credentials, and network route.",
    inputSchema: externalReviewInputSchema.shape,
    outputSchema: externalReviewResultSchema.shape,
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    }),
  }),
});

const externalDelegateToolDefinition = Object.freeze({
  name: "external_delegate",
  registration: Object.freeze({
    title: "External LLM Delegate",
    description:
      "Run one complete writable task with an explicitly selected external LLM in the caller-provided working directory.",
    inputSchema: externalDelegateInputSchema.shape,
    outputSchema: externalDelegateResultSchema.shape,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    }),
  }),
});

export const PUBLIC_EXTERNAL_TOOL_DEFINITIONS = Object.freeze([
  externalReviewToolDefinition,
  externalDelegateToolDefinition,
] as const);

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Public MCP tool definitions are invalid");
  }
  return value as Record<string, unknown>;
}

export function assertPublicExternalToolDefinitions(
  definitions: readonly unknown[] = PUBLIC_EXTERNAL_TOOL_DEFINITIONS,
): void {
  try {
    const records = definitions.map(recordOf);
    const names = records.map(({ name }) => name).sort();
    if (
      JSON.stringify(names) !==
      JSON.stringify(["external_delegate", "external_review"])
    ) {
      throw new Error("name drift");
    }

    for (const definition of records) {
      const name = definition.name;
      const registration = recordOf(definition.registration);
      const inputSchema = recordOf(registration.inputSchema);
      const llmSchema = recordOf(inputSchema.llm);
      if (typeof llmSchema.safeParse !== "function") {
        throw new Error("llm schema drift");
      }
      const parse = llmSchema.safeParse as (value: unknown) => {
        readonly success: boolean;
      };
      if (parse(undefined).success || !parse("doctor-static-check").success) {
        throw new Error("llm must be required");
      }

      const annotations = recordOf(registration.annotations);
      const expected =
        name === "external_review"
          ? {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: true,
            }
          : {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
              openWorldHint: true,
            };
      if (
        Object.keys(expected).some(
          (key) => annotations[key] !== expected[key as keyof typeof expected],
        )
      ) {
        throw new Error("annotation drift");
      }
    }
  } catch {
    throw new Error("Public MCP tool definitions are invalid");
  }
}

export function registerExternalTools(
  server: McpServer,
  service: ExternalTaskService,
  inFlight: InFlightTasks = new InFlightTasks(),
): InFlightTasks {
  server.registerTool(
    PUBLIC_EXTERNAL_TOOL_DEFINITIONS[0].name,
    PUBLIC_EXTERNAL_TOOL_DEFINITIONS[0].registration,
    (input, extra) => {
      return inFlight.run(async () => {
        const progress = createMcpProgressReporter(extra);
        try {
          const output = externalReviewResultSchema.parse(
            await service.review(input, {
              signal: extra.signal,
              shutdownSignal: inFlight.shutdownSignal,
              onProgress: progress.report,
            }),
          );
          return {
            content: textContent(output),
            structuredContent: output,
          };
        } finally {
          await progress.finish();
        }
      });
    },
  );

  server.registerTool(
    PUBLIC_EXTERNAL_TOOL_DEFINITIONS[1].name,
    PUBLIC_EXTERNAL_TOOL_DEFINITIONS[1].registration,
    (input, extra) => {
      return inFlight.run(async () => {
        const progress = createMcpProgressReporter(extra);
        try {
          const output = externalDelegateResultSchema.parse(
            await service.delegate(input, {
              signal: extra.signal,
              shutdownSignal: inFlight.shutdownSignal,
              onProgress: progress.report,
            }),
          );
          return {
            content: textContent(output),
            structuredContent: output,
          };
        } finally {
          await progress.finish();
        }
      });
    },
  );

  return inFlight;
}
