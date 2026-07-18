import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MCP_SERVER_NAME = "codex_external_agents";
export const OWNERSHIP_MARKER = "# managed-by: codex-agent-tools";

export interface CodexConfigOptions {
  nodePath: string;
  mcpPath: string;
}

export interface CodexConfigResult {
  configPath: string;
  changed: boolean;
}

interface TableRange {
  start: number;
  end: number;
  owned: boolean;
}

const TABLE_HEADER_PATTERN = /^[ \t]*\[([^\]]+)\][ \t]*$/gm;
const TARGET_TABLE = `mcp_servers.${MCP_SERVER_NAME}`;

function newlineFor(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function tomlString(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("TOML strings cannot contain control characters");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function buildManagedBlock(
  options: CodexConfigOptions,
  newline: string,
): string {
  if (!path.isAbsolute(options.nodePath) || !path.isAbsolute(options.mcpPath)) {
    throw new Error("Codex MCP node and server paths must be absolute");
  }
  return [
    OWNERSHIP_MARKER,
    `[${TARGET_TABLE}]`,
    `command = ${tomlString(options.nodePath)}`,
    `args = [${tomlString(options.mcpPath)}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 900",
    "required = false",
    "enabled = true",
    'enabled_tools = ["external_review", "external_delegate"]',
  ].join(newline);
}

function findTargetTable(text: string): TableRange | undefined {
  const headers = Array.from(text.matchAll(TABLE_HEADER_PATTERN));
  const targetIndex = headers.findIndex(
    (match) => (match[1] ?? "").trim() === TARGET_TABLE,
  );
  if (targetIndex < 0) return undefined;

  const headerStart = headers[targetIndex]?.index ?? 0;
  const beforeHeader = text.slice(0, headerStart);
  const markerMatch = beforeHeader.match(
    /(^|\r?\n)(# managed-by: codex-agent-tools)\r?\n$/u,
  );
  const owned = markerMatch !== null;
  const start = owned
    ? headerStart - `${OWNERSHIP_MARKER}${newlineFor(text)}`.length
    : headerStart;

  let end = text.length;
  const nextHeader = headers[targetIndex + 1];
  if (nextHeader?.index !== undefined) {
    end = nextHeader.index;
    const segment = text.slice(headerStart, end);
    end =
      headerStart +
      segment.replace(/(?:\r?\n[ \t]*(?:#.*)?)*$/u, "").length;
  }
  return { start, end, owned };
}

export function installCodexConfigText(
  existing: string,
  options: CodexConfigOptions,
): string {
  const newline = newlineFor(existing);
  const block = buildManagedBlock(options, newline);
  const range = findTargetTable(existing);
  if (range !== undefined && !range.owned) {
    throw new Error(
      `${TARGET_TABLE} exists but is not managed by codex-agent-tools`,
    );
  }

  if (range !== undefined) {
    const replaced = `${existing.slice(0, range.start)}${block}${existing.slice(range.end)}`;
    return replaced.endsWith(newline) ? replaced : `${replaced}${newline}`;
  }

  if (existing === "") {
    return `${block}${newline}`;
  }
  const separator = existing.endsWith(newline)
    ? newline
    : `${newline}${newline}`;
  return `${existing}${separator}${block}${newline}`;
}

export function uninstallCodexConfigText(existing: string): string {
  const range = findTargetTable(existing);
  if (range === undefined || !range.owned) {
    return existing;
  }
  const newline = newlineFor(existing);
  let removalStart = range.start;
  if (existing.slice(0, removalStart).endsWith(`${newline}${newline}`)) {
    removalStart -= newline.length;
  }
  let result = `${existing.slice(0, removalStart)}${existing.slice(range.end)}`;
  if (result.endsWith(`${newline}${newline}`)) {
    result = result.slice(0, -newline.length);
  }
  return result;
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function writeConfig(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export function getDefaultCodexConfigPath(home = os.homedir()): string {
  return path.join(home, ".codex", "config.toml");
}

export async function installCodexConfig(
  configPath: string,
  options: CodexConfigOptions,
): Promise<CodexConfigResult> {
  const existing = await readTextIfExists(configPath);
  const next = installCodexConfigText(existing, options);
  if (next !== existing) await writeConfig(configPath, next);
  return { configPath, changed: next !== existing };
}

export async function uninstallCodexConfig(
  configPath: string,
): Promise<CodexConfigResult> {
  const existing = await readTextIfExists(configPath);
  const next = uninstallCodexConfigText(existing);
  if (next !== existing) await writeConfig(configPath, next);
  return { configPath, changed: next !== existing };
}

export function hasManagedCodexConfig(text: string): boolean {
  return findTargetTable(text)?.owned === true;
}
