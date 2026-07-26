import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  QualificationCoordinatorError,
  runQualificationBatch,
  type QualificationCoordinatorDependencies,
} from "../../src/qualification/coordinator.js";
import {
  ACTIVE_QUALIFICATION_CASES,
  ACTIVE_QUALIFICATION_PLAN_ID,
} from "../../src/qualification/protocol.js";
import type {
  FrozenPreflightRecord,
  QualificationCaseIdentity,
  QualificationLockHandle,
  QualificationTerminalManifest,
} from "../../src/qualification/types.js";

const AUTHORIZATION_REFERENCE = "6ce61ce4-02ed-4e95-9813-f30e74ce9af5";
const AUTHORIZATION_HASH = createHash("sha256")
  .update(AUTHORIZATION_REFERENCE)
  .digest("hex");
const BATCH_ID = "2026-07-26T12-00-00Z-a1b2c3d4";
const COMMIT = "a".repeat(40);
const BUILD_IDENTITY = "b".repeat(64);

const zeroProcesses = Object.freeze({
  kimi: Object.freeze({ count: 0 }),
  piRpc: Object.freeze({ count: 0 }),
  realSmoke: Object.freeze({ count: 0 }),
});

const preflight = Object.freeze({
  schemaVersion: 2,
  qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
  repositoryCommit: COMMIT,
  repositoryBranch: "codex/ark-cutover",
  repositoryDirty: false,
  packageVersion: "0.1.0-alpha.1",
  packageLockSha256: "c".repeat(64),
  buildArtifacts: Object.freeze([
    Object.freeze({ path: "dist/ark-smoke.js", sha256: "d".repeat(64) }),
    Object.freeze({ path: "dist/kimi-smoke.js", sha256: "e".repeat(64) }),
    Object.freeze({ path: "dist/smoke-evidence.js", sha256: "1".repeat(64) }),
    Object.freeze({
      path: "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
      sha256: "2".repeat(64),
    }),
  ]),
  buildIdentitySha256: BUILD_IDENTITY,
  runtimeVersions: Object.freeze({
    node: "v24.0.0",
    codex: "codex 1.2.3",
    kimi: "kimi 4.5.6",
    pi: "pi 7.8.9",
  }),
  piConfigSha256: "3".repeat(64),
  logicalLlms: Object.freeze([
    Object.freeze({
      llm: "ark-agent-deepseek-v4-flash",
      runtime: "pi-rpc" as const,
      model: "deepseek-v4-flash",
      provider: "ark-agent-plan",
      route: "direct" as const,
    }),
    Object.freeze({
      llm: "ark-agent-plan",
      runtime: "pi-rpc" as const,
      model: "ark-code-latest",
      provider: "ark-agent-plan",
      route: "direct" as const,
    }),
    Object.freeze({
      llm: "ark-coding-plan",
      runtime: "pi-rpc" as const,
      model: "ark-code-latest",
      provider: "ark-coding-plan",
      route: "direct" as const,
    }),
    Object.freeze({
      llm: "kimi-k3",
      runtime: "kimi-acp" as const,
      model: "kimi-code/k3",
      provider: null,
      route: "direct" as const,
    }),
  ]),
  credentialMatches: Object.freeze([
    Object.freeze({
      llm: "ark-agent-deepseek-v4-flash",
      environmentVariableName: "OPENAI_API_KEY_DOUBAO",
    }),
    Object.freeze({
      llm: "ark-agent-plan",
      environmentVariableName: "OPENAI_API_KEY_DOUBAO",
    }),
    Object.freeze({
      llm: "ark-coding-plan",
      environmentVariableName: "ARK_API_KEY",
    }),
    Object.freeze({
      llm: "kimi-k3",
      environmentVariableName: null,
    }),
  ]),
  targetProcesses: zeroProcesses,
}) satisfies FrozenPreflightRecord;

const lockHandle = Object.freeze({
  lockDirectory: "X:/temp/codex-agent-tools-qualification/repository",
  owner: Object.freeze({
    schemaVersion: 2 as const,
    qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
    repositoryRealpathSha256: "4".repeat(64),
    processId: 1234,
    processStartTime: "2026-07-26T11:59:00.000Z",
    nonce: "owner-nonce",
    batchId: BATCH_ID,
    authorizationReferenceSha256: AUTHORIZATION_HASH,
    acquiredAt: "2026-07-26T12:00:00.000Z",
  }),
}) satisfies QualificationLockHandle;

