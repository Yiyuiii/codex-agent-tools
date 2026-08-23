import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  QualificationCaseIdentity,
  QualificationLockHandle,
  QualificationTerminalManifest,
} from "../src/qualification/types.js";
import {
  ACTIVE_QUALIFICATION_PLAN_ID,
  CAPABILITY_REFRESH_QUALIFICATION_CASES,
  CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID,
  DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
  type CurrentQualificationPlanId,
} from "../src/qualification/protocol.js";

const AUTHORIZATION_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BATCH_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const MAX_SMOKE_OUTPUT_BYTES = 1_048_576;
const DEFAULT_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const HELP = `Usage: npm run --silent qualify:gates -- --authorization-ref <uuid>
       npm run --silent qualify:gates -- --plan capability-refresh-v1 --authorization-ref <uuid>
       npm run --silent qualify:gates -- --plan direct-deepseek-v1 --authorization-ref <uuid>
       npm run --silent qualify:gates -- --recover-interrupted <batchId>
       npm run --silent qualify:gates -- --help
`;

export type GateRequalificationCommand =
  | Readonly<{ kind: "help" }>
  | Readonly<{
      kind: "qualify";
      qualificationPlanId: CurrentQualificationPlanId;
      authorizationReference: string;
    }>
  | Readonly<{ kind: "recover"; batchId: string }>;

export function parseGateRequalificationArguments(
  args: readonly string[],
): GateRequalificationCommand {
  if (args.length === 1 && args[0] === "--help") {
    return Object.freeze({ kind: "help" });
  }
  if (
    args.length === 2 &&
    args[0] === "--authorization-ref" &&
    typeof args[1] === "string" &&
    AUTHORIZATION_REFERENCE_PATTERN.test(args[1])
  ) {
    return Object.freeze({
      kind: "qualify",
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
      authorizationReference: args[1],
    });
  }
  if (
    args.length === 4 &&
    args[0] === "--plan" &&
    (args[1] === DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID ||
      args[1] === CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID) &&
    args[2] === "--authorization-ref" &&
    typeof args[3] === "string" &&
    AUTHORIZATION_REFERENCE_PATTERN.test(args[3])
  ) {
    return Object.freeze({
      kind: "qualify",
      qualificationPlanId: args[1],
      authorizationReference: args[3],
    });
  }
  if (
    args.length === 2 &&
    args[0] === "--recover-interrupted" &&
    typeof args[1] === "string" &&
    BATCH_ID_PATTERN.test(args[1]) &&
    args[1] !== "." &&
    args[1] !== ".." &&
    !path.isAbsolute(args[1]) &&
    !path.win32.isAbsolute(args[1])
  ) {
    return Object.freeze({ kind: "recover", batchId: args[1] });
  }
  throw new Error("Invalid gate requalification arguments");
}

interface SmokeMainModule {
  main(options: {
    args: readonly string[];
    evidenceDirectory: string;
    qualificationContext: Readonly<{
      qualificationPlanId: CurrentQualificationPlanId;
      batchId: string;
      ordinal: number;
      llm: string;
      task: "review" | "delegate";
      frozenCommit: string;
      frozenBuildIdentity: string;
      authorizationReferenceSha256: string;
      orchestratorFallbackUsed: false;
    }>;
    writeStdout: (text: string) => void;
    writeStderr: (text: string) => void;
  }): Promise<number>;
}

async function smokeModule(
  identity: QualificationCaseIdentity,
): Promise<SmokeMainModule> {
  if (identity.llm === "kimi-k3") {
    // @ts-expect-error The production .mjs entrypoint intentionally has no declaration file.
    return import("./real-kimi-smoke.mjs") as Promise<SmokeMainModule>;
  }
  if (identity.llm === "deepseek-v4-flash") {
    // @ts-expect-error The production .mjs entrypoint intentionally has no declaration file.
    return import("./real-deepseek-smoke.mjs") as Promise<SmokeMainModule>;
  }
  // @ts-expect-error The production .mjs entrypoint intentionally has no declaration file.
  return import("./real-ark-smoke.mjs") as Promise<SmokeMainModule>;
}

