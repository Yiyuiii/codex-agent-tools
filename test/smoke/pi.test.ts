import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parsePiSmokeArguments,
  runPiSmoke,
  type PiSmokeService,
} from "../../src/smoke/pi.js";

const roots: string[] = [];

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
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "gemini-3.5-flash",
        actualModel: "gemini-3.5-flash",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "Empty input has length zero, so division returns NaN.",
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
      delegate: async (input) => {
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
      filesChanged: ["result.txt"],
      commandCount: 1,
      checks: {
        resultFileValid: true,
        resultFileObserved: true,
        onlyExpectedFileChanged: true,
        commandObserved: true,
        noNewPiRpcProcesses: true,
      },
    });
    expect(receivedPrompt).toContain("Both actions are mandatory");
    expect(receivedPrompt).toContain("bash tool with the exact command `git status --short`");
    expect(await readdir(root)).toEqual([]);
  });

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
});
