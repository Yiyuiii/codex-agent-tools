import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AdapterExecutionTelemetry } from "../../src/adapters/adapter.js";
import {
  parseDeepSeekSmokeArguments,
  runDeepSeekSmoke,
} from "../../src/smoke/deepseek.js";
import type { PiSmokeService } from "../../src/smoke/pi.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-deepseek-smoke-test-${process.pid}-${Date.now()}-${roots.length}`,
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
  ownedProcessDrained: true,
};

describe("DeepSeek real-smoke harness", () => {
  it("accepts only the fixed direct DeepSeek logical LLM", () => {
    expect(
      parseDeepSeekSmokeArguments([
        "--llm",
        "deepseek-v4-flash",
        "--task",
        "review",
      ]),
    ).toEqual({ llm: "deepseek-v4-flash", task: "review" });
    expect(() =>
      parseDeepSeekSmokeArguments([
        "--llm",
        "ark-agent-deepseek-v4-flash",
        "--task",
        "review",
      ]),
    ).toThrow(/direct DeepSeek Pi profile/u);
    expect(() => parseDeepSeekSmokeArguments(["--task", "review"])).toThrow(
      /--llm/u,
    );
  });

  it("records the official endpoint, normalized credential, and exact model", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async (_input, context) => {
        context?.onExecutionTelemetry?.(validPiTelemetry);
        return {
          ok: true,
          status: "completed",
          llm: "deepseek-v4-flash",
          actualModel: "deepseek-v4-flash",
          elapsedMs: 10,
          diagnostics: [],
          filesChanged: [],
          review:
            "Empty input has length zero, so division returns NaN at average.js:2.",
        };
      },
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runDeepSeekSmoke(
      {
        llm: "deepseek-v4-flash",
        task: "review",
        tempRoot: root,
      },
      {
        service,
        runtimeEvidence: {
          configSha256: "d".repeat(64),
          childEnvironment: {
            CODEX_AGENT_DEEPSEEK_KEY: "secret",
            PI_CODING_AGENT_DIR: "C:\\cache\\pi",
          },
        },
      },
    );

    expect(evidence).toMatchObject({
      schemaVersion: 4,
      qualification: null,
      llm: "deepseek-v4-flash",
      provider: "deepseek",
      actualModel: "deepseek-v4-flash",
      expectedModel: "deepseek-v4-flash",
      endpointHost: "api.deepseek.com",
      credentialEnv: "CODEX_AGENT_DEEPSEEK_KEY",
      passed: true,
      checks: {
        actualModelMatches: true,
        environmentIsolated: true,
        executionTelemetryValid: true,
        knownDefectFound: true,
        ownedProcessDrained: true,
        workspaceUnchanged: true,
      },
    });
    expect(await readdir(root)).toEqual([]);
  });
});
