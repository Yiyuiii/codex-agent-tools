import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import type { PiInvocation } from "../../src/adapters/pi/locator.js";

import {
  assertQualificationFrozenCandidate,
  collectQualificationBuildIdentity,
  collectQualificationCurrentSnapshot,
  computeQualificationBuildIdentitySha256,
  QUALIFICATION_BUILD_ARTIFACT_PATHS,
  QUALIFICATION_MAX_BUILD_ARTIFACT_BYTES,
  QualificationPreflightError,
  runQualificationPreflight,
  type QualificationPreflightCommandRequest,
  type QualificationPreflightDependencies,
} from "../../src/qualification/preflight.js";

const roots: string[] = [];
const commit = "a".repeat(40);
const authorizationReferenceSha256 = "b".repeat(64);
const piConfigSha256 = "c".repeat(64);

function verifiedPiInvocation(): PiInvocation {
  return Object.freeze({
    executable: process.execPath,
    argvPrefix: Object.freeze([
      "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
    ]) as readonly [string],
    identity: Object.freeze({
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.80.10",
      nodeEngine: ">=20.0.0",
    }),
  });
}

async function tempRepository(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-preflight-test-${process.pid}-${Date.now()}-${roots.length}`,
  );
  await mkdir(root, { recursive: true });
  roots.push(root);
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "codex-agent-tools", version: "0.1.1-beta.1" })}\n`,
  );
  await writeFile(path.join(root, "package-lock.json"), "lock-v1\n");
  for (const [
    index,
    relativePath,
  ] of QUALIFICATION_BUILD_ARTIFACT_PATHS.entries()) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `artifact-${index}\n`);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface HarnessOptions {
  initialDirty?: boolean;
  finalDirty?: boolean;
  finalCommit?: string;
  commitSnapshots?: readonly string[];
  failCommandStage?: string;
  failCommandOutput?: string;
  missingCredential?: string;
  platform?: NodeJS.Platform;
  failLocator?: "kimi" | "pi-invocation" | "pi-legacy";
  piInvocation?: PiInvocation;
  authorizationUsed?: boolean;
  mutateBuildOnBuild?: boolean;
}

function commandStage(request: QualificationPreflightCommandRequest): string {
  if (
    request.command === "npm" &&
    request.args[0] === "run" &&
    request.args[1] === "typecheck"
  ) {
    return "typecheck";
  }
  if (
    request.command === "npm" &&
    request.args[0] === "run" &&
    request.args[1] === "test:deterministic"
  ) {
    return "test";
  }
  if (
    request.command === "npm" &&
    request.args[0] === "run" &&
    request.args[1] === "build"
  ) {
    return "build";
  }
  if (
    request.command === process.execPath &&
    request.args[0] === "scripts/plugin-isolated-acceptance.mjs" &&
    request.args[1] === "--check-report"
  ) {
    return "isolated_acceptance";
  }
  if (
    request.command === "git" &&
    request.args[0] === "diff" &&
    request.args[1] === "--check"
  ) {
    return "diff_check";
  }
  return "other";
}

