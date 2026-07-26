import type {
  AdapterExecutionTelemetry,
  AdapterRunRequest,
  AdapterRunResult,
  ExternalAgentAdapter,
} from "../adapters/adapter.js";
import type { RuntimeKind, TaskKind } from "../domain/types.js";
import {
  captureWorkspace,
  compareWorkspace,
  type WorkspaceSnapshot,
} from "../evidence/workspace.js";
import type { LlmRegistry } from "../llms/registry.js";
import { KeyedLimiter } from "../runtime/limiter.js";
import type {
  ExternalDelegateInput,
  ExternalReviewInput,
} from "./schemas.js";
import {
  externalDelegateInputSchema,
  externalReviewInputSchema,
} from "./schemas.js";
import type {
  ExternalDelegateResult,
  ExternalReviewResult,
  ExternalTaskResultBase,
  ExternalTaskStatus,
} from "./results.js";

export interface ExternalAgentServiceDependencies {
  registry: LlmRegistry;
  adapters: ReadonlyMap<RuntimeKind, ExternalAgentAdapter>;
  parentEnvironment?: NodeJS.ProcessEnv;
  limiter?: KeyedLimiter;
}

export interface TaskExecutionContext {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onExecutionTelemetry?: (
    telemetry: AdapterExecutionTelemetry | null,
  ) => void;
}

