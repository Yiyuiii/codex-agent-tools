import { createHash } from "node:crypto";
import {
  mkdir,
  rename,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import { resolveLlm } from "../../src/llms/registry.js";
import {
  assertAuthorizationReferenceUnused,
  createQualificationLedger,
  freezePreflightRecord,
  hashFrozenPreflightRecord,
  inspectQualificationTerminal,
  QualificationLedgerError,
  recoverInterruptedQualificationBatch,
} from "../../src/qualification/manifest.js";
import {
  acquireQualificationLock,
  recoverQualificationLock,
} from "../../src/qualification/lock.js";
import { publishImmutableJson } from "../../src/smoke/evidence.js";
import type {
  CurrentFrozenPreflightRecord,
  FrozenPreflightRecord,
  LegacyFrozenPreflightRecord,
  QualificationCaseIdentity,
} from "../../src/qualification/types.js";

const roots: string[] = [];
const batchId = "batch-2026-07-26";
const historicalBatchId =
  "2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f";
const historicalBatchFiles = [
  "cases/2026-07-26T09-01-07.689Z-gemini-3.5-flash-delegate-pi.json",
  "checkpoints/000000.json",
  "checkpoints/000001.json",
  "checkpoints/000002.json",
  "manifest.json",
] as const;
const authHash = "a".repeat(64);
const commit = "b".repeat(40);
const artifacts = [
  "dist/ark-smoke.js",
  "dist/kimi-smoke.js",
  "dist/pi-smoke.js",
  "dist/smoke-evidence.js",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
].map((artifactPath, index) => ({
  path: artifactPath,
  sha256: String(index + 1).repeat(64),
}));
const buildHash = createHash("sha256")
  .update(JSON.stringify(artifacts))
  .digest("hex");

type DeepReadonly<T> = {
  readonly [Key in keyof T]: T[Key] extends object
    ? DeepReadonly<T[Key]>
    : T[Key];
};

type TypeEqual<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? (<Value>() => Value extends Right ? 1 : 2) extends <
      Value,
    >() => Value extends Left ? 1 : 2
    ? true
    : false
  : false;

async function tempRepository(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-manifest-test-${process.pid}-${Date.now()}-${roots.length}`,
  );
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}

async function copyHistoricalBatch(repositoryRoot: string): Promise<void> {
  const source = path.join(
    process.cwd(),
    "docs",
    "smoke",
    "evidence",
    "batches",
    historicalBatchId,
  );
  const destination = path.join(
    repositoryRoot,
    "docs",
    "smoke",
    "evidence",
    "batches",
    historicalBatchId,
  );
  for (const relativePath of historicalBatchFiles) {
    const target = path.join(destination, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const text = await readFile(
      path.join(source, ...relativePath.split("/")),
      "utf8",
    );
    await writeFile(target, text.replaceAll("\r\n", "\n"), "utf8");
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function preflight(): FrozenPreflightRecord {
  return freezePreflightRecord({
    schemaVersion: 1,
    repositoryCommit: commit,
    repositoryBranch: "codex/ark-cutover",
    repositoryDirty: false,
    packageVersion: "0.1.0-alpha.1",
    packageLockSha256: "d".repeat(64),
    buildArtifacts: artifacts,
    buildIdentitySha256: buildHash,
    runtimeVersions: {
      node: "v24.0.0",
      codex: "codex-cli 0.135.0",
      kimi: "0.27.0",
      pi: "0.80.10",
    },
    piConfigSha256: "e".repeat(64),
    logicalLlms: [
      {
        llm: "ark-agent-deepseek-v4-flash",
        runtime: "pi-rpc",
        model: "deepseek-v4-flash",
        provider: "ark-agent-plan",
        route: "direct",
      },
      {
        llm: "ark-agent-plan",
        runtime: "pi-rpc",
        model: "ark-code-latest",
        provider: "ark-agent-plan",
        route: "direct",
      },
      {
        llm: "ark-coding-plan",
        runtime: "pi-rpc",
        model: "ark-code-latest",
        provider: "ark-coding-plan",
        route: "direct",
      },
      {
        llm: "gemini-3.5-flash",
        runtime: "pi-rpc",
        model: "gemini-3.5-flash",
        provider: "google",
        route: "proxy-10808",
      },
      {
        llm: "kimi-k3",
        runtime: "kimi-acp",
        model: "kimi-code/k3",
        provider: null,
        route: "direct",
      },
    ],
    credentialMatches: [
      {
        llm: "ark-agent-deepseek-v4-flash",
        environmentVariableName: "OPENAI_API_KEY_DOUBAO",
      },
      {
        llm: "ark-agent-plan",
        environmentVariableName: "OPENAI_API_KEY_DOUBAO",
      },
      {
        llm: "ark-coding-plan",
        environmentVariableName: "API_KEY_DOUBAO_CODING",
      },
      {
        llm: "gemini-3.5-flash",
        environmentVariableName: "GEMINI_API_KEY",
      },
      { llm: "kimi-k3", environmentVariableName: null },
    ],
    proxy10808: {
      host: "127.0.0.1",
      port: 10808,
      listening: true,
    },
    targetProcesses: {
      kimi: { count: 0 },
      piRpc: { count: 0 },
      realSmoke: { count: 0 },
    },
  });
}

function currentPreflightRecord() {
  const legacy = preflight();
  const buildArtifacts = legacy.buildArtifacts.filter(
    ({ path: artifactPath }) => artifactPath !== "dist/pi-smoke.js",
  );
  return {
    schemaVersion: 2,
    qualificationPlanId: "four-llm-v1",
    repositoryCommit: legacy.repositoryCommit,
    repositoryBranch: legacy.repositoryBranch,
    repositoryDirty: legacy.repositoryDirty,
    packageVersion: legacy.packageVersion,
    packageLockSha256: legacy.packageLockSha256,
    buildArtifacts,
    buildIdentitySha256: createHash("sha256")
      .update(JSON.stringify(buildArtifacts))
      .digest("hex"),
    runtimeVersions: legacy.runtimeVersions,
    piConfigSha256: legacy.piConfigSha256,
    logicalLlms: legacy.logicalLlms.filter(
      ({ llm }) => llm !== "gemini-3.5-flash",
    ),
    credentialMatches: legacy.credentialMatches.filter(
      ({ llm }) => llm !== "gemini-3.5-flash",
    ),
    targetProcesses: legacy.targetProcesses,
  };
}

function sparseCopy(values: readonly unknown[]): unknown[] {
  const sparse = new Array<unknown>(values.length);
  values.forEach((value, index) => {
    if (index !== 1) sparse[index] = value;
  });
  return sparse;
}

function cases(): QualificationCaseIdentity[] {
  return [
    { ordinal: 1, llm: "gemini-3.5-flash", task: "delegate" },
    { ordinal: 2, llm: "gemini-3.5-flash", task: "review" },
    { ordinal: 3, llm: "ark-coding-plan", task: "delegate" },
    { ordinal: 4, llm: "ark-coding-plan", task: "review" },
    { ordinal: 5, llm: "kimi-k3", task: "review" },
    { ordinal: 6, llm: "kimi-k3", task: "delegate" },
    { ordinal: 7, llm: "ark-agent-plan", task: "review" },
    { ordinal: 8, llm: "ark-agent-plan", task: "delegate" },
    {
      ordinal: 9,
      llm: "ark-agent-deepseek-v4-flash",
      task: "review",
    },
    {
      ordinal: 10,
      llm: "ark-agent-deepseek-v4-flash",
      task: "delegate",
    },
  ];
}

async function publishEvidence(
  repository: string,
  identity: QualificationCaseIdentity,
  passed = true,
): Promise<string> {
  const casesDirectory = path.join(
    repository,
    "docs",
    "smoke",
    "evidence",
    "batches",
    batchId,
    "cases",
  );
  await mkdir(casesDirectory, { recursive: true });
  const evidencePath = path.join(
    casesDirectory,
    `${String(identity.ordinal).padStart(2, "0")}.json`,
  );
  const identityRecord = preflight().logicalLlms.find(
    (candidate) => candidate.llm === identity.llm,
  )!;
  const credential = preflight().credentialMatches.find(
    (candidate) => candidate.llm === identity.llm,
  )!;
  const profile = resolveLlm(identity.llm);
  await writeFile(
    evidencePath,
    `${JSON.stringify({
      schemaVersion: 2,
      qualification: {
        batchId,
        ordinal: identity.ordinal,
        repositoryCommit: commit,
        buildIdentitySha256: buildHash,
        authorizationReferenceSha256: authHash,
        orchestratorFallbackUsed: false,
      },
      llm: identity.llm,
      task: identity.task,
      actualModel: identityRecord.model,
      expectedModel: identityRecord.model,
      runtime: identityRecord.runtime,
      ...(identityRecord.provider === null
        ? {}
        : { provider: identityRecord.provider }),
      route: identityRecord.route,
      ...(identityRecord.runtime === "pi-rpc"
        ? {
            configSha256: preflight().piConfigSha256,
            credentialEnv:
              profile.credentialTargetEnv ?? credential.environmentVariableName,
          }
        : {}),
      passed,
      failureReason: passed ? null : "acceptance_failed",
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      orchestratorFallbackUsed: false,
      executionTelemetrySource:
        identity.llm === "kimi-k3"
          ? "kimi-acp-observable"
          : "pi-rpc-observable",
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return evidencePath;
}

describe("frozen qualification preflight", () => {
  it("decodes and preserves the hash of the real historical preflight", async () => {
    const checkpoint = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          "docs",
          "smoke",
          "evidence",
          "batches",
          historicalBatchId,
          "checkpoints",
          "000000.json",
        ),
        "utf8",
      ),
    ) as { preflight: unknown; preflightSha256: string };

    const frozen = freezePreflightRecord(checkpoint.preflight);
    expect(frozen).toEqual(checkpoint.preflight);
    expect(hashFrozenPreflightRecord(frozen)).toBe(
      checkpoint.preflightSha256,
    );
  });

  it("validates the real historical blocked terminal manifest", async () => {
    const repositoryRoot = await tempRepository();
    await copyHistoricalBatch(repositoryRoot);
    const manifest = JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          "docs",
          "smoke",
          "evidence",
          "batches",
          historicalBatchId,
          "manifest.json",
        ),
        "utf8",
      ),
    ) as {
      status: string;
      authorizationReferenceSha256: string;
    };

    expect(manifest.status).toBe("blocked");
    await expect(
      inspectQualificationTerminal({
        repositoryRoot,
        batchId: historicalBatchId,
      }),
    ).resolves.toEqual({
      state: "valid",
      batchId: historicalBatchId,
      authorizationReferenceSha256:
        manifest.authorizationReferenceSha256,
    });
  });

  it("accepts only the current schema and matching four-LLM plan identity", () => {
    const current = currentPreflightRecord();

    expect(freezePreflightRecord(current)).toEqual(current);
    expect(() =>
      freezePreflightRecord({
        ...preflight(),
        qualificationPlanId: "four-llm-v1",
      }),
    ).toThrow("Qualification ledger operation failed");
    const { qualificationPlanId: _omitted, ...withoutPlan } = current;
    expect(() => freezePreflightRecord(withoutPlan)).toThrow(
      "Qualification ledger operation failed",
    );
    expect(() =>
      freezePreflightRecord({
        ...current,
        qualificationPlanId: "five-llm-v1",
      }),
    ).toThrow("Qualification ledger operation failed");
    expect(() =>
      freezePreflightRecord({ ...current, schemaVersion: 3 }),
    ).toThrow("Qualification ledger operation failed");
    expect(() =>
      freezePreflightRecord({ ...current, extra: "forbidden" }),
    ).toThrow("Qualification ledger operation failed");
  });

  it.each([
    "buildArtifacts",
    "logicalLlms",
    "credentialMatches",
  ] as const)("rejects sparse legacy and current %s arrays", (field) => {
    const legacy = preflight();
    const current = currentPreflightRecord();

    expect(() =>
      freezePreflightRecord({
        ...legacy,
        [field]: sparseCopy(legacy[field]),
      }),
    ).toThrow("Qualification ledger operation failed");
    expect(() =>
      freezePreflightRecord({
        ...current,
        [field]: sparseCopy(current[field]),
      }),
    ).toThrow("Qualification ledger operation failed");
  });

  it.each([
    "buildArtifacts",
    "logicalLlms",
    "credentialMatches",
  ] as const)("rejects proxied legacy and current %s arrays", (field) => {
    let trapCalls = 0;
    const proxy = (values: readonly unknown[]) =>
      new Proxy([...values], {
        get() {
          trapCalls += 1;
          throw new Error("array proxy trap must not execute");
        },
      });
    const legacy = preflight();
    const current = currentPreflightRecord();

    expect(() =>
      freezePreflightRecord({
        ...legacy,
        [field]: proxy(legacy[field]),
      }),
    ).toThrow("Qualification ledger operation failed");
    expect(() =>
      freezePreflightRecord({
        ...current,
        [field]: proxy(current[field]),
      }),
    ).toThrow("Qualification ledger operation failed");
    expect(trapCalls).toBe(0);
  });

  it("rejects array index accessors and extra symbol properties without invoking them", () => {
    let getterCalls = 0;
    const logicalLlms = [...preflight().logicalLlms];
    Object.defineProperty(logicalLlms, "1", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return preflight().logicalLlms[1];
      },
    });
    expect(() =>
      freezePreflightRecord({ ...preflight(), logicalLlms }),
    ).toThrow("Qualification ledger operation failed");
    expect(getterCalls).toBe(0);

    const current = currentPreflightRecord();
    const credentialMatches = [...current.credentialMatches];
    Object.defineProperty(credentialMatches, Symbol("forbidden"), {
      enumerable: true,
      value: "forbidden",
    });
    expect(() =>
      freezePreflightRecord({ ...current, credentialMatches }),
    ).toThrow("Qualification ledger operation failed");
  });

  it("binds legacy and current build identity hashes to normalized artifacts", () => {
    const legacy = preflight();
    const current = currentPreflightRecord();

    expect(() =>
      freezePreflightRecord({
        ...legacy,
        buildIdentitySha256: "f".repeat(64),
      }),
    ).toThrow("Qualification ledger operation failed");
    expect(() =>
      freezePreflightRecord({
        ...current,
        buildIdentitySha256: "f".repeat(64),
      }),
    ).toThrow("Qualification ledger operation failed");
  });

  it("exposes deeply readonly legacy and current preflight records", () => {
    expectTypeOf<
      TypeEqual<
        LegacyFrozenPreflightRecord,
        DeepReadonly<LegacyFrozenPreflightRecord>
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypeEqual<
        CurrentFrozenPreflightRecord,
        DeepReadonly<CurrentFrozenPreflightRecord>
      >
    >().toEqualTypeOf<true>();
  });

  it("deep-freezes and rejects drift in fixed identities or zero baseline", () => {
    const frozen = preflight();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.logicalLlms)).toBe(true);
    expect(Object.isFrozen(frozen.logicalLlms[0])).toBe(true);
    expect(Object.isFrozen(frozen.targetProcesses.kimi)).toBe(true);

    expect(() =>
      freezePreflightRecord({
        ...frozen,
        logicalLlms: [
          ...frozen.logicalLlms.slice(0, 4),
          { ...frozen.logicalLlms[4]!, model: "wrong-model" },
        ],
      }),
    ).toThrow("Qualification ledger operation failed");
    expect(() =>
      freezePreflightRecord({
        ...frozen,
        targetProcesses: {
          ...frozen.targetProcesses,
          piRpc: { count: 1 },
        },
      }),
    ).toThrow("Qualification ledger operation failed");
  });

  it.each([
    {
      buildArtifacts: [
        { path: "../escape.js", sha256: "1".repeat(64) },
        ...artifacts.slice(1),
      ],
    },
    {
      buildArtifacts: [artifacts[0], artifacts[0], ...artifacts.slice(2)],
    },
    {
      buildArtifacts: [
        { ...artifacts[0], sha256: "not-a-hash" },
        ...artifacts.slice(1),
      ],
    },
    {
      proxy10808: {
        host: "0.0.0.0",
        port: 10808,
        listening: true,
      },
    },
    {
      credentialMatches: preflight().credentialMatches.map((match, index) =>
        index === 0 ? { ...match, value: "SECRET_VALUE" } : match,
      ),
    },
  ])("fails closed for malformed frozen input %#", (patch) => {
    expect(() => freezePreflightRecord({ ...preflight(), ...patch })).toThrow(
      "Qualification ledger operation failed",
    );
  });

  it.each(["schemaVersion", "repositoryBranch"] as const)(
    "rejects a non-enumerable %s preflight field",
    (field) => {
      const candidate = { ...preflight() };
      Object.defineProperty(candidate, field, {
        configurable: true,
        enumerable: false,
        value: candidate[field],
        writable: true,
      });

      expect(() => freezePreflightRecord(candidate)).toThrow(
        "Qualification ledger operation failed",
      );
    },
  );

  it("rejects preflight accessors without executing getters", () => {
    let getterCalls = 0;
    const accessor = {
      ...preflight(),
      get repositoryBranch() {
        getterCalls += 1;
        return "codex/ark-cutover";
      },
    };
    expect(() => freezePreflightRecord(accessor)).toThrow(
      "Qualification ledger operation failed",
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects preflight proxies without executing traps", () => {
    let trapCalls = 0;
    const proxy = new Proxy(preflight(), {
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error("preflight proxy trap must not execute");
      },
    });
    expect(() => freezePreflightRecord(proxy)).toThrow(
      "Qualification ledger operation failed",
    );
    expect(trapCalls).toBe(0);
  });

  it("rejects extra preflight fields", () => {
    expect(() =>
      freezePreflightRecord({ ...preflight(), extra: "forbidden" }),
    ).toThrow("Qualification ledger operation failed");
  });
});

