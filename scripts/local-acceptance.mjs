import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";

import {
  assertCompletedDelegate,
  assertCompletedReview,
  assertLocalToolContract,
  forwardedCredentialEnvironment,
  requireStructuredContent,
} from "../dist/local-acceptance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpPath = path.join(root, "dist", "mcp.js");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-local-acceptance-"));

async function runGit(cwd, args) {
  const result = await execa("git", args, {
    cwd,
    reject: false,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

async function createFixture(name, kind = "review") {
  const cwd = path.join(tempRoot, name);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd, { recursive: true }));
  await runGit(cwd, ["init", "--quiet"]);
  await runGit(cwd, ["config", "user.name", "codex-agent-tools acceptance"]);
  await runGit(cwd, ["config", "user.email", "acceptance@example.invalid"]);
  if (kind === "delegate") {
    await writeFile(
      path.join(cwd, "README.md"),
      "# Isolated Kimi delegate acceptance fixture\n",
      "utf8",
    );
  } else {
    await writeFile(
      path.join(cwd, "average.js"),
      "export function average(values) {\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n",
      "utf8",
    );
    await writeFile(
      path.join(cwd, "average.test.js"),
      'import assert from "node:assert/strict";\nimport { average } from "./average.js";\nassert.equal(average([]), 0);\n',
      "utf8",
    );
  }
  await runGit(cwd, ["add", "."]);
  await runGit(cwd, ["commit", "--quiet", "-m", "acceptance fixture"]);
  return cwd;
}

async function listAgentProcessIds() {
  if (process.platform === "win32") {
    const script = [
      "Get-CimInstance Win32_Process",
      "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains('codex-external-agents') -or (($_.Name -like 'kimi*') -and $_.CommandLine.Contains(' acp'))) }",
      "ForEach-Object { $_.ProcessId }",
    ].join(" | ");
    const result = await execa(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { reject: false, timeout: 30_000, windowsHide: true },
    );
    if (result.exitCode !== 0) throw new Error("Unable to inspect agent processes");
    return result.stdout
      .split(/\s+/u)
      .filter((value) => /^\d+$/u.test(value))
      .map(Number)
      .sort((left, right) => left - right);
  }
  const result = await execa("ps", ["-eo", "pid=,args="], {
    reject: false,
    timeout: 30_000,
  });
  if (result.exitCode !== 0) throw new Error("Unable to inspect agent processes");
  return result.stdout
    .split(/\r?\n/u)
    .filter(
      (line) =>
        line.includes("codex-external-agents") ||
        (line.includes("kimi") && line.includes(" acp")),
    )
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

async function waitForNoNewProcesses(baseline) {
  const baselineSet = new Set(baseline);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = await listAgentProcessIds();
    if (current.every((pid) => baselineSet.has(pid))) return;
    if (Date.now() >= deadline) {
      throw new Error("Cancellation left an external agent process running");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function callReview(client, llm, expectedModel, cwd) {
  const startedAt = Date.now();
  const result = requireStructuredContent(
    await client.callTool(
      {
        name: "external_review",
        arguments: {
          llm,
          task: "review_diff",
          prompt:
            "Read average.js and average.test.js. Identify the concrete empty-input correctness defect and cite the relevant expression. Do not modify files or execute commands.",
          cwd,
          includeGitDiff: true,
        },
      },
      undefined,
      { timeout: 600_000, maxTotalTimeout: 600_000, resetTimeoutOnProgress: true },
    ),
  );
  assertCompletedReview(result, expectedModel);
  if ((await runGit(cwd, ["status", "--porcelain"])).trim() !== "") {
    throw new Error(`${llm} review changed its fixture`);
  }
  return { llm, actualModel: result.actualModel, elapsedMs: Date.now() - startedAt };
}

async function callDelegate(client) {
  const startedAt = Date.now();
  const failures = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cwd = await createFixture(`delegate-${attempt + 1}`, "delegate");
    const result = requireStructuredContent(
      await client.callTool(
        {
          name: "external_delegate",
          arguments: {
            llm: "kimi-k3",
            prompt:
              attempt === 0
                ? "Create result.txt in the working directory with exactly one line: KIMI_SMOKE_OK. Then run `git status --short` to verify the change and report what you did. Do not modify any other file."
                : "The required file may already exist. Verify that result.txt contains exactly KIMI_SMOKE_OK, then run the exact command `git status --short` before reporting what you did. Do not modify any other file.",
            cwd,
          },
        },
        undefined,
        { timeout: 600_000, maxTotalTimeout: 600_000, resetTimeoutOnProgress: true },
      ),
    );
    let content = "";
    try {
      content = await readFile(path.join(cwd, "result.txt"), "utf8");
    } catch {
      content = "";
    }
    try {
      assertCompletedDelegate(
        result,
        "kimi-code/k3",
        content,
        "KIMI_SMOKE_OK",
        "result.txt",
      );
      return {
        llm: "kimi-k3",
        actualModel: result.actualModel,
        attempts: attempt + 1,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      failures.push({
        attempt: attempt + 1,
        status: result.status,
        actualModel: result.actualModel,
        filesChanged: Array.isArray(result.filesChanged) ? result.filesChanged : [],
        commandCount: Array.isArray(result.commandsRun) ? result.commandsRun.length : 0,
        diagnosticCount: Array.isArray(result.diagnostics) ? result.diagnostics.length : 0,
        contentMatches: content.trim() === "KIMI_SMOKE_OK",
        failure: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new Error(`Kimi delegate acceptance attempts failed: ${JSON.stringify(failures)}`);
}

async function checkCancellation(client, cwd) {
  const baseline = await listAgentProcessIds();
  const controller = new AbortController();
  let progressSeen = false;
  const fallback = setTimeout(() => controller.abort(), 1_000);
  try {
    await client.callTool(
      {
        name: "external_delegate",
        arguments: {
          llm: "kimi-k3",
          prompt:
            "Inspect every file in detail, then produce a long analysis. Do not modify files.",
          cwd,
        },
      },
      undefined,
      {
        signal: controller.signal,
        timeout: 600_000,
        maxTotalTimeout: 600_000,
        resetTimeoutOnProgress: true,
        onprogress: () => {
          progressSeen = true;
          controller.abort();
        },
      },
    );
    throw new Error("Cancellation request unexpectedly completed");
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(fallback);
  }
  await waitForNoNewProcesses(baseline);
  return { progressSeen, noNewProcesses: true };
}

const client = new Client({ name: "codex-agent-local-acceptance", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpPath],
  cwd: root,
  env: forwardedCredentialEnvironment(process.env),
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assertLocalToolContract(listed.tools);
  const kimiReview = await callReview(
    client,
    "kimi-k2.7-highspeed",
    "kimi-code/kimi-for-coding-highspeed",
    await createFixture("kimi-review"),
  );
  const delegate = await callDelegate(client);
  const cancellation = await checkCancellation(
    client,
    await createFixture("cancellation"),
  );
  let piReview;
  try {
    piReview = await callReview(
      client,
      "gemini-3.5-flash",
      "gemini-3.5-flash",
      await createFixture("pi-review"),
    );
  } catch (error) {
    piReview = {
      status: "blocked",
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 512),
    };
  }
  const summary = { tools: ["external_review", "external_delegate"], kimiReview, piReview, delegate, cancellation };
  const digest = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
  process.stdout.write(`${JSON.stringify({ ...summary, summarySha256: digest }, null, 2)}\n`);
  if (piReview.status === "blocked") process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