function buildReviewPacket(
  input: ExternalReviewInput,
  snapshot: WorkspaceSnapshot,
): string {
  const sections = [
    `Review task: ${input.task}`,
    `Request:\n${input.prompt}`,
  ];
  if (input.context !== undefined) {
    sections.push(`Context:\n${input.context}`);
  }
  if (input.acceptanceCriteria !== undefined) {
    sections.push(
      `Acceptance criteria:\n${input.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  if (snapshot.kind === "git") {
    sections.push(`Git status (porcelain):\n${snapshot.gitStatus || "(clean)"}`);
    if (input.includeGitDiff === true) {
      sections.push(`Git diff:\n${snapshot.gitDiff || "(empty)"}`);
    }
  }
  return sections.join("\n\n");
}

function failedAdapterResult(error: unknown): AdapterRunResult {
  return {
    status: "failed",
    text: "",
    elapsedMs: 0,
    events: [],
    diagnostics: [error instanceof Error ? error.message : String(error)],
    executionTelemetry: null,
  };
}

function adapterStatus(status: AdapterRunResult["status"]): ExternalTaskStatus {
  return status;
}

function extractCommands(events: readonly unknown[]): string[] {
  const commands: string[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "tool_call" || record.kind !== "execute") continue;
    const rawInput =
      typeof record.rawInput === "object" && record.rawInput !== null
        ? (record.rawInput as Record<string, unknown>)
        : undefined;
    const command = rawInput?.command;
    if (typeof command === "string") {
      commands.push(command);
    } else if (typeof record.title === "string") {
      commands.push(record.title);
    }
  }
  return commands;
}

function reviewPolicyViolations(events: readonly unknown[]): string[] {
  const violations: string[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (
      record.type !== "tool_call" ||
      record.runtime !== "pi-rpc" ||
      (record.kind !== "execute" && record.kind !== "write")
    ) {
      continue;
    }
    violations.push(
      `review_policy_violation: Pi emitted disallowed ${String(record.title ?? record.kind)} tool event`,
    );
  }
  return violations;
}

function commonResult(
  llm: string,
  startedAt: number,
  adapter: AdapterRunResult,
  status: ExternalTaskStatus,
  filesChanged: string[],
): ExternalTaskResultBase {
  const result: ExternalTaskResultBase = {
    ok: status === "completed",
    status,
    llm,
    elapsedMs: Date.now() - startedAt,
    diagnostics: [...adapter.diagnostics],
    filesChanged,
  };
  if (adapter.actualModel !== undefined) result.actualModel = adapter.actualModel;
  if (adapter.sessionId !== undefined) result.sessionId = adapter.sessionId;
  return result;
}

export class ExternalAgentService {
  readonly #registry: LlmRegistry;
  readonly #adapters: ReadonlyMap<RuntimeKind, ExternalAgentAdapter>;
  readonly #parentEnvironment: NodeJS.ProcessEnv;
  readonly #limiter: KeyedLimiter;

  public constructor(dependencies: ExternalAgentServiceDependencies) {
    this.#registry = dependencies.registry;
    this.#adapters = dependencies.adapters;
    this.#parentEnvironment = dependencies.parentEnvironment ?? process.env;
    if (dependencies.limiter !== undefined) {
      this.#limiter = dependencies.limiter;
    } else {
      const limits = new Map<string, number>();
      for (const id of this.#registry.ids()) {
        const profile = this.#registry.resolve(id);
        const key = profile.concurrencyKey ?? profile.id;
        const existing = limits.get(key);
        if (existing !== undefined && existing !== profile.maxConcurrency) {
          throw new Error(`Conflicting concurrency limits for pool "${key}"`);
        }
        limits.set(key, profile.maxConcurrency);
      }
      this.#limiter = new KeyedLimiter((key) => limits.get(key) ?? 0);
    }
  }

  public async review(
    rawInput: unknown,
    context: TaskExecutionContext = {},
  ): Promise<ExternalReviewResult> {
    const input = externalReviewInputSchema.parse(rawInput);
    return this.#runReview(input, context);
  }

  public async delegate(
    rawInput: unknown,
    context: TaskExecutionContext = {},
  ): Promise<ExternalDelegateResult> {
    const input = externalDelegateInputSchema.parse(rawInput);
    return this.#runDelegate(input, context);
  }

  async #runReview(
    input: ExternalReviewInput,
    context: TaskExecutionContext,
  ): Promise<ExternalReviewResult> {
    const profile = this.#registry.resolve(input.llm, "review");
    return this.#limiter.run(
      profile.concurrencyKey ?? input.llm,
      context.signal,
      async () => {
      const startedAt = Date.now();
      const captureOptions: {
        includeGitDiff?: boolean;
        includeUntracked?: boolean;
      } = {};
      if (input.includeGitDiff !== undefined) {
        captureOptions.includeGitDiff = input.includeGitDiff;
      }
      if (input.includeUntracked !== undefined) {
        captureOptions.includeUntracked = input.includeUntracked;
      }
      const before = await captureWorkspace(input.cwd, captureOptions);
      const adapter = this.#adapterFor(profile.runtime);
      let adapterResult: AdapterRunResult;
      try {
        adapterResult = await adapter.run(
          this.#adapterRequest(
            profile,
            "review",
            input,
            buildReviewPacket(input, before),
            context,
          ),
        );
      } catch (error) {
        adapterResult = failedAdapterResult(error);
      }
      context.onExecutionTelemetry?.(adapterResult.executionTelemetry);
      const after = await captureWorkspace(input.cwd);
      const comparison = compareWorkspace(before, after);
      const policyViolations = reviewPolicyViolations(adapterResult.events);
      if (policyViolations.length > 0) {
        adapterResult = {
          ...adapterResult,
          diagnostics: [...adapterResult.diagnostics, ...policyViolations],
        };
      }
      const status: ExternalTaskStatus =
        comparison.filesChanged.length > 0
          ? "workspace_changed"
          : policyViolations.length > 0
            ? "failed"
          : adapterStatus(adapterResult.status);
      return {
        ...commonResult(
          input.llm,
          startedAt,
          adapterResult,
          status,
          comparison.filesChanged,
        ),
        review: adapterResult.text,
      };
      },
    );
  }

  async #runDelegate(
    input: ExternalDelegateInput,
    context: TaskExecutionContext,
  ): Promise<ExternalDelegateResult> {
    const profile = this.#registry.resolve(input.llm, "delegate");
    return this.#limiter.run(
      profile.concurrencyKey ?? input.llm,
      context.signal,
      async () => {
      const startedAt = Date.now();
      const before = await captureWorkspace(input.cwd);
      const adapter = this.#adapterFor(profile.runtime);
      let adapterResult: AdapterRunResult;
      try {
        adapterResult = await adapter.run(
          this.#adapterRequest(
            profile,
            "delegate",
            input,
            input.prompt,
            context,
          ),
        );
      } catch (error) {
        adapterResult = failedAdapterResult(error);
      }
      context.onExecutionTelemetry?.(adapterResult.executionTelemetry);
      const after = await captureWorkspace(input.cwd);
      const comparison = compareWorkspace(before, after);
      const status = adapterStatus(adapterResult.status);
      return {
        ...commonResult(
          input.llm,
          startedAt,
          adapterResult,
          status,
          comparison.filesChanged,
        ),
        summary: adapterResult.text,
        commandsRun: extractCommands(adapterResult.events),
        verification: [],
        risks: [],
      };
      },
    );
  }

  #adapterFor(runtime: RuntimeKind): ExternalAgentAdapter {
    const adapter = this.#adapters.get(runtime);
    if (adapter === undefined) {
      throw new Error(`No external agent adapter registered for ${runtime}`);
    }
    return adapter;
  }

  #adapterRequest(
    profile: ReturnType<LlmRegistry["resolve"]>,
    task: TaskKind,
    input: ExternalReviewInput | ExternalDelegateInput,
    prompt: string,
    context: TaskExecutionContext,
  ): AdapterRunRequest {
    const request: AdapterRunRequest = {
      profile,
      task,
      cwd: input.cwd,
      prompt,
      parentEnvironment: this.#parentEnvironment,
    };
    if (input.timeoutMs !== undefined) request.timeoutMs = input.timeoutMs;
    if ("sessionId" in input && input.sessionId !== undefined) {
      request.sessionId = input.sessionId;
    }
    if (context.signal !== undefined) request.signal = context.signal;
    if (context.onProgress !== undefined) request.onProgress = context.onProgress;
    return request;
  }
}
