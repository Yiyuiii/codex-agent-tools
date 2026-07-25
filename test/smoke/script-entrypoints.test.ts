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
  runSmoke: (options: {
    llm: string;
    task: SmokeTask;
    onProgress: (message: string) => void;
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
    name: "Pi/Gemini",
    script: "scripts/real-pi-smoke.mjs",
    llm: "gemini-3.5-flash",
    task: "delegate" as const,
    expectedFile:
      "2026-07-25T01-02-03.000Z-gemini-3.5-flash-delegate-pi.json",
    expectedRuntime: "pi-rpc",
    expectedRoute: "proxy-10808",
    expectedKind: "pi",
    distModule: "dist/pi-smoke.js",
    parserExport: "parsePiSmokeArguments",
    runnerExport: "runPiSmoke",
    usage:
      "Usage: npm run smoke:pi -- --llm gemini-3.5-flash --task review|delegate\n",
  },
  {
    name: "Ark",
    script: "scripts/real-ark-smoke.mjs",
    llm: "ark-agent-plan",
    task: "review" as const,
    expectedFile:
      "2026-07-25T01-02-03.000Z-ark-agent-plan-review-ark.json",
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
    const packageJson = JSON.parse(
      await readFile("package.json", "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.pretest).toBe("npm run build:library");
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
      expect(module.productionConfig.parseArguments).toBe(
        dist[parserExport],
      );
      expect(module.productionConfig.runSmoke).toBe(dist[runnerExport]);
    },
  );

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
        "Smoke failed; sanitized evidence was written.\n",
      );
      expect(stderr).not.toContain(secret);
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
