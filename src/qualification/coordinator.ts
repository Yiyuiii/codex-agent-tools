import { createHash } from "node:crypto";
import path from "node:path";

import {
  ACTIVE_QUALIFICATION_CASES,
  ACTIVE_QUALIFICATION_PLAN_ID,
} from "./protocol.js";
import type {
  CurrentFrozenPreflightRecord,
  QualificationCaseIdentity,
  QualificationLockHandle,
  QualificationTerminalManifest,
  TargetAgentProcessCounts,
} from "./types.js";
import type { QualificationLedger } from "./manifest.js";

const AUTHORIZATION_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTIVE_QUALIFICATION_PROTOCOL = Object.freeze({
  qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
  schedule: ACTIVE_QUALIFICATION_CASES,
});

export type QualificationCoordinatorStage =
  "arguments" | "lock" | "preflight" | "batch" | "release";

export class QualificationCoordinatorError extends Error {
  readonly category = "infrastructure";
  readonly stage: QualificationCoordinatorStage;
  readonly count = 1;

  constructor(stage: QualificationCoordinatorStage) {
    super("Qualification coordination failed");
    this.name = "QualificationCoordinatorError";
    this.stage = stage;
  }
}

class QualificationLockOwnershipLostError extends Error {}

export interface QualificationCaseRunResult {
  exitCode: 0 | 1;
  evidencePath: string;
}

export interface QualificationCoordinatorDependencies {
  createBatchId(): string;
  now(): Date;
  acquireLock(options: {
    repositoryRoot: string;
    batchId: string;
    authorizationReferenceSha256: string;
    qualificationPlanId: "four-llm-v1";
  }): Promise<QualificationLockHandle>;
  releaseLock(handle: QualificationLockHandle): Promise<void>;
  runPreflight(options: {
    repositoryRoot: string;
    authorizationReferenceSha256: string;
    lockHandle: QualificationLockHandle;
    qualificationPlanId: "four-llm-v1";
  }): Promise<CurrentFrozenPreflightRecord>;
  createLedger(options: {
    repositoryRoot: string;
    batchId: string;
    qualificationPlanId: "four-llm-v1";
  }): QualificationLedger;
  assertLockOwner(handle: QualificationLockHandle): Promise<void>;
  assertFrozenCandidate(options: {
    repositoryRoot: string;
    batchId: string;
    preflight: CurrentFrozenPreflightRecord;
    qualificationPlanId: "four-llm-v1";
  }): Promise<void>;
  inspectTargetProcesses(): Promise<TargetAgentProcessCounts>;
  runCase(options: {
    identity: QualificationCaseIdentity;
    qualificationContext: Readonly<{
      qualificationPlanId: "four-llm-v1";
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
  }): Promise<QualificationCaseRunResult>;
}

function authorizationReferenceSha256(reference: string): string {
  return createHash("sha256").update(reference.toLowerCase()).digest("hex");
}

function safeTimestamp(dependencies: QualificationCoordinatorDependencies) {
  try {
    return dependencies.now().toISOString();
  } catch {
    throw new QualificationCoordinatorError("batch");
  }
}

function assertZeroTargetProcesses(counts: TargetAgentProcessCounts): void {
  const record = counts as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "kimi" ||
    keys[1] !== "piRpc" ||
    keys[2] !== "realSmoke"
  ) {
    throw new QualificationCoordinatorError("batch");
  }
  for (const key of keys) {
    const value = record[key];
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      (value as { count?: unknown }).count !== 0
    ) {
      throw new QualificationCoordinatorError("batch");
    }
  }
}

function normalizeRunResult(value: unknown): QualificationCaseRunResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "evidencePath,exitCode"
  ) {
    throw new QualificationCoordinatorError("batch");
  }
  const result = value as {
    exitCode?: unknown;
    evidencePath?: unknown;
  };
  if (
    (result.exitCode !== 0 && result.exitCode !== 1) ||
    typeof result.evidencePath !== "string" ||
    result.evidencePath.length === 0
  ) {
    throw new QualificationCoordinatorError("batch");
  }
  return Object.freeze({
    exitCode: result.exitCode,
    evidencePath: result.evidencePath,
  });
}

async function assertBatchLockOwner(
  dependencies: QualificationCoordinatorDependencies,
  lockHandle: QualificationLockHandle,
): Promise<void> {
  try {
    await dependencies.assertLockOwner(lockHandle);
  } catch {
    throw new QualificationLockOwnershipLostError();
  }
}