describe("immutable qualification ledger", () => {
  it("publishes monotonic checkpoints and one terminal manifest", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    const identity = cases()[0]!;
    await ledger.publishCaseRunning({
      ...identity,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    const evidencePath = await publishEvidence(repository, identity);
    await ledger.publishCaseCompleted({
      ...identity,
      result: "passed",
      evidencePath,
      recordedAt: "2026-07-26T02:02:00.000Z",
    });
    const manifest = await ledger.publishTerminalManifest({
      status: "blocked",
      stopReason: "infrastructure_failure",
      notRun: cases().slice(1),
      completedAt: "2026-07-26T02:03:00.000Z",
    });

    expect(manifest.cases).toHaveLength(1);
    expect(manifest.cases[0]).toMatchObject({
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      orchestratorFallbackUsed: false,
      executionTelemetrySource: "pi-rpc-observable",
    });
    expect(manifest.checkpoints.map((item) => item.sequence)).toEqual([
      0, 1, 2,
    ]);
    expect(manifest.promotionEligible).toBe(false);
    expect(
      await inspectQualificationTerminal({
        repositoryRoot: repository,
        batchId,
      }),
    ).toEqual({
      state: "valid",
      batchId,
      authorizationReferenceSha256: authHash,
    });
    await expect(
      ledger.publishTerminalManifest({
        status: "interrupted",
        stopReason: "process_interrupted",
        notRun: [],
        completedAt: "2026-07-26T02:04:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
    expect(
      await readFile(
        path.join(
          repository,
          "docs/smoke/evidence/batches",
          batchId,
          "manifest.json",
        ),
        "utf8",
      ),
    ).not.toContain("infrastructure secret");
  });

  it("only marks the exact fixed ten-case schedule promotion eligible", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    for (const identity of cases()) {
      await ledger.publishCaseRunning({
        ...identity,
        recordedAt: `2026-07-26T02:${String(identity.ordinal).padStart(2, "0")}:00.000Z`,
      });
      await ledger.publishCaseCompleted({
        ...identity,
        result: "passed",
        evidencePath: await publishEvidence(repository, identity),
        recordedAt: `2026-07-26T03:${String(identity.ordinal).padStart(2, "0")}:00.000Z`,
      });
    }
    const manifest = await ledger.publishTerminalManifest({
      status: "passed",
      stopReason: null,
      notRun: [],
      completedAt: "2026-07-26T04:00:00.000Z",
    });
    expect(manifest.promotionEligible).toBe(true);
    expect(
      manifest.cases.map(({ ordinal, llm, task }) => ({ ordinal, llm, task })),
    ).toEqual(cases());
  });

  it("records the parent credential source but validates Ark evidence against the child target name", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    for (const identity of cases().slice(0, 3)) {
      await ledger.publishCaseRunning({
        ...identity,
        recordedAt: `2026-07-26T02:0${identity.ordinal}:00.000Z`,
      });
      const evidencePath = await publishEvidence(repository, identity);
      if (identity.ordinal === 3) {
        const evidence = JSON.parse(
          await readFile(evidencePath, "utf8"),
        ) as Record<string, unknown>;
        expect(
          preflight().credentialMatches.find(
            (entry) => entry.llm === identity.llm,
          )?.environmentVariableName,
        ).toBe("API_KEY_DOUBAO_CODING");
        expect(evidence.credentialEnv).toBe("CODEX_AGENT_ARK_CODING_KEY");
      }
      await expect(
        ledger.publishCaseCompleted({
          ...identity,
          result: "passed",
          evidencePath,
          recordedAt: `2026-07-26T03:0${identity.ordinal}:00.000Z`,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("enforces batch_started, same-ordinal pairing, and strict ordinal order", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await expect(
      ledger.publishCaseRunning({
        ...cases()[0]!,
        recordedAt: "2026-07-26T02:00:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await expect(
      ledger.publishCaseRunning({
        ...cases()[1]!,
        recordedAt: "2026-07-26T02:01:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
    await ledger.publishCaseRunning({
      ...cases()[0]!,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    await expect(
      ledger.publishCaseCompleted({
        ...cases()[1]!,
        result: "failed",
        evidencePath: path.join(repository, "outside.json"),
        recordedAt: "2026-07-26T02:02:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it("rejects the next running case after any completed case failed", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    const identity = cases()[0]!;
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...identity,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    await ledger.publishCaseCompleted({
      ...identity,
      result: "failed",
      evidencePath: await publishEvidence(repository, identity, false),
      recordedAt: "2026-07-26T02:02:00.000Z",
    });

    await expect(
      ledger.publishCaseRunning({
        ...cases()[1]!,
        recordedAt: "2026-07-26T02:03:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it("rejects a manually published running checkpoint after a failed completion", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    const identity = cases()[0]!;
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...identity,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    await ledger.publishCaseCompleted({
      ...identity,
      result: "failed",
      evidencePath: await publishEvidence(repository, identity, false),
      recordedAt: "2026-07-26T02:02:00.000Z",
    });
    const started = JSON.parse(
      await readFile(
        path.join(
          repository,
          "docs/smoke/evidence/batches",
          batchId,
          "checkpoints/000000.json",
        ),
        "utf8",
      ),
    );
    await publishImmutableJson(
      path.join(
        repository,
        "docs/smoke/evidence/batches",
        batchId,
        "checkpoints/000003.json",
      ),
      {
        schemaVersion: 1,
        sequence: 3,
        kind: "case_running",
        batchId,
        recordedAt: "2026-07-26T02:03:00.000Z",
        repositoryCommit: commit,
        buildIdentitySha256: buildHash,
        preflightSha256: started.preflightSha256,
        ...cases()[1]!,
      },
    );

    await expect(
      ledger.publishTerminalManifest({
        status: "blocked",
        stopReason: "case_failed",
        notRun: cases().slice(1),
        completedAt: "2026-07-26T02:04:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it.each([
    ["v1", { schemaVersion: 1 }],
    ["other batch", { qualification: { batchId: "other" } }],
    ["other commit", { qualification: { repositoryCommit: "f".repeat(40) } }],
    ["other build", { qualification: { buildIdentitySha256: "f".repeat(64) } }],
  ] as const)(
    "rejects %s evidence before completion",
    async (_label, patch) => {
      const repository = await tempRepository();
      const identity = cases()[0]!;
      const ledger = createQualificationLedger({
        repositoryRoot: repository,
        batchId,
      });
      await ledger.publishBatchStarted({
        authorizationReferenceSha256: authHash,
        preflight: preflight(),
        recordedAt: "2026-07-26T02:00:00.000Z",
      });
      await ledger.publishCaseRunning({
        ...identity,
        recordedAt: "2026-07-26T02:01:00.000Z",
      });
      const evidencePath = await publishEvidence(repository, identity);
      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      const modified = {
        ...evidence,
        ...patch,
        qualification: {
          ...evidence.qualification,
          ...("qualification" in patch ? patch.qualification : {}),
        },
      };
      await rm(evidencePath);
      await writeFile(evidencePath, `${JSON.stringify(modified)}\n`, "utf8");

      await expect(
        ledger.publishCaseCompleted({
          ...identity,
          result: "passed",
          evidencePath,
          recordedAt: "2026-07-26T02:02:00.000Z",
        }),
      ).rejects.toThrow("Qualification ledger operation failed");
    },
  );

  it.each([
    [
      "other authorization",
      { qualification: { authorizationReferenceSha256: "f".repeat(64) } },
    ],
    ["other ordinal", { qualification: { ordinal: 2 } }],
    ["other llm", { llm: "ark-agent-plan" }],
    ["other task", { task: "review" }],
    ["other actual model", { actualModel: "wrong-model" }],
    ["other expected model", { expectedModel: "wrong-model" }],
    ["other runtime", { runtime: "kimi-acp" }],
    ["other provider", { provider: "wrong-provider" }],
    ["other route", { route: "direct" }],
    ["other Pi config", { configSha256: "8".repeat(64) }],
    ["missing Pi credential", { credentialEnv: undefined }],
    ["retry telemetry", { adapterRetryCount: 1 }],
    ["fallback telemetry", { adapterReportedFallbackUsed: true }],
    ["wrong source", { executionTelemetrySource: "kimi-acp-observable" }],
    ["result mismatch", { passed: false }],
  ] as const)(
    "rejects %s evidence identity or telemetry drift",
    async (_label, patch) => {
      const repository = await tempRepository();
      const identity = cases()[0]!;
      const ledger = createQualificationLedger({
        repositoryRoot: repository,
        batchId,
      });
      await ledger.publishBatchStarted({
        authorizationReferenceSha256: authHash,
        preflight: preflight(),
        recordedAt: "2026-07-26T02:00:00.000Z",
      });
      await ledger.publishCaseRunning({
        ...identity,
        recordedAt: "2026-07-26T02:01:00.000Z",
      });
      const evidencePath = await publishEvidence(repository, identity);
      const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
      await rm(evidencePath);
      await writeFile(
        evidencePath,
        `${JSON.stringify({
          ...evidence,
          ...patch,
          qualification: {
            ...evidence.qualification,
            ...("qualification" in patch ? patch.qualification : {}),
          },
        })}\n`,
      );
      await expect(
        ledger.publishCaseCompleted({
          ...identity,
          result: "passed",
          evidencePath,
          recordedAt: "2026-07-26T02:02:00.000Z",
        }),
      ).rejects.toThrow("Qualification ledger operation failed");
    },
  );

  it("rejects a failed case that reports the other runtime telemetry source", async () => {
    const repository = await tempRepository();
    const identity = cases()[0]!;
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...identity,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    const evidencePath = await publishEvidence(repository, identity, false);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    await rm(evidencePath);
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        ...evidence,
        executionTelemetrySource: "kimi-acp-observable",
      })}\n`,
    );
    await expect(
      ledger.publishCaseCompleted({
        ...identity,
        result: "failed",
        evidencePath,
        recordedAt: "2026-07-26T02:02:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it("records a failed checkpoint when the runtime safely reports an unexpected actual model", async () => {
    const repository = await tempRepository();
    const identity = cases()[0]!;
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...identity,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    const evidencePath = await publishEvidence(repository, identity, false);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    await rm(evidencePath);
    await writeFile(
      evidencePath,
      `${JSON.stringify({
        ...evidence,
        actualModel: "observed-wrong-model",
      })}\n`,
    );
    await expect(
      ledger.publishCaseCompleted({
        ...identity,
        result: "failed",
        evidencePath,
        recordedAt: "2026-07-26T02:02:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("requires case_failed to be backed by a failed completed case and derives notRun", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await expect(
      ledger.publishTerminalManifest({
        status: "blocked",
        stopReason: "case_failed",
        notRun: cases(),
        completedAt: "2026-07-26T02:03:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
    await expect(
      ledger.publishTerminalManifest({
        status: "blocked",
        stopReason: "infrastructure_failure",
        notRun: cases().slice(1),
        completedAt: "2026-07-26T02:03:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it("publishes a blocked infrastructure terminal from an active running case", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...cases()[0]!,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });

    const manifest = await ledger.publishTerminalManifest({
      status: "blocked",
      stopReason: "infrastructure_failure",
      notRun: cases().slice(1),
      completedAt: "2026-07-26T02:02:00.000Z",
    });
    expect(manifest.status).toBe("blocked");
    expect(manifest.notRun).toEqual(cases().slice(1));
    expect(manifest.checkpoints).toHaveLength(2);
    expect(
      await inspectQualificationTerminal({
        repositoryRoot: repository,
        batchId,
      }),
    ).toEqual({
      state: "valid",
      batchId,
      authorizationReferenceSha256: authHash,
    });
  });

  it("rejects case_failed while a case is still running", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...cases()[0]!,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    await expect(
      ledger.publishTerminalManifest({
        status: "blocked",
        stopReason: "case_failed",
        notRun: cases().slice(1),
        completedAt: "2026-07-26T02:02:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it("does not overwrite a colliding checkpoint when concurrent publishers race", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    const attempts = await Promise.allSettled([
      ledger.publishCaseRunning({
        ...cases()[0]!,
        recordedAt: "2026-07-26T02:01:00.000Z",
      }),
      ledger.publishCaseRunning({
        ...cases()[0]!,
        recordedAt: "2026-07-26T02:01:01.000Z",
      }),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const checkpoint = JSON.parse(
      await readFile(
        path.join(
          repository,
          "docs/smoke/evidence/batches",
          batchId,
          "checkpoints/000001.json",
        ),
        "utf8",
      ),
    );
    expect(["2026-07-26T02:01:00.000Z", "2026-07-26T02:01:01.000Z"]).toContain(
      checkpoint.recordedAt,
    );
  });

  it("recovers all crash windows and treats evidence without completion as interrupted", async () => {
    for (const crashWindow of [
      "before_started",
      "after_started",
      "after_running",
      "after_evidence",
    ] as const) {
      const repository = await tempRepository();
      const ledger = createQualificationLedger({
        repositoryRoot: repository,
        batchId,
      });
      if (crashWindow !== "before_started") {
        await ledger.publishBatchStarted({
          authorizationReferenceSha256: authHash,
          preflight: preflight(),
          recordedAt: "2026-07-26T02:00:00.000Z",
        });
      }
      if (crashWindow === "after_running" || crashWindow === "after_evidence") {
        await ledger.publishCaseRunning({
          ...cases()[0]!,
          recordedAt: "2026-07-26T02:01:00.000Z",
        });
      }
      if (crashWindow === "after_evidence") {
        await publishEvidence(repository, cases()[0]!);
      }

      const manifest = await recoverInterruptedQualificationBatch({
        repositoryRoot: repository,
        batchId,
        authorizationReferenceSha256: authHash,
        completedAt: "2026-07-26T02:03:00.000Z",
      });
      expect(manifest.status).toBe("interrupted");
      expect(manifest.promotionEligible).toBe(false);
      expect(manifest.uncommittedEvidence === null).toBe(
        crashWindow !== "after_evidence",
      );
      if (crashWindow === "after_evidence") {
        expect(manifest.uncommittedEvidence).toMatchObject({
          validationStatus: "valid",
          ordinal: 1,
          llm: "gemini-3.5-flash",
          task: "delegate",
          observedPassed: true,
          failureReason: null,
          adapterClientInvocationCount: 1,
          adapterRetryCount: 0,
          runtimeReportedAutoRetryCount: 0,
          adapterReportedFallbackUsed: false,
          orchestratorFallbackUsed: false,
          executionTelemetrySource: "pi-rpc-observable",
        });
      }
      expect(
        await inspectQualificationTerminal({
          repositoryRoot: repository,
          batchId,
        }),
      ).toEqual({
        state: "valid",
        batchId,
        authorizationReferenceSha256: authHash,
      });
    }
  });

  it("recovers a completed case without a manifest and never reissues it", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    const identity = cases()[0]!;
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...identity,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    await ledger.publishCaseCompleted({
      ...identity,
      result: "passed",
      evidencePath: await publishEvidence(repository, identity),
      recordedAt: "2026-07-26T02:02:00.000Z",
    });
    const manifest = await recoverInterruptedQualificationBatch({
      repositoryRoot: repository,
      batchId,
      authorizationReferenceSha256: authHash,
      notRun: cases().slice(1),
      completedAt: "2026-07-26T02:03:00.000Z",
    });
    expect(manifest.cases).toHaveLength(1);
    expect(manifest.uncommittedEvidence).toBeNull();
  });

  it.each([
    "v1",
    "invalid-json",
    "identity-mismatch",
    "model-drift",
    "telemetry-drift",
  ] as const)(
    "records one invalid %s evidence file without leaking its contents",
    async (scenario) => {
      const repository = await tempRepository();
      const ledger = createQualificationLedger({
        repositoryRoot: repository,
        batchId,
      });
      await ledger.publishBatchStarted({
        authorizationReferenceSha256: authHash,
        preflight: preflight(),
        recordedAt: "2026-07-26T02:00:00.000Z",
      });
      await ledger.publishCaseRunning({
        ...cases()[0]!,
        recordedAt: "2026-07-26T02:01:00.000Z",
      });
      const first = await publishEvidence(repository, cases()[0]!);
      if (scenario === "v1") {
        const value = JSON.parse(await readFile(first, "utf8"));
        await rm(first);
        await writeFile(
          first,
          `${JSON.stringify({ ...value, schemaVersion: 1 })}\n`,
        );
      } else if (scenario === "invalid-json") {
        await rm(first);
        await writeFile(first, '{"rawSecret":"must-not-leak"');
      } else if (scenario === "identity-mismatch") {
        const value = JSON.parse(await readFile(first, "utf8"));
        await rm(first);
        await writeFile(
          first,
          `${JSON.stringify({
            ...value,
            llm: "ark-agent-plan",
            rawSecret: "must-not-leak",
          })}\n`,
        );
      } else {
        const value = JSON.parse(await readFile(first, "utf8"));
        await rm(first);
        await writeFile(
          first,
          `${JSON.stringify({
            ...value,
            ...(scenario === "model-drift"
              ? { expectedModel: "unexpected-model" }
              : {
                  adapterRetryCount: 1,
                  executionTelemetrySource: "kimi-acp-observable",
                }),
          })}\n`,
        );
      }
      const manifest = await recoverInterruptedQualificationBatch({
        repositoryRoot: repository,
        batchId,
        authorizationReferenceSha256: authHash,
        notRun: cases().slice(1),
        completedAt: "2026-07-26T02:03:00.000Z",
      });
      expect(manifest).toMatchObject({
        status: "interrupted",
        promotionEligible: false,
        uncommittedEvidence: {
          validationStatus: "invalid",
          ordinal: 1,
          llm: "gemini-3.5-flash",
          task: "delegate",
          observedPassed: null,
          failureReason: "infrastructure_failure",
          adapterClientInvocationCount: null,
          adapterRetryCount: null,
          runtimeReportedAutoRetryCount: null,
          adapterReportedFallbackUsed: null,
          orchestratorFallbackUsed: null,
          executionTelemetrySource: null,
        },
      });
      expect(manifest.uncommittedEvidence?.evidence.path).toMatch(
        /\/cases\/01\.json$/u,
      );
      expect(manifest.uncommittedEvidence?.evidence.sha256).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toContain("must-not-leak");
      expect(
        await inspectQualificationTerminal({
          repositoryRoot: repository,
          batchId,
        }),
      ).toEqual({
        state: "valid",
        batchId,
        authorizationReferenceSha256: authHash,
      });
    },
  );

  it("publishes a controlled blocked terminal for one invalid uncommitted file", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...cases()[0]!,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    const evidencePath = await publishEvidence(repository, cases()[0]!);
    await rm(evidencePath);
    await writeFile(evidencePath, "invalid-json");

    const manifest = await ledger.publishTerminalManifest({
      status: "blocked",
      stopReason: "infrastructure_failure",
      notRun: cases().slice(1),
      completedAt: "2026-07-26T02:02:00.000Z",
    });

    expect(manifest.uncommittedEvidence).toMatchObject({
      validationStatus: "invalid",
      ordinal: 1,
      llm: "gemini-3.5-flash",
      task: "delegate",
      observedPassed: null,
      failureReason: "infrastructure_failure",
    });
    expect(
      await inspectQualificationTerminal({
        repositoryRoot: repository,
        batchId,
      }),
    ).toEqual({
      state: "valid",
      batchId,
      authorizationReferenceSha256: authHash,
    });
  });

  it("publishes a controlled blocked terminal for one valid uncommitted file", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...cases()[0]!,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    await publishEvidence(repository, cases()[0]!);

    const manifest = await ledger.publishTerminalManifest({
      status: "blocked",
      stopReason: "infrastructure_failure",
      notRun: cases().slice(1),
      completedAt: "2026-07-26T02:02:00.000Z",
    });

    expect(manifest.uncommittedEvidence).toMatchObject({
      validationStatus: "valid",
      ordinal: 1,
      llm: "gemini-3.5-flash",
      task: "delegate",
      observedPassed: true,
      failureReason: null,
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      orchestratorFallbackUsed: false,
      executionTelemetrySource: "pi-rpc-observable",
    });
    expect(manifest.cases).toHaveLength(0);
    expect(manifest.promotionEligible).toBe(false);
    expect(
      await inspectQualificationTerminal({
        repositoryRoot: repository,
        batchId,
      }),
    ).toEqual({
      state: "valid",
      batchId,
      authorizationReferenceSha256: authHash,
    });
  });

  it.each(["extra-field", "evidence-hash"] as const)(
    "rejects a terminal whose invalid uncommitted record has %s tampering",
    async (scenario) => {
      const repository = await tempRepository();
      const ledger = createQualificationLedger({
        repositoryRoot: repository,
        batchId,
      });
      await ledger.publishBatchStarted({
        authorizationReferenceSha256: authHash,
        preflight: preflight(),
        recordedAt: "2026-07-26T02:00:00.000Z",
      });
      await ledger.publishCaseRunning({
        ...cases()[0]!,
        recordedAt: "2026-07-26T02:01:00.000Z",
      });
      const evidencePath = await publishEvidence(repository, cases()[0]!);
      await rm(evidencePath);
      await writeFile(evidencePath, "invalid-json");
      await recoverInterruptedQualificationBatch({
        repositoryRoot: repository,
        batchId,
        authorizationReferenceSha256: authHash,
        notRun: cases().slice(1),
        completedAt: "2026-07-26T02:03:00.000Z",
      });

      if (scenario === "extra-field") {
        const manifestPath = path.join(
          repository,
          "docs/smoke/evidence/batches",
          batchId,
          "manifest.json",
        );
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        await rm(manifestPath);
        await writeFile(
          manifestPath,
          `${JSON.stringify({
            ...manifest,
            uncommittedEvidence: {
              ...manifest.uncommittedEvidence,
              validationError: "must-not-be-recorded",
            },
          })}\n`,
        );
      } else {
        await rm(evidencePath);
        await writeFile(evidencePath, "different-invalid-json");
      }

      await expect(
        inspectQualificationTerminal({ repositoryRoot: repository, batchId }),
      ).rejects.toThrow("Qualification ledger operation failed");
    },
  );

  it("publishes an invalid interrupted terminal and releases the exact stale owner", async () => {
    const repository = await tempRepository();
    const tempDirectory = await tempRepository();
    const processStartTime = "2026-07-26T01:00:00.000Z";
    const handle = await acquireQualificationLock({
      repositoryRoot: repository,
      batchId,
      authorizationReferenceSha256: authHash,
      tempDirectory,
      processId: 4242,
      processIdentityInspector: async () => ({
        alive: true,
        startTime: processStartTime,
      }),
      nonce: "11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-07-26T01:00:01.000Z"),
    });
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await ledger.publishCaseRunning({
      ...cases()[0]!,
      recordedAt: "2026-07-26T02:01:00.000Z",
    });
    const evidencePath = await publishEvidence(repository, cases()[0]!);
    await rm(evidencePath);
    await writeFile(evidencePath, '{"rawSecret":"must-not-leak"');

    await recoverQualificationLock({
      repositoryRoot: repository,
      batchId,
      tempDirectory,
      processIdentityInspector: async () => ({
        alive: false,
        startTime: null,
      }),
      inspectTargetProcesses: async () => ({
        kimi: { count: 0 },
        piRpc: { count: 0 },
        realSmoke: { count: 0 },
      }),
      inspectTerminalManifest: (expectedBatchId) =>
        inspectQualificationTerminal({
          repositoryRoot: repository,
          batchId: expectedBatchId,
        }),
      publishInterruptedManifest: async (reference) => {
        const manifest = await recoverInterruptedQualificationBatch({
          repositoryRoot: repository,
          batchId: reference.batchId,
          authorizationReferenceSha256: reference.authorizationReferenceSha256,
          notRun: cases().slice(1),
          completedAt: "2026-07-26T02:03:00.000Z",
        });
        expect(manifest.uncommittedEvidence).toMatchObject({
          validationStatus: "invalid",
          failureReason: "infrastructure_failure",
        });
      },
    });

    expect(
      await inspectQualificationTerminal({
        repositoryRoot: repository,
        batchId,
      }),
    ).toEqual({
      state: "valid",
      batchId,
      authorizationReferenceSha256: authHash,
    });
    await expect(
      readFile(path.join(handle.lockDirectory, "owner.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["multiple", "unpaired", "oversized"] as const)(
    "fails closed recovering %s uncommitted evidence",
    async (scenario) => {
      const repository = await tempRepository();
      const ledger = createQualificationLedger({
        repositoryRoot: repository,
        batchId,
      });
      await ledger.publishBatchStarted({
        authorizationReferenceSha256: authHash,
        preflight: preflight(),
        recordedAt: "2026-07-26T02:00:00.000Z",
      });
      if (scenario !== "unpaired") {
        await ledger.publishCaseRunning({
          ...cases()[0]!,
          recordedAt: "2026-07-26T02:01:00.000Z",
        });
      }
      const first = await publishEvidence(repository, cases()[0]!);
      if (scenario === "multiple") {
        const second = path.join(path.dirname(first), "extra.json");
        await writeFile(second, await readFile(first));
      } else if (scenario === "oversized") {
        await rm(first);
        await writeFile(first, Buffer.alloc(1_048_577, 0x61));
      }
      await expect(
        recoverInterruptedQualificationBatch({
          repositoryRoot: repository,
          batchId,
          authorizationReferenceSha256: authHash,
          notRun: scenario === "unpaired" ? cases() : cases().slice(1),
          completedAt: "2026-07-26T02:03:00.000Z",
        }),
      ).rejects.toThrow("Qualification ledger operation failed");
    },
  );

  it("recomputes evidence and checkpoint hashes when inspecting a terminal", async () => {
    for (const target of ["evidence", "checkpoint"] as const) {
      const repository = await tempRepository();
      const ledger = createQualificationLedger({
        repositoryRoot: repository,
        batchId,
      });
      const identity = cases()[0]!;
      await ledger.publishBatchStarted({
        authorizationReferenceSha256: authHash,
        preflight: preflight(),
        recordedAt: "2026-07-26T02:00:00.000Z",
      });
      await ledger.publishCaseRunning({
        ...identity,
        recordedAt: "2026-07-26T02:01:00.000Z",
      });
      const evidencePath = await publishEvidence(repository, identity);
      await ledger.publishCaseCompleted({
        ...identity,
        result: "failed",
        evidencePath: await (async () => {
          const value = JSON.parse(await readFile(evidencePath, "utf8"));
          await rm(evidencePath);
          await writeFile(
            evidencePath,
            `${JSON.stringify({
              ...value,
              passed: false,
              failureReason: "acceptance_failed",
            })}\n`,
          );
          return evidencePath;
        })(),
        recordedAt: "2026-07-26T02:02:00.000Z",
      });
      await ledger.publishTerminalManifest({
        status: "blocked",
        stopReason: "case_failed",
        notRun: cases().slice(1),
        completedAt: "2026-07-26T02:03:00.000Z",
      });
      const tamperPath =
        target === "evidence"
          ? evidencePath
          : path.join(
              repository,
              "docs/smoke/evidence/batches",
              batchId,
              "checkpoints/000002.json",
            );
      const raw = await readFile(tamperPath, "utf8");
      await rm(tamperPath);
      await writeFile(tamperPath, raw.replace(/\n$/u, " \n"));
      await expect(
        inspectQualificationTerminal({ repositoryRoot: repository, batchId }),
      ).rejects.toThrow("Qualification ledger operation failed");
    }
  });

  it("rejects checkpoint tampering, collisions, path escape, and raw secret fields", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    const checkpoint = path.join(
      repository,
      "docs/smoke/evidence/batches",
      batchId,
      "checkpoints/000000.json",
    );
    const value = JSON.parse(await readFile(checkpoint, "utf8"));
    await rm(checkpoint);
    await writeFile(
      checkpoint,
      `${JSON.stringify({ ...value, error: "SECRET_ERROR" })}\n`,
    );

    await expect(
      ledger.publishCaseRunning({
        ...cases()[0]!,
        recordedAt: "2026-07-26T02:01:00.000Z",
      }),
    ).rejects.toBeInstanceOf(QualificationLedgerError);
    await expect(
      createQualificationLedger({
        repositoryRoot: repository,
        batchId: "../escape",
      }).publishBatchStarted({
        authorizationReferenceSha256: authHash,
        preflight: preflight(),
        recordedAt: "2026-07-26T02:00:00.000Z",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it("fails closed when any ledger directory ancestor is a junction or symlink", async () => {
    const linkType = process.platform === "win32" ? "junction" : "dir";
    for (const scenario of [
      "batches",
      "batch",
      "checkpoints",
      "cases",
      "manifest",
      "read",
    ] as const) {
      const repository = await tempRepository();
      const outside = path.join(
        path.dirname(repository),
        `${path.basename(repository)}-outside`,
      );
      await mkdir(outside, { recursive: true });
      roots.push(outside);
      const batches = path.join(repository, "docs/smoke/evidence/batches");
      const batch = path.join(batches, batchId);
      const ledger = createQualificationLedger({
        repositoryRoot: repository,
        batchId,
      });

      if (scenario === "batches") {
        await mkdir(path.dirname(batches), { recursive: true });
        await symlink(outside, batches, linkType);
        await expect(
          ledger.publishBatchStarted({
            authorizationReferenceSha256: authHash,
            preflight: preflight(),
            recordedAt: "2026-07-26T02:00:00.000Z",
          }),
        ).rejects.toThrow("Qualification ledger operation failed");
        expect(
          await readFile(
            path.join(outside, "checkpoints/000000.json"),
            "utf8",
          ).catch(() => null),
        ).toBeNull();
        continue;
      }

      if (scenario === "batch") {
        await mkdir(batches, { recursive: true });
        await symlink(outside, batch, linkType);
        await expect(
          ledger.publishBatchStarted({
            authorizationReferenceSha256: authHash,
            preflight: preflight(),
            recordedAt: "2026-07-26T02:00:00.000Z",
          }),
        ).rejects.toThrow("Qualification ledger operation failed");
        continue;
      }

      await ledger.publishBatchStarted({
        authorizationReferenceSha256: authHash,
        preflight: preflight(),
        recordedAt: "2026-07-26T02:00:00.000Z",
      });
      if (scenario === "checkpoints") {
        const checkpoints = path.join(batch, "checkpoints");
        await rm(checkpoints, { recursive: true, force: true });
        await symlink(outside, checkpoints, linkType);
        await expect(
          ledger.publishCaseRunning({
            ...cases()[0]!,
            recordedAt: "2026-07-26T02:01:00.000Z",
          }),
        ).rejects.toThrow("Qualification ledger operation failed");
        continue;
      }

      await ledger.publishCaseRunning({
        ...cases()[0]!,
        recordedAt: "2026-07-26T02:01:00.000Z",
      });
      if (scenario === "cases") {
        const caseDirectory = path.join(batch, "cases");
        await symlink(outside, caseDirectory, linkType);
        const outsideEvidence = await publishEvidence(repository, cases()[0]!);
        await expect(
          ledger.publishCaseCompleted({
            ...cases()[0]!,
            result: "passed",
            evidencePath: outsideEvidence,
            recordedAt: "2026-07-26T02:02:00.000Z",
          }),
        ).rejects.toThrow("Qualification ledger operation failed");
        continue;
      }

      const evidencePath = await publishEvidence(
        repository,
        cases()[0]!,
        false,
      );
      await ledger.publishCaseCompleted({
        ...cases()[0]!,
        result: "failed",
        evidencePath,
        recordedAt: "2026-07-26T02:02:00.000Z",
      });
      const movedBatch = path.join(outside, "stored-batch");
      await rename(batch, movedBatch);
      await symlink(movedBatch, batch, linkType);
      if (scenario === "manifest") {
        await expect(
          ledger.publishTerminalManifest({
            status: "blocked",
            stopReason: "case_failed",
            notRun: cases().slice(1),
            completedAt: "2026-07-26T02:03:00.000Z",
          }),
        ).rejects.toThrow("Qualification ledger operation failed");
      } else {
        await publishImmutableJson(path.join(movedBatch, "manifest.json"), {
          schemaVersion: 1,
          batchId,
        });
        await expect(
          inspectQualificationTerminal({ repositoryRoot: repository, batchId }),
        ).rejects.toThrow("Qualification ledger operation failed");
      }
    }
  });
});

describe("authorization reuse index", () => {
  it("rejects reuse from checkpoints, terminal manifests, and another lock owner", async () => {
    const repository = await tempRepository();
    const ledger = createQualificationLedger({
      repositoryRoot: repository,
      batchId,
    });
    await ledger.publishBatchStarted({
      authorizationReferenceSha256: authHash,
      preflight: preflight(),
      recordedAt: "2026-07-26T02:00:00.000Z",
    });
    await expect(
      assertAuthorizationReferenceUnused({
        repositoryRoot: repository,
        authorizationReferenceSha256: authHash,
      }),
    ).rejects.toThrow("Qualification ledger operation failed");

    const otherRepository = await tempRepository();
    const lockDirectory = path.join(otherRepository, "lock");
    await mkdir(lockDirectory);
    await writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        repositoryRealpathSha256: "f".repeat(64),
        processId: 123,
        processStartTime: "2026-07-26T01:00:00.000Z",
        nonce: "11111111-1111-4111-8111-111111111111",
        batchId: "other-batch",
        authorizationReferenceSha256: authHash,
        acquiredAt: "2026-07-26T01:00:01.000Z",
      })}\n`,
    );
    await expect(
      assertAuthorizationReferenceUnused({
        repositoryRoot: otherRepository,
        authorizationReferenceSha256: authHash,
        lockDirectory,
        currentOwnerNonce: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it("rejects a terminal-only consumed reference", async () => {
    const repository = await tempRepository();
    await recoverInterruptedQualificationBatch({
      repositoryRoot: repository,
      batchId,
      authorizationReferenceSha256: authHash,
      notRun: cases(),
      completedAt: "2026-07-26T02:03:00.000Z",
    });
    await expect(
      assertAuthorizationReferenceUnused({
        repositoryRoot: repository,
        authorizationReferenceSha256: authHash,
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it("fails closed on unreadable historical state and allows its own current owner", async () => {
    const repository = await tempRepository();
    const lockDirectory = path.join(repository, "lock");
    await mkdir(lockDirectory);
    await writeFile(path.join(lockDirectory, "owner.json"), "{", "utf8");
    await expect(
      assertAuthorizationReferenceUnused({
        repositoryRoot: repository,
        authorizationReferenceSha256: authHash,
        lockDirectory,
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });

  it("allows exactly its own valid current owner and rejects unreadable batch state", async () => {
    const repository = await tempRepository();
    const lockDirectory = path.join(
      repository,
      "codex-agent-tools-qualification-locks",
      "f".repeat(64),
    );
    await mkdir(lockDirectory, { recursive: true });
    const nonce = "11111111-1111-4111-8111-111111111111";
    await writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        repositoryRealpathSha256: "f".repeat(64),
        processId: 123,
        processStartTime: "2026-07-26T01:00:00.000Z",
        nonce,
        batchId: "other-batch",
        authorizationReferenceSha256: authHash,
        acquiredAt: "2026-07-26T01:00:01.000Z",
      })}\n`,
    );
    await expect(
      assertAuthorizationReferenceUnused({
        repositoryRoot: repository,
        authorizationReferenceSha256: authHash,
        lockDirectory,
        currentOwnerNonce: nonce,
      }),
    ).resolves.toBeUndefined();

    const brokenBatch = path.join(
      repository,
      "docs/smoke/evidence/batches/broken-batch",
    );
    await mkdir(brokenBatch, { recursive: true });
    await writeFile(path.join(brokenBatch, "unexpected.txt"), "broken");
    await expect(
      assertAuthorizationReferenceUnused({
        repositoryRoot: repository,
        authorizationReferenceSha256: "9".repeat(64),
      }),
    ).rejects.toThrow("Qualification ledger operation failed");
  });
});
