import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installCodexConfig,
  installCodexConfigText,
  uninstallCodexConfig,
  uninstallCodexConfigText,
} from "../../src/cli/config.js";

const options = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  mcpPath: "D:\\Tools\\codex-agent-tools\\dist\\mcp.js",
};

let tempDirectory: string;

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-agent-config-"));
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

describe("Codex MCP config ownership", () => {
  it("installs idempotently without disturbing comments or another server", () => {
    const existing = [
      "# user comment",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      "[profiles.default]",
      'model = "gpt"',
      "",
    ].join("\n");
    const installed = installCodexConfigText(existing, options);
    const installedAgain = installCodexConfigText(installed, options);

    expect(installedAgain).toBe(installed);
    expect(installed).toContain("# managed-by: codex-agent-tools");
    expect(installed).toContain("[mcp_servers.codex_external_agents]");
    expect(installed.match(/\[mcp_servers\.codex_external_agents\]/g)).toHaveLength(1);
    expect(installed).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(installed).toContain('[profiles.default]\nmodel = "gpt"');
    expect(installed).toContain('enabled_tools = ["external_review", "external_delegate"]');
    expect(installed).toContain(
      'env_vars = ["ARK_API_KEY", "VOLCENGINE_API_KEY", "API_KEY_DOUBAO_CODING", "OPENAI_API_KEY_DOUBAO", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]',
    );
  });

  it("refuses to overwrite an unowned same-name table", () => {
    const existing = [
      "[mcp_servers.codex_external_agents]",
      'command = "user-command"',
      "",
    ].join("\n");
    expect(() => installCodexConfigText(existing, options)).toThrow(
      /not managed by codex-agent-tools/,
    );
  });

  it("uninstalls only its owned block and preserves surrounding bytes", () => {
    const existing = [
      "# before",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    const installed = installCodexConfigText(existing, options);
    expect(uninstallCodexConfigText(installed)).toBe(existing);
  });

  it("creates parent directories and does not create a file for a no-op uninstall", async () => {
    const configPath = path.join(tempDirectory, "nested", "config.toml");
    const absent = await uninstallCodexConfig(configPath);
    expect(absent).toEqual({ configPath, changed: false });

    const installed = await installCodexConfig(configPath, options);
    expect(installed.changed).toBe(true);
    expect(await readFile(configPath, "utf8")).toContain(
      "[mcp_servers.codex_external_agents]",
    );
    const removed = await uninstallCodexConfig(configPath);
    expect(removed.changed).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe("");
  });

  it("preserves CRLF style when replacing an owned block", () => {
    const existing = "# user\r\n[mcp_servers.other]\r\ncommand = \"x\"\r\n";
    const first = installCodexConfigText(existing, options);
    const updated = installCodexConfigText(first, {
      ...options,
      mcpPath: "D:\\Tools\\new\\dist\\mcp.js",
    });
    expect(updated).not.toMatch(/(?<!\r)\n/u);
    expect(updated).toContain("D:\\\\Tools\\\\new\\\\dist\\\\mcp.js");
  });
});
