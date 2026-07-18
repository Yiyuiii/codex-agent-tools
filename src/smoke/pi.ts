import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import { PiAdapter } from "../adapters/pi/adapter.js";
import { runPiRpc } from "../adapters/pi/client.js";
import { buildIsolatedPiConfig } from "../adapters/pi/config.js";
import { locatePi } from "../adapters/pi/locator.js";
import type { LlmProfile, NetworkPolicy, RuntimeKind } from "../domain/types.js";
import { createLlmRegistry, resolveLlm } from "../llms/registry.js";
import type {
  ExternalDelegateResult,
  ExternalReviewResult,
} from "../tasks/results.js";
import type {
  ExternalDelegateInput,
  ExternalReviewInput,
} from "../tasks/schemas.js";
import { ExternalAgentService, type TaskExecutionContext } from "../tasks/service.js";
import { VERSION } from "../version.js";

export type PiSmokeTask = "review" | "delegate";

export interface PiSmokeOptions {
  llm: string;
  task: PiSmokeTask;
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
  commandObserved?: boolean;
}

export interface PiSmokeEvidence {
  schemaVersion: 1;
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
  checks: PiSmokeChecks;
}

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

export function parsePiSmokeArguments(args: readonly string[]): {
  llm: string;
  task: PiSmokeTask;
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
      throw new Error(`Unknown Pi smoke argument: ${argument ?? ""}`);
    }
  }
  if (llm === undefined || llm.trim() === "") {
    throw new Error("Pi smoke requires --llm <logical-id>");
  }
  const profile = resolveLlm(llm);
  if (llm !== "gemini-3.5-flash" || profile.runtime !== "pi-rpc") {
    throw new Error(`Logical llm ${llm} is not the Gemini Pi profile`);
  }
  if (task !== "review" && task !== "delegate") {
    throw new Error("Pi smoke requires --task review|delegate");
  }
  return { llm, task };
}

