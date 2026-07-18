import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseArkSmokeArguments,
  runArkSmoke,
} from "../../src/smoke/ark.js";
import type { PiSmokeService } from "../../src/smoke/pi.js";

const roots: string[] = [];

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

describe("Ark real-smoke harness", () => {
  it.each([
    "ark-coding-plan",
    "ark-agent-glm-5.2",
    "ark-agent-doubao-seed-2.0-pro",
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
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "ark-agent-glm-5.2",
        actualModel: "glm-5.2",
        elapsedMs: 10,
        diagnostics: [],
        filesChanged: [],
        review: "Empty input has length zero, so division returns NaN at average.js:2.",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runArkSmoke(
      { llm: "ark-agent-glm-5.2", task: "review", tempRoot: root },
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
      llm: "ark-agent-glm-5.2",
      provider: "ark-agent-plan",
      actualModel: "glm-5.2",
      expectedModel: "glm-5.2",
      endpointHost: "ark.cn-beijing.volces.com",
      credentialEnv: "CODEX_AGENT_ARK_AGENT_KEY",
      passed: true,
      failureReason: null,
      checks: {
        environmentIsolated: true,
        workspaceUnchanged: true,
        knownDefectFound: true,
      },
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("uses a profile-specific delegate file and requires command evidence", async () => {
    const root = await tempRoot();
    let requestedFile = "";
    const service: PiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input) => {
        requestedFile = /create ([^ ]+\.txt)/u.exec(input.prompt)?.[1] ?? "";
        await writeFile(
          path.join(input.cwd, requestedFile),
          "ARK_SMOKE_OK:ark-agent-doubao-seed-2.0-pro\n",
          "utf8",
        );
        return {
          ok: true,
          status: "completed",
          llm: "ark-agent-doubao-seed-2.0-pro",
          actualModel: "doubao-seed-2.0-pro",
          elapsedMs: 10,
          diagnostics: [],
          filesChanged: [requestedFile],
          summary: "created and verified",
          commandsRun: ["git status --short"],
          verification: [],
          risks: [],
        };
      },
    };

    const evidence = await runArkSmoke(
      {
        llm: "ark-agent-doubao-seed-2.0-pro",
        task: "delegate",
        tempRoot: root,
      },
      {
        service,
        runtimeEvidence: {
          configSha256: "c".repeat(64),
          childEnvironment: {
            CODEX_AGENT_ARK_AGENT_KEY: "secret",
            PI_CODING_AGENT_DIR: "C:\\cache\\pi",
          },
        },
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [],
      },
    );

    expect(requestedFile).toBe("ark-agent-doubao-seed-2.0-pro-smoke.txt");
    expect(evidence.passed).toBe(true);
    expect(evidence.checks.commandObserved).toBe(true);
    expect(evidence.filesChanged).toEqual([requestedFile]);
  });

  it("records a stable quota failure code without persisting raw diagnostics", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async () => ({
        ok: false,
        status: "failed",
        llm: "ark-agent-glm-5.2",
        actualModel: "glm-5.2",
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
      { llm: "ark-agent-glm-5.2", task: "review", tempRoot: root },
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
});