function terminal(status: "passed" | "blocked"): QualificationTerminalManifest {
  return {
    schemaVersion: 2,
    qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
    batchId: BATCH_ID,
    status,
    authorizationReferenceSha256: AUTHORIZATION_HASH,
    repositoryCommit: COMMIT,
    buildIdentitySha256: BUILD_IDENTITY,
    preflightSha256: "5".repeat(64),
    preflight,
    cases: [],
    uncommittedEvidence: null,
    checkpoints: [],
    stopReason: status === "passed" ? null : "case_failed",
    notRun: [],
    promotionEligible: status === "passed",
    completedAt: "2026-07-26T12:00:30.000Z",
  };
}

function makeDependencies(options?: {
  failOrdinal?: number;
  throwOrdinal?: number;
  preflightError?: Error;
  releaseError?: Error;
  terminalError?: Error;
  batchStartedError?: Error;
  runningErrorOrdinal?: number;
  completedErrorOrdinal?: number;
  ownerFailureFromCall?: number;
}) {
  const events: string[] = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  let ownerChecks = 0;
  const publishCaseRunning = vi.fn(
    async (input: QualificationCaseIdentity & { recordedAt: string }) => {
      if (options?.runningErrorOrdinal === input.ordinal) {
        throw new Error("running checkpoint failure");
      }
      events.push(`running:${input.ordinal}`);
    },
  );
  const publishCaseCompleted = vi.fn(
    async (
      input: QualificationCaseIdentity & {
        result: "passed" | "failed";
        evidencePath: string;
        recordedAt: string;
      },
    ) => {
      if (options?.completedErrorOrdinal === input.ordinal) {
        throw new Error("completion checkpoint failure");
      }
      events.push(`completed:${input.ordinal}:${input.result}`);
    },
  );
  const publishTerminalManifest = vi.fn(
    async (input: {
      status: "passed" | "blocked" | "interrupted";
      stopReason:
        "case_failed" | "infrastructure_failure" | "process_interrupted" | null;
      notRun: readonly QualificationCaseIdentity[];
      completedAt: string;
    }) => {
      events.push(`terminal:${input.status}:${input.stopReason ?? "none"}`);
      if (options?.terminalError !== undefined) throw options.terminalError;
      return terminal(input.status === "passed" ? "passed" : "blocked");
    },
  );
  const dependencies: QualificationCoordinatorDependencies = {
    createBatchId: () => BATCH_ID,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    acquireLock: vi.fn(async () => {
      events.push("acquire");
      return lockHandle;
    }),
    releaseLock: vi.fn(async () => {
      events.push("release");
      if (options?.releaseError !== undefined) throw options.releaseError;
    }),
    runPreflight: vi.fn(async () => {
      events.push("preflight");
      if (options?.preflightError !== undefined) throw options.preflightError;
      return preflight;
    }),
    createLedger: vi.fn(() => ({
      batchDirectory: `D:/repo/docs/smoke/evidence/batches/${BATCH_ID}`,
      publishBatchStarted: vi.fn(async () => {
        if (options?.batchStartedError !== undefined) {
          throw options.batchStartedError;
        }
        events.push("batch_started");
      }),
      publishCaseRunning,
      publishCaseCompleted,
      publishTerminalManifest,
    })),
    assertLockOwner: vi.fn(async () => {
      events.push("assert_owner");
      ownerChecks += 1;
      if (
        options?.ownerFailureFromCall !== undefined &&
        ownerChecks >= options.ownerFailureFromCall
      ) {
        throw new Error("lock ownership lost");
      }
    }),
    assertFrozenCandidate: vi.fn(async () => {
      events.push("assert_candidate");
    }),
    inspectTargetProcesses: vi.fn(async () => {
      events.push("inspect_processes");
      return zeroProcesses;
    }),
    runCase: vi.fn(async ({ identity }) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      events.push(`run:${identity.ordinal}`);
      try {
        if (options?.throwOrdinal === identity.ordinal) {
          throw new Error("secret infrastructure details");
        }
        return {
          exitCode: (options?.failOrdinal === identity.ordinal ? 1 : 0) as
            0 | 1,
          evidencePath: `docs/smoke/evidence/batches/${BATCH_ID}/cases/case-${identity.ordinal}.json`,
        };
      } finally {
        inFlight -= 1;
      }
    }),
  };
  return {
    dependencies,
    events,
    maximumInFlight: () => maximumInFlight,
    publishCaseRunning,
    publishCaseCompleted,
    publishTerminalManifest,
  };
}

