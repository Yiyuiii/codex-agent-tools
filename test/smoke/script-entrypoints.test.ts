import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

type SmokeTask = "review" | "delegate";

interface ScriptMainOptions {
  args: string[];
  evidenceDirectory: string;
  qualificationContext?: {
    qualificationPlanId: "four-llm-v1";
    batchId: string;
    ordinal: number;
    llm: string;
    task: SmokeTask;
    frozenCommit: string;
    frozenBuildIdentity: string;
    authorizationReferenceSha256: string;
    orchestratorFallbackUsed: false;
  };
  runSmoke: (options: {
    llm: string;
    task: SmokeTask;
    onProgress: (message: string) => void;
    qualificationContext?: ScriptMainOptions["qualificationContext"];
  }) => Promise<never>;
  now: () => Date;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

interface SmokeScriptModule {
  main?: (options: ScriptMainOptions) => Promise<number>;
  productionConfig?: {
    kind: string;
    parseArguments: unknown;
    runSmoke: unknown;
  };
}

interface RealSmokeMainModule {
  runRealSmokeMain?: (
    config: {
      kind: "kimi";
      usage: string;
      parseArguments: (args: readonly string[]) => {
        llm: string;
        task: SmokeTask;
      };
      runSmoke: ScriptMainOptions["runSmoke"];
      evidenceDirectory: string;
    },
    options: Omit<ScriptMainOptions, "evidenceDirectory">,
  ) => Promise<number>;
}

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-script-smoke-test-${process.pid}-${Date.now()}-${roots.length}`,
  );
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}

async function importSmokeScript(script: string): Promise<SmokeScriptModule> {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  process.argv = [process.execPath];
  try {
    const url = pathToFileURL(path.resolve(script));
    url.searchParams.set("vitest", `${Date.now()}-${Math.random()}`);
    return (await import(url.href)) as SmokeScriptModule;
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  }
}

async function importRealSmokeMain(): Promise<RealSmokeMainModule> {
  const url = pathToFileURL(path.resolve("scripts/real-smoke-main.mjs"));
  url.searchParams.set("vitest", `${Date.now()}-${Math.random()}`);
  return (await import(url.href)) as RealSmokeMainModule;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const scripts = [
  {
    name: "Kimi",
    script: "scripts/real-kimi-smoke.mjs",
    llm: "kimi-k3",
    task: "review" as const,
    expectedFile: "2026-07-25T01-02-03.000Z-kimi-k3-review.json",
    expectedRuntime: "kimi-acp",
    expectedRoute: "direct",
    expectedKind: "kimi",
    distModule: "dist/kimi-smoke.js",
    parserExport: "parseKimiSmokeArguments",
    runnerExport: "runKimiSmoke",
    usage:
      "Usage: npm run smoke:kimi -- --llm <logical-id> --task review|delegate\n",
  },
  {
    name: "Ark",
    script: "scripts/real-ark-smoke.mjs",
    llm: "ark-agent-plan",
    task: "review" as const,
    expectedFile: "2026-07-25T01-02-03.000Z-ark-agent-plan-review-ark.json",
    expectedRuntime: "pi-rpc",
    expectedRoute: "direct",
    expectedKind: "ark",
    distModule: "dist/ark-smoke.js",
    parserExport: "parseArkSmokeArguments",
    runnerExport: "runArkSmoke",
    usage:
      "Usage: npm run smoke:ark -- --llm <ark-logical-id> --task review|delegate\n",
  },
] as const;

describe("production real-smoke script entrypoints", () => {
  it("builds the library before npm test loads production scripts", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.pretest).toBe("npm run build:library");
  });

  it("does not expose a standalone Pi smoke script or build entry", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const tsupSource = await readFile("tsup.config.ts", "utf8");

    expect(packageJson.scripts).not.toHaveProperty("smoke:pi");
    expect(tsupSource).not.toMatch(/["']pi-smoke["']\s*:/u);
  });

  it.each(scripts)(
    "$name freezes the exact production parser and runner binding",
    async ({
      script,
      expectedKind,
      distModule,
      parserExport,
      runnerExport,
    }) => {
      const module = await importSmokeScript(script);
      expect(module.productionConfig).toBeDefined();
      if (module.productionConfig === undefined) return;

      const distUrl = pathToFileURL(path.resolve(distModule));
      const dist = (await import(distUrl.href)) as Record<string, unknown>;
      expect(Object.isFrozen(module.productionConfig)).toBe(true);
      expect(module.productionConfig.kind).toBe(expectedKind);
      expect(module.productionConfig.parseArguments).toBe(dist[parserExport]);
      expect(module.productionConfig.runSmoke).toBe(dist[runnerExport]);
    },
  );

  it("requires a programmatic final case directory for qualification mode", async () => {
    const common = await importRealSmokeMain();
    expect(common.runRealSmokeMain).toBeTypeOf("function");
    if (common.runRealSmokeMain === undefined) return;

    const root = await tempRoot();
    let runnerCalls = 0;
    let stderr = "";
    const exitCode = await common.runRealSmokeMain(
      {
        kind: "kimi",
        usage: "unused",
        parseArguments: (args) => {
          expect(args).toEqual(["--llm", "kimi-k3", "--task", "review"]);
          return { llm: "kimi-k3", task: "review" };
        },
        runSmoke: async () => {
          runnerCalls += 1;
          throw new Error("must not run");
        },
        evidenceDirectory: path.join(root, "standalone"),
      },
      {
        args: ["--llm", "kimi-k3", "--task", "review"],
        qualificationContext: {
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
        runSmoke: async () => {
          runnerCalls += 1;
          throw new Error("must not run");
        },
        now: () => new Date("2026-07-25T01:02:03.000Z"),
        writeStdout: () => {},
        writeStderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(runnerCalls).toBe(0);
    expect(stderr).toBe(
      "Smoke qualification evidence directory is required.\n",
    );
    expect(await readdir(root)).toEqual([]);
  });

  it.each(scripts)(
    "$name uses the injected runner and writes sanitized failure evidence",
    async ({
      script,
      llm,
      task,
      expectedFile,
      expectedRuntime,
      expectedRoute,
    }) => {
      const module = await importSmokeScript(script);
      expect(module.main).toBeTypeOf("function");
      if (module.main === undefined) return;

      const root = await tempRoot();
      const evidenceDirectory = path.join(root, "evidence");
      const secret = `${llm}_SCRIPT_SECRET_SENTINEL`;
      let runnerCalls = 0;
      let receivedOptions: { llm: string; task: SmokeTask } | undefined;
      let stdout = "";
      let stderr = "";

      const exitCode = await module.main({
        args: ["--llm", llm, "--task", task],
        evidenceDirectory,
        runSmoke: async (options) => {
          runnerCalls += 1;
          receivedOptions = options;
          options.onProgress(secret);
          throw new Error(secret);
        },
        now: () => new Date("2026-07-25T01:02:03.000Z"),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });

      expect(exitCode).toBe(1);
      expect(runnerCalls).toBe(1);
      expect(receivedOptions).toMatchObject({ llm, task });
      expect(await readdir(evidenceDirectory)).toEqual([expectedFile]);
      const json = await readFile(
        path.join(evidenceDirectory, expectedFile),
        "utf8",
      );
      expect(JSON.parse(json)).toMatchObject({
        llm,
        task,
        runtime: expectedRuntime,
        route: expectedRoute,
        passed: false,
        failureReason: "infrastructure_failure",
        failure: {
          category: "infrastructure",
          stage: "smoke_execution",
          count: 1,
        },
      });
      expect(json).not.toContain(secret);
      expect(stdout).not.toContain(secret);
      expect(stderr).toBe(
        `[${module.productionConfig?.kind ?? "unknown"} smoke] activity\n` +
          "Smoke failed; sanitized evidence was written.\n",
      );
      expect(stderr).not.toContain(secret);
    },
  );

  const qualificationScripts = [scripts[0], scripts[1]] as const;

  it.each(qualificationScripts)(
    "$name programmatically binds qualification context and a batch case directory",
    async ({ script, llm, task, expectedFile }) => {
      const module = await importSmokeScript(script);
      expect(module.main).toBeTypeOf("function");
      if (module.main === undefined) return;

      const root = await tempRoot();
      const qualificationContext = {
        qualificationPlanId: "four-llm-v1" as const,
        batchId: "2026-07-26T12-00-00Z-a1b2c3d4",
        ordinal: llm === "kimi-k3" ? 3 : 5,
        llm,
        task,
        frozenCommit: "a".repeat(40),
        frozenBuildIdentity: "b".repeat(64),
        authorizationReferenceSha256: "c".repeat(64),
        orchestratorFallbackUsed: false as const,
      };
      const caseDirectory = path.join(
        root,
        "evidence",
        "batches",
        qualificationContext.batchId,
        "cases",
      );
      let receivedContext: unknown;
      let stdout = "";

      const exitCode = await module.main({
        args: ["--llm", llm, "--task", task],
        evidenceDirectory: caseDirectory,
        qualificationContext,
        runSmoke: async (options) => {
          receivedContext = options.qualificationContext;
          throw new Error("sanitized infrastructure failure");
        },
        now: () => new Date("2026-07-25T01:02:03.000Z"),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: () => {},
      });

      expect(exitCode).toBe(1);
      expect(receivedContext).toEqual(qualificationContext);
      expect(await readdir(caseDirectory)).toEqual([expectedFile]);
      expect(
        await readdir(
          path.join(
            caseDirectory,
            "batches",
            qualificationContext.batchId,
            "cases",
          ),
        ).catch(() => []),
      ).toEqual([]);
      const evidence = JSON.parse(
        await readFile(path.join(caseDirectory, expectedFile), "utf8"),
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
        `docs/smoke/evidence/batches/${qualificationContext.batchId}/cases/${expectedFile}`,
      );
    },
  );

  it.each(scripts)(
    "$name does not expose qualification through public CLI arguments",
    async ({ script, llm }) => {
      const module = await importSmokeScript(script);
      expect(module.main).toBeTypeOf("function");
      if (module.main === undefined) return;

      const root = await tempRoot();
      let runnerCalls = 0;
      let stderr = "";
      const exitCode = await module.main({
        args: ["--llm", llm, "--task", "review", "--batch", "forbidden"],
        evidenceDirectory: path.join(root, "evidence"),
        runSmoke: async () => {
          runnerCalls += 1;
          throw new Error("must not run");
        },
        now: () => new Date("2026-07-25T01:02:03.000Z"),
        writeStdout: () => {},
        writeStderr: (text) => {
          stderr += text;
        },
      });

      expect(exitCode).toBe(1);
      expect(runnerCalls).toBe(0);
      expect(stderr).toBe("Smoke arguments are invalid.\n");
      expect(await readdir(root)).toEqual([]);
    },
  );

  it.each(scripts)(
    "$name help returns without invoking any runner",
    async ({ script, usage }) => {
      const module = await importSmokeScript(script);
      expect(module.main).toBeTypeOf("function");
      if (module.main === undefined) return;

      const root = await tempRoot();
      let runnerCalls = 0;
      let stdout = "";
      let stderr = "";
      const exitCode = await module.main({
        args: ["--help"],
        evidenceDirectory: path.join(root, "evidence"),
        runSmoke: async () => {
          runnerCalls += 1;
          throw new Error("runner must not be called for help");
        },
        now: () => new Date("2026-07-25T01:02:03.000Z"),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });

      expect(exitCode).toBe(0);
      expect(runnerCalls).toBe(0);
      expect(stdout).toBe(usage);
      expect(stderr).toBe("");
      expect(await readdir(root)).toEqual([]);
    },
  );

  it.each(scripts)(
    "$name direct-execution guard preserves CLI help",
    async ({ script, usage }) => {
      const result = await execa(process.execPath, [script, "--help"], {
        cwd: process.cwd(),
        reject: false,
        timeout: 30_000,
        windowsHide: true,
      });

      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}\n`).toBe(usage);
      expect(result.stderr).toBe("");
    },
  );
});