async function harness(
  repositoryRoot: string,
  options: HarnessOptions = {},
): Promise<{
  dependencies: QualificationPreflightDependencies;
  commands: QualificationPreflightCommandRequest[];
  codexHomes: string[];
  removedCodexHomes: string[];
  locatorCalls: string[];
  authorizationChecks: number;
}> {
  const commands: QualificationPreflightCommandRequest[] = [];
  const codexHomes: string[] = [];
  const removedCodexHomes: string[] = [];
  const locatorCalls: string[] = [];
  let statusCalls = 0;
  let commitCalls = 0;
  let authorizationChecks = 0;
  let buildMutated = false;
  const activeCodexHome = path.join(repositoryRoot, "must-not-be-used");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    CODEX_HOME: activeCodexHome,
    ARK_API_KEY: "ARK_SECRET_VALUE",
    OPENAI_API_KEY_DOUBAO: "AGENT_SECRET_VALUE",
  };
  if (options.missingCredential !== undefined) {
    delete environment[options.missingCredential];
  }

  const dependencies: QualificationPreflightDependencies = {
    environment,
    nodeVersion: "v24.0.0",
    platform: options.platform ?? "win32",
    locateKimiExecutable: async () => {
      locatorCalls.push("kimi");
      if (options.failLocator === "kimi") throw new Error("locator failed");
      return "kimi";
    },
    locatePiInvocation: async () => {
      locatorCalls.push("pi-invocation");
      if (options.failLocator === "pi-invocation") {
        throw new Error("locator failed");
      }
      return options.piInvocation ?? verifiedPiInvocation();
    },
    locatePosixPiExecutable: async () => {
      locatorCalls.push("pi-legacy");
      if (options.failLocator === "pi-legacy") {
        throw new Error("locator failed");
      }
      return "pi";
    },
    createTemporaryCodexHome: async () => {
      const directory = path.join(
        os.tmpdir(),
        `isolated-codex-home-${process.pid}-${codexHomes.length}`,
      );
      codexHomes.push(directory);
      return directory;
    },
    removeTemporaryCodexHome: async (directory) => {
      removedCodexHomes.push(directory);
    },
    buildQualificationPiConfig: async () => ({
      contentSha256: piConfigSha256,
    }),
    assertAuthorizationUnused: async () => {
      authorizationChecks += 1;
      if (options.authorizationUsed === true) {
        throw new Error("authorization already used SECRET_VALUE");
      }
    },
    runCommand: async (request) => {
      commands.push({
        ...request,
        args: [...request.args],
        environment: { ...request.environment },
      });
      if (
        request.command === "git" &&
        request.args[0] === "status" &&
        request.args[1] === "--porcelain=v1"
      ) {
        statusCalls += 1;
        return {
          exitCode: 0,
          stdout:
            statusCalls === 1
              ? options.initialDirty === true
                ? " M tracked.ts\n"
                : ""
              : options.finalDirty === true
                ? "?? unexpected.txt\n"
                : "",
        };
      }
      if (
        request.command === "git" &&
        request.args[0] === "rev-parse" &&
        request.args[1] === "HEAD"
      ) {
        commitCalls += 1;
        return {
          exitCode: 0,
          stdout:
            options.commitSnapshots === undefined
              ? commitCalls === 1
                ? commit
                : (options.finalCommit ?? commit)
              : options.commitSnapshots[
                  Math.min(commitCalls - 1, options.commitSnapshots.length - 1)
                ]!,
        };
      }
      if (
        request.command === "git" &&
        request.args[0] === "branch" &&
        request.args[1] === "--show-current"
      ) {
        return { exitCode: 0, stdout: "codex/ark-cutover\n" };
      }
      if (request.command === "codex") {
        return { exitCode: 0, stdout: "codex-cli 0.135.0\n" };
      }
      if (request.command === "kimi" || request.command === "pi") {
        throw new Error("qualification preflight must not start target CLIs");
      }
      const stage = commandStage(request);
      if (stage === options.failCommandStage) {
        return {
          exitCode: 17,
          stdout: options.failCommandOutput ?? "unsafe failure output",
        };
      }
      if (
        stage === "build" &&
        options.mutateBuildOnBuild === true &&
        !buildMutated
      ) {
        buildMutated = true;
        const relativePath = QUALIFICATION_BUILD_ARTIFACT_PATHS[0]!;
        await writeFile(
          path.join(repositoryRoot, ...relativePath.split("/")),
          "artifact-drift\n",
        );
      }
      return { exitCode: 0, stdout: "" };
    },
  };

  return {
    dependencies,
    commands,
    codexHomes,
    removedCodexHomes,
    locatorCalls,
    get authorizationChecks() {
      return authorizationChecks;
    },
  };
}