describe("qualification coordinator", () => {
  it("runs the active eight-case schedule strictly serially and publishes one current passed terminal", async () => {
    const fixture = makeDependencies();

    const result = await runQualificationBatch(
      {
        repositoryRoot: "D:/repo",
        authorizationReference: AUTHORIZATION_REFERENCE,
      },
      fixture.dependencies,
    );

    expect(result).toMatchObject({
      schemaVersion: 2,
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
      status: "passed",
      promotionEligible: true,
    });
    expect(fixture.maximumInFlight()).toBe(1);
    expect(
      vi
        .mocked(fixture.dependencies.runCase)
        .mock.calls.map(([input]) => input.identity),
    ).toEqual(ACTIVE_QUALIFICATION_CASES);
    expect(fixture.events.slice(0, 5)).toEqual([
      "acquire",
      "preflight",
      "assert_owner",
      "assert_candidate",
      "batch_started",
    ]);
    for (const identity of ACTIVE_QUALIFICATION_CASES) {
      const running = fixture.events.indexOf(`running:${identity.ordinal}`);
      const run = fixture.events.indexOf(`run:${identity.ordinal}`);
      const completed = fixture.events.indexOf(
        `completed:${identity.ordinal}:passed`,
      );
      expect(running).toBeGreaterThan(-1);
      expect(run).toBeGreaterThan(running);
      expect(completed).toBeGreaterThan(run);
    }
    expect(fixture.events.at(-2)).toBe("terminal:passed:none");
    expect(fixture.events.at(-1)).toBe("release");
    expect(fixture.publishTerminalManifest).toHaveBeenCalledTimes(1);
    expect(fixture.publishTerminalManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "passed",
        stopReason: null,
        notRun: [],
      }),
    );
  });

  it.each([1, 4])(
    "stops after failed case %s and never calls a later case",
    async (failOrdinal) => {
      const fixture = makeDependencies({ failOrdinal });

      const result = await runQualificationBatch(
        {
          repositoryRoot: "D:/repo",
          authorizationReference: AUTHORIZATION_REFERENCE,
        },
        fixture.dependencies,
      );

      expect(result.status).toBe("blocked");
      expect(vi.mocked(fixture.dependencies.runCase)).toHaveBeenCalledTimes(
        failOrdinal,
      );
      expect(fixture.publishTerminalManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "blocked",
          stopReason: "case_failed",
          notRun: ACTIVE_QUALIFICATION_CASES.slice(failOrdinal),
        }),
      );
      expect(fixture.events.at(-1)).toBe("release");
    },
  );

  it("releases its own lock without starting a ledger when preflight fails", async () => {
    const fixture = makeDependencies({
      preflightError: new Error("sensitive command output"),
    });

    await expect(
      runQualificationBatch(
        {
          repositoryRoot: "D:/repo",
          authorizationReference: AUTHORIZATION_REFERENCE,
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({
      name: "QualificationCoordinatorError",
      category: "infrastructure",
      stage: "preflight",
      count: 1,
      message: "Qualification coordination failed",
    });

    expect(fixture.events).toEqual(["acquire", "preflight", "release"]);
    expect(fixture.dependencies.createLedger).not.toHaveBeenCalled();
  });

  it("publishes a sanitized blocked terminal after a controlled case exception", async () => {
    const fixture = makeDependencies({ throwOrdinal: 4 });

    const result = await runQualificationBatch(
      {
        repositoryRoot: "D:/repo",
        authorizationReference: AUTHORIZATION_REFERENCE,
      },
      fixture.dependencies,
    );

    expect(result.status).toBe("blocked");
    expect(fixture.publishCaseCompleted).toHaveBeenCalledTimes(3);
    expect(fixture.dependencies.inspectTargetProcesses).toHaveBeenCalledTimes(
      8,
    );
    expect(fixture.publishTerminalManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        stopReason: "infrastructure_failure",
        notRun: ACTIVE_QUALIFICATION_CASES.slice(4),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(fixture.events.at(-1)).toBe("release");
  });

  it("checks owner, frozen candidate, and zero target processes around every case and rechecks ownership before terminal promotion", async () => {
    const fixture = makeDependencies();

    await runQualificationBatch(
      {
        repositoryRoot: "D:/repo",
        authorizationReference: AUTHORIZATION_REFERENCE,
      },
      fixture.dependencies,
    );

    expect(fixture.dependencies.assertLockOwner).toHaveBeenCalledTimes(19);
    expect(fixture.dependencies.assertFrozenCandidate).toHaveBeenCalledTimes(
      18,
    );
    expect(fixture.dependencies.inspectTargetProcesses).toHaveBeenCalledTimes(
      17,
    );
    for (const identity of ACTIVE_QUALIFICATION_CASES) {
      const run = fixture.events.indexOf(`run:${identity.ordinal}`);
      expect(fixture.events.slice(Math.max(0, run - 4), run)).toEqual([
        "assert_owner",
        "assert_candidate",
        "inspect_processes",
        `running:${identity.ordinal}`,
      ]);
      expect(fixture.events[run + 1]).toBe("inspect_processes");
      expect(fixture.events[run + 2]).toBe("assert_owner");
      expect(fixture.events[run + 3]).toBe("assert_candidate");
    }
  });

  it("blocks instead of promoting when the frozen candidate drifts during the final case", async () => {
    const fixture = makeDependencies();
    let candidateChecks = 0;
    vi.mocked(fixture.dependencies.assertFrozenCandidate).mockImplementation(
      async () => {
        candidateChecks += 1;
        if (candidateChecks === 17) {
          throw new Error("final-case build drift");
        }
      },
    );

    const result = await runQualificationBatch(
      {
        repositoryRoot: "D:/repo",
        authorizationReference: AUTHORIZATION_REFERENCE,
      },
      fixture.dependencies,
    );

    expect(result.status).toBe("blocked");
    expect(fixture.dependencies.runCase).toHaveBeenCalledTimes(8);
    expect(fixture.publishCaseCompleted).toHaveBeenCalledTimes(7);
    expect(fixture.publishTerminalManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        stopReason: "infrastructure_failure",
        notRun: [],
      }),
    );
  });

  it("fails closed when a target process count is nonzero", async () => {
    const fixture = makeDependencies();
    vi.mocked(fixture.dependencies.inspectTargetProcesses)
      .mockResolvedValueOnce(zeroProcesses)
      .mockResolvedValueOnce({
        ...zeroProcesses,
        piRpc: { count: 1 },
      });

    const result = await runQualificationBatch(
      {
        repositoryRoot: "D:/repo",
        authorizationReference: AUTHORIZATION_REFERENCE,
      },
      fixture.dependencies,
    );

    expect(result.status).toBe("blocked");
    expect(fixture.publishCaseCompleted).not.toHaveBeenCalled();
    expect(fixture.publishTerminalManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        stopReason: "infrastructure_failure",
        notRun: ACTIVE_QUALIFICATION_CASES.slice(1),
      }),
    );
  });

  it("does not publish a second terminal when release fails after the first terminal", async () => {
    const fixture = makeDependencies({
      releaseError: new Error("release failure"),
    });

    await expect(
      runQualificationBatch(
        {
          repositoryRoot: "D:/repo",
          authorizationReference: AUTHORIZATION_REFERENCE,
        },
        fixture.dependencies,
      ),
    ).rejects.toBeInstanceOf(QualificationCoordinatorError);

    expect(fixture.publishTerminalManifest).toHaveBeenCalledTimes(1);
    expect(fixture.events.at(-2)).toBe("terminal:passed:none");
    expect(fixture.events.at(-1)).toBe("release");
  });

  it.each([
    ["before a case", 2, 0],
    ["after a case", 3, 1],
    ["during the final promotion check", 18, 8],
  ])(
    "leaves recovery ownership intact when lock ownership is lost %s",
    async (_label, ownerFailureFromCall, expectedRuns) => {
      const fixture = makeDependencies({ ownerFailureFromCall });

      await expect(
        runQualificationBatch(
          {
            repositoryRoot: "D:/repo",
            authorizationReference: AUTHORIZATION_REFERENCE,
          },
          fixture.dependencies,
        ),
      ).rejects.toMatchObject({
        name: "QualificationCoordinatorError",
        stage: "batch",
      });

      expect(fixture.dependencies.runCase).toHaveBeenCalledTimes(expectedRuns);
      expect(fixture.publishTerminalManifest).not.toHaveBeenCalled();
      expect(fixture.dependencies.releaseLock).not.toHaveBeenCalled();
    },
  );

  it("never retries terminal publication when its commit outcome is uncertain", async () => {
    const fixture = makeDependencies({
      failOrdinal: 1,
      terminalError: new Error("uncertain terminal publication"),
    });

    await expect(
      runQualificationBatch(
        {
          repositoryRoot: "D:/repo",
          authorizationReference: AUTHORIZATION_REFERENCE,
        },
        fixture.dependencies,
      ),
    ).rejects.toBeInstanceOf(QualificationCoordinatorError);

    expect(fixture.publishTerminalManifest).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.releaseLock).not.toHaveBeenCalled();
    expect(fixture.events.at(-1)).toBe("terminal:blocked:case_failed");
  });

  it("releases without attempting a terminal when batch_started cannot be committed", async () => {
    const fixture = makeDependencies({
      batchStartedError: new Error("batch start failure"),
    });

    await expect(
      runQualificationBatch(
        {
          repositoryRoot: "D:/repo",
          authorizationReference: AUTHORIZATION_REFERENCE,
        },
        fixture.dependencies,
      ),
    ).rejects.toBeInstanceOf(QualificationCoordinatorError);

    expect(fixture.dependencies.runCase).not.toHaveBeenCalled();
    expect(fixture.publishTerminalManifest).not.toHaveBeenCalled();
    expect(fixture.events.at(-1)).toBe("release");
  });

  it("does not run a case when its running checkpoint fails and publishes one blocked terminal", async () => {
    const fixture = makeDependencies({ runningErrorOrdinal: 1 });

    const result = await runQualificationBatch(
      {
        repositoryRoot: "D:/repo",
        authorizationReference: AUTHORIZATION_REFERENCE,
      },
      fixture.dependencies,
    );

    expect(result.status).toBe("blocked");
    expect(fixture.dependencies.runCase).not.toHaveBeenCalled();
    expect(fixture.publishTerminalManifest).toHaveBeenCalledTimes(1);
    expect(fixture.publishTerminalManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        stopReason: "infrastructure_failure",
        notRun: ACTIVE_QUALIFICATION_CASES,
      }),
    );
  });

  it("stops after evidence when completion checkpoint publication fails", async () => {
    const fixture = makeDependencies({ completedErrorOrdinal: 1 });

    const result = await runQualificationBatch(
      {
        repositoryRoot: "D:/repo",
        authorizationReference: AUTHORIZATION_REFERENCE,
      },
      fixture.dependencies,
    );

    expect(result.status).toBe("blocked");
    expect(fixture.dependencies.runCase).toHaveBeenCalledTimes(1);
    expect(fixture.publishCaseCompleted).toHaveBeenCalledTimes(1);
    expect(fixture.publishTerminalManifest).toHaveBeenCalledTimes(1);
    expect(fixture.publishTerminalManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        stopReason: "infrastructure_failure",
        notRun: ACTIVE_QUALIFICATION_CASES.slice(1),
      }),
    );
  });

  it("rejects malformed authorization before acquiring a lock", async () => {
    const fixture = makeDependencies();

    await expect(
      runQualificationBatch(
        {
          repositoryRoot: "D:/repo",
          authorizationReference: "not-a-uuid",
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({
      stage: "arguments",
    });

    expect(fixture.dependencies.acquireLock).not.toHaveBeenCalled();
  });

  it("normalizes UUID case before hashing so spelling variants cannot reuse authorization", async () => {
    const fixture = makeDependencies();

    await runQualificationBatch(
      {
        repositoryRoot: "D:/repo",
        authorizationReference: AUTHORIZATION_REFERENCE.toUpperCase(),
      },
      fixture.dependencies,
    );

    expect(fixture.dependencies.acquireLock).toHaveBeenCalledWith({
      repositoryRoot: "D:/repo",
      batchId: BATCH_ID,
      authorizationReferenceSha256: AUTHORIZATION_HASH,
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
    });
  });

  it("binds every current batch dependency and smoke context to four-llm-v1", async () => {
    const fixture = makeDependencies();

    await runQualificationBatch(
      {
        repositoryRoot: "D:/repo",
        authorizationReference: AUTHORIZATION_REFERENCE,
      },
      fixture.dependencies,
    );

    expect(fixture.dependencies.acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
      }),
    );
    expect(fixture.dependencies.runPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
      }),
    );
    expect(fixture.dependencies.createLedger).toHaveBeenCalledWith({
      repositoryRoot: "D:/repo",
      batchId: BATCH_ID,
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
    });
    for (const [input] of vi.mocked(fixture.dependencies.runCase).mock.calls) {
      expect(input.qualificationContext).toEqual({
        qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
        batchId: BATCH_ID,
        ordinal: input.identity.ordinal,
        llm: input.identity.llm,
        task: input.identity.task,
        frozenCommit: COMMIT,
        frozenBuildIdentity: BUILD_IDENTITY,
        authorizationReferenceSha256: AUTHORIZATION_HASH,
        orchestratorFallbackUsed: false,
      });
    }
    for (const [input] of vi.mocked(fixture.dependencies.assertFrozenCandidate)
      .mock.calls) {
      expect(input.qualificationPlanId).toBe(ACTIVE_QUALIFICATION_PLAN_ID);
    }
  });
});
