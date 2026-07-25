import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultSmokeEvidenceFileOperations,
  SmokeInfrastructureError,
  runSmokeEntrypoint,
} from "../../src/smoke/evidence.js";
import { parseArkSmokeArguments } from "../../src/smoke/ark.js";
import { parseKimiSmokeArguments } from "../../src/smoke/kimi.js";
import { parsePiSmokeArguments } from "../../src/smoke/pi.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-evidence-test-${process.pid}-${Date.now()}-${roots.length}`,
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

describe("real smoke evidence entrypoint", () => {
  it("writes sanitized Kimi infrastructure evidence after arguments parse", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    const secret = "SECRET_SENTINEL_DO_NOT_PERSIST";
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async (options) => {
        options.onProgress(secret);
        options.onProgress("kimi heartbeat 15000ms");
        throw new SmokeInfrastructureError(
          "version_probe",
          {},
          new Error(secret),
        );
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json",
    ]);
    const json = await readFile(
      path.join(
        evidenceDirectory,
        "2026-07-25T01-02-03.000Z-kimi-k3-review.json",
      ),
      "utf8",
    );
    expect(JSON.parse(json)).toMatchObject({
      llm: "kimi-k3",
      task: "review",
      runtime: "kimi-acp",
      route: "direct",
      passed: false,
      failureReason: "infrastructure_failure",
      failure: {
        category: "infrastructure",
        stage: "version_probe",
        count: 1,
      },
    });
    expect(json).not.toContain(secret);
    expect(stdout).not.toContain(secret);
    expect(stderr).toBe(
      "[kimi smoke] activity\n" +
        "[kimi smoke] heartbeat\n" +
        "Smoke failed; sanitized evidence was written.\n",
    );
    expect(stderr).not.toContain(secret);
  });

  it("fails closed with a fixed message when evidence cannot be written", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "not-a-directory");
    await writeFile(evidenceDirectory, "occupied", "utf8");
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("SECRET_EVIDENCE_WRITE_SENTINEL");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
    expect(stderr).not.toContain("SECRET_EVIDENCE_WRITE_SENTINEL");
  });

  it("removes a partially written temporary file without reporting evidence", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    const secret = "PARTIAL_WRITE_SECRET_SENTINEL";
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("model failure");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      fileOperations: {
        ...defaultSmokeEvidenceFileOperations,
        writeExclusive: async (filePath, contents) => {
          await writeFile(filePath, contents.slice(0, 7), "utf8");
          throw new Error(secret);
        },
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([]);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
    expect(stderr).not.toContain(secret);
  });

  it("removes the temporary file when exclusive publication fails", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    const secret = "RENAME_SECRET_SENTINEL";
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "ark",
      args: ["--llm", "ark-agent-plan", "--task", "delegate"],
      parseArguments: parseArkSmokeArguments,
      runSmoke: async () => {
        throw new Error("model failure");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      fileOperations: {
        ...defaultSmokeEvidenceFileOperations,
        publishExclusive: async () => {
          throw new Error(secret);
        },
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([]);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
    expect(stderr).not.toContain(secret);
  });

  it("preserves a final file that appears during exclusive publication", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    const fileName =
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json";
    const finalPath = path.join(evidenceDirectory, fileName);
    const competingEvidence = '{"competitor":true}\n';
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("model failure");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      fileOperations: {
        ...defaultSmokeEvidenceFileOperations,
        publishExclusive: async (temporaryPath, destinationPath) => {
          await writeFile(
            destinationPath,
            competingEvidence,
            { encoding: "utf8", flag: "wx" },
          );
          await defaultSmokeEvidenceFileOperations.publishExclusive(
            temporaryPath,
            destinationPath,
          );
        },
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([fileName]);
    expect(await readFile(finalPath, "utf8")).toBe(competingEvidence);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
  });

  it("does not overwrite an existing final evidence file", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    await mkdir(evidenceDirectory, { recursive: true });
    const fileName =
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json";
    const finalPath = path.join(evidenceDirectory, fileName);
    const original = '{"existing":true}\n';
    await writeFile(finalPath, original, "utf8");
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("model failure");
      },
      evidenceDirectory,
      now: () => new Date("2026-07-25T01:02:03.000Z"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(await readdir(evidenceDirectory)).toEqual([fileName]);
    expect(await readFile(finalPath, "utf8")).toBe(original);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Smoke evidence could not be confirmed; no evidence path was reported.\n",
    );
  });

  it("writes structured model or acceptance failures returned by the harness", async () => {
    const root = await tempRoot();
    const evidenceDirectory = path.join(root, "evidence");
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--llm", "kimi-k3", "--task", "review"],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => ({
        schemaVersion: 1,
        timestamp: "2026-07-25T01:02:03.000Z",
        llm: "kimi-k3",
        task: "review",
        status: "failed",
        passed: false,
        failureReason: "adapter_auth_or_model_unavailable",
        diagnosticCount: 1,
      }),
      evidenceDirectory,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    const fileName =
      "2026-07-25T01-02-03.000Z-kimi-k3-review.json";
    const json = await readFile(
      path.join(evidenceDirectory, fileName),
      "utf8",
    );
    expect(JSON.parse(json)).toMatchObject({
      passed: false,
      failureReason: "adapter_auth_or_model_unavailable",
      diagnosticCount: 1,
    });
    expect(stdout).toContain(`docs/smoke/evidence/${fileName}`);
    expect(stderr).toBe("Smoke failed; sanitized evidence was written.\n");
  });

  it("does not echo a secret embedded in an argument parsing error", async () => {
    const root = await tempRoot();
    const secret = "ARGUMENT_SECRET_SENTINEL";
    let stdout = "";
    let stderr = "";

    const exitCode = await runSmokeEntrypoint({
      kind: "kimi",
      args: ["--secret", secret],
      parseArguments: parseKimiSmokeArguments,
      runSmoke: async () => {
        throw new Error("not reached");
      },
      evidenceDirectory: path.join(root, "evidence"),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Smoke arguments are invalid.\n");
    expect(stderr).not.toContain(secret);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    {
      kind: "pi" as const,
      llm: "gemini-3.5-flash",
      parseArguments: parsePiSmokeArguments,
      expectedFile:
        "2026-07-25T01-02-03.000Z-gemini-3.5-flash-delegate-pi.json",
    },
    {
      kind: "ark" as const,
      llm: "ark-agent-plan",
      parseArguments: parseArkSmokeArguments,
      expectedFile:
        "2026-07-25T01-02-03.000Z-ark-agent-plan-delegate-ark.json",
    },
  ])(
    "sanitizes $kind failures and preserves the existing evidence suffix",
    async ({ kind, llm, parseArguments, expectedFile }) => {
      const root = await tempRoot();
      const evidenceDirectory = path.join(root, "evidence");
      const secret = `${kind.toUpperCase()}_SECRET_SENTINEL`;
      let stdout = "";
      let stderr = "";

      const exitCode = await runSmokeEntrypoint({
        kind,
        args: ["--llm", llm, "--task", "delegate"],
        parseArguments,
        runSmoke: async () => {
          throw new SmokeInfrastructureError(
            "post_process_snapshot",
            { processIdsBefore: 2 },
            new Error(secret),
          );
        },
        evidenceDirectory,
        now: () => new Date("2026-07-25T01:02:03.000Z"),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });

      expect(exitCode).toBe(1);
      expect(await readdir(evidenceDirectory)).toEqual([expectedFile]);
      const json = await readFile(
        path.join(evidenceDirectory, expectedFile),
        "utf8",
      );
      expect(JSON.parse(json)).toMatchObject({
        llm,
        task: "delegate",
        passed: false,
        failureReason: "infrastructure_failure",
        failure: {
          category: "infrastructure",
          stage: "post_process_snapshot",
          count: 1,
        },
        counts: { processIdsBefore: 2 },
        checks: {
          postProcessSnapshot: "unknown",
          processCleanup: "unknown",
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
});
