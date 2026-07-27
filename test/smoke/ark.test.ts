import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AdapterExecutionTelemetry } from "../../src/adapters/adapter.js";
import {
  parseArkSmokeArguments,
  runArkSmoke,
} from "../../src/smoke/ark.js";
import {
  buildPiDelegateSmokeContract,
  type PiSmokeService,
} from "../../src/smoke/pi.js";

const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-ark-smoke-test-${process.pid}-${Date.now()}-${roots.length}`,
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

const validPiTelemetry: AdapterExecutionTelemetry = {
  adapterClientInvocationCount: 1,
  adapterRetryCount: 0,
  runtimeReportedAutoRetryCount: 0,
  adapterReportedFallbackUsed: false,
  source: "pi-rpc-observable",
};

const qualificationContext = {
  qualificationPlanId: "four-llm-v1" as const,
  batchId: "2026-07-26T12-00-00Z-a1b2c3d4",
  ordinal: 5,
  llm: "ark-agent-plan",
  task: "review" as const,
  frozenCommit: "a".repeat(40),
  frozenBuildIdentity: "b".repeat(64),
  authorizationReferenceSha256: "c".repeat(64),
  orchestratorFallbackUsed: false as const,
};

describe("Ark real-smoke harness", () => {
  it.each([
    "ark-coding-plan",
    "ark-agent-plan",
    "ark-agent-deepseek-v4-flash",
  ])("accepts registered Ark Pi profile %s", (llm) => {
    expect(
      parseArkSmokeArguments(["--llm", llm, "--task", "review"]),
    ).toEqual({ llm, task: "review" });
  });

  it("rejects non-Ark and incomplete arguments", () => {
    expect(() =>
      parseArkSmokeArguments([
        "--llm",
        "gemini-3.5-flash",
        "--task",
        "review",
      ]),
    ).toThrow(/Ark Pi profile/u);
    expect(() => parseArkSmokeArguments(["--task", "review"])).toThrow(
      /--llm/u,
    );
  });

  it("records fixed Agent Plan identity, endpoint, isolation, and review evidence", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async (_input, context) => {
        context?.onExecutionTelemetry?.(validPiTelemetry);
        return {
          ok: true,
          status: "completed",
          llm: "ark-agent-plan",
          actualModel: "ark-code-latest",
          elapsedMs: 10,
          diagnostics: [],
          filesChanged: [],
          review: "Empty input has length zero, so division returns NaN at average.js:2.",
        };
      },
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runArkSmoke(
      {
        llm: "ark-agent-plan",
        task: "review",
        tempRoot: root,
        qualificationContext,
      },
      {
        service,
        runtimeEvidence: {
          configSha256: "b".repeat(64),
          childEnvironment: {
            CODEX_AGENT_ARK_AGENT_KEY: "secret",
            PI_CODING_AGENT_DIR: "C:\\cache\\pi",
          },
        },
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [101],
        now: () => new Date("2026-07-18T00:00:00.000Z"),
      },
    );

    expect(evidence).toMatchObject({
      schemaVersion: 3,
      qualification: qualificationContext,
      llm: "ark-agent-plan",
      provider: "ark-agent-plan",
      actualModel: "ark-code-latest",
      expectedModel: "ark-code-latest",
      endpointHost: "ark.cn-beijing.volces.com",
      credentialEnv: "CODEX_AGENT_ARK_AGENT_KEY",
      passed: true,
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      orchestratorFallbackUsed: false,
      executionTelemetrySource: "pi-rpc-observable",
      failureReason: null,
      checks: {
        environmentIsolated: true,
        workspaceUnchanged: true,
        knownDefectFound: true,
      },
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    {
      llm: "ark-coding-plan",
      actualModel: "ark-code-latest",
      provider: "ark-coding-plan",
      credentialEnv: "CODEX_AGENT_ARK_CODING_KEY",
    },
    {
      llm: "ark-agent-plan",
      actualModel: "ark-code-latest",
      provider: "ark-agent-plan",
      credentialEnv: "CODEX_AGENT_ARK_AGENT_KEY",
    },
    {
      llm: "ark-agent-deepseek-v4-flash",
      actualModel: "deepseek-v4-flash",
      provider: "ark-agent-plan",
      credentialEnv: "CODEX_AGENT_ARK_AGENT_KEY",
    },
  ] as const)(
    "uses the exact delegate contract for $llm",
    async ({ llm, actualModel, provider, credentialEnv }) => {
      const root = await tempRoot();
      const contract = buildPiDelegateSmokeContract(llm);
      let receivedPrompt = "";
      const service: PiSmokeService = {
        review: async () => {
          throw new Error("not used");
        },
        delegate: async (input, context) => {
          context?.onExecutionTelemetry?.(validPiTelemetry);
          receivedPrompt = input.prompt;
          await writeFile(
            path.join(input.cwd, contract.resultFileName),
            `${contract.expectedLine}\n`,
            "utf8",
          );
          return {
            ok: true,
            status: "completed",
            llm,
            actualModel,
            elapsedMs: 10,
            diagnostics: [],
            filesChanged: [contract.resultFileName],
            summary: "created and verified",
            commandsRun: ["git status --short"],
            verification: [],
            risks: [],
          };
        },
      };

      const evidence = await runArkSmoke(
        { llm, task: "delegate", tempRoot: root },
        {
          service,
          runtimeEvidence: {
            configSha256: "c".repeat(64),
            childEnvironment: {
              [credentialEnv]: "secret",
              PI_CODING_AGENT_DIR: "C:\\cache\\pi",
            },
          },
          readPiVersion: async () => "0.80.10",
          listPiRpcProcessIds: async () => [],
        },
      );

      expect(receivedPrompt).toBe(contract.prompt);
      expect(evidence.passed).toBe(true);
      expect(evidence).toMatchObject({
        llm,
        actualModel,
        expectedModel: actualModel,
        provider,
        credentialEnv,
        filesChanged: [contract.resultFileName],
        resultFileReadStatus: "read",
        resultFileByteLength: Buffer.byteLength(
          `${contract.expectedLine}\n`,
        ),
        resultFileRawSha256: sha256(`${contract.expectedLine}\n`),
        resultFileNormalizedSha256: sha256(contract.expectedLine),
        expectedResultNormalizedSha256: sha256(contract.expectedLine),
        resultFileNormalizedLineCount: 1,
        resultFileContainsExpectedLine: true,
        checks: {
          resultFileValid: true,
          resultFileObserved: true,
          onlyExpectedFileChanged: true,
          requiredCommandObserved: true,
          environmentIsolated: true,
          noNewPiRpcProcesses: true,
        },
      });
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("records a stable quota failure code without persisting raw diagnostics", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async () => ({
        ok: false,
        status: "failed",
        llm: "ark-agent-plan",
        actualModel: "ark-code-latest",
        elapsedMs: 10,
        diagnostics: ["429 AccountQuotaExceeded: weekly usage quota"],
        filesChanged: [],
        review: "",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runArkSmoke(
      { llm: "ark-agent-plan", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: {
          configSha256: "d".repeat(64),
          childEnvironment: {
            CODEX_AGENT_ARK_AGENT_KEY: "secret",
            PI_CODING_AGENT_DIR: "C:\\cache\\pi",
          },
        },
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [],
      },
    );

    expect(evidence.failureReason).toBe("account_quota_exceeded");
    expect(JSON.stringify(evidence)).not.toContain("weekly usage quota");
  });

  it("does not classify retired Google free-tier quota text as an active reason", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async () => ({
        ok: false,
        status: "failed",
        llm: "ark-agent-plan",
        actualModel: "ark-code-latest",
        elapsedMs: 10,
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

    const evidence = await runArkSmoke(
      { llm: "ark-agent-plan", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: {
          configSha256: "e".repeat(64),
          childEnvironment: {
            CODEX_AGENT_ARK_AGENT_KEY: "secret",
            PI_CODING_AGENT_DIR: "C:\\cache\\pi",
          },
        },
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [],
      },
    );

    expect(evidence.failureReason).toBe("adapter_failure");
  });

  it("rejects an Ark case when the adapter reports fallback", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async (_input, context) => {
        context?.onExecutionTelemetry?.({
          ...validPiTelemetry,
          adapterReportedFallbackUsed: true,
        });
        return {
          ok: true,
          status: "completed",
          llm: "ark-agent-plan",
          actualModel: "ark-code-latest",
          elapsedMs: 10,
          diagnostics: [],
          filesChanged: [],
          review: "Empty input has length zero and produces NaN.",
        };
      },
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runArkSmoke(
      { llm: "ark-agent-plan", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: {
          configSha256: "f".repeat(64),
          childEnvironment: {
            CODEX_AGENT_ARK_AGENT_KEY: "secret",
            PI_CODING_AGENT_DIR: "C:\\cache\\pi",
          },
        },
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [],
      },
    );

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.executionTelemetryValid).toBe(false);
  });
});