function run(
  repositoryRoot: string,
  dependencies: QualificationPreflightDependencies,
) {
  return runQualificationPreflight(
    {
      repositoryRoot,
      authorizationReferenceSha256,
      lockDirectory: path.join(os.tmpdir(), "qualification-lock"),
      currentOwnerNonce: "11111111-1111-4111-8111-111111111111",
    },
    dependencies,
  );
}

describe("qualification build identity", () => {
  it("hashes the exact four current artifacts in canonical order", async () => {
    const repositoryRoot = await tempRepository();
    const identity = await collectQualificationBuildIdentity(repositoryRoot);

    expect(identity.buildArtifacts.map((artifact) => artifact.path)).toEqual(
      QUALIFICATION_BUILD_ARTIFACT_PATHS,
    );
    expect(identity.buildArtifacts).toHaveLength(4);
    expect(identity.buildArtifacts.map(({ path: artifactPath }) => artifactPath))
      .not.toContain("dist/pi-smoke.js");
    expect(identity.buildIdentitySha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(identity.buildArtifacts))
        .digest("hex"),
    );
    expect(
      computeQualificationBuildIdentitySha256(identity.buildArtifacts),
    ).toBe(identity.buildIdentitySha256);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.buildArtifacts[0])).toBe(true);
  });

  it("rejects oversized build artifacts before hashing unbounded input", async () => {
    const repositoryRoot = await tempRepository();
    await truncate(
      path.join(
        repositoryRoot,
        ...QUALIFICATION_BUILD_ARTIFACT_PATHS[0]!.split("/"),
      ),
      QUALIFICATION_MAX_BUILD_ARTIFACT_BYTES + 1,
    );

    await expect(
      collectQualificationBuildIdentity(repositoryRoot),
    ).rejects.toMatchObject({ stage: "build_initial" });
  });

  it("rejects a junction or symlink in the fixed artifact ancestor chain", async () => {
    const repositoryRoot = await tempRepository();
    const dist = path.join(repositoryRoot, "dist");
    const realDist = path.join(repositoryRoot, "dist-real");
    await rename(dist, realDist);
    await symlink(
      realDist,
      dist,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      collectQualificationBuildIdentity(repositoryRoot),
    ).rejects.toMatchObject({ stage: "build_initial" });
  });
});

