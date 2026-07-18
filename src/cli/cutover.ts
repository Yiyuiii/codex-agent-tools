import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  hasManagedCodexConfig,
  installCodexConfigText,
  removeLegacyCodexCcToolsText,
} from "./config.js";
import { collectDoctorReport } from "./doctor.js";

export interface CutoverSelfCheckOptions {
  nodePath: string;
  mcpPath: string;
}

export interface CutoverCodexConfigOptions extends CutoverSelfCheckOptions {
  configPath: string;
  assertReady?: () => Promise<void>;
  selfCheck?: (options: CutoverSelfCheckOptions) => Promise<void>;
  now?: () => Date;
}

export interface CutoverCodexConfigResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
}

async function readTextIfExists(filePath: string): Promise<{
  exists: boolean;
  text: string;
}> {
  try {
    return { exists: true, text: await readFile(filePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, text: "" };
    }
    throw error;
  }
}

async function durableWriteNew(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await durableWriteNew(tempPath, content);
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function acquireLock(configPath: string): Promise<{
  release: () => Promise<void>;
}> {
  const lockPath = `${configPath}.codex-agent-tools.lock`;
  await mkdir(path.dirname(configPath), { recursive: true });
  const handle = await open(lockPath, "wx").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Codex config is locked: ${lockPath}`);
    }
    throw error;
  });
  await handle.writeFile(`${process.pid}\n`, "utf8");
  await handle.sync();
  return {
    release: async () => {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    },
  };
}

function validateCutoverText(text: string): void {
  const headers = Array.from(text.matchAll(/^[ \t]*\[([^\]]+)\][ \t]*$/gmu)).map(
    (match) => (match[1] ?? "").trim(),
  );
  if (new Set(headers).size !== headers.length) {
    throw new Error("Cutover produced duplicate TOML tables");
  }
  if (headers.includes("mcp_servers.codex_cc_tools")) {
    throw new Error("Cutover did not remove codex_cc_tools");
  }
  if (!hasManagedCodexConfig(text)) {
    throw new Error("Cutover did not install the managed codex_external_agents table");
  }
}

async function defaultAssertReady(configPath: string): Promise<void> {
  const report = await collectDoctorReport({ configPath });
  const blockers = report.checks.filter(
    (check) =>
      check.level === "error" ||
      (check.name.startsWith("LLM ") && check.ok === false),
  );
  if (blockers.length > 0) {
    throw new Error(
      `Cutover readiness failed: ${blockers.map((check) => check.name).join(", ")}`,
    );
  }
}

async function defaultSelfCheck(
  options: CutoverSelfCheckOptions,
): Promise<void> {
  const client = new Client({ name: "codex-agent-tools-cutover", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: options.nodePath,
    args: [options.mcpPath],
    cwd: path.dirname(options.mcpPath),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    if (
      JSON.stringify(tools) !==
      JSON.stringify(["external_delegate", "external_review"])
    ) {
      throw new Error(`Unexpected MCP tools after cutover: ${tools.join(", ")}`);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

function backupPathFor(configPath: string, now: Date): string {
  const timestamp = now.toISOString().replaceAll(":", "-");
  return `${configPath}.codex-agent-tools-backup-${timestamp}`;
}

export async function cutoverCodexConfig(
  options: CutoverCodexConfigOptions,
): Promise<CutoverCodexConfigResult> {
  if (
    !path.isAbsolute(options.configPath) ||
    !path.isAbsolute(options.nodePath) ||
    !path.isAbsolute(options.mcpPath)
  ) {
    throw new Error("Cutover paths must be absolute");
  }
  await (options.assertReady ?? (() => defaultAssertReady(options.configPath)))();
  const lock = await acquireLock(options.configPath);
  try {
    const existing = await readTextIfExists(options.configPath);
    const withoutLegacy = removeLegacyCodexCcToolsText(existing.text);
    const next = installCodexConfigText(withoutLegacy, {
      nodePath: options.nodePath,
      mcpPath: options.mcpPath,
    });
    validateCutoverText(next);
    if (next === existing.text) {
      return { configPath: options.configPath, changed: false };
    }

    const backupPath = backupPathFor(
      options.configPath,
      (options.now ?? (() => new Date()))(),
    );
    await durableWriteNew(backupPath, existing.text);
    await atomicReplace(options.configPath, next);
    try {
      await (options.selfCheck ?? defaultSelfCheck)({
        nodePath: options.nodePath,
        mcpPath: options.mcpPath,
      });
    } catch (error) {
      if (existing.exists) await atomicReplace(options.configPath, existing.text);
      else await unlink(options.configPath).catch(() => undefined);
      throw error;
    }
    return { configPath: options.configPath, changed: true, backupPath };
  } finally {
    await lock.release();
  }
}

export async function restoreCodexConfigBackup(
  configPath: string,
  backupPath: string,
): Promise<void> {
  if (!path.isAbsolute(configPath) || !path.isAbsolute(backupPath)) {
    throw new Error("Restore paths must be absolute");
  }
  const content = await readFile(backupPath, "utf8");
  const lock = await acquireLock(configPath);
  try {
    await atomicReplace(configPath, content);
  } finally {
    await lock.release();
  }
}