describe("qualification maintainer script entrypoints", () => {
  it("registers maintainer-only npm scripts without adding public bins", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
      bin?: Record<string, string>;
    };

    expect(packageJson.scripts?.["qualify:gates"]).toBe(
      "tsx scripts/gate-requalification.ts",
    );
    expect(packageJson.scripts?.["verify:qualification"]).toBe(
      "tsx scripts/verify-qualification.ts",
    );
    expect(Object.values(packageJson.bin ?? {})).not.toContain(
      "scripts/gate-requalification.ts",
    );
    expect(Object.values(packageJson.bin ?? {})).not.toContain(
      "scripts/verify-qualification.ts",
    );
  });

  it("accepts only the fixed qualification, recovery, or help command shapes", async () => {
    const { parseGateRequalificationArguments } =
      await import("../../scripts/gate-requalification.js");
    const authorizationReference = "6ce61ce4-02ed-4e95-9813-f30e74ce9af5";

    expect(parseGateRequalificationArguments(["--help"])).toEqual({
      kind: "help",
    });
    expect(
      parseGateRequalificationArguments([
        "--authorization-ref",
        authorizationReference,
      ]),
    ).toEqual({
      kind: "qualify",
      authorizationReference,
    });
    expect(
      parseGateRequalificationArguments([
        "--recover-interrupted",
        "batch-2026-07-26",
      ]),
    ).toEqual({
      kind: "recover",
      batchId: "batch-2026-07-26",
    });

    for (const args of [
      [],
      ["--authorization-ref"],
      ["--authorization-ref", authorizationReference, "--retry"],
      ["--recover-interrupted", "../escape"],
      ["--only", "1"],
      ["--llm", "kimi-k3"],
      ["--model", "kimi-code/k3"],
      ["--provider", "google"],
      ["--retry"],
      ["--resume"],
      ["--fallback"],
      ["--parallel"],
    ]) {
      expect(() => parseGateRequalificationArguments(args)).toThrowError(
        "Invalid gate requalification arguments",
      );
    }
  });

  it("accepts only the two fixed verifier modes and a safe manifest path", async () => {
    const { parseQualificationVerifierArguments } =
      await import("../../scripts/verify-qualification.js");

    expect(parseQualificationVerifierArguments(["--help"])).toEqual({
      kind: "help",
    });
    for (const mode of ["frozen-candidate", "immutable-evidence"] as const) {
      expect(
        parseQualificationVerifierArguments([
          "--mode",
          mode,
          "--manifest",
          "docs/smoke/evidence/batches/batch-1/manifest.json",
        ]),
      ).toEqual({
        kind: "verify",
        mode,
        manifestPath: "docs/smoke/evidence/batches/batch-1/manifest.json",
      });
    }
    for (const args of [
      [],
      ["--mode", "unknown", "--manifest", "manifest.json"],
      ["--mode", "frozen-candidate"],
      [
        "--mode",
        "immutable-evidence",
        "--manifest",
        "../outside/manifest.json",
      ],
      [
        "--mode",
        "immutable-evidence",
        "--manifest",
        "docs/smoke/evidence/batches/b/manifest.json",
        "--write-registry",
      ],
    ]) {
      expect(() => parseQualificationVerifierArguments(args)).toThrowError(
        "Invalid qualification verifier arguments",
      );
    }
  });

  it.each([
    {
      script: "scripts/gate-requalification.ts",
      expected: "Usage: npm run --silent qualify:gates --",
    },
    {
      script: "scripts/verify-qualification.ts",
      expected: "Usage: npm run verify:qualification --",
    },
  ])(
    "$script exposes help without entering production work",
    async ({ script, expected }) => {
      const result = await execa(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["tsx", script, "--help"],
        {
          cwd: process.cwd(),
          reject: false,
          timeout: 30_000,
          windowsHide: true,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(expected);
      expect(result.stderr).toBe("");
    },
  );

  it("keeps the authorization reference out of the prescribed npm entrypoint output", async () => {
    const authorizationReference = "authorization-reference-sentinel";
    const result = await execa(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "run",
        "--silent",
        "qualify:gates",
        "--",
        "--authorization-ref",
        authorizationReference,
      ],
      {
        cwd: process.cwd(),
        reject: false,
        timeout: 30_000,
        windowsHide: true,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      authorizationReference,
    );
  });

  it("routes active qualification cases only through Kimi and Ark smoke entrypoints", async () => {
    const source = await readFile("scripts/gate-requalification.ts", "utf8");

    for (const script of ["./real-kimi-smoke.mjs", "./real-ark-smoke.mjs"]) {
      expect(source).toContain(`import("${script}")`);
    }
    expect(source).not.toContain('import("./real-pi-smoke.mjs")');
    expect(source).not.toContain('identity.llm === "gemini-3.5-flash"');
    expect(source).not.toMatch(/runKimiSmoke|runPiSmoke|runArkSmoke/u);
  });

  it("forwards the recovered lock plan into interrupted manifest recovery", async () => {
    const source = await readFile("scripts/gate-requalification.ts", "utf8");

    expect(source).toMatch(
      /recoverInterruptedQualificationBatch\(\{[\s\S]*?qualificationPlanId:\s*reference\.qualificationPlanId/u,
    );
  });
});
