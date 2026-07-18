import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cutoverCodexConfig,
  restoreCodexConfigBackup,
} from "../../src/cli/cutover.js";

let tempDirectory: string;
let configPath: string;

const original = [
  "# user comment",
  "[mcp_servers.other]",
  'command = "other"',
  "",
  "# old bridge",
  "[mcp_servers.codex_cc_tools]",
  'command = "old-node"',
  'args = ["old-mcp.js"]',
  "",
  "[profiles.default]",
  'model = "gpt"',
  "",
].join("\n");

beforeEach(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-agent-cutover-"));
  configPath = path.join(tempDirectory, "config.toml");
  await writeFile(configPath, original, "utf8");
});

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    configPath,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    mcpPath: "D:\\Tools\\codex-agent-tools\\dist\\mcp.js",
    assertReady: async () => undefined,
    selfCheck: async () => undefined,
    now: () => new Date("2026-07-18T10:00:00.000Z"),
    ...overrides,
  };
}

describe("reversible Codex MCP cutover", () => {
  it("changes no bytes and creates no backup when readiness fails", async () => {
    await expect(
      cutoverCodexConfig(
        options({
          assertReady: async () => {
            throw new Error("Ark gates are pending");
          },
        }),
      ),
    ).rejects.toThrow(/Ark gates are pending/u);

    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(tempDirectory)).toEqual(["config.toml"]);
  });

  it("backs up once, removes only the old table, and installs the owned new table", async () => {
    const selfCheck = vi.fn(async () => undefined);
    const result = await cutoverCodexConfig(options({ selfCheck }));
    const next = await readFile(configPath, "utf8");

    expect(result).toMatchObject({ changed: true, configPath });
    expect(result.backupPath).toContain(
      "config.toml.codex-agent-tools-backup-2026-07-18T10-00-00.000Z",
    );
    expect(await readFile(result.backupPath!, "utf8")).toBe(original);
    expect(next).not.toContain("[mcp_servers.codex_cc_tools]");
    expect(next).toContain("# old bridge");
    expect(next).toContain("[mcp_servers.codex_external_agents]");
    expect(next).toContain("# managed-by: codex-agent-tools");
    expect(next).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(next).toContain('[profiles.default]\nmodel = "gpt"');
    expect(selfCheck).toHaveBeenCalledOnce();

    const second = await cutoverCodexConfig(options({ selfCheck }));
    expect(second).toEqual({ configPath, changed: false });
    expect(selfCheck).toHaveBeenCalledOnce();
  });

  it("restores the exact original bytes when MCP self-check fails", async () => {
    await expect(
      cutoverCodexConfig(
        options({
          selfCheck: async () => {
            throw new Error("initialize/listTools failed");
          },
        }),
      ),
    ).rejects.toThrow(/initialize\/listTools failed/u);

    expect(await readFile(configPath, "utf8")).toBe(original);
    const backups = (await readdir(tempDirectory)).filter((name) =>
      name.includes("codex-agent-tools-backup"),
    );
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(tempDirectory, backups[0]!), "utf8")).toBe(
      original,
    );
  });

  it("restores an explicit backup without touching any other file", async () => {
    const result = await cutoverCodexConfig(options());
    await writeFile(configPath, "broken", "utf8");

    await restoreCodexConfigBackup(configPath, result.backupPath!);

    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readFile(result.backupPath!, "utf8")).toBe(original);
  });
});
