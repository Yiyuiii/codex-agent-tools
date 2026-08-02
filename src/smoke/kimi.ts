import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import type { AdapterExecutionTelemetry } from "../adapters/adapter.js";
import { KimiAdapter } from "../adapters/kimi/adapter.js";
import type { RuntimeKind } from "../domain/types.js";
import { createLlmRegistry, resolveLlm } from "../llms/registry.js";
import { ExternalAgentService, type TaskExecutionContext } from "../tasks/service.js";
import type {
  ExternalDelegateResult,
  ExternalReviewResult,
} from "../tasks/results.js";
import type {
  ExternalDelegateInput,
  ExternalReviewInput,
} from "../tasks/schemas.js";
import type { CommandObservation } from "../tasks/command-observations.js";
import {
  sanitizeCommandObservations,
  type SanitizedCommandObservation,
} from "./command-observation.js";
import {
  assertSmokeQualificationIdentity,
  inSmokeInfrastructureStage,
  normalizeSmokeQualificationContext,
  type CurrentSmokeEvidenceEnvelope,
  type SmokeQualificationContext,
} from "./evidence.js";
import {
  inspectResultFile,
  type ResultFileEvidence,
  type ResultFileReadStatus,
} from "./result-file-evidence.js";

export type KimiSmokeTask = "review" | "delegate";

export interface KimiSmokeOptions {
  llm: string;
  task: KimiSmokeTask;
  qualificationContext?: SmokeQualificationContext;
  tempRoot?: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface KimiSmokeChecks {
  actualModelMatches: boolean;
  ownedProcessDrained: boolean;
  workspaceUnchanged?: boolean;
  knownDefectFound?: boolean;
  resultFileValid?: boolean;
  resultFileObserved?: boolean;
  onlyExpectedFileChanged?: boolean;
  requiredCommandObserved?: boolean;
  executionTelemetryValid: boolean;
}

interface KimiSmokeEvidencePayload {
  timestamp: string;
  llm: string;
  actualModel: string | null;
  expectedModel: string;
  runtime: "kimi-acp";
  route: "direct";
  task: KimiSmokeTask;
  status: ExternalReviewResult["status"];
  passed: boolean;
  failureReason:
    | "adapter_auth_or_model_unavailable"
    | "acceptance_failed"
    | "infrastructure_failure"
    | null;
  elapsedMs: number;
  outputSha256: string;
  filesChanged: string[];
  commandCount?: number;
  diagnosticCount: number;
  adapterClientInvocationCount: number | null;
  adapterRetryCount: number | null;
  runtimeReportedAutoRetryCount: number | null;
  adapterReportedFallbackUsed: boolean | null;
  ownedProcessDrained: true | null;
  orchestratorFallbackUsed: boolean | null;
  executionTelemetrySource: AdapterExecutionTelemetry["source"] | null;
  checks: KimiSmokeChecks;
  resultFileReadStatus?: ResultFileReadStatus;
  resultFileByteLength?: number;
  resultFileRawSha256?: string;
  resultFileNormalizedSha256?: string;
  expectedResultNormalizedSha256?: string;
  resultFileNormalizedLineCount?: number;
  resultFileContainsExpectedLine?: boolean;
  commandObservations?: SanitizedCommandObservation[];
}

export type KimiSmokeEvidence =
  CurrentSmokeEvidenceEnvelope<KimiSmokeEvidencePayload>;

export interface KimiSmokeService {
  review(
    input: ExternalReviewInput,
    context?: TaskExecutionContext,
  ): Promise<ExternalReviewResult>;
  delegate(
    input: ExternalDelegateInput,
    context?: TaskExecutionContext,
  ): Promise<ExternalDelegateResult>;
}

export interface KimiSmokeDependencies {
  service?: KimiSmokeService;
  now?: () => Date;
}

export function parseKimiSmokeArguments(args: readonly string[]): {
  llm: string;
  task: KimiSmokeTask;
} {
  let llm: string | undefined;
  let task: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--llm") {
      llm = args[index + 1];
      index += 1;
    } else if (argument === "--task") {
      task = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown Kimi smoke argument: ${argument ?? ""}`);
    }
  }
  if (llm === undefined || llm.trim() === "") {
    throw new Error("Kimi smoke requires --llm <logical-id>");
  }
  const profile = resolveLlm(llm);
  if (profile.runtime !== "kimi-acp") {
    throw new Error(`Logical llm ${llm} is not a Kimi ACP profile`);
  }
  if (task !== "review" && task !== "delegate") {
    throw new Error("Kimi smoke requires --task review|delegate");
  }
  return { llm, task };
}

function smokeService(llm: string, task: KimiSmokeTask): KimiSmokeService {
  const base = resolveLlm(llm);
  if (base.runtime !== "kimi-acp") {
    throw new Error(`Real Kimi smoke cannot run runtime ${base.runtime}`);
  }
  const profile = {
    ...base,
    capabilities: {
      ...base.capabilities,
      [task]: true,
    },
    qualityGates: {
      ...base.qualityGates,
      [task]: { status: "passed" as const, evidence: "ephemeral smoke gate" },
    },
  };
  const registry = createLlmRegistry([profile]);
  const kimi = new KimiAdapter();
  return new ExternalAgentService({
    registry,
    adapters: new Map<RuntimeKind, KimiAdapter>([[kimi.runtime, kimi]]),
  });
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa("git", [...args], {
    cwd,
    reject: false,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed`);
  }
  return result.stdout;
}

