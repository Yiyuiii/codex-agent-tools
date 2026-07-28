import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import type { AdapterExecutionTelemetry } from "../adapters/adapter.js";
import {
  PiAdapter,
  type PiAdapterDependencies,
} from "../adapters/pi/adapter.js";
import { runPiRpc } from "../adapters/pi/client.js";
import {
  buildIsolatedPiConfig,
  type BuildIsolatedPiConfigOptions,
  type IsolatedPiConfig,
} from "../adapters/pi/config.js";
import { locatePi } from "../adapters/pi/locator.js";
import type {
  LlmProfile,
  NetworkPolicy,
  RuntimeKind,
} from "../domain/types.js";
import { createLlmRegistry, resolveLlm } from "../llms/registry.js";
import type {
  ExternalDelegateResult,
  ExternalReviewResult,
} from "../tasks/results.js";
import type {
  ExternalDelegateInput,
  ExternalReviewInput,
} from "../tasks/schemas.js";
import type { PiCommandLifecycleObservation } from "../tasks/pi-command-lifecycle.js";
import {
  ExternalAgentService,
  type TaskExecutionContext,
} from "../tasks/service.js";
import { VERSION } from "../version.js";
import {
  assertSmokeQualificationIdentity,
  inSmokeInfrastructureStage,
  normalizeSmokeQualificationContext,
  type SmokeEvidenceEnvelope,
  type SmokeQualificationContext,
} from "./evidence.js";
import {
  sanitizePiWriteCommandObservations,
  type SanitizedPiWriteCommandObservation,
} from "./pi-write-command-observation.js";
import {
  inspectResultFile,
  type ResultFileEvidence,
  type ResultFileReadStatus,
} from "./result-file-evidence.js";

export type PiSmokeTask = "review" | "delegate";

