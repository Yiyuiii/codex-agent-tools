import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  assertAllowedPackFiles,
  assertNoSensitiveContent,
} from "../dist/release-assurance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const cliPath = path.join(dist, "cli.js");
const mcpPath = path.join(dist, "mcp.js");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? run(process.execPath, [npmExecPath, ...args])
    : run("npm", args);
}

function releaseSecrets(environment) {
  return Object.entries(environment)
    .filter(([name, value]) =>
      /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/iu.test(name) &&
      typeof value === "string" &&
      value.length >= 8,
    )
    .map(([, value]) => value);
}

async function checkMcpContract() {
  const client = new Client({ name: "release-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath],
    cwd: root,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(["external_delegate", "external_review"])) {
      throw new Error(`Unexpected MCP tools: ${names.join(", ")}`);
    }
    for (const tool of listed.tools) {
      if (!tool.inputSchema.required?.includes("llm")) {
        throw new Error(`${tool.name} does not require llm`);
      }
    }
    const review = listed.tools.find((tool) => tool.name === "external_review");
    const delegate = listed.tools.find((tool) => tool.name === "external_delegate");
    if (review?.annotations?.readOnlyHint !== true || review.annotations.destructiveHint !== false) {
      throw new Error("external_review annotations are unsafe");
    }
    if (delegate?.annotations?.readOnlyHint !== false || delegate.annotations.destructiveHint !== true) {
      throw new Error("external_delegate annotations are unsafe");
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function checkDoctorJson() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codex-agent-tools-release-"));
  try {
    const output = run(process.execPath, [
      cliPath,
      "doctor",
      "--json",
      "--config",
      path.join(temp, "config.toml"),
    ]);
    const report = JSON.parse(output);
    const publicTools = report.checks?.find((check) => check.name === "Public MCP tools");
    if (publicTools?.detail !== "external_review, external_delegate") {
      throw new Error("doctor JSON does not report the public tool contract");
    }
    const logicalLlms = report.checks?.filter((check) => check.name.startsWith("LLM ")) ?? [];
    if (logicalLlms.length !== 4) {
      throw new Error(`doctor JSON reported ${logicalLlms.length} logical LLMs, expected 4`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function checkPackage() {
  const packOutput = runNpm(["pack", "--dry-run", "--json"]);
  const packResult = JSON.parse(packOutput)?.[0];
  if (!packResult || !Array.isArray(packResult.files)) {
    throw new Error("npm pack did not return a file list");
  }
  const fileNames = packResult.files.map((entry) => entry.path);
  assertAllowedPackFiles(fileNames);

  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "docs/operations.md",
    "dist/cli.js",
    "dist/mcp.js",
  ]) {
    if (!fileNames.includes(required)) {
      throw new Error(`Required npm package file is missing: ${required}`);
    }
  }

  const textEntries = [];
  for (const name of fileNames) {
    if (/\.(?:js|map|ts|json|md)$/iu.test(name) || name === "LICENSE") {
      textEntries.push({ name, content: await readFile(path.join(root, name), "utf8") });
    }
  }
  assertNoSensitiveContent(textEntries, {
    forbiddenPaths: [root, os.homedir()],
    secrets: releaseSecrets(process.env),
  });
}

await Promise.all([access(cliPath), access(mcpPath)]);
run(process.execPath, [cliPath, "--version"]);
run(process.execPath, [cliPath, "--help"]);
run(process.execPath, [mcpPath, "--help"]);
await checkMcpContract();
await checkDoctorJson();
await checkPackage();

process.stdout.write("release smoke passed\n");