describe("qualification preflight", () => {
  it("collects a frozen record, runs deterministic gates in order, and creates no batch", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);
    const record = await run(repositoryRoot, state.dependencies);

    expect(record).toMatchObject({
      schemaVersion: 3,
      qualificationPlanId: "four-llm-v1",
      repositoryCommit: commit,
      repositoryBranch: "codex/ark-cutover",
      repositoryDirty: false,
      packageVersion: "0.1.1-beta.1",
      packageLockSha256: createHash("sha256").update("lock-v1\n").digest("hex"),
      runtimeVersions: {
        node: "v24.0.0",
        codex: "codex-cli 0.135.0",
      },
      piConfigSha256,
    });
    expect(record).not.toHaveProperty("targetProcesses");
    expect(record).not.toHaveProperty("proxy10808");
    expect(record.logicalLlms.map((identity) => identity.llm)).toEqual([
      "ark-agent-deepseek-v4-flash",
      "ark-agent-plan",
      "ark-coding-plan",
      "kimi-k3",
    ]);
    expect(record.logicalLlms.every(({ route }) => route === "direct")).toBe(
      true,
    );
    expect(record.credentialMatches).toEqual([
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
        environmentVariableName: "ARK_API_KEY",
      },
      { llm: "kimi-k3", environmentVariableName: null },
    ]);
    expect(record.buildArtifacts.map(({ path: artifactPath }) => artifactPath))
      .not.toContain("dist/pi-smoke.js");
    expect(
      state.commands.map(commandStage).filter((stage) => stage !== "other"),
    ).toEqual([
      "build",
      "typecheck",
      "test",
      "isolated_acceptance",
      "diff_check",
    ]);
    const acceptance = state.commands.find(
      (request) => commandStage(request) === "isolated_acceptance",
    );
    expect(acceptance).toMatchObject({
      command: process.execPath,
      args: [
        "scripts/plugin-isolated-acceptance.mjs",
        "--check-report",
      ],
    });
    expect(
      state.commands.filter((request) => commandStage(request) === "build"),
    ).toHaveLength(1);
    expect(
      state.commands.some(
        ({ command, args }) =>
          command === "npm" &&
          (args[0] === "test" ||
            (args[0] === "run" &&
              (args[1] === "smoke:release" ||
                args[1] === "smoke:release:built" ||
                args[1] === "acceptance:plugin:isolated"))),
      ),
    ).toBe(false);
    expect(state.authorizationChecks).toBe(1);
    expect(state.locatorCalls).toEqual(["kimi", "pi-invocation"]);
    expect(
      state.commands.some(({ command }) => command === "kimi" || command === "pi"),
    ).toBe(false);
    expect(
      await readFile(
        path.join(
          repositoryRoot,
          "docs/smoke/evidence/batches/any/manifest.json",
        ),
        "utf8",
      ).catch(() => null),
    ).toBeNull();
    expect(Object.isFrozen(record)).toBe(true);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("ARK_SECRET_VALUE");
    expect(serialized).not.toContain("AGENT_SECRET_VALUE");
    expect(serialized).not.toContain(repositoryRoot);
  });

  it("probes Codex with a fresh temporary CODEX_HOME and always removes it", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);
    await run(repositoryRoot, state.dependencies);

    const codex = state.commands.find((request) => request.command === "codex");
    expect(state.codexHomes).toHaveLength(1);
    expect(codex?.environment.CODEX_HOME).toBe(state.codexHomes[0]);
    expect(codex?.environment.CODEX_HOME).not.toBe(
      state.dependencies.environment?.CODEX_HOME,
    );
    expect(state.removedCodexHomes).toEqual(state.codexHomes);
  });

  it("rejects runtime version output that could persist an absolute user path", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);
    const baseRunner = state.dependencies.runCommand!;
    state.dependencies.runCommand = (request) =>
      request.command === "codex"
        ? Promise.resolve({
            exitCode: 0,
            stdout: "codex-cli 0.135.0 C:\\Users\\private\\config",
          })
        : baseRunner(request);

    let observed: unknown;
    try {
      await run(repositoryRoot, state.dependencies);
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({ stage: "runtime_versions" });
    expect(JSON.stringify(observed)).not.toContain("Users");
    expect(String(observed)).not.toContain("private");
  });

  it.each([
    ["dirty initial tree", { initialDirty: true }, "repository_initial"],
    ["dirty final tree", { finalDirty: true }, "repository_final"],
    ["commit drift", { finalCommit: "d".repeat(40) }, "repository_final"],
    ["build drift", { mutateBuildOnBuild: true }, "build_final"],
    [
      "credential missing",
      { missingCredential: "ARK_API_KEY" },
      "credentials",
    ],
    ["static locator failure", { failLocator: "kimi" }, "locators"],
    [
      "strict Pi invocation failure",
      { failLocator: "pi-invocation" },
      "locators",
    ],
    [
      "authorization already used",
      { authorizationUsed: true },
      "authorization",
    ],
    [
      "deterministic command failure",
      { failCommandStage: "typecheck" },
      "typecheck",
    ],
  ] as const)(
    "fails closed before model calls for %s",
    async (_label, options, expectedStage) => {
      const repositoryRoot = await tempRepository();
      const state = await harness(repositoryRoot, options);

      await expect(
        run(repositoryRoot, state.dependencies),
      ).rejects.toMatchObject({
        name: "QualificationPreflightError",
        category: "infrastructure",
        stage: expectedStage,
        count: 1,
        message: "Qualification preflight failed",
      });
      expect(
        await readFile(
          path.join(
            repositoryRoot,
            "docs/smoke/evidence/batches/batch/checkpoints/000000.json",
          ),
          "utf8",
        ).catch(() => null),
      ).toBeNull();
      expect(
        state.commands.some((request) =>
          /real-(?:kimi|pi|ark)-smoke/u.test(
            [request.command, ...request.args].join(" "),
          ),
        ),
      ).toBe(false);
    },
  );

  it("rejects a clean HEAD change while final artifacts are being hashed", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot, {
      commitSnapshots: [commit, commit, "d".repeat(40)],
    });

    await expect(run(repositoryRoot, state.dependencies)).rejects.toMatchObject(
      {
        stage: "repository_final",
        message: "Qualification preflight failed",
      },
    );
  });

  it("does not retain command output, credential values, or absolute paths in errors", async () => {
    const repositoryRoot = await tempRepository();
    const secret = "SUPER_SECRET_COMMAND_OUTPUT";
    const state = await harness(repositoryRoot, {
      failCommandStage: "typecheck",
      failCommandOutput: `${secret} ${repositoryRoot}`,
    });

    let observed: unknown;
    try {
      await run(repositoryRoot, state.dependencies);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(QualificationPreflightError);
    const serialized = JSON.stringify(observed);
    expect(String(observed)).not.toContain(secret);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(repositoryRoot);
    expect(serialized).not.toContain("ARK_SECRET_VALUE");
    expect(serialized).not.toContain("AGENT_SECRET_VALUE");
  });

  it("stops the deterministic sequence at the first failed command", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot, {
      failCommandStage: "test",
    });

    await expect(run(repositoryRoot, state.dependencies)).rejects.toMatchObject(
      {
        stage: "test",
      },
    );
    expect(
      state.commands.map(commandStage).filter((stage) => stage !== "other"),
    ).toEqual(["build", "typecheck", "test"]);
  });

  it("rejects a mutable or multi-prefix Windows Pi invocation without starting Pi", async () => {
    const repositoryRoot = await tempRepository();
    const mutable = {
      ...verifiedPiInvocation(),
      argvPrefix: ["C:\\one.js", "C:\\two.js"],
    } as unknown as PiInvocation;
    const state = await harness(repositoryRoot, { piInvocation: mutable });

    await expect(run(repositoryRoot, state.dependencies)).rejects.toMatchObject(
      { stage: "locators" },
    );
    expect(state.locatorCalls).toEqual(["kimi", "pi-invocation"]);
    expect(
      state.commands.some(
        ({ command }) => command === "kimi" || command === "pi",
      ),
    ).toBe(false);
  });

  it("rejects a frozen Windows Pi invocation that substitutes another absolute executable", async () => {
    const repositoryRoot = await tempRepository();
    const invocation = Object.freeze({
      ...verifiedPiInvocation(),
      executable: "C:\\OtherRuntime\\node.exe",
    });
    const state = await harness(repositoryRoot, { piInvocation: invocation });

    await expect(run(repositoryRoot, state.dependencies)).rejects.toMatchObject(
      { stage: "locators" },
    );
    expect(state.locatorCalls).toEqual(["kimi", "pi-invocation"]);
    expect(
      state.commands.some(
        ({ command }) => command === "kimi" || command === "pi",
      ),
    ).toBe(false);
  });

  it("keeps POSIX preflight on the legacy Pi string locator only", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot, { platform: "linux" });

    await run(repositoryRoot, state.dependencies);

    expect(state.locatorCalls).toEqual(["kimi", "pi-legacy"]);
    expect(
      state.commands.some(
        ({ command }) => command === "kimi" || command === "pi",
      ),
    ).toBe(false);
  });

  it("rejects malformed authorization hashes without invoking dependencies", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);

    await expect(
      runQualificationPreflight(
        {
          repositoryRoot,
          authorizationReferenceSha256: "not-a-hash",
          lockDirectory: "unused",
          currentOwnerNonce: "unused",
        },
        state.dependencies,
      ),
    ).rejects.toMatchObject({ stage: "input" });
    expect(state.commands).toHaveLength(0);
    expect(state.authorizationChecks).toBe(0);
  });
});

