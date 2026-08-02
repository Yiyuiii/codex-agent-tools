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
import {
  createHostAcceptanceRequestIdentity,
  emitHostAcceptanceEvent,
  type HostAcceptanceEventSink,
  type HostAcceptanceRequestIdentity,
} from "./host-acceptance-events.js";
import type { HostAcceptanceRequestResolver } from "./host-acceptance-client.js";
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
  hostAcceptanceObservation?:
    | HostAcceptanceEventSink
    | HostAcceptanceRequestResolver,
): InFlightTasks {
  server.registerTool(
    PUBLIC_EXTERNAL_TOOL_DEFINITIONS[0].name,
    PUBLIC_EXTERNAL_TOOL_DEFINITIONS[0].registration,
    (input, extra) => {
      let requestIdentity: HostAcceptanceRequestIdentity | undefined;
      let requestEventSink: HostAcceptanceEventSink | undefined;
      const execute = async (
        hostAcceptanceEventSink: HostAcceptanceEventSink | undefined,
      ) => {
        requestEventSink = hostAcceptanceEventSink;
        const lifecycle =
          hostAcceptanceEventSink === undefined
            ? undefined
            : createRequestLifecycle(
                hostAcceptanceEventSink,
                createHostAcceptanceRequestIdentity(extra.requestId),
                "review",
                extra.signal,
              );
        requestIdentity = lifecycle?.identity;
        const progress = createMcpProgressReporter(extra);
        let outputStatus: ExternalReviewResult["status"] | undefined;
        try {
          const output = externalReviewResultSchema.parse(
            await service.review(input, {
              signal: extra.signal,
              shutdownSignal: inFlight.shutdownSignal,
              onProgress: progress.report,
              ...(lifecycle === undefined
                ? {}
                : { onExecutionTelemetry: lifecycle.onExecutionTelemetry }),
            }),
          );
          outputStatus = output.status;
          return {
            content: textContent(output),
            structuredContent: output,
          };
        } finally {
          await progress.finish();
          lifecycle?.finish(outputStatus);
        }
      };
      const factory =
        hostAcceptanceObservation !== undefined &&
        typeof hostAcceptanceObservation !== "function"
          ? async () =>
              resolveHostAcceptanceEventSink(
                hostAcceptanceObservation,
                "review",
                input,
              ).then((sink) => {
                if (inFlight.shutdownSignal.aborted) {
                  throw new Error("MCP session is shutting down.");
                }
                return execute(sink);
              })
          : () =>
              execute(
                typeof hostAcceptanceObservation === "function"
                  ? hostAcceptanceObservation
                  : undefined,
              );
      return inFlight.run(factory, () => {
        if (requestIdentity !== undefined) {
          emitHostAcceptanceEvent(requestEventSink, {
            type: "inFlightRemoved",
            ...requestIdentity,
          });
        }
      });
    },
  );

  server.registerTool(
    PUBLIC_EXTERNAL_TOOL_DEFINITIONS[1].name,
    PUBLIC_EXTERNAL_TOOL_DEFINITIONS[1].registration,
    (input, extra) => {
      let requestIdentity: HostAcceptanceRequestIdentity | undefined;
      let requestEventSink: HostAcceptanceEventSink | undefined;
      const execute = async (
        hostAcceptanceEventSink: HostAcceptanceEventSink | undefined,
      ) => {
        requestEventSink = hostAcceptanceEventSink;
        const lifecycle =
          hostAcceptanceEventSink === undefined
            ? undefined
            : createRequestLifecycle(
                hostAcceptanceEventSink,
                createHostAcceptanceRequestIdentity(extra.requestId),
                "delegate",
                extra.signal,
              );
        requestIdentity = lifecycle?.identity;
        const progress = createMcpProgressReporter(extra);
        let outputStatus: ExternalDelegateResult["status"] | undefined;
        try {
          const output = externalDelegateResultSchema.parse(
            await service.delegate(input, {
              signal: extra.signal,
              shutdownSignal: inFlight.shutdownSignal,
              onProgress: progress.report,
              ...(lifecycle === undefined
                ? {}
                : { onExecutionTelemetry: lifecycle.onExecutionTelemetry }),
            }),
          );
          outputStatus = output.status;
          return {
            content: textContent(output),
            structuredContent: output,
          };
        } finally {
          await progress.finish();
          lifecycle?.finish(outputStatus);
        }
      };
      const factory =
        hostAcceptanceObservation !== undefined &&
        typeof hostAcceptanceObservation !== "function"
          ? async () =>
              resolveHostAcceptanceEventSink(
                hostAcceptanceObservation,
                "delegate",
                input,
              ).then((sink) => {
                if (inFlight.shutdownSignal.aborted) {
                  throw new Error("MCP session is shutting down.");
                }
                return execute(sink);
              })
          : () =>
              execute(
                typeof hostAcceptanceObservation === "function"
                  ? hostAcceptanceObservation
                  : undefined,
              );
      return inFlight.run(factory, () => {
        if (requestIdentity !== undefined) {
          emitHostAcceptanceEvent(requestEventSink, {
            type: "inFlightRemoved",
            ...requestIdentity,
          });
        }
      });
    },
  );

  return inFlight;
}

async function resolveHostAcceptanceEventSink(
  observation: HostAcceptanceEventSink | HostAcceptanceRequestResolver | undefined,
  task: "review" | "delegate",
  input: unknown,
): Promise<HostAcceptanceEventSink | undefined> {
  if (observation === undefined || typeof observation === "function") {
    return observation;
  }
  try {
    return await observation.openRequest(task, input);
  } catch {
    return undefined;
  }
}

function createRequestLifecycle(
  sink: HostAcceptanceEventSink,
  identity: HostAcceptanceRequestIdentity,
  task: "review" | "delegate",
  signal: AbortSignal,
): {
  readonly identity: HostAcceptanceRequestIdentity;
  readonly onExecutionTelemetry: NonNullable<
    TaskExecutionContext["onExecutionTelemetry"]
  >;
  finish(status: ExternalReviewResult["status"] | undefined): void;
} {
  let active = true;
  let sdkAbortEmitted = false;
  let ownedExitEmitted = false;

  const emit = (
    event: Parameters<HostAcceptanceEventSink>[0],
  ): void => {
    emitHostAcceptanceEvent(sink, event);
  };
  const onAbort = (): void => {
    if (!active || sdkAbortEmitted) return;
    sdkAbortEmitted = true;
    emit({ type: "sdkAbort", ...identity });
  };

  emit({ type: "requestStarted", task, ...identity });
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  return {
    identity,
    onExecutionTelemetry(telemetry) {
      if (
        active &&
        !ownedExitEmitted &&
        telemetry?.ownedProcessCompletion === "cancelled" &&
        telemetry.ownedProcessDrained === true
      ) {
        ownedExitEmitted = true;
        emit({
          type: "ownedExit",
          completion: "cancelled",
          ownershipDrained: true,
          ...identity,
        });
      }
    },
    finish(status) {
      if (!active) return;
      active = false;
      signal.removeEventListener("abort", onAbort);
      if (status === "cancelled") {
        emit({ type: "handlerCancelled", ...identity });
      }
    },
  };
}
