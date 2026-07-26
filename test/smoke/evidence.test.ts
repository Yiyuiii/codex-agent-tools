import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultSmokeEvidenceFileOperations,
  normalizeSmokeQualificationContext,
  publishImmutableJson,
  SmokeInfrastructureError,
  runSmokeEntrypoint,
} from "../../src/smoke/evidence.js";
import { parseArkSmokeArguments } from "../../src/smoke/ark.js";
import { parseKimiSmokeArguments } from "../../src/smoke/kimi.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-evidence-test-${process.pid}-${Date.now()}-${roots.length}`,
  );
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("immutable JSON publication", () => {
  it("publishes formatted JSON through an exclusive same-directory hard link", async () => {
    const root = await tempRoot();
    const destination = path.join(root, "ledger", "manifest.json");
    const calls: string[] = [];

    await publishImmutableJson(
      destination,
      { status: "passed", ordinal: 10 },
      {
        ...defaultSmokeEvidenceFileOperations,
        ensureDirectory: async (directory) => {
          calls.push(`mkdir:${directory}`);
          await defaultSmokeEvidenceFileOperations.ensureDirectory(directory);
        },
        writeExclusive: async (filePath, contents) => {
          calls.push(`write:${filePath}`);
          expect(path.dirname(filePath)).toBe(path.dirname(destination));
          expect(path.basename(filePath)).toMatch(
            /^\.manifest\.json\.[a-f0-9-]+\.tmp$/u,
          );
          expect(contents).toBe(
            '{\n  "status": "passed",\n  "ordinal": 10\n}\n',
          );
          await defaultSmokeEvidenceFileOperations.writeExclusive(
            filePath,
            contents,
          );
        },
        publishExclusive: async (source, target) => {
          calls.push(`link:${source}->${target}`);
          expect(path.dirname(source)).toBe(path.dirname(target));
          expect(target).toBe(destination);
          await defaultSmokeEvidenceFileOperations.publishExclusive(
            source,
            target,
          );
        },
        remove: async (filePath) => {
          calls.push(`remove:${filePath}`);
          await defaultSmokeEvidenceFileOperations.remove(filePath);
        },
      },
    );

    expect(await readFile(destination, "utf8")).toBe(
      '{\n  "status": "passed",\n  "ordinal": 10\n}\n',
    );
    expect(await readdir(path.dirname(destination))).toEqual([
      "manifest.json",
    ]);
    expect(calls.map((call) => call.split(":")[0])).toEqual([
      "mkdir",
      "write",
      "link",
      "remove",
    ]);
  });

  it("does not overwrite an existing destination", async () => {
    const root = await tempRoot();
    const destination = path.join(root, "manifest.json");
    const original = '{"owner":"first"}\n';
    await writeFile(destination, original, "utf8");

    await expect(
      publishImmutableJson(destination, { owner: "second" }),
    ).rejects.toThrow("Immutable JSON publication failed");

    expect(await readFile(destination, "utf8")).toBe(original);
    expect(await readdir(root)).toEqual(["manifest.json"]);
  });

  it("treats a successful hard link as committed when temporary cleanup fails", async () => {
    const root = await tempRoot();
    const destination = path.join(root, "manifest.json");

    await expect(
      publishImmutableJson(
        destination,
        { committed: true },
        {
          ...defaultSmokeEvidenceFileOperations,
          remove: async () => {
            throw new Error("SECRET_POST_COMMIT_CLEANUP_FAILURE");
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(await readFile(destination, "utf8")).toBe(
      '{\n  "committed": true\n}\n',
    );
  });

  it.each(["write", "publish"] as const)(
    "cleans the temporary file and sanitizes a %s failure",
    async (failureStage) => {
      const root = await tempRoot();
      const destination = path.join(
        root,
        "SECRET_DESTINATION_SENTINEL.json",
      );
      const removed: string[] = [];

      const publication = publishImmutableJson(
        destination,
        { secret: false },
        {
          ...defaultSmokeEvidenceFileOperations,
          writeExclusive: async (filePath, contents) => {
            await writeFile(filePath, contents.slice(0, 5), "utf8");
            if (failureStage === "write") {
              throw new Error(`write failed at ${destination}`);
            }
          },
          publishExclusive: async () => {
            if (failureStage === "publish") {
              throw new Error(`link failed at ${destination}`);
            }
          },
          remove: async (filePath) => {
            removed.push(filePath);
            await defaultSmokeEvidenceFileOperations.remove(filePath);
          },
        },
      );

      let failure: unknown;
      try {
        await publication;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "Immutable JSON publication failed",
      );
      expect(JSON.stringify(failure)).not.toContain(
        "SECRET_DESTINATION_SENTINEL",
      );
      expect(removed).toHaveLength(1);
      expect(await readdir(root)).toEqual([]);
    },
  );
});

describe("qualification evidence identity", () => {
  const validContext = {
    qualificationPlanId: "four-llm-v1" as const,
    batchId: "valid-batch",
    ordinal: 3,
    llm: "kimi-k3",
    task: "review" as const,
    frozenCommit: "a".repeat(40),
    frozenBuildIdentity: "b".repeat(64),
    authorizationReferenceSha256: "c".repeat(64),
    orchestratorFallbackUsed: false as const,
  };

  it("normalizes and freezes an exact active schedule identity", () => {
    const normalized = normalizeSmokeQualificationContext(validContext);

    expect(normalized).toEqual(validContext);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it.each([
    { ...validContext, qualificationPlanId: "five-llm-v1" },
    { ...validContext, qualificationPlanId: "unknown-plan" },
    { ...validContext, ordinal: 1 },
    { ...validContext, llm: "ark-coding-plan" },
    { ...validContext, task: "delegate" },
    { ...validContext, extra: "forbidden" },
  ])("rejects a context outside the active plan identity", (context) => {
    expect(() => normalizeSmokeQualificationContext(context)).toThrow(
      "Invalid smoke qualification context",
    );
  });
});

describe("real smoke evidence entrypoint", () => {
  it("writes sanitized Kimi infrastructure evidence after arguments parse", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    const secret = "SECRET_SENTINEL_DO_NOT_PERSIST";
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async (options) => {
        options.onProgress(secret);
        options.onProgress("kimi heartbeat 15000ms");
        throw new SmokeInfrastructureError(
          "version_probe",
          {},
          new Error(secret),
        );
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json",
    ]);
    const json = await readFile(
      path.join(
        evidenceDirectory,
        "2026-07-25T01-02-03.000Z-kimi-k3-review.json",
      ),
      "utf8",
    );
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: 2,
      qualification: null,
      llm: "kimi-k3",
      task: "review",
      runtime: "kimi-acp",
      route: "direct",
      adapterClientInvocationCount: null,
      adapterRetryCount: null,
      runtimeReportedAutoRetryCount: null,
      adapterReportedFallbackUsed: null,
      orchestratorFallbackUsed: null,
      executionTelemetrySource: null,
      passed: false,
      failureReason: "infrastructure_failure",
      failure: {
        category: "infrastructure",
        stage: "version_probe",
        count: 1,
      },
    });
    expect(json).not.toContain(secret);
    expect(stdout).not.toContain(secret);
    expect(stderr).toBe(
      "[kimi smoke] activity\n" +
        "[kimi smoke] heartbeat\n" +
        "Smoke failed; sanitized evidence was written.\n",
    );
    expect(stderr).not.toContain(secret);
  });

  it("copies a validated qualification context into infrastructure evidence", async () => {
    const root = await tempRoot();
    const qualificationContext = {
      qualificationPlanId: "four-llm-v1" as const,
      batchId: "2026-07-26T12-00-00Z-a1b2c3d4",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review" as const,
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false as const,
    };
    const evidenceDirectory = path.join(
      root,
      "evidence",
      "batches",
      qualificationContext.batchId,
      "cases",
    );
    let receivedContext: unknown;
    let stdout = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async (options) => {
        receivedContext = options.qualificationContext;
        throw new SmokeInfrastructureError("task_execution");
      },
      evidenceDirectory,
      reportedEvidenceDirectory:
        `docs/smoke/evidence/batches/${qualificationContext.batchId}/cases`,
      qualificationContext,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
    });

    expect(exitCode).toBe(1);
    expect(receivedContext).toEqual(qualificationContext);
    const fileName =
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json";
    const evidence = JSON.parse(
      await readFile(path.join(evidenceDirectory, fileName), "utf8"),
    ) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      schemaVersion: 3,
      qualification: qualificationContext,
      adapterClientInvocationCount: null,
      adapterRetryCount: null,
      runtimeReportedAutoRetryCount: null,
      adapterReportedFallbackUsed: null,
      orchestratorFallbackUsed: false,
      executionTelemetrySource: null,
    });
    expect(stdout).toContain(
      `docs/smoke/evidence/batches/${qualificationContext.batchId}/cases/${fileName}`,
    );
  });

  it("rejects accessor-backed qualification context without executing getters", async () => {
    const root = await tempRoot();
    let getterCalls = 0;
    let runnerCalls = 0;
    let stderr = "";
    const qualificationContext = {
      qualificationPlanId: "four-llm-v1",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review",
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false,
      get batchId() {
        getterCalls += 1;
        return getterCalls === 1 ? "valid-batch" : "../../outside";
      },
    };

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        runnerCalls += 1;
        throw new Error("must not run");
      },
      evidenceDirectory: path.join(root, "cases"),
      qualificationContext,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(getterCalls).toBe(0);
    expect(runnerCalls).toBe(0);
    expect(stderr).toBe("Smoke qualification context is invalid.\n");
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects proxy qualification context before invoking proxy traps", async () => {
    const root = await tempRoot();
    let trapCalls = 0;
    let runnerCalls = 0;
    const qualificationContext = new Proxy(
      {
        qualificationPlanId: "four-llm-v1",
        batchId: "valid-batch",
        ordinal: 3,
        llm: "kimi-k3",
        task: "review",
        frozenCommit: "a".repeat(40),
        frozenBuildIdentity: "b".repeat(64),
        authorizationReferenceSha256: "c".repeat(64),
        orchestratorFallbackUsed: false,
      },
      {
        getPrototypeOf: () => {
          trapCalls += 1;
          return Object.prototype;
        },
      },
    );

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        runnerCalls += 1;
        throw new Error("must not run");
      },
      evidenceDirectory: path.join(root, "cases"),
      qualificationContext,
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(exitCode).toBe(1);
    expect(trapCalls).toBe(0);
    expect(runnerCalls).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects symbol, non-enumerable, and extra qualification fields", async () => {
    const root = await tempRoot();
    const base = {
      qualificationPlanId: "four-llm-v1",
      batchId: "valid-batch",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review",
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false,
    };
    const symbolContext = { ...base, [Symbol("secret")]: "hidden" };
    const nonEnumerableContext = { ...base };
    Object.defineProperty(nonEnumerableContext, "hidden", {
      value: "secret",
      enumerable: false,
    });
    const extraContext = { ...base, extra: "forbidden" };

    for (const qualificationContext of [
      symbolContext,
      nonEnumerableContext,
      extraContext,
    ]) {
      let runnerCalls = 0;
      const exitCode = await runSmokeEntrypoint({
        kind: "kimi",
        args: ["--llm", "kimi-k3", "--task", "review"],
        parseArguments: parseKimiSmokeArguments,
        runSmoke: async () => {
          runnerCalls += 1;
          throw new Error("must not run");
        },
        evidenceDirectory: path.join(root, "cases"),
        qualificationContext,
        writeStdout: () => {},
        writeStderr: () => {},
      });
      expect(exitCode).toBe(1);
      expect(runnerCalls).toBe(0);
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps an authoritative frozen context when the runner attempts mutation then fails", async () => {
    const root = await tempRoot();
    const qualificationContext = {
      qualificationPlanId: "four-llm-v1" as const,
      batchId: "valid-batch",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review" as const,
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false as const,
    };
    const caseDirectory = path.join(
      root,
      "batches",
      qualificationContext.batchId,
      "cases",
    );
    const attemptedDirectories: string[] = [];

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async (options) => {
        expect(Object.isFrozen(options.qualificationContext)).toBe(true);
        Reflect.set(
          options.qualificationContext as object,
          "batchId",
          "../../outside",
        );
        throw new Error("runner failed after mutation attempt");
      },
      evidenceDirectory: caseDirectory,
      qualificationContext,
      fileOperations: {
        ...defaultSmokeEvidenceFileOperations,
        ensureDirectory: async (directory) => {
          attemptedDirectories.push(path.resolve(directory));
          throw new Error("stop before filesystem write");
        },
      },
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(exitCode).toBe(1);
    expect(attemptedDirectories).toEqual([path.resolve(caseDirectory)]);
    expect(qualificationContext.batchId).toBe("valid-batch");
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ["plain directory", ["wrong-cases"]],
    ["different batch id", ["batches", "different-batch", "cases"]],
  ] as const)(
    "rejects a qualification directory with %s",
    async (_label, directorySegments) => {
    const root = await tempRoot();
    const qualificationContext = {
      qualificationPlanId: "four-llm-v1" as const,
      batchId: "valid-batch",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review" as const,
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false as const,
    };
    let runnerCalls = 0;
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        runnerCalls += 1;
        throw new Error("must not run");
      },
      evidenceDirectory: path.join(root, ...directorySegments),
      qualificationContext,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(runnerCalls).toBe(0);
    expect(stderr).toBe("Smoke evidence destination is invalid.\n");
    expect(await readdir(root)).toEqual([]);
    },
  );

  it("snapshots runner evidence without executing qualification getters", async () => {
    const root = await tempRoot();
    const qualificationContext = {
      qualificationPlanId: "four-llm-v1" as const,
      batchId: "valid-batch",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review" as const,
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false as const,
    };
    let getterCalls = 0;
    const caseDirectory = path.join(
      root,
      "batches",
      qualificationContext.batchId,
      "cases",
    );

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () =>
        ({
          schemaVersion: 3,
          timestamp: "2026-07-25T01:02:03.000Z",
          passed: true,
          orchestratorFallbackUsed: false,
          get qualification() {
            getterCalls += 1;
            return getterCalls === 1 ? qualificationContext : null;
          },
        }) as never,
      evidenceDirectory: caseDirectory,
      qualificationContext,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(exitCode).toBe(1);
    expect(getterCalls).toBe(0);
    const files = await readdir(caseDirectory);
    expect(files).toEqual([
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json",
    ]);
    const evidence = JSON.parse(
      await readFile(path.join(caseDirectory, files[0]!), "utf8"),
    ) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      schemaVersion: 3,
      qualification: qualificationContext,
      passed: false,
      failureReason: "infrastructure_failure",
    });
  });

  it("rejects reserved runner evidence keys and reports only the authoritative path", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    let stdout = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () =>
        ({
          schemaVersion: 2,
          qualification: null,
          timestamp: "2026-07-25T01:02:03.000Z",
          passed: true,
          orchestratorFallbackUsed: null,
          evidence: "ATTACKER_CONTROLLED_PATH",
        }) as never,
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
    });

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.evidence).toBe(
      "docs/smoke/evidence/2026-07-25T01-02-03.000Z-kimi-k3-review.json",
    );
    expect(stdout).not.toContain("ATTACKER_CONTROLLED_PATH");
  });

  it("fails a batch closed when a runner returns legacy v1 evidence", async () => {
    const root = await tempRoot();
    const qualificationContext = {
      qualificationPlanId: "four-llm-v1" as const,
      batchId: "2026-07-26T12-00-00Z-a1b2c3d4",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review" as const,
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false as const,
    };
    const evidenceDirectory = path.join(
      root,
      "evidence",
      "batches",
      qualificationContext.batchId,
      "cases",
    );

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () =>
        ({
          schemaVersion: 1,
          timestamp: "2026-07-25T01:02:03.000Z",
          qualification: null,
          passed: true,
      }) as never,
      evidenceDirectory,
      qualificationContext,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(exitCode).toBe(1);
    const fileName =
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json";
    const evidence = JSON.parse(
      await readFile(
        path.join(
          evidenceDirectory,
          fileName,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      schemaVersion: 3,
      qualification: qualificationContext,
      passed: false,
      failureReason: "infrastructure_failure",
      adapterClientInvocationCount: null,
    });
  });

  it("rejects schema v2 runner evidence with non-null qualification", async () => {
    const root = await tempRoot();
    const qualificationContext = {
      qualificationPlanId: "four-llm-v1" as const,
      batchId: "valid-batch",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review" as const,
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false as const,
    };
    const evidenceDirectory = path.join(
      root,
      "batches",
      qualificationContext.batchId,
      "cases",
    );

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () =>
        ({
          schemaVersion: 2,
          timestamp: "2026-07-25T01:02:03.000Z",
          qualification: qualificationContext,
          passed: true,
          orchestratorFallbackUsed: false,
        }) as never,
      evidenceDirectory,
      qualificationContext,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(exitCode).toBe(1);
    const evidence = JSON.parse(
      await readFile(
        path.join(
          evidenceDirectory,
          "2026-07-25T01-02-03.000Z-kimi-k3-review.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      schemaVersion: 3,
      qualification: qualificationContext,
      passed: false,
      failureReason: "infrastructure_failure",
    });
  });

  it("rejects schema v3 runner evidence with null qualification", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () =>
        ({
          schemaVersion: 3,
          timestamp: "2026-07-25T01:02:03.000Z",
          qualification: null,
          passed: true,
          orchestratorFallbackUsed: null,
        }) as never,
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(exitCode).toBe(1);
    const evidence = JSON.parse(
      await readFile(
        path.join(
          evidenceDirectory,
          "2026-07-25T01-02-03.000Z-kimi-k3-review.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      qualification: null,
      passed: false,
      failureReason: "infrastructure_failure",
    });
  });

  it.each([
    {
      qualificationPlanId: "four-llm-v1",
      batchId: "../escape",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review",
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false as const,
    },
    {
      qualificationPlanId: "four-llm-v1",
      batchId: "valid-batch",
      ordinal: 0,
      llm: "kimi-k3",
      task: "review",
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false as const,
    },
    {
      qualificationPlanId: "four-llm-v1",
      batchId: "valid-batch",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review",
      frozenCommit: "not-a-commit",
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: false as const,
    },
    {
      qualificationPlanId: "four-llm-v1",
      batchId: "valid-batch",
      ordinal: 3,
      llm: "kimi-k3",
      task: "review",
      frozenCommit: "a".repeat(40),
      frozenBuildIdentity: "b".repeat(64),
      authorizationReferenceSha256: "c".repeat(64),
      orchestratorFallbackUsed: true as const,
    },
  ])("rejects invalid qualification context without running smoke", async (qualificationContext) => {
    const root = await tempRoot();
    let runnerCalls = 0;
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        runnerCalls += 1;
        throw new Error("must not run");
      },
      evidenceDirectory: path.join(root, "evidence"),
      qualificationContext,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(runnerCalls).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("Smoke qualification context is invalid.\n");
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    "/absolute/evidence",
    "../evidence",
    "docs/smoke/evidence/../outside",
  ])("rejects unsafe reported evidence directory %s", async (reportedEvidenceDirectory) => {
    const root = await tempRoot();
    let runnerCalls = 0;
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        runnerCalls += 1;
        throw new Error("must not run");
      },
      evidenceDirectory: path.join(root, "evidence"),
      reportedEvidenceDirectory,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(runnerCalls).toBe(0);
    expect(stderr).toBe("Smoke evidence destination is invalid.\n");
    expect(await readdir(root)).toEqual([]);
  });

  it("fails closed with a fixed message when evidence cannot be written", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "not-a-directory");
    await writeFile(evidenceDirectory, "occupied", "utf8");
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("SECRET_EVIDENCE_WRITE_SENTINEL");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
    expect(stderr).not.toContain("SECRET_EVIDENCE_WRITE_SENTINEL");
  });

  it("rejects a runner-controlled evidence filename that would escape the destination", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    let fileOperationCalls = 0;
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => ({
        schemaVersion: 2,
        qualification: null,
        timestamp: "../../../ESCAPE_SENTINEL",
        passed: false,
        orchestratorFallbackUsed: null,
      }),
      evidenceDirectory,
      fileOperations: {
        ...defaultSmokeEvidenceFileOperations,
        ensureDirectory: async () => {
          fileOperationCalls += 1;
          throw new Error("unsafe destination reached file operations");
        },
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
    expect(fileOperationCalls).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it("removes a partially written temporary file without reporting evidence", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    const secret = "PARTIAL_WRITE_SECRET_SENTINEL";
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("model failure");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      fileOperations: {
        ...defaultSmokeEvidenceFileOperations,
        writeExclusive: async (filePath, contents) => {
          await writeFile(filePath, contents.slice(0, 7), "utf8");
          throw new Error(secret);
        },
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([]);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
    expect(stderr).not.toContain(secret);
  });

  it("removes the temporary file when exclusive publication fails", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    const secret = "RENAME_SECRET_SENTINEL";
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "ark",
      args: ["--llm", "ark-agent-plan", "--task", "delegate"],
      parseArguments: parseArkSmokeArguments,
      runSmoke: async () => {
        throw new Error("model failure");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      fileOperations: {
        ...defaultSmokeEvidenceFileOperations,
        publishExclusive: async () => {
          throw new Error(secret);
        },
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([]);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
    expect(stderr).not.toContain(secret);
  });

  it("preserves a final file that appears during exclusive publication", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    const fileName =
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json";
    const finalPath = path.join(evidenceDirectory, fileName);
    const competingEvidence = '{"competitor":true}\n';
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("model failure");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      fileOperations: {
        ...defaultSmokeEvidenceFileOperations,
        publishExclusive: async (temporaryPath, destinationPath) => {
          await writeFile(
            destinationPath,
            competingEvidence,
            { encoding: "utf8", flag: "wx" },
          );
          await defaultSmokeEvidenceFileOperations.publishExclusive(
            temporaryPath,
            destinationPath,
          );
        },
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([fileName]);
    expect(await readFile(finalPath, "utf8")).toBe(competingEvidence);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
  });

  it("does not overwrite an existing final evidence file", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    await mkdir(evidenceDirectory, { recursive: true });
    const fileName =
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json";
    const finalPath = path.join(evidenceDirectory, fileName);
    const original = '{"existing":true}\n';
    await writeFile(finalPath, original, "utf8");
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("model failure");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([fileName]);
    expect(await readFile(finalPath, "utf8")).toBe(original);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
  });

  it("writes structured model or acceptance failures returned by the harness", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => ({
        schemaVersion: 2,
        qualification: null,
        timestamp: "2026-07-25T01:02:03.000Z",
        llm: "kimi-k3",
        task: "review",
        status: "failed",
        passed: false,
        orchestratorFallbackUsed: null,
        failureReason: "adapter_auth_or_model_unavailable",
        diagnosticCount: 1,
      }),
      evidenceDirectory,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    const fileName =
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json";
    const json = await readFile(
      path.join(evidenceDirectory, fileName),
      "utf8",
    );
    expect(JSON.parse(json)).toMatchObject({
      passed: false,
      failureReason: "adapter_auth_or_model_unavailable",
      diagnosticCount: 1,
    });
    expect(stdout).toContain(`docs/smoke/evidence/${fileName}`);
    expect(stderr).toBe("Smoke failed; sanitized evidence was written.\n");
  });

  it("does not echo a secret embedded in an argument parsing error", async () => {
    const root = await tempRoot();
    const secret = "ARGUMENT_SECRET_SENTINEL";
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--secret", secret],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("not reached");
      },
      evidenceDirectory: path.join(root, "evidence"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Smoke arguments are invalid.\n");
    expect(stderr).not.toContain(secret);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    {
      kind: "ark" as const,
      llm: "ark-agent-plan",
      parseArguments: parseArkSmokeArguments,
      expectedFile:
        "2026-07-25T01-02-03.000Z-ark-agent-plan-delegate-ark.json",
    },
  ])(
    "sanitizes $kind failures and preserves the active evidence suffix",
    async ({ kind, llm, parseArguments, expectedFile }) => {
      const root = await tempRoot();
      const evidenceDirectory = path.join(root, "evidence");
      const secret = `${kind.toUpperCase()}_SECRET_SENTINEL`;
      let stdout = "";
      let stderr = "";

      const exitCode = await runSmokeEntrypoint({
        kind,
        args: ["--llm", llm, "--task", "delegate"],
        parseArguments,
        runSmoke: async () => {
          throw new SmokeInfrastructureError(
            "post_process_snapshot",
            { processIdsBefore: 2 },
            new Error(secret),
          );
        },
        evidenceDirectory,
        now: () => new Date("2026-07-25T01:02:03.000Z"),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });

      expect(exitCode).toBe(1);
      expect(await readdir(evidenceDirectory)).toEqual([expectedFile]);
      const json = await readFile(
        path.join(evidenceDirectory, expectedFile),
        "utf8",
      );
      expect(JSON.parse(json)).toMatchObject({
        llm,
        task: "delegate",
        passed: false,
        failureReason: "infrastructure_failure",
        failure: {
          category: "infrastructure",
          stage: "post_process_snapshot",
          count: 1,
        },
        counts: { processIdsBefore: 2 },
        checks: {
          postProcessSnapshot: "unknown",
          processCleanup: "unknown",
        },
      });
      expect(json).not.toContain(secret);
      expect(stdout).not.toContain(secret);
      expect(stderr).toBe(
        "Smoke failed; sanitized evidence was written.\n",
      );
      expect(stderr).not.toContain(secret);
    },
  );
});