describe("frozen candidate integration helpers", () => {
  it("allows only new files beneath the current immutable batch directory", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);
    const preflight = await run(repositoryRoot, state.dependencies);
    state.commands.splice(0);
    const batchId = "batch-2026-07-26";
    const dependencies: QualificationPreflightDependencies = {
      ...state.dependencies,
      runCommand: async (request) => {
        state.commands.push(request);
        if (request.command === "git" && request.args[0] === "status") {
          return {
            exitCode: 0,
            stdout:
              `?? docs/smoke/evidence/batches/${batchId}/checkpoints/000000.json\n` +
              `?? docs/smoke/evidence/batches/${batchId}/cases/01.json\n`,
          };
        }
        if (request.command === "git" && request.args[0] === "rev-parse") {
          return { exitCode: 0, stdout: `${commit}\n` };
        }
        throw new Error("unexpected command");
      },
    };

    await expect(
      assertQualificationFrozenCandidate(
        { repositoryRoot, batchId, preflight },
        dependencies,
      ),
    ).resolves.toBeUndefined();
    expect(state.commands.map((request) => request.command)).toEqual([
      "git",
      "git",
      "git",
      "git",
    ]);
  });

  it.each([
    ["unrelated untracked file", "?? unrelated.txt\n"],
    ["tracked source drift", " M src/qualification/preflight.ts\n"],
    [
      "other batch file",
      "?? docs/smoke/evidence/batches/other-batch/cases/01.json\n",
    ],
  ])("rejects frozen candidate workspace drift: %s", async (_label, status) => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);
    const preflight = await run(repositoryRoot, state.dependencies);
    const dependencies: QualificationPreflightDependencies = {
      ...state.dependencies,
      runCommand: async (request) => {
        if (request.command === "git" && request.args[0] === "status") {
          return { exitCode: 0, stdout: status };
        }
        if (request.command === "git" && request.args[0] === "rev-parse") {
          return { exitCode: 0, stdout: commit };
        }
        throw new Error("unexpected command");
      },
    };

    await expect(
      assertQualificationFrozenCandidate(
        {
          repositoryRoot,
          batchId: "batch-2026-07-26",
          preflight,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({
      stage: "frozen_candidate",
      message: "Qualification preflight failed",
    });
  });

  it("rejects frozen candidate commit or artifact drift", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);
    const preflight = await run(repositoryRoot, state.dependencies);
    const commandDependencies: QualificationPreflightDependencies = {
      ...state.dependencies,
      runCommand: async (request) => {
        if (request.command === "git" && request.args[0] === "status") {
          return { exitCode: 0, stdout: "" };
        }
        return { exitCode: 0, stdout: "d".repeat(40) };
      },
    };
    await expect(
      assertQualificationFrozenCandidate(
        {
          repositoryRoot,
          batchId: "batch-2026-07-26",
          preflight,
        },
        commandDependencies,
      ),
    ).rejects.toMatchObject({ stage: "frozen_candidate" });

    await writeFile(
      path.join(
        repositoryRoot,
        ...QUALIFICATION_BUILD_ARTIFACT_PATHS[0]!.split("/"),
      ),
      "post-batch-artifact-drift\n",
    );
    await expect(
      assertQualificationFrozenCandidate(
        {
          repositoryRoot,
          batchId: "batch-2026-07-26",
          preflight,
        },
        {
          ...commandDependencies,
          runCommand: async (request) =>
            request.args[0] === "status"
              ? { exitCode: 0, stdout: "" }
              : { exitCode: 0, stdout: commit },
        },
      ),
    ).rejects.toMatchObject({ stage: "frozen_candidate" });
  });

  it("rechecks allowed workspace state after hashing the artifacts", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);
    const preflight = await run(repositoryRoot, state.dependencies);
    let statusCalls = 0;

    await expect(
      assertQualificationFrozenCandidate(
        {
          repositoryRoot,
          batchId: "batch-2026-07-26",
          preflight,
        },
        {
          ...state.dependencies,
          runCommand: async (request) => {
            if (request.args[0] === "status") {
              statusCalls += 1;
              return {
                exitCode: 0,
                stdout:
                  statusCalls === 1
                    ? ""
                    : " M src/qualification/preflight.ts\n",
              };
            }
            return { exitCode: 0, stdout: commit };
          },
        },
      ),
    ).rejects.toMatchObject({ stage: "frozen_candidate" });
    expect(statusCalls).toBe(2);
  });

  it("rechecks HEAD after artifact hashing and the final workspace snapshot", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);
    const preflight = await run(repositoryRoot, state.dependencies);
    let commitCalls = 0;

    await expect(
      assertQualificationFrozenCandidate(
        {
          repositoryRoot,
          batchId: "batch-2026-07-26",
          preflight,
        },
        {
          ...state.dependencies,
          runCommand: async (request) => {
            if (request.args[0] === "status") {
              return { exitCode: 0, stdout: "" };
            }
            commitCalls += 1;
            return {
              exitCode: 0,
              stdout: commitCalls === 1 ? commit : "d".repeat(40),
            };
          },
        },
      ),
    ).rejects.toMatchObject({ stage: "frozen_candidate" });
    expect(commitCalls).toBe(2);
  });

  it("collects the verifier current snapshot without gates or authorization checks", async () => {
    const repositoryRoot = await tempRepository();
    const state = await harness(repositoryRoot);
    const forbidden = async () => {
      throw new Error("forbidden full-preflight dependency");
    };
    const snapshot = await collectQualificationCurrentSnapshot(
      { repositoryRoot },
      {
        ...state.dependencies,
        assertAuthorizationUnused: forbidden,
      },
    );

    expect(snapshot).toMatchObject({
      repositoryCommit: commit,
      packageVersion: "0.1.1-beta.1",
      runtimeVersions: {
        node: "v24.0.0",
        codex: "codex-cli 0.135.0",
      },
      piConfigSha256,
    });
    expect(snapshot.buildArtifacts.map((artifact) => artifact.path)).toEqual(
      QUALIFICATION_BUILD_ARTIFACT_PATHS,
    );
    expect(snapshot.logicalLlms).toHaveLength(4);
    expect(snapshot.credentialMatches).toHaveLength(4);
    expect(
      state.commands.map(commandStage).filter((stage) => stage !== "other"),
    ).toEqual([]);
    expect(state.authorizationChecks).toBe(0);
    expect(state.locatorCalls).toEqual(["kimi", "pi-invocation"]);
    expect(
      state.commands.some(({ command }) => command === "kimi" || command === "pi"),
    ).toBe(false);
    expect(state.removedCodexHomes).toEqual(state.codexHomes);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("does not expose a dead proxy preflight dependency", () => {
    type HasProxyDependency =
      "checkProxy10808" extends keyof QualificationPreflightDependencies
        ? true
        : false;
    expectTypeOf<HasProxyDependency>().toEqualTypeOf<false>();
  });

  it("does not expose the removed whole-machine process scanner dependency", () => {
    type HasTargetScannerDependency =
      "classifyTargetProcesses" extends keyof QualificationPreflightDependencies
        ? true
        : false;
    expectTypeOf<HasTargetScannerDependency>().toEqualTypeOf<false>();
  });

  it("does not expose the ambiguous cross-platform Pi string locator", () => {
    type HasAmbiguousPiLocator =
      "locatePiExecutable" extends keyof QualificationPreflightDependencies
        ? true
        : false;
    expectTypeOf<HasAmbiguousPiLocator>().toEqualTypeOf<false>();
  });
});