async function initializeFixture(cwd: string, task: KimiSmokeTask): Promise<void> {
  await runGit(cwd, ["init", "--quiet"]);
  await runGit(cwd, ["config", "user.name", "codex-agent-tools smoke"]);
  await runGit(cwd, ["config", "user.email", "smoke@example.invalid"]);

  if (task === "review") {
    await writeFile(
      path.join(cwd, "average.js"),
      [
        "export function average(values) {",
        "  return values.reduce((sum, value) => sum + value, 0) / values.length;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(cwd, "average.test.js"),
      [
        'import assert from "node:assert/strict";',
        'import { average } from "./average.js";',
        "assert.equal(average([]), 0);",
        "",
      ].join("\n"),
      "utf8",
    );
  } else {
    await writeFile(
      path.join(cwd, "README.md"),
      "# Isolated Kimi delegate smoke fixture\n",
      "utf8",
    );
  }

  await runGit(cwd, ["add", "."]);
  await runGit(cwd, ["commit", "--quiet", "-m", "smoke fixture"]);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function reviewFoundKnownDefect(review: string): boolean {
  return /(?:empty|zero|length|nan|division|空数组|空输入|零|长度|除零)/iu.test(
    review,
  );
}

function telemetryIsValid(
  telemetry: AdapterExecutionTelemetry | null | undefined,
  reportCount: number,
): telemetry is AdapterExecutionTelemetry {
  return (
    reportCount === 1 &&
    telemetry !== null &&
    telemetry !== undefined &&
    telemetry.source === "kimi-acp-observable" &&
    telemetry.adapterClientInvocationCount === 1 &&
    telemetry.adapterRetryCount === 0 &&
    telemetry.runtimeReportedAutoRetryCount === 0 &&
    telemetry.adapterReportedFallbackUsed === false
  );
}

function resultFileArtifactFields(
  evidence: ResultFileEvidence,
): Pick<
  KimiSmokeEvidence,
  | "resultFileReadStatus"
  | "resultFileByteLength"
  | "resultFileRawSha256"
  | "resultFileNormalizedSha256"
  | "expectedResultNormalizedSha256"
  | "resultFileNormalizedLineCount"
  | "resultFileContainsExpectedLine"
> {
  return {
    resultFileReadStatus: evidence.readStatus,
    expectedResultNormalizedSha256: evidence.expectedNormalizedSha256,
    ...(evidence.byteLength === undefined
      ? {}
      : { resultFileByteLength: evidence.byteLength }),
    ...(evidence.rawSha256 === undefined
      ? {}
      : { resultFileRawSha256: evidence.rawSha256 }),
    ...(evidence.normalizedSha256 === undefined
      ? {}
      : { resultFileNormalizedSha256: evidence.normalizedSha256 }),
    ...(evidence.normalizedLineCount === undefined
      ? {}
      : { resultFileNormalizedLineCount: evidence.normalizedLineCount }),
    ...(evidence.containsExpectedLine === undefined
      ? {}
      : { resultFileContainsExpectedLine: evidence.containsExpectedLine }),
  };
}

function commonEvidence(
  options: KimiSmokeOptions,
  result: ExternalReviewResult | ExternalDelegateResult,
  expectedModel: string,
  now: Date,
  checks: KimiSmokeChecks,
  passed: boolean,
  telemetry: AdapterExecutionTelemetry | null | undefined,
  qualification: SmokeQualificationContext | null,
): KimiSmokeEvidence {
  const output = "review" in result ? result.review : result.summary;
  const payload: KimiSmokeEvidencePayload = {
    timestamp: now.toISOString(),
    llm: options.llm,
    actualModel: result.actualModel ?? null,
    expectedModel,
    runtime: "kimi-acp",
    route: "direct",
    task: options.task,
    status: result.status,
    passed,
    failureReason:
      !passed && result.status !== "completed"
        ? "adapter_auth_or_model_unavailable"
        : !passed
          ? "acceptance_failed"
          : null,
    elapsedMs: result.elapsedMs,
    outputSha256: sha256(output),
    filesChanged: [...result.filesChanged].sort(),
    ...(options.task === "delegate"
      ? {
          commandCount:
            "commandsRun" in result ? result.commandsRun.length : 0,
        }
      : {}),
    diagnosticCount: result.diagnostics.length,
    adapterClientInvocationCount:
      telemetry?.adapterClientInvocationCount ?? null,
    adapterRetryCount: telemetry?.adapterRetryCount ?? null,
    runtimeReportedAutoRetryCount:
      telemetry?.runtimeReportedAutoRetryCount ?? null,
    adapterReportedFallbackUsed:
      telemetry?.adapterReportedFallbackUsed ?? null,
    ownedProcessDrained:
      telemetry?.ownedProcessDrained === true ? true : null,
    orchestratorFallbackUsed:
      qualification?.orchestratorFallbackUsed ?? null,
    executionTelemetrySource: telemetry?.source ?? null,
    checks,
  };
  return { schemaVersion: 4, qualification, ...payload };
}

export async function runKimiSmoke(
  options: KimiSmokeOptions,
  dependencies: KimiSmokeDependencies = {},
): Promise<KimiSmokeEvidence> {
  const qualification = normalizeSmokeQualificationContext(
    options.qualificationContext,
  );
  assertSmokeQualificationIdentity(
    qualification,
    options.llm,
    options.task,
  );
  const profile = resolveLlm(options.llm);
  if (profile.runtime !== "kimi-acp" || profile.network !== "direct") {
    throw new Error(`Logical llm ${options.llm} is not a direct Kimi profile`);
  }
  const service = dependencies.service ?? smokeService(options.llm, options.task);
  const now = dependencies.now ?? (() => new Date());
  const root = options.tempRoot ?? os.tmpdir();
  const cwd = await inSmokeInfrastructureStage(
    "workspace_setup",
    () => mkdtemp(path.join(root, "codex-kimi-smoke-")),
  );

  try {
    await inSmokeInfrastructureStage(
      "fixture_setup",
      () => initializeFixture(cwd, options.task),
    );
    let executionTelemetry: AdapterExecutionTelemetry | null | undefined;
    let executionTelemetryReportCount = 0;
    let commandObservations: readonly CommandObservation[] | undefined;
    let commandObservationReportCount = 0;
    const context: TaskExecutionContext = {};
    if (options.onProgress !== undefined) context.onProgress = options.onProgress;
    context.onExecutionTelemetry = (telemetry) => {
      executionTelemetryReportCount += 1;
      executionTelemetry = telemetry;
    };
    if (options.task === "delegate") {
      context.commandObservationPolicy = "raw_only";
      context.onCommandObservations = (observations) => {
        commandObservationReportCount += 1;
        commandObservations = observations;
      };
    }
    if (options.task === "review") {
      const result = await inSmokeInfrastructureStage(
        "task_execution",
        () =>
          service.review(
            {
              llm: options.llm,
              task: "review_diff",
              prompt:
                "Read average.js and average.test.js. Identify the concrete correctness defect that makes the test fail. Cite the relevant expression. Do not modify files and do not execute commands.",
              cwd,
              includeGitDiff: true,
              ...(options.timeoutMs === undefined
                ? {}
                : { timeoutMs: options.timeoutMs }),
            },
            context,
          ),
      );
      const gitClean = await inSmokeInfrastructureStage(
        "acceptance_check",
        async () =>
          (await runGit(cwd, ["status", "--porcelain"])).trim() === "",
      );
      const checks: KimiSmokeChecks = {
        actualModelMatches: result.actualModel === profile.model,
        ownedProcessDrained: executionTelemetry?.ownedProcessDrained === true,
        workspaceUnchanged: result.filesChanged.length === 0 && gitClean,
        knownDefectFound: reviewFoundKnownDefect(result.review),
        executionTelemetryValid: telemetryIsValid(
          executionTelemetry,
          executionTelemetryReportCount,
        ),
      };
      const passed =
        result.status === "completed" &&
        checks.actualModelMatches &&
        checks.ownedProcessDrained &&
        checks.workspaceUnchanged === true &&
        checks.knownDefectFound === true &&
        checks.executionTelemetryValid === true;
      return commonEvidence(
        options,
        result,
        profile.model,
        now(),
        checks,
        passed,
        executionTelemetry,
        qualification,
      );
    }

    const { result, reportedCommandObservations } =
      await inSmokeInfrastructureStage(
        "task_execution",
        async () => {
          const delegateResult = await service.delegate(
            {
              llm: options.llm,
              prompt:
                [
                  "Use two separate tool calls for this task.",
                  "First, create result.txt in the working directory with exactly one line: KIMI_SMOKE_OK. Use a file-writing tool call.",
                  "Second, use a separate command-execution tool call. Execute the command line exactly as shown:\n\ngit status --short\n\nDo not place any command before or after it.",
                  "Do not use shell chaining or connectors (including &&, ||, or ;), pipes, redirects, or wrapper commands.",
                  "Do not modify any other file. Report the file creation and the command result.",
                ].join("\n\n"),
              cwd,
              ...(options.timeoutMs === undefined
                ? {}
                : { timeoutMs: options.timeoutMs }),
            },
            context,
          );
          if (
            commandObservationReportCount !== 1 ||
            commandObservations === undefined
          ) {
            throw new Error(
              "Internal Kimi command observation report contract violated",
            );
          }
          return {
            result: delegateResult,
            reportedCommandObservations: commandObservations,
          };
        },
      );
    const resultFile = await inspectResultFile({
      filePath: path.join(cwd, "result.txt"),
      expectedLine: "KIMI_SMOKE_OK",
      maximumBytes: 65_536,
    });
    const normalizedFiles = result.filesChanged.map((name) => name.replaceAll("\\", "/"));
    const checks: KimiSmokeChecks = {
      actualModelMatches: result.actualModel === profile.model,
      ownedProcessDrained: executionTelemetry?.ownedProcessDrained === true,
      resultFileValid: resultFile.valid,
      resultFileObserved: normalizedFiles.includes("result.txt"),
      onlyExpectedFileChanged:
        normalizedFiles.length === 1 && normalizedFiles[0] === "result.txt",
      requiredCommandObserved: result.commandsRun.includes(
        "git status --short",
      ),
      executionTelemetryValid: telemetryIsValid(
        executionTelemetry,
        executionTelemetryReportCount,
      ),
    };
    const passed =
      result.status === "completed" &&
      checks.actualModelMatches &&
      checks.ownedProcessDrained &&
      checks.resultFileValid === true &&
      checks.resultFileObserved === true &&
      checks.onlyExpectedFileChanged === true &&
      checks.requiredCommandObserved === true &&
      checks.executionTelemetryValid === true;
    return {
      ...commonEvidence(
        options,
        result,
        profile.model,
        now(),
        checks,
        passed,
        executionTelemetry,
        qualification,
      ),
      commandObservations: sanitizeCommandObservations(
        reportedCommandObservations,
        "git status --short",
      ),
      ...resultFileArtifactFields(resultFile),
    };
  } finally {
    await inSmokeInfrastructureStage(
      "workspace_cleanup",
      () => rm(cwd, { recursive: true, force: true }),
    );
  }
}