export interface PiSmokeOptions {
  llm: string;
  task: PiSmokeTask;
  qualificationContext?: SmokeQualificationContext;
  tempRoot?: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface PiSmokeRuntimeEvidence {
  configSha256: string;
  childEnvironment: NodeJS.ProcessEnv;
}

export interface PiSmokeChecks {
  actualModelMatches: boolean;
  environmentIsolated: boolean;
  noNewPiRpcProcesses: boolean;
  workspaceUnchanged?: boolean;
  knownDefectFound?: boolean;
  resultFileValid?: boolean;
  resultFileObserved?: boolean;
  onlyExpectedFileChanged?: boolean;
  requiredCommandObserved?: boolean;
  executionTelemetryValid: boolean;
}

interface PiSmokeEvidencePayload {
  timestamp: string;
  piVersion: string;
  llm: string;
  actualModel: string | null;
  expectedModel: string;
  runtime: "pi-rpc";
  provider: string;
  endpointHost: string;
  route: NetworkPolicy;
  credentialEnv: string | null;
  configSha256: string;
  task: PiSmokeTask;
  status: ExternalReviewResult["status"];
  passed: boolean;
  failureReason:
    | "missing_credential"
    | "account_quota_exceeded"
    | "adapter_failure"
    | "acceptance_failed"
    | null;
  elapsedMs: number;
  outputSha256: string;
  filesChanged: string[];
  commandCount: number;
  diagnosticCount: number;
  adapterClientInvocationCount: number | null;
  adapterRetryCount: number | null;
  runtimeReportedAutoRetryCount: number | null;
  adapterReportedFallbackUsed: boolean | null;
  orchestratorFallbackUsed: boolean | null;
  executionTelemetrySource: AdapterExecutionTelemetry["source"] | null;
  checks: PiSmokeChecks;
  resultFileReadStatus?: ResultFileReadStatus;
  resultFileByteLength?: number;
  resultFileRawSha256?: string;
  resultFileNormalizedSha256?: string;
  expectedResultNormalizedSha256?: string;
  resultFileNormalizedLineCount?: number;
  resultFileContainsExpectedLine?: boolean;
  writeCommandObservations?: SanitizedPiWriteCommandObservation[];
}

export type PiSmokeEvidence = SmokeEvidenceEnvelope<PiSmokeEvidencePayload>;

export interface PiSmokeService {
  review(
    input: ExternalReviewInput,
    context?: TaskExecutionContext,
  ): Promise<ExternalReviewResult>;
  delegate(
    input: ExternalDelegateInput,
    context?: TaskExecutionContext,
  ): Promise<ExternalDelegateResult>;
}

export interface PiSmokeDependencies {
  service?: PiSmokeService;
  runtimeEvidence?: PiSmokeRuntimeEvidence;
  readPiVersion?: () => Promise<string>;
  listPiRpcProcessIds?: () => Promise<number[]>;
  now?: () => Date;
}

export interface PiSmokeRuntimeFactoryDependencies {
  buildConfig?: (
    options: BuildIsolatedPiConfigOptions,
  ) => Promise<IsolatedPiConfig>;
  createAdapter?: (dependencies: PiAdapterDependencies) => PiAdapter;
}

export async function createPiSmokeRuntime(
  llm: string,
  task: PiSmokeTask,
  qualification: SmokeQualificationContext | null,
  dependencies: PiSmokeRuntimeFactoryDependencies = {},
): Promise<{ service: PiSmokeService; evidence: PiSmokeRuntimeEvidence }> {
  const normalizedQualification =
    normalizeSmokeQualificationContext(qualification);
  assertSmokeQualificationIdentity(normalizedQualification, llm, task);
  const base = resolveLlm(llm);
  const profile = {
    ...base,
    capabilities: { ...base.capabilities, [task]: true },
    qualityGates: {
      ...base.qualityGates,
      [task]: { status: "passed" as const, evidence: "ephemeral smoke gate" },
    },
  };
  const buildConfig = dependencies.buildConfig ?? buildIsolatedPiConfig;
  const config = await buildConfig({
    version: VERSION,
    providers: ["ark"],
    ...(normalizedQualification === null ? {} : { qualification: true }),
  });
  const evidence: PiSmokeRuntimeEvidence = {
    configSha256: config.contentSha256,
    childEnvironment: {},
  };
  const createAdapter =
    dependencies.createAdapter ??
    ((adapterDependencies: PiAdapterDependencies) =>
      new PiAdapter(adapterDependencies));
  const pi = createAdapter({
    ...(normalizedQualification === null
      ? {}
      : { retryMode: "qualification-single-attempt" as const }),
    buildConfig: async () => config,
    runClient: async (request) => {
      evidence.childEnvironment = { ...request.environment };
      return runPiRpc(request);
    },
  });
  return {
    service: new ExternalAgentService({
      registry: createLlmRegistry([profile]),
      adapters: new Map<RuntimeKind, PiAdapter>([[pi.runtime, pi]]),
    }),
    evidence,
  };
}

async function defaultReadPiVersion(): Promise<string> {
  const executable = await locatePi();
  const result = await execa(executable, ["--version"], {
    reject: false,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.exitCode !== 0) throw new Error("Unable to read Pi version");
  return result.stdout.trim();
}

async function defaultListPiRpcProcessIds(): Promise<number[]> {
  if (process.platform === "win32") {
    const script = [
      "Get-CimInstance Win32_Process",
      "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('--mode') -and $_.CommandLine.Contains('rpc') -and $_.CommandLine.Contains('codex-external-agents') }",
      "ForEach-Object { $_.ProcessId }",
    ].join(" | ");
    const result = await execa(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { reject: false, timeout: 30_000, windowsHide: true },
    );
    if (result.exitCode !== 0) {
      throw new Error("Unable to list Pi RPC processes");
    }
    return result.stdout
      .split(/\s+/u)
      .filter((value) => /^\d+$/u.test(value))
      .map(Number)
      .sort((left, right) => left - right);
  }
  const result = await execa("ps", ["-eo", "pid=,args="], {
    reject: false,
    timeout: 30_000,
  });
  if (result.exitCode !== 0) throw new Error("Unable to list Pi RPC processes");
  return result.stdout
    .split(/\r?\n/u)
    .filter(
      (line) =>
        line.includes("--mode") &&
        line.includes("rpc") &&
        line.includes("codex-external-agents"),
    )
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
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

async function initializeFixture(
  cwd: string,
  task: PiSmokeTask,
): Promise<void> {
  await runGit(cwd, ["init", "--quiet"]);
  await runGit(cwd, ["config", "user.name", "codex-agent-tools smoke"]);
  await runGit(cwd, ["config", "user.email", "smoke@example.invalid"]);
  if (task === "review") {
    await writeFile(
      path.join(cwd, "average.js"),
      "export function average(values) {\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n",
      "utf8",
    );
    await writeFile(
      path.join(cwd, "average.test.js"),
      'import assert from "node:assert/strict";\nimport { average } from "./average.js";\nassert.equal(average([]), 0);\n',
      "utf8",
    );
  } else {
    await writeFile(
      path.join(cwd, "README.md"),
      "# Isolated Pi delegate smoke fixture\n",
      "utf8",
    );
  }
  await runGit(cwd, ["add", "."]);
  await runGit(cwd, ["commit", "--quiet", "-m", "smoke fixture"]);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface PiDelegateSmokeContract {
  readonly resultFileName: string;
  readonly expectedLine: string;
  readonly writeCommand: string;
  readonly prompt: string;
}

export function buildPiDelegateSmokeContract(
  llm: string,
): PiDelegateSmokeContract {
  if (!/^[A-Za-z0-9._-]+$/u.test(llm)) {
    throw new Error("Unsafe Pi smoke llm id");
  }
  const resultFileName = `${llm}-smoke.txt`;
  const expectedLine = `ARK_SMOKE_OK:${llm}`;
  const payloadBase64 = Buffer.from(`${expectedLine}\n`, "utf8").toString(
    "base64",
  );
  const writeCommand =
    `node -e 'require("node:fs").writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))' ` +
    `'${resultFileName}' '${payloadBase64}'`;
  return Object.freeze({
    resultFileName,
    expectedLine,
    writeCommand,
    prompt: [
      "Both actions below are mandatory before you finish.",
      "1. Invoke the bash tool with this exact command:",
      "```bash",
      writeCommand,
      "```",
      "The command must create the result file with this exact normalized payload:",
      "```text",
      expectedLine,
      "```",
      "The code fences are not part of the file.",
      "2. Invoke the bash tool with this exact command:",
      "```bash",
      "git status --short",
      "```",
      "Report both actions. Do not modify any other file. Do not substitute a prose claim for either bash invocation.",
    ].join("\n"),
  });
}

function knownDefectFound(review: string): boolean {
  return /(?:empty|zero|length|nan|division|空数组|空输入|零|长度|除零)/iu.test(
    review,
  );
}

function hasNoNewProcesses(
  before: readonly number[],
  after: readonly number[],
): boolean {
  const baseline = new Set(before);
  return after.every((pid) => baseline.has(pid));
}

function inspectEnvironment(
  environment: NodeJS.ProcessEnv,
  profile: LlmProfile,
): {
  isolated: boolean;
  credentialEnv: string | null;
} {
  const keys = Object.keys(environment).map((name) => name.toUpperCase());
  const expectedCredentialNames = (
    profile.credentialTargetEnv === undefined
      ? profile.credentialEnv
      : [profile.credentialTargetEnv]
  ).map((name) => name.toUpperCase());
  const credentialNames = expectedCredentialNames.filter((name) =>
    keys.includes(name),
  );
  const forbiddenCredential = keys.some(
    (name) =>
      /^(?:ANTHROPIC|OPENAI|DEEPSEEK|ARK|VOLCENGINE|KIMI|GEMINI|GOOGLE|CODEX_AGENT)_/u.test(
        name,
      ) && !expectedCredentialNames.includes(name),
  );
  const proxyEntries = Object.entries(environment).filter(([name]) =>
    /^(?:HTTP|HTTPS|ALL|SOCKS5)_PROXY$/iu.test(name),
  );
  const hasAgentDir = keys.includes("PI_CODING_AGENT_DIR");
  return {
    isolated:
      !forbiddenCredential &&
      proxyEntries.length === 0 &&
      hasAgentDir &&
      credentialNames.length === 1,
    credentialEnv: credentialNames[0] ?? null,
  };
}

function endpointHost(): string {
  return "ark.cn-beijing.volces.com";
}

function telemetryIsValid(
  telemetry: AdapterExecutionTelemetry | null | undefined,
  reportCount: number,
): telemetry is AdapterExecutionTelemetry {
  return (
    reportCount === 1 &&
    telemetry !== null &&
    telemetry !== undefined &&
    telemetry.source === "pi-rpc-observable" &&
    telemetry.adapterClientInvocationCount === 1 &&
    telemetry.adapterRetryCount === 0 &&
    telemetry.runtimeReportedAutoRetryCount === 0 &&
    telemetry.adapterReportedFallbackUsed === false
  );
}

function resultFileArtifactFields(
  evidence: ResultFileEvidence,
): Pick<
  PiSmokeEvidence,
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
  options: PiSmokeOptions,
  result: ExternalReviewResult | ExternalDelegateResult,
  piVersion: string,
  runtimeEvidence: PiSmokeRuntimeEvidence,
  processIdsBefore: readonly number[],
  processIdsAfter: readonly number[],
  now: Date,
  profile: LlmProfile,
  checks: PiSmokeChecks,
  passed: boolean,
  telemetry: AdapterExecutionTelemetry | null | undefined,
  qualification: SmokeQualificationContext | null,
): PiSmokeEvidence {
  const environment = inspectEnvironment(
    runtimeEvidence.childEnvironment,
    profile,
  );
  const output = "review" in result ? result.review : result.summary;
  const diagnosticText = result.diagnostics.join("\n");
  const failureReason = passed
    ? null
    : /Missing credential:/iu.test(diagnosticText)
      ? "missing_credential"
      : /AccountQuotaExceeded|weekly usage quota/iu.test(diagnosticText)
        ? "account_quota_exceeded"
        : result.status !== "completed"
          ? "adapter_failure"
          : "acceptance_failed";
  const payload: PiSmokeEvidencePayload = {
    timestamp: now.toISOString(),
    piVersion,
    llm: options.llm,
    actualModel: result.actualModel ?? null,
    expectedModel: profile.model,
    runtime: "pi-rpc",
    provider: profile.provider!,
    endpointHost: endpointHost(),
    route: profile.network,
    credentialEnv: environment.credentialEnv,
    configSha256: runtimeEvidence.configSha256,
    task: options.task,
    status: result.status,
    passed,
    failureReason,
    elapsedMs: result.elapsedMs,
    outputSha256: sha256(output),
    filesChanged: [...result.filesChanged].sort(),
    commandCount: "commandsRun" in result ? result.commandsRun.length : 0,
    diagnosticCount: result.diagnostics.length,
    adapterClientInvocationCount:
      telemetry?.adapterClientInvocationCount ?? null,
    adapterRetryCount: telemetry?.adapterRetryCount ?? null,
    runtimeReportedAutoRetryCount:
      telemetry?.runtimeReportedAutoRetryCount ?? null,
    adapterReportedFallbackUsed: telemetry?.adapterReportedFallbackUsed ?? null,
    orchestratorFallbackUsed: qualification?.orchestratorFallbackUsed ?? null,
    executionTelemetrySource: telemetry?.source ?? null,
    checks: {
      ...checks,
      environmentIsolated: environment.isolated,
      noNewPiRpcProcesses: hasNoNewProcesses(processIdsBefore, processIdsAfter),
    },
  };
  return qualification === null
    ? {
        schemaVersion: 2,
        qualification: null,
        ...payload,
      }
    : {
        schemaVersion: 3,
        qualification,
        ...payload,
      };
}

export async function runPiSmoke(
  options: PiSmokeOptions,
  dependencies: PiSmokeDependencies = {},
): Promise<PiSmokeEvidence> {
  const qualification = normalizeSmokeQualificationContext(
    options.qualificationContext,
  );
  assertSmokeQualificationIdentity(qualification, options.llm, options.task);
  const profile = resolveLlm(options.llm);
  if (profile.runtime !== "pi-rpc" || profile.provider === undefined) {
    throw new Error(`Logical llm ${options.llm} is not a Pi profile`);
  }
  let service = dependencies.service;
  let runtimeEvidence = dependencies.runtimeEvidence;
  if (service === undefined || runtimeEvidence === undefined) {
    if (service !== undefined || runtimeEvidence !== undefined) {
      throw new Error(
        "Pi smoke service and runtimeEvidence must be injected together",
      );
    }
    const runtime = await inSmokeInfrastructureStage("runtime_setup", () =>
      createPiSmokeRuntime(options.llm, options.task, qualification),
    );
    service = runtime.service;
    runtimeEvidence = runtime.evidence;
  }
  const readPiVersion = dependencies.readPiVersion ?? defaultReadPiVersion;
  const listPiRpcProcessIds =
    dependencies.listPiRpcProcessIds ?? defaultListPiRpcProcessIds;
  const now = dependencies.now ?? (() => new Date());
  const cwd = await inSmokeInfrastructureStage("workspace_setup", () =>
    mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "codex-pi-smoke-")),
  );

  try {
    await inSmokeInfrastructureStage("fixture_setup", () =>
      initializeFixture(cwd, options.task),
    );
    const piVersion = await inSmokeInfrastructureStage(
      "version_probe",
      readPiVersion,
    );
    const processIdsBefore = await inSmokeInfrastructureStage(
      "pre_process_snapshot",
      listPiRpcProcessIds,
    );
    let executionTelemetry: AdapterExecutionTelemetry | null | undefined;
    let executionTelemetryReportCount = 0;
    const context: TaskExecutionContext = {};
    if (options.onProgress !== undefined)
      context.onProgress = options.onProgress;
    context.onExecutionTelemetry = (telemetry) => {
      executionTelemetryReportCount += 1;
      executionTelemetry = telemetry;
    };
    const timeoutMs = options.timeoutMs ?? profile.timeoutMs;

    if (options.task === "review") {
      const result = await inSmokeInfrastructureStage("task_execution", () =>
        service.review(
          {
            llm: options.llm,
            task: "review_diff",
            prompt:
              "Read average.js and average.test.js. Identify the concrete correctness defect that makes the test fail. Cite the relevant expression. Do not modify files and do not execute commands.",
            cwd,
            includeGitDiff: true,
            timeoutMs,
          },
          context,
        ),
      );
      const gitClean = await inSmokeInfrastructureStage(
        "acceptance_check",
        async () =>
          (await runGit(cwd, ["status", "--porcelain"])).trim() === "",
      );
      const processIdsAfter = await inSmokeInfrastructureStage(
        "post_process_snapshot",
        listPiRpcProcessIds,
        { processIdsBefore: processIdsBefore.length },
      );
      const environment = inspectEnvironment(
        runtimeEvidence.childEnvironment,
        profile,
      );
      const checks: PiSmokeChecks = {
        actualModelMatches: result.actualModel === profile.model,
        environmentIsolated: environment.isolated,
        noNewPiRpcProcesses: hasNoNewProcesses(
          processIdsBefore,
          processIdsAfter,
        ),
        workspaceUnchanged: result.filesChanged.length === 0 && gitClean,
        knownDefectFound: knownDefectFound(result.review),
        executionTelemetryValid: telemetryIsValid(
          executionTelemetry,
          executionTelemetryReportCount,
        ),
      };
      const passed =
        result.status === "completed" &&
        Object.values(checks).every((value) => value === true);
      return commonEvidence(
        options,
        result,
        piVersion,
        runtimeEvidence,
        processIdsBefore,
        processIdsAfter,
        now(),
        profile,
        checks,
        passed,
        executionTelemetry,
        qualification,
      );
    }

    const { resultFileName, expectedLine, prompt, writeCommand } =
      buildPiDelegateSmokeContract(options.llm);
    let lifecycleObservations:
      readonly PiCommandLifecycleObservation[] | undefined;
    let lifecycleReportCount = 0;
    if (qualification !== null) {
      context.onPiCommandLifecycleObservations = (observations) => {
        lifecycleReportCount += 1;
        lifecycleObservations = observations;
      };
    }
    const result = await inSmokeInfrastructureStage(
      "task_execution",
      async () => {
        const delegateResult = await service.delegate(
          {
            llm: options.llm,
            prompt,
            cwd,
            timeoutMs,
          },
          context,
        );
        if (
          qualification !== null &&
          (lifecycleReportCount !== 1 ||
            lifecycleObservations === undefined ||
            lifecycleObservations.length > 256)
        ) {
          throw new Error(
            "Internal Pi command lifecycle report contract violated",
          );
        }
        return delegateResult;
      },
    );
    const resultFile = await inspectResultFile({
      filePath: path.join(cwd, resultFileName),
      expectedLine,
      maximumBytes: 65_536,
    });
    const processIdsAfter = await inSmokeInfrastructureStage(
      "post_process_snapshot",
      listPiRpcProcessIds,
      { processIdsBefore: processIdsBefore.length },
    );
    const environment = inspectEnvironment(
      runtimeEvidence.childEnvironment,
      profile,
    );
    const normalizedFiles = result.filesChanged.map((name) =>
      name.replaceAll("\\", "/"),
    );
    const checks: PiSmokeChecks = {
      actualModelMatches: result.actualModel === profile.model,
      environmentIsolated: environment.isolated,
      noNewPiRpcProcesses: hasNoNewProcesses(processIdsBefore, processIdsAfter),
      resultFileValid: resultFile.valid,
      resultFileObserved: normalizedFiles.includes(resultFileName),
      onlyExpectedFileChanged:
        normalizedFiles.length === 1 && normalizedFiles[0] === resultFileName,
      requiredCommandObserved:
        result.commandsRun.includes("git status --short"),
      executionTelemetryValid: telemetryIsValid(
        executionTelemetry,
        executionTelemetryReportCount,
      ),
    };
    const passed =
      result.status === "completed" &&
      Object.values(checks).every((value) => value === true);
    return {
      ...commonEvidence(
        options,
        result,
        piVersion,
        runtimeEvidence,
        processIdsBefore,
        processIdsAfter,
        now(),
        profile,
        checks,
        passed,
        executionTelemetry,
        qualification,
      ),
      ...resultFileArtifactFields(resultFile),
      ...(qualification === null
        ? {}
        : {
            writeCommandObservations: sanitizePiWriteCommandObservations(
              lifecycleObservations!,
              writeCommand,
            ),
          }),
    };
  } finally {
    await inSmokeInfrastructureStage("workspace_cleanup", () =>
      rm(cwd, { recursive: true, force: true }),
    );
  }
}
