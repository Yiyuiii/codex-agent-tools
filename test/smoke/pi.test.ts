import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AdapterExecutionTelemetry } from "../../src/adapters/adapter.js";
import {
  parsePiSmokeArguments,
  runPiSmoke,
  type PiSmokeService,
} from "../../src/smoke/pi.js";
import { SmokeInfrastructureError } from "../../src/smoke/evidence.js";

const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-pi-smoke-test-${process.pid}-${Date.now()}-${roots.length}`,
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

function runtimeEvidence(environment: NodeJS.ProcessEnv = {
  GEMINI_API_KEY: "secret",
  HTTP_PROXY: "http://127.0.0.1:10808",
  HTTPS_PROXY: "http://127.0.0.1:10808",
  http_proxy: "http://127.0.0.1:10808",
  https_proxy: "http://127.0.0.1:10808",
  PI_CODING_AGENT_DIR: "C:\\cache\\pi",
}) {
  return {
    configSha256: "a".repeat(64),
    childEnvironment: environment,
  };
}

const validPiTelemetry: AdapterExecutionTelemetry = {
  adapterClientInvocationCount: 1,
  adapterRetryCount: 0,
  runtimeReportedAutoRetryCount: 0,
  adapterReportedFallbackUsed: false,
  source: "pi-rpc-observable",
};

describe("Pi/Gemini real-smoke harness", () => {
  it("requires the fixed Gemini logical id and one task", () => {
    expect(
      parsePiSmokeArguments([
        "--llm",
        "gemini-3.5-flash",
        "--task",
        "review",
      ]),
    ).toEqual({ llm: "gemini-3.5-flash", task: "review" });
    expect(() => parsePiSmokeArguments(["--task", "review"])).toThrow(
      /--llm/u,
    );
    expect(() =>
      parsePiSmokeArguments([
        "--llm",
        "kimi-k3",
        "--task",
        "review",
      ]),
    ).toThrow(/Pi profile/u);
  });

  it("validates review, fixed 10808 environment isolation, and process cleanup", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async (_input, context) => {
        context?.onExecutionTelemetry?.(validPiTelemetry);
        return {
          ok: true,
          status: "completed",
          llm: "gemini-3.5-flash",
          actualModel: "gemini-3.5-flash",
          elapsedMs: 12,
          diagnostics: [],
          filesChanged: [],
          review: "Empty input has length zero, so division returns NaN.",
        };
      },
      delegate: async () => {
        throw new Error("not used");
      },
    };
    const evidence = await runPiSmoke(
      { llm: "gemini-3.5-flash", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
        now: () => new Date("2026-07-18T00:00:00.000Z"),
      },
    );
    expect(evidence).toMatchObject({
      llm: "gemini-3.5-flash",
      task: "review",
      actualModel: "gemini-3.5-flash",
      piVersion: "0.80.10",
      route: "proxy-10808",
      credentialEnv: "GEMINI_API_KEY",
      passed: true,
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      executionTelemetrySource: "pi-rpc-observable",
      checks: {
        actualModelMatches: true,
        environmentIsolated: true,
        noNewPiRpcProcesses: true,
        workspaceUnchanged: true,
        knownDefectFound: true,
      },
    });
    expect(evidence.configSha256).toBe("a".repeat(64));
    expect(await readdir(root)).toEqual([]);
  });

  it("classifies Google free-tier quota failures without storing diagnostics", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async () => ({
        ok: false,
        status: "failed",
        llm: "gemini-3.5-flash",
        actualModel: "gemini-3.5-flash",
        elapsedMs: 60_010,
        diagnostics: [
          "generate_content_free_tier_requests; Please retry in 30s.",
        ],
        filesChanged: [],
        review: "",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runPiSmoke(
      { llm: "gemini-3.5-flash", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
      },
    );

    expect(evidence.failureReason).toBe("google_free_tier_quota");
    expect(evidence.diagnosticCount).toBe(1);
    expect(evidence).not.toHaveProperty("diagnostics");
  });

  it("validates delegate file and command evidence", async () => {
    const root = await tempRoot();
    let receivedPrompt = "";
    const service: PiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input, context) => {
        context?.onExecutionTelemetry?.(validPiTelemetry);
        receivedPrompt = input.prompt;
        await writeFile(path.join(input.cwd, "result.txt"), "PI_SMOKE_OK\n", "utf8");
        return {
          ok: true,
          status: "completed",
          llm: "gemini-3.5-flash",
          actualModel: "gemini-3.5-flash",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: ["result.txt"],
          summary: "Created result.txt and ran git status.",
          commandsRun: ["git status --short"],
          verification: [],
          risks: [],
        };
      },
    };
    const evidence = await runPiSmoke(
      { llm: "gemini-3.5-flash", task: "delegate", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
      },
    );
    expect(evidence).toMatchObject({
      passed: true,
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      executionTelemetrySource: "pi-rpc-observable",
      filesChanged: ["result.txt"],
      commandCount: 1,
      resultFileReadStatus: "read",
      resultFileByteLength: Buffer.byteLength("PI_SMOKE_OK\n"),
      resultFileRawSha256: sha256("PI_SMOKE_OK\n"),
      resultFileNormalizedSha256: sha256("PI_SMOKE_OK"),
      expectedResultNormalizedSha256: sha256("PI_SMOKE_OK"),
      resultFileNormalizedLineCount: 1,
      resultFileContainsExpectedLine: true,
      checks: {
        resultFileValid: true,
        resultFileObserved: true,
        onlyExpectedFileChanged: true,
        requiredCommandObserved: true,
        noNewPiRpcProcesses: true,
      },
    });
    expect(receivedPrompt).toContain("Both actions are mandatory");
    expect(receivedPrompt).toContain("bash tool with the exact command `git status --short`");
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    [["pwd"], "unrelated command"],
    [["echo x && git status --short"], "compound command"],
    [["bash"], "tool title only"],
  ])(
    "rejects %s as %s rather than exact command evidence",
    async (commandsRun) => {
      const root = await tempRoot();
      const service: PiSmokeService = {
        review: async () => {
          throw new Error("not used");
        },
        delegate: async (input) => {
          await writeFile(
            path.join(input.cwd, "result.txt"),
            "PI_SMOKE_OK\n",
            "utf8",
          );
          return {
            ok: true,
            status: "completed",
            llm: "gemini-3.5-flash",
            actualModel: "gemini-3.5-flash",
            elapsedMs: 15,
            diagnostics: [],
            filesChanged: ["result.txt"],
            summary: "Tool event claimed git status --short.",
            commandsRun,
            verification: [],
            risks: [],
          };
        },
      };

      const evidence = await runPiSmoke(
        { llm: "gemini-3.5-flash", task: "delegate", tempRoot: root },
        {
          service,
          runtimeEvidence: runtimeEvidence(),
          readPiVersion: async () => "0.80.10",
          listPiRpcProcessIds: async () => [100],
        },
      );

      expect(evidence.passed).toBe(false);
      expect(evidence.checks.requiredCommandObserved).toBe(false);
      expect(evidence).not.toHaveProperty("commandsRun");
      expect(JSON.stringify(evidence)).not.toContain(commandsRun[0]);
    },
  );

  it("fails when a forbidden credential or proxy reaches the Pi child", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "gemini-3.5-flash",
        actualModel: "gemini-3.5-flash",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "Empty array length zero produces NaN.",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };
    const evidence = await runPiSmoke(
      { llm: "gemini-3.5-flash", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence({
          GEMINI_API_KEY: "secret",
          ANTHROPIC_API_KEY: "forbidden",
          HTTPS_PROXY: "http://127.0.0.1:11808",
          PI_CODING_AGENT_DIR: "C:\\cache\\pi",
        }),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
      },
    );
    expect(evidence.passed).toBe(false);
    expect(evidence.checks.environmentIsolated).toBe(false);
  });

  it.each([
    ["missing observer", undefined],
    ["null telemetry", null],
    [
      "multiple client invocations",
      { ...validPiTelemetry, adapterClientInvocationCount: 2 },
    ],
    ["adapter retry", { ...validPiTelemetry, adapterRetryCount: 1 }],
    [
      "runtime retry",
      { ...validPiTelemetry, runtimeReportedAutoRetryCount: 1 },
    ],
    [
      "reported fallback",
      { ...validPiTelemetry, adapterReportedFallbackUsed: true },
    ],
  ] as const)("fails qualification telemetry gate for %s", async (_name, telemetry) => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async (_input, context) => {
        if (telemetry !== undefined) {
          context?.onExecutionTelemetry?.(telemetry);
        }
        return {
          ok: true,
          status: "completed",
          llm: "gemini-3.5-flash",
          actualModel: "gemini-3.5-flash",
          elapsedMs: 12,
          diagnostics: [],
          filesChanged: [],
          review: "Empty input has length zero and produces NaN.",
        };
      },
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runPiSmoke(
      { llm: "gemini-3.5-flash", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
      },
    );

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.executionTelemetryValid).toBe(false);
  });

  it("labels a Pi version-probe exception without exposing its original message", async () => {
    const root = await tempRoot();
    const secret = "PI_VERSION_SECRET_SENTINEL";
    const service: PiSmokeService = {
      review: async () => {
        throw new Error("not reached");
      },
      delegate: async () => {
        throw new Error("not reached");
      },
    };

    const failure = await runPiSmoke(
      { llm: "gemini-3.5-flash", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => {
          throw new Error(secret);
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmokeInfrastructureError);
    expect(failure).toMatchObject({
      message: "Smoke infrastructure failure",
      stage: "version_probe",
    });
    expect(String(failure)).not.toContain(secret);
    expect(await readdir(root)).toEqual([]);
  });

  it("labels a missing post-task Pi snapshot and records the baseline count", async () => {
    const root = await tempRoot();
    const secret = "PI_POST_SNAPSHOT_SECRET_SENTINEL";
    let calls = 0;
    const service: PiSmokeService = {
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "gemini-3.5-flash",
        actualModel: "gemini-3.5-flash",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "Empty input has length zero and produces NaN.",
      }),
      delegate: async () => {
        throw new Error("not reached");
      },
    };

    const failure = await runPiSmoke(
      { llm: "gemini-3.5-flash", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => {
          if (calls++ === 0) return [100, 101];
          throw new Error(secret);
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmokeInfrastructureError);
    expect(failure).toMatchObject({
      message: "Smoke infrastructure failure",
      stage: "post_process_snapshot",
      counts: { processIdsBefore: 2 },
    });
    expect(String(failure)).not.toContain(secret);
    expect(await readdir(root)).toEqual([]);
  });
});
