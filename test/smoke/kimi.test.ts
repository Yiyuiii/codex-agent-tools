import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseKimiSmokeArguments,
  runKimiSmoke,
  type KimiSmokeService,
} from "../../src/smoke/kimi.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-smoke-test-${process.pid}-${Date.now()}-${roots.length}`,
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

describe("Kimi real-smoke harness", () => {
  it("requires an explicit supported llm and one task", () => {
    expect(
      parseKimiSmokeArguments(["--llm", "kimi-k3", "--task", "review"]),
    ).toEqual({ llm: "kimi-k3", task: "review" });
    expect(() => parseKimiSmokeArguments(["--task", "review"])).toThrow(
      /--llm/u,
    );
    expect(() =>
      parseKimiSmokeArguments(["--llm", "kimi-k3", "--task", "other"]),
    ).toThrow(/--task/u);
    expect(() =>
      parseKimiSmokeArguments([
        "--llm",
        "ark-coding-plan",
        "--task",
        "review",
      ]),
    ).toThrow(/Kimi ACP profile/u);
  });

  it("validates a read-only review against the known empty-array defect", async () => {
    const root = await tempRoot();
    const service: KimiSmokeService = {
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "kimi-k3",
        actualModel: "kimi-code/k3",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "The empty array has length zero, so division returns NaN.",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "review", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
        now: () => new Date("2026-07-18T00:00:00.000Z"),
      },
    );

    expect(evidence).toMatchObject({
      llm: "kimi-k3",
      task: "review",
      actualModel: "kimi-code/k3",
      route: "direct",
      kimiVersion: "0.27.0",
      status: "completed",
      passed: true,
      checks: {
        workspaceUnchanged: true,
        knownDefectFound: true,
        noNewKimiProcesses: true,
      },
    });
    expect(evidence.outputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readdir(root)).toEqual([]);
  });

  it("validates delegate output, filesystem evidence, and a command event", async () => {
    const root = await tempRoot();
    const service: KimiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input) => {
        await writeFile(path.join(input.cwd, "result.txt"), "KIMI_SMOKE_OK\n", "utf8");
        return {
          ok: true,
          status: "completed",
          llm: "kimi-k3",
          actualModel: "kimi-code/k3",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: ["result.txt"],
          summary: "Created and verified result.txt.",
          commandsRun: ["git status --short"],
          verification: [],
          risks: [],
        };
      },
    };

    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "delegate", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    );

    expect(evidence).toMatchObject({
      passed: true,
      checks: {
        resultFileValid: true,
        resultFileObserved: true,
        commandObserved: true,
        noNewKimiProcesses: true,
      },
      filesChanged: ["result.txt"],
      commandCount: 1,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("fails the gate when a new Kimi process remains after the task", async () => {
    const root = await tempRoot();
    let call = 0;
    const service: KimiSmokeService = {
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "kimi-k3",
        actualModel: "kimi-code/k3",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "Empty input has length zero and produces NaN.",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };
    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "review", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => (call++ === 0 ? [100] : [100, 200]),
      },
    );
    expect(evidence.passed).toBe(false);
    expect(evidence.checks.noNewKimiProcesses).toBe(false);
  });

  it("rejects non-Kimi logical IDs before creating a workspace", async () => {
    const root = await tempRoot();
    await expect(
      runKimiSmoke({ llm: "deepseek", task: "review", tempRoot: root }),
    ).rejects.toThrow(/Supported llms/u);
    expect(await readdir(root)).toEqual([]);
  });
});