async function publishInfrastructureTerminal(options: {
  ledger: QualificationLedger;
  currentIndex: number;
  runningPublished: boolean;
  dependencies: QualificationCoordinatorDependencies;
  schedule: readonly QualificationCaseIdentity[];
}): Promise<QualificationTerminalManifest> {
  const notRunStart = options.currentIndex + (options.runningPublished ? 1 : 0);
  return options.ledger.publishTerminalManifest({
    status: "blocked",
    stopReason: "infrastructure_failure",
    notRun: options.schedule.slice(notRunStart),
    completedAt: safeTimestamp(options.dependencies),
  });
}

export async function runQualificationBatch(
  options: {
    repositoryRoot: string;
    authorizationReference: string;
  },
  dependencies: QualificationCoordinatorDependencies,
): Promise<QualificationTerminalManifest> {
  const protocol = ACTIVE_QUALIFICATION_PROTOCOL;
  if (
    typeof options.repositoryRoot !== "string" ||
    options.repositoryRoot.length === 0 ||
    typeof options.authorizationReference !== "string" ||
    !AUTHORIZATION_REFERENCE_PATTERN.test(options.authorizationReference)
  ) {
    throw new QualificationCoordinatorError("arguments");
  }

  let batchId: string;
  try {
    batchId = dependencies.createBatchId();
    if (typeof batchId !== "string" || batchId.length === 0) {
      throw new Error("invalid batch id");
    }
  } catch {
    throw new QualificationCoordinatorError("arguments");
  }
  const authorizationHash = authorizationReferenceSha256(
    options.authorizationReference,
  );

  let lockHandle: QualificationLockHandle;
  try {
    lockHandle = await dependencies.acquireLock({
      repositoryRoot: options.repositoryRoot,
      batchId,
      authorizationReferenceSha256: authorizationHash,
      qualificationPlanId: protocol.qualificationPlanId,
    });
    if (
      lockHandle.owner.schemaVersion !== 2 ||
      lockHandle.owner.qualificationPlanId !== protocol.qualificationPlanId
    ) {
      throw new Error("qualification lock protocol mismatch");
    }
  } catch {
    throw new QualificationCoordinatorError("lock");
  }

  let result: QualificationTerminalManifest | null = null;
  let failure: QualificationCoordinatorError | null = null;
  let batchStarted = false;
  try {
    let preflight: CurrentFrozenPreflightRecord;
    try {
      preflight = await dependencies.runPreflight({
        repositoryRoot: options.repositoryRoot,
        authorizationReferenceSha256: authorizationHash,
        lockHandle,
        qualificationPlanId: protocol.qualificationPlanId,
      });
      if (
        preflight.schemaVersion !== 2 ||
        preflight.qualificationPlanId !== protocol.qualificationPlanId
      ) {
        throw new Error("qualification preflight protocol mismatch");
      }
    } catch {
      throw new QualificationCoordinatorError("preflight");
    }

    let ledger: QualificationLedger;
    try {
      await dependencies.assertLockOwner(lockHandle);
      await dependencies.assertFrozenCandidate({
        repositoryRoot: options.repositoryRoot,
        batchId,
        preflight,
        qualificationPlanId: protocol.qualificationPlanId,
      });
      ledger = dependencies.createLedger({
        repositoryRoot: options.repositoryRoot,
        batchId,
        qualificationPlanId: protocol.qualificationPlanId,
      });
      await ledger.publishBatchStarted({
        authorizationReferenceSha256: authorizationHash,
        preflight,
        recordedAt: safeTimestamp(dependencies),
      });
      batchStarted = true;
    } catch {
      throw new QualificationCoordinatorError("batch");
    }

    let terminalPublicationAttempted = false;
    for (let index = 0; index < protocol.schedule.length; index += 1) {
      const identity = protocol.schedule[index]!;
      let runningPublished = false;
      let postProcessInspectionAttempted = false;
      try {
        await assertBatchLockOwner(dependencies, lockHandle);
        await dependencies.assertFrozenCandidate({
          repositoryRoot: options.repositoryRoot,
          batchId,
          preflight,
          qualificationPlanId: protocol.qualificationPlanId,
        });
        assertZeroTargetProcesses(await dependencies.inspectTargetProcesses());
        await ledger.publishCaseRunning({
          ...identity,
          recordedAt: safeTimestamp(dependencies),
        });
        runningPublished = true;

        const run = normalizeRunResult(
          await dependencies.runCase({
            identity,
            qualificationContext: Object.freeze({
              qualificationPlanId: protocol.qualificationPlanId,
              batchId,
              ordinal: identity.ordinal,
              llm: identity.llm,
              task: identity.task,
              frozenCommit: preflight.repositoryCommit,
              frozenBuildIdentity: preflight.buildIdentitySha256,
              authorizationReferenceSha256: authorizationHash,
              orchestratorFallbackUsed: false,
            }),
            evidenceDirectory: path.join(ledger.batchDirectory, "cases"),
          }),
        );
        postProcessInspectionAttempted = true;
        assertZeroTargetProcesses(await dependencies.inspectTargetProcesses());
        await assertBatchLockOwner(dependencies, lockHandle);
        await dependencies.assertFrozenCandidate({
          repositoryRoot: options.repositoryRoot,
          batchId,
          preflight,
          qualificationPlanId: protocol.qualificationPlanId,
        });
        await ledger.publishCaseCompleted({
          ...identity,
          result: run.exitCode === 0 ? "passed" : "failed",
          evidencePath: run.evidencePath,
          recordedAt: safeTimestamp(dependencies),
        });
        runningPublished = false;

        if (run.exitCode === 1) {
          await assertBatchLockOwner(dependencies, lockHandle);
          terminalPublicationAttempted = true;
          result = await ledger.publishTerminalManifest({
            status: "blocked",
            stopReason: "case_failed",
            notRun: protocol.schedule.slice(index + 1),
            completedAt: safeTimestamp(dependencies),
          });
          break;
        }
      } catch (error) {
        if (error instanceof QualificationLockOwnershipLostError) {
          throw new QualificationCoordinatorError("batch");
        }
        if (terminalPublicationAttempted) {
          throw new QualificationCoordinatorError("batch");
        }
        if (runningPublished && !postProcessInspectionAttempted) {
          postProcessInspectionAttempted = true;
          try {
            assertZeroTargetProcesses(
              await dependencies.inspectTargetProcesses(),
            );
          } catch {
            // The terminal remains an infrastructure block; never retry the case.
          }
        }
        try {
          await assertBatchLockOwner(dependencies, lockHandle);
          terminalPublicationAttempted = true;
          result = await publishInfrastructureTerminal({
            ledger,
            currentIndex: index,
            runningPublished,
            dependencies,
            schedule: protocol.schedule,
          });
        } catch {
          throw new QualificationCoordinatorError("batch");
        }
        break;
      }
    }

    if (result === null) {
      try {
        await assertBatchLockOwner(dependencies, lockHandle);
        await dependencies.assertFrozenCandidate({
          repositoryRoot: options.repositoryRoot,
          batchId,
          preflight,
          qualificationPlanId: protocol.qualificationPlanId,
        });
        assertZeroTargetProcesses(await dependencies.inspectTargetProcesses());
      } catch (error) {
        if (error instanceof QualificationLockOwnershipLostError) {
          throw new QualificationCoordinatorError("batch");
        }
        try {
          await assertBatchLockOwner(dependencies, lockHandle);
          terminalPublicationAttempted = true;
          result = await ledger.publishTerminalManifest({
            status: "blocked",
            stopReason: "infrastructure_failure",
            notRun: [],
            completedAt: safeTimestamp(dependencies),
          });
        } catch {
          throw new QualificationCoordinatorError("batch");
        }
      }
    }

    if (result === null) {
      try {
        await assertBatchLockOwner(dependencies, lockHandle);
        terminalPublicationAttempted = true;
        result = await ledger.publishTerminalManifest({
          status: "passed",
          stopReason: null,
          notRun: [],
          completedAt: safeTimestamp(dependencies),
        });
      } catch {
        throw new QualificationCoordinatorError("batch");
      }
    }
  } catch (error) {
    failure =
      error instanceof QualificationCoordinatorError
        ? error
        : new QualificationCoordinatorError("batch");
  }

  if (failure !== null && batchStarted && result === null) {
    throw failure;
  }
  try {
    await dependencies.releaseLock(lockHandle);
  } catch {
    throw new QualificationCoordinatorError("release");
  }
  if (failure !== null) throw failure;
  if (result === null) throw new QualificationCoordinatorError("batch");
  return result;
}
