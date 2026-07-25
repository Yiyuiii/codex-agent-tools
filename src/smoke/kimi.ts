import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import { KimiAdapter } from "../adapters/kimi/adapter.js";
import { locateKimi } from "../adapters/kimi/locator.js";
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
import { inSmokeInfrastructureStage } from "./evidence.js";

export type KimiSmokeTask = "review" | "delegate";

export interface KimiSmokeOptions {
  llm: string;
  task: KimiSmokeTask;
  tempRoot?: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

export interface KimiSmokeChecks {
  actualModelMatches: boolean;
  noNewKimiProcesses: boolean;
  workspaceUnchanged?: boolean;
  knownDefectFound?: boolean;
  resultFileValid?: boolean;
  resultFileObserved?: boolean;
  onlyExpectedFileChanged?: boolean;
  commandObserved?: boolean;
}

export interface KimiSmokeEvidence {
  schemaVersion: 1;
  timestamp: string;
  kimiVersion: string;
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
    | "process_residual"
    | "infrastructure_failure"
    | null;
  elapsedMs: number;
  outputSha256: string;
  filesChanged: string[];
  commandCount: number;
  diagnosticCount: number;
  checks: KimiSmokeChecks;
}

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
  readKimiVersion?: () => Promise<string>;
  listKimiProcessIds?: () => Promise<number[]>;
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

async function defaultReadKimiVersion(): Promise<string> {
  const executable = await locateKimi();
  const result = await execa(executable, ["--version"], {
    reject: false,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    throw new Error("Unable to read Kimi Code version");
  }
  return result.stdout.trim();
}

async function defaultListKimiProcessIds(): Promise<number[]> {
  if (process.platform === "win32") {
    const result = await execa(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq kimi.exe", "/FO", "CSV", "/NH"],
      { reject: false, timeout: 30_000, windowsHide: true },
    );
    if (result.exitCode !== 0) {
      throw new Error("Unable to list Kimi processes with tasklist");
    }
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => /^"[^"]+","(\d+)"/u.exec(line)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .sort((left, right) => left - right);
  }

  const result = await execa("pgrep", ["-f", "kimi.*acp"], {
    reject: false,
    timeout: 30_000,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error("Unable to list Kimi ACP processes with pgrep");
  }
  return result.stdout
    .split(/\s+/u)
    .filter((value) => /^\d+$/u.test(value))
    .map(Number)
    .sort((left, right) => left - right);
}

function hasNoNewProcesses(before: readonly number[], after: readonly number[]): boolean {
  const baseline = new Set(before);
  return after.every((pid) => baseline.has(pid));
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

function commonEvidence(
  options: KimiSmokeOptions,
  result: ExternalReviewResult | ExternalDelegateResult,
  expectedModel: string,
  kimiVersion: string,
  now: Date,
  checks: KimiSmokeChecks,
  passed: boolean,
): KimiSmokeEvidence {
  const output = "review" in result ? result.review : result.summary;
  return {
    schemaVersion: 1,
    timestamp: now.toISOString(),
    kimiVersion,
    llm: options.llm,
    actualModel: result.actualModel ?? null,
    expectedModel,
    runtime: "kimi-acp",
    route: "direct",
    task: options.task,
    status: result.status,
    passed,
    failureReason:
      !passed && checks.noNewKimiProcesses === false
        ? "process_residual"
        : !passed && result.status !== "completed"
          ? "adapter_auth_or_model_unavailable"
          : !passed
            ? "acceptance_failed"
            : null,
    elapsedMs: result.elapsedMs,
    outputSha256: sha256(output),
    filesChanged: [...result.filesChanged].sort(),
    commandCount: "commandsRun" in result ? result.commandsRun.length : 0,
    diagnosticCount: result.diagnostics.length,
    checks,
  };
}

export async function runKimiSmoke(
  options: KimiSmokeOptions,
  dependencies: KimiSmokeDependencies = {},
): Promise<KimiSmokeEvidence> {
  const profile = resolveLlm(options.llm);
  if (profile.runtime !== "kimi-acp" || profile.network !== "direct") {
    throw new Error(`Logical llm ${options.llm} is not a direct Kimi profile`);
  }
  const service = dependencies.service ?? smokeService(options.llm, options.task);
  const readKimiVersion = dependencies.readKimiVersion ?? defaultReadKimiVersion;
  const listKimiProcessIds =
    dependencies.listKimiProcessIds ?? defaultListKimiProcessIds;
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
    const kimiVersion = await inSmokeInfrastructureStage(
      "version_probe",
      readKimiVersion,
    );
    const processIdsBefore = await inSmokeInfrastructureStage(
      "pre_process_snapshot",
      listKimiProcessIds,
    );
    const context: TaskExecutionContext = {};
    if (options.onProgress !== undefined) context.onProgress = options.onProgress;
    const timeoutMs = options.timeoutMs ?? profile.timeoutMs;

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
        listKimiProcessIds,
        { processIdsBefore: processIdsBefore.length },
      );
      const checks: KimiSmokeChecks = {
        actualModelMatches: result.actualModel === profile.model,
        noNewKimiProcesses: hasNoNewProcesses(
          processIdsBefore,
          processIdsAfter,
        ),
        workspaceUnchanged: result.filesChanged.length === 0 && gitClean,
        knownDefectFound: reviewFoundKnownDefect(result.review),
      };
      const passed =
        result.status === "completed" &&
        checks.actualModelMatches &&
        checks.noNewKimiProcesses &&
        checks.workspaceUnchanged === true &&
        checks.knownDefectFound === true;
      return commonEvidence(
        options,
        result,
        profile.model,
        kimiVersion,
        now(),
        checks,
        passed,
      );
    }

    const result = await inSmokeInfrastructureStage(
      "task_execution",
      () =>
        service.delegate(
          {
            llm: options.llm,
            prompt:
              "Create result.txt in the working directory with exactly one line: KIMI_SMOKE_OK. Then run `git status --short` to verify the change and report what you did. Do not modify any other file.",
            cwd,
            timeoutMs,
          },
          context,
        ),
    );
    let resultText = "";
    try {
      resultText = await readFile(path.join(cwd, "result.txt"), "utf8");
    } catch {
      resultText = "";
    }
    const normalizedFiles = result.filesChanged.map((name) => name.replaceAll("\\", "/"));
    const processIdsAfter = await inSmokeInfrastructureStage(
      "post_process_snapshot",
      listKimiProcessIds,
      { processIdsBefore: processIdsBefore.length },
    );
    const checks: KimiSmokeChecks = {
      actualModelMatches: result.actualModel === profile.model,
      noNewKimiProcesses: hasNoNewProcesses(
        processIdsBefore,
        processIdsAfter,
      ),
      resultFileValid: resultText.trim() === "KIMI_SMOKE_OK",
      resultFileObserved: normalizedFiles.includes("result.txt"),
      onlyExpectedFileChanged:
        normalizedFiles.length === 1 && normalizedFiles[0] === "result.txt",
      commandObserved: result.commandsRun.length > 0,
    };
    const passed =
      result.status === "completed" &&
      checks.actualModelMatches &&
      checks.noNewKimiProcesses &&
      checks.resultFileValid === true &&
      checks.resultFileObserved === true &&
      checks.onlyExpectedFileChanged === true &&
      checks.commandObserved === true;
    return commonEvidence(
      options,
      result,
      profile.model,
      kimiVersion,
      now(),
      checks,
      passed,
    );
  } finally {
    await inSmokeInfrastructureStage(
      "workspace_cleanup",
      () => rm(cwd, { recursive: true, force: true }),
    );
  }
}