async function createSmokeRuntime(
  llm: string,
  task: PiSmokeTask,
): Promise<{ service: PiSmokeService; evidence: PiSmokeRuntimeEvidence }> {
  const base = resolveLlm(llm);
  const profile = {
    ...base,
    capabilities: { ...base.capabilities, [task]: true },
    qualityGates: {
      ...base.qualityGates,
      [task]: { status: "passed" as const, evidence: "ephemeral smoke gate" },
    },
  };
  const config = await buildIsolatedPiConfig({
    version: VERSION,
    providers: ["ark"],
  });
  const evidence: PiSmokeRuntimeEvidence = {
    configSha256: config.contentSha256,
    childEnvironment: {},
  };
  const pi = new PiAdapter({
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

async function initializeFixture(cwd: string, task: PiSmokeTask): Promise<void> {
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

function knownDefectFound(review: string): boolean {
  return /(?:empty|zero|length|nan|division|空数组|空输入|零|长度|除零)/iu.test(
    review,
  );
}

function hasNoNewProcesses(before: readonly number[], after: readonly number[]): boolean {
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
      ) &&
      !expectedCredentialNames.includes(name),
  );
  const proxyEntries = Object.entries(environment).filter(([name]) =>
    /^(?:HTTP|HTTPS|ALL|SOCKS5)_PROXY$/iu.test(name),
  );
  const expectedProxy =
    profile.network === "direct"
      ? undefined
      : `http://127.0.0.1:${profile.network === "proxy-10808" ? 10808 : 11808}`;
  const proxyIsolated =
    expectedProxy === undefined
      ? proxyEntries.length === 0
      : ["HTTP_PROXY", "HTTPS_PROXY"].every((expectedName) =>
          proxyEntries.some(
            ([name, value]) =>
              name.toUpperCase() === expectedName && value === expectedProxy,
          ),
        ) &&
        proxyEntries.every(
          ([name, value]) =>
            ["HTTP_PROXY", "HTTPS_PROXY"].includes(name.toUpperCase()) &&
            value === expectedProxy,
        );
  const hasAgentDir = keys.includes("PI_CODING_AGENT_DIR");
  return {
    isolated:
      !forbiddenCredential &&
      proxyIsolated &&
      hasAgentDir &&
      credentialNames.length === 1,
    credentialEnv: credentialNames[0] ?? null,
  };
}

function endpointHost(profile: LlmProfile): string {
  return profile.provider?.startsWith("ark-") === true
    ? "ark.cn-beijing.volces.com"
    : "generativelanguage.googleapis.com";
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
  return {
    schemaVersion: 1,
    timestamp: now.toISOString(),
    piVersion,
    llm: options.llm,
    actualModel: result.actualModel ?? null,
    expectedModel: profile.model,
    runtime: "pi-rpc",
    provider: profile.provider!,
    endpointHost: endpointHost(profile),
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
    checks: {
      ...checks,
      environmentIsolated: environment.isolated,
      noNewPiRpcProcesses: hasNoNewProcesses(
        processIdsBefore,
        processIdsAfter,
      ),
    },
  };
}

export async function runPiSmoke(
  options: PiSmokeOptions,
  dependencies: PiSmokeDependencies = {},
): Promise<PiSmokeEvidence> {
  const profile = resolveLlm(options.llm);
  if (
    profile.runtime !== "pi-rpc" ||
    profile.provider === undefined
  ) {
    throw new Error(`Logical llm ${options.llm} is not a Pi profile`);
  }
  let service = dependencies.service;
  let runtimeEvidence = dependencies.runtimeEvidence;
  if (service === undefined || runtimeEvidence === undefined) {
    if (service !== undefined || runtimeEvidence !== undefined) {
      throw new Error("Pi smoke service and runtimeEvidence must be injected together");
    }
    const runtime = await createSmokeRuntime(options.llm, options.task);
    service = runtime.service;
    runtimeEvidence = runtime.evidence;
  }
  const readPiVersion = dependencies.readPiVersion ?? defaultReadPiVersion;
  const listPiRpcProcessIds =
    dependencies.listPiRpcProcessIds ?? defaultListPiRpcProcessIds;
  const now = dependencies.now ?? (() => new Date());
  const cwd = await mkdtemp(
    path.join(options.tempRoot ?? os.tmpdir(), "codex-pi-smoke-"),
  );

  try {
    await initializeFixture(cwd, options.task);
    const piVersion = await readPiVersion();
    const processIdsBefore = await listPiRpcProcessIds();
    const context: TaskExecutionContext = {};
    if (options.onProgress !== undefined) context.onProgress = options.onProgress;
    const timeoutMs = options.timeoutMs ?? profile.timeoutMs;

    if (options.task === "review") {
      const result = await service.review(
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
      );
      const gitClean = (await runGit(cwd, ["status", "--porcelain"])).trim() === "";
      const processIdsAfter = await listPiRpcProcessIds();
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
      );
    }

    const resultFileName =
      profile.provider.startsWith("ark-")
        ? `${options.llm}-smoke.txt`
        : "result.txt";
    const expectedLine =
      profile.provider.startsWith("ark-")
        ? `ARK_SMOKE_OK:${options.llm}`
        : "PI_SMOKE_OK";
    const result = await service.delegate(
      {
        llm: options.llm,
        prompt:
          `Both actions are mandatory before you finish: (1) create ${resultFileName} in the working directory with exactly one line: ${expectedLine}; (2) invoke the bash tool with the exact command \`git status --short\` to verify the change. Report both actions. Do not modify any other file, and do not substitute a prose claim for the bash invocation.`,
        cwd,
        timeoutMs,
      },
      context,
    );
    let resultText = "";
    try {
      resultText = await readFile(path.join(cwd, resultFileName), "utf8");
    } catch {
      resultText = "";
    }
    const processIdsAfter = await listPiRpcProcessIds();
    const environment = inspectEnvironment(
      runtimeEvidence.childEnvironment,
      profile,
    );
    const normalizedFiles = result.filesChanged.map((name) => name.replaceAll("\\", "/"));
    const checks: PiSmokeChecks = {
      actualModelMatches: result.actualModel === profile.model,
      environmentIsolated: environment.isolated,
      noNewPiRpcProcesses: hasNoNewProcesses(
        processIdsBefore,
        processIdsAfter,
      ),
      resultFileValid: resultText.trim() === expectedLine,
      resultFileObserved: normalizedFiles.includes(resultFileName),
      onlyExpectedFileChanged:
        normalizedFiles.length === 1 && normalizedFiles[0] === resultFileName,
      commandObserved: result.commandsRun.length > 0,
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
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