function batchId(): string {
  return `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
}

async function runSmokeCase(options: {
  repositoryRoot: string;
  identity: QualificationCaseIdentity;
  qualificationContext: Readonly<{
    qualificationPlanId: CurrentQualificationPlanId;
    batchId: string;
    ordinal: number;
    llm: string;
    task: "review" | "delegate";
    frozenCommit: string;
    frozenBuildIdentity: string;
    authorizationReferenceSha256: string;
    orchestratorFallbackUsed: false;
  }>;
  evidenceDirectory: string;
  writeStderr: (text: string) => void;
}): Promise<{ exitCode: 0 | 1; evidencePath: string }> {
  const module = await smokeModule(options.identity);
  let stdout = "";
  let outputBytes = 0;
  const exitCode = await module.main({
    args: ["--llm", options.identity.llm, "--task", options.identity.task],
    evidenceDirectory: options.evidenceDirectory,
    qualificationContext: options.qualificationContext,
    writeStdout: (text) => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > MAX_SMOKE_OUTPUT_BYTES) {
        throw new Error("Qualification smoke output exceeded its limit");
      }
      stdout += text;
    },
    writeStderr: options.writeStderr,
  });
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error("Qualification smoke returned an invalid exit code");
  }
  let evidence: unknown;
  try {
    evidence = (JSON.parse(stdout) as { evidence?: unknown }).evidence;
  } catch {
    throw new Error("Qualification smoke result was invalid");
  }
  if (
    typeof evidence !== "string" ||
    evidence.length === 0 ||
    path.isAbsolute(evidence) ||
    path.win32.isAbsolute(evidence)
  ) {
    throw new Error("Qualification smoke evidence path was invalid");
  }
  return Object.freeze({
    exitCode,
    evidencePath: path.resolve(options.repositoryRoot, evidence),
  });
}

function ownersEqual(
  left: QualificationLockHandle["owner"],
  right: QualificationLockHandle["owner"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCurrentQualificationPlan(
  qualificationPlanId: unknown,
): asserts qualificationPlanId is CurrentQualificationPlanId {
  if (
    qualificationPlanId !== ACTIVE_QUALIFICATION_PLAN_ID &&
    qualificationPlanId !== DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID &&
    qualificationPlanId !== CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID
  ) {
    throw new Error("Qualification plan mismatch");
  }
}

export async function assertCapabilityRefreshSelection(
  repositoryRoot: string,
  analyze?: (
    repositoryRoot: string,
  ) => Promise<{
    entries: readonly {
      llm: string;
      task: "review" | "delegate";
      runtimeFingerprintStatus: "current" | "stale" | "invalid";
    }[];
  }>,
): Promise<void> {
  const analysis = await (
    analyze ??
    (async (root) => {
      const capabilityIndex = await import(
        "../src/qualification/capability-index.js"
      );
      return capabilityIndex.analyzeCapabilityIndex({ repositoryRoot: root });
    })
  )(repositoryRoot);
  const expected = analysis.entries
    .filter(
      (entry) =>
        entry.llm !== "deepseek-v4-flash" &&
        entry.runtimeFingerprintStatus !== "current",
    )
    .map((entry) => `${entry.llm}/${entry.task}`)
    .sort((left, right) => left.localeCompare(right, "en"));
  const selected = CAPABILITY_REFRESH_QUALIFICATION_CASES.map(
    (entry) => `${entry.llm}/${entry.task}`,
  ).sort((left, right) => left.localeCompare(right, "en"));
  if (
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    JSON.stringify(selected) !== JSON.stringify(expected)
  ) {
    throw new Error("Capability refresh target selection mismatch");
  }
}

async function runProductionQualification(options: {
  repositoryRoot: string;
  authorizationReference: string;
  qualificationPlanId: CurrentQualificationPlanId;
  writeStderr: (text: string) => void;
}): Promise<QualificationTerminalManifest> {
  if (
    options.qualificationPlanId === CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID
  ) {
    await assertCapabilityRefreshSelection(options.repositoryRoot);
  }
  const [coordinator, lock, manifest, preflight] = await Promise.all(
    [
      import("../src/qualification/coordinator.js"),
      import("../src/qualification/lock.js"),
      import("../src/qualification/manifest.js"),
      import("../src/qualification/preflight.js"),
    ],
  );
  const preflightModule = preflight as typeof preflight & {
    assertQualificationCandidateUnchanged(input: {
      repositoryRoot: string;
      batchId: string;
      preflight: import("../src/qualification/types.js").CurrentFrozenPreflightRecord;
    }): Promise<void>;
  };

  return coordinator.runQualificationBatch(
    {
      repositoryRoot: options.repositoryRoot,
      authorizationReference: options.authorizationReference,
      qualificationPlanId: options.qualificationPlanId,
    },
    {
      createBatchId: batchId,
      now: () => new Date(),
      acquireLock: (input) => {
        assertCurrentQualificationPlan(input.qualificationPlanId);
        return lock.acquireQualificationLock(input);
      },
      releaseLock: (handle) => lock.releaseQualificationLock(handle),
      runPreflight: ({
        repositoryRoot,
        authorizationReferenceSha256,
        lockHandle,
        qualificationPlanId,
      }) => {
        assertCurrentQualificationPlan(qualificationPlanId);
        return preflight.runQualificationPreflight({
          repositoryRoot,
          authorizationReferenceSha256,
          lockDirectory: lockHandle.lockDirectory,
          currentOwnerNonce: lockHandle.owner.nonce,
          qualificationPlanId,
        });
      },
      createLedger: (input) => {
        assertCurrentQualificationPlan(input.qualificationPlanId);
        return manifest.createQualificationLedger(input);
      },
      assertLockOwner: async (handle) => {
        const owner = await lock.readQualificationLockOwner(
          handle.lockDirectory,
        );
        if (!ownersEqual(owner, handle.owner)) {
          throw new Error("Qualification lock owner changed");
        }
      },
      assertFrozenCandidate: (input) => {
        assertCurrentQualificationPlan(input.qualificationPlanId);
        return preflightModule.assertQualificationCandidateUnchanged(input);
      },
      runCase: ({ identity, qualificationContext, evidenceDirectory }) =>
        runSmokeCase({
          repositoryRoot: options.repositoryRoot,
          identity,
          qualificationContext,
          evidenceDirectory,
          writeStderr: options.writeStderr,
        }),
    },
  );
}

async function recoverProductionQualification(options: {
  repositoryRoot: string;
  batchId: string;
}): Promise<void> {
  const [lock, manifest] = await Promise.all([
    import("../src/qualification/lock.js"),
    import("../src/qualification/manifest.js"),
  ]);
  await lock.recoverQualificationLock({
    repositoryRoot: options.repositoryRoot,
    batchId: options.batchId,
    inspectTerminalManifest: (candidateBatchId) =>
      manifest.inspectQualificationTerminal({
        repositoryRoot: options.repositoryRoot,
        batchId: candidateBatchId,
      }),
    publishInterruptedManifest: async (reference) => {
      await manifest.recoverInterruptedQualificationBatch({
        repositoryRoot: options.repositoryRoot,
        batchId: reference.batchId,
        authorizationReferenceSha256: reference.authorizationReferenceSha256,
        qualificationPlanId: reference.qualificationPlanId,
        completedAt: new Date().toISOString(),
      });
    },
  });
}

export interface GateRequalificationMainOptions {
  args?: readonly string[];
  repositoryRoot?: string;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  qualify?: typeof runProductionQualification;
  recover?: typeof recoverProductionQualification;
}

export async function main(
  options: GateRequalificationMainOptions = {},
): Promise<number> {
  const writeStdout =
    options.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr =
    options.writeStderr ?? ((text: string) => process.stderr.write(text));
  let command: GateRequalificationCommand;
  try {
    command = parseGateRequalificationArguments(
      options.args ?? process.argv.slice(2),
    );
  } catch {
    writeStderr("Invalid gate requalification arguments\n");
    return 1;
  }
  if (command.kind === "help") {
    writeStdout(HELP);
    return 0;
  }
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT,
  );
  try {
    if (command.kind === "recover") {
      await (options.recover ?? recoverProductionQualification)({
        repositoryRoot,
        batchId: command.batchId,
      });
      writeStdout(
        `${JSON.stringify({ recovered: true, batchId: command.batchId })}\n`,
      );
      return 0;
    }
    const manifest = await (options.qualify ?? runProductionQualification)({
      repositoryRoot,
      authorizationReference: command.authorizationReference,
      qualificationPlanId: command.qualificationPlanId,
      writeStderr,
    });
    writeStdout(
      `${JSON.stringify({
        batchId: manifest.batchId,
        qualificationPlanId: command.qualificationPlanId,
        status: manifest.status,
        completedCases: manifest.cases.length,
        promotionEligible: manifest.promotionEligible,
      })}\n`,
    );
    return manifest.status === "passed" ? 0 : 1;
  } catch {
    writeStderr("Gate requalification failed\n");
    return 1;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const left = pathToFileURL(path.resolve(entry)).href;
  const right = import.meta.url;
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

if (isDirectExecution()) {
  process.exitCode = await main();
}
