import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveLlm } from "../llms/registry.js";

export type SmokeKind = "kimi" | "pi" | "ark";
export type SmokeTask = "review" | "delegate";

export type SmokeInfrastructureStage =
  | "runtime_setup"
  | "workspace_setup"
  | "fixture_setup"
  | "version_probe"
  | "pre_process_snapshot"
  | "task_execution"
  | "acceptance_check"
  | "post_process_snapshot"
  | "workspace_cleanup"
  | "smoke_execution";

export interface SmokeInfrastructureCounts {
  processIdsBefore?: number;
  processIdsAfter?: number;
}

export class SmokeInfrastructureError extends Error {
  readonly stage: SmokeInfrastructureStage;
  readonly counts: SmokeInfrastructureCounts;

  constructor(
    stage: SmokeInfrastructureStage,
    counts: SmokeInfrastructureCounts = {},
    cause?: unknown,
  ) {
    super("Smoke infrastructure failure", { cause });
    this.name = "SmokeInfrastructureError";
    this.stage = stage;
    this.counts = { ...counts };
  }
}

export async function inSmokeInfrastructureStage<T>(
  stage: SmokeInfrastructureStage,
  operation: () => Promise<T>,
  counts: SmokeInfrastructureCounts = {},
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SmokeInfrastructureError) throw error;
    throw new SmokeInfrastructureError(stage, counts, error);
  }
}

interface ParsedSmokeArguments {
  llm: string;
  task: SmokeTask;
}

interface SmokeEvidence {
  timestamp: string;
  passed: boolean;
  [key: string]: unknown;
}

export interface SmokeEntrypointOptions<
  TOptions extends ParsedSmokeArguments,
  TEvidence extends SmokeEvidence,
> {
  kind: SmokeKind;
  args: readonly string[];
  parseArguments: (args: readonly string[]) => TOptions;
  runSmoke: (
    options: TOptions & { onProgress: (message: string) => void },
  ) => Promise<TEvidence>;
  evidenceDirectory: string;
  now?: () => Date;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

function evidenceFileName(
  kind: SmokeKind,
  timestamp: string,
  options: ParsedSmokeArguments,
): string {
  const suffix = kind === "kimi" ? "" : `-${kind}`;
  return `${timestamp.replaceAll(":", "-")}-${options.llm}-${options.task}${suffix}.json`;
}

function infrastructureEvidence(
  options: ParsedSmokeArguments,
  error: SmokeInfrastructureError,
  timestamp: string,
): SmokeEvidence {
  const profile = resolveLlm(options.llm);
  return {
    schemaVersion: 1,
    timestamp,
    llm: options.llm,
    actualModel: null,
    expectedModel: profile.model,
    runtime: profile.runtime,
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    route: profile.network,
    task: options.task,
    status: "failed",
    passed: false,
    failureReason: "infrastructure_failure",
    failure: {
      category: "infrastructure",
      stage: error.stage,
      count: 1,
    },
    counts: { ...error.counts },
    checks: {
      postProcessSnapshot:
        error.stage === "post_process_snapshot" ? "unknown" : "not_reached",
      processCleanup: "unknown",
    },
  };
}

async function writeEvidence(
  evidenceDirectory: string,
  fileName: string,
  evidence: SmokeEvidence,
): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, fileName),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
}

export async function runSmokeEntrypoint<
  TOptions extends ParsedSmokeArguments,
  TEvidence extends SmokeEvidence,
>(
  config: SmokeEntrypointOptions<TOptions, TEvidence>,
): Promise<number> {
  const writeStdout = config.writeStdout ?? ((text) => process.stdout.write(text));
  const writeStderr = config.writeStderr ?? ((text) => process.stderr.write(text));
  let options: TOptions;
  try {
    options = config.parseArguments(config.args);
  } catch {
    writeStderr("Smoke arguments are invalid.\n");
    return 1;
  }

  const now = config.now ?? (() => new Date());
  let evidence: SmokeEvidence;
  let infrastructureFailure = false;
  try {
    evidence = await config.runSmoke({
      ...options,
      onProgress: (message) =>
        writeStderr(`[${config.kind} smoke] ${message}\n`),
    });
  } catch (error) {
    infrastructureFailure = true;
    const sanitized =
      error instanceof SmokeInfrastructureError
        ? error
        : new SmokeInfrastructureError("smoke_execution", {}, error);
    evidence = infrastructureEvidence(options, sanitized, now().toISOString());
  }

  const fileName = evidenceFileName(
    config.kind,
    evidence.timestamp,
    options,
  );
  try {
    await writeEvidence(config.evidenceDirectory, fileName, evidence);
  } catch {
    writeStderr(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
    return 1;
  }

  writeStdout(
    `${JSON.stringify(
      {
        evidence: `docs/smoke/evidence/${fileName}`,
        ...evidence,
      },
      null,
      2,
    )}\n`,
  );
  if (infrastructureFailure || !evidence.passed) {
    writeStderr("Smoke failed; sanitized evidence was written.\n");
    return 1;
  }
  return 0;
}
