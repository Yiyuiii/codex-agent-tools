import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import {
  isAbsoluteOnAnyPlatform,
  isSafeRelativeLaunchPath,
} from "../../scripts/lib/npm-launch-path.mjs";
import {
  capabilitySourcePathsFromIndex,
  packageFilePathsFromManifest,
} from "../../src/release/assurance.js";
import {
  digestReleasePluginArtifactTree,
  RELEASE_PLUGIN_ARTIFACT_PATHS,
} from "../../src/release/release-validation.js";
import { resolveWindowsJobHelperForModule } from "../../src/runtime/windows-job-helper.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pluginRoot = resolve(
  repositoryRoot,
  "plugins/codex-external-agents",
);

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

describe("Codex plugin artifact", () => {
  it("declares the single repository-local marketplace entry", () => {
    const marketplace = readJson(".agents/plugins/marketplace.json");

    expect(marketplace).toEqual({
      name: "codex-external-agents-local",
      interface: {
        displayName: "Codex External Agents Local",
      },
      plugins: [
        {
          name: "codex-external-agents",
          source: {
            source: "local",
            path: "./plugins/codex-external-agents",
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Productivity",
        },
      ],
    });

    const [plugin] = marketplace.plugins as [
      Record<string, unknown>,
    ];
    expect((plugin.policy as Record<string, unknown>).products).toBeUndefined();
  });

  it("keeps the plugin manifest aligned with the package and folder", () => {
    const packageManifest = readJson("package.json");
    const pluginManifest = readJson(
      "plugins/codex-external-agents/.codex-plugin/plugin.json",
    );

    expect(pluginManifest).toMatchObject({
      name: "codex-external-agents",
      version: packageManifest.version,
      description:
        "Use explicitly selected external LLMs for review and delegated coding tasks.",
      author: {
        name: "codex-agent-tools maintainers",
      },
      license: "MIT",
      mcpServers: "./.mcp.json",
      interface: {
        displayName: "Codex External Agents",
        shortDescription:
          "Review and delegate with explicitly selected external LLMs",
        longDescription:
          "Use explicitly selected local Kimi and Pi-backed LLMs for Codex review and delegated coding tasks.",
        developerName: "codex-agent-tools maintainers",
        category: "Productivity",
        capabilities: ["Interactive", "Write"],
      },
    });
    expect(pluginManifest.name).toBe(basename(pluginRoot));
    expect(pluginManifest).not.toHaveProperty("skills");
    expect(pluginManifest).not.toHaveProperty("hooks");
    expect(pluginManifest).not.toHaveProperty("apps");
    expect(JSON.stringify(pluginManifest)).not.toContain("TODO");

    const defaultPrompt = (
      pluginManifest.interface as Record<string, unknown>
    ).defaultPrompt;

    expect(Array.isArray(defaultPrompt)).toBe(true);
    if (!Array.isArray(defaultPrompt)) return;
    expect(defaultPrompt.length).toBeGreaterThanOrEqual(1);
    expect(defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const prompt of defaultPrompt) {
      expect(typeof prompt).toBe("string");
      if (typeof prompt !== "string") continue;
      expect(prompt.trim().length).toBeGreaterThan(0);
      expect(prompt.length).toBeLessThanOrEqual(128);
    }
  });

  it("keeps release plugin text artifacts LF-only for byte-stable OIDC builds", () => {
    for (const relativePath of [
      "plugins/codex-external-agents/.codex-plugin/plugin.json",
      "plugins/codex-external-agents/.mcp.json",
      "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
      "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256",
    ]) {
      expect(
        readFileSync(resolve(repositoryRoot, relativePath)).includes(0x0d),
        relativePath,
      ).toBe(false);
    }
  });

  it("binds the current prerelease marker to the freshly built plugin tree", () => {
    const packageManifest = readJson("package.json");
    const version = packageManifest.version;
    expect(typeof version).toBe("string");
    if (typeof version !== "string" || !version.includes("-")) return;

    const marker = readJson(`.release-validation/v${version}.json`);
    expect(marker).toMatchObject({
      kind: "beta",
      package: {
        name: "codex-agent-tools",
        version,
        tag: `v${version}`,
        npmChannel: "next",
      },
    });
    const tree = marker.pluginArtifactTree as Record<string, unknown>;
    expect(
      digestReleasePluginArtifactTree(
        RELEASE_PLUGIN_ARTIFACT_PATHS.map((relativePath) => ({
          path: relativePath,
          content: readFileSync(resolve(repositoryRoot, relativePath)),
        })),
      ),
    ).toBe(tree.digestSha256);
  });

  it("starts exactly one MCP server through the bundled relative path", () => {
    const mcpManifest = readJson(
      "plugins/codex-external-agents/.mcp.json",
    );

    expect(mcpManifest).toEqual({
      codex_external_agents: {
        command: "node",
        args: ["./runtime/codex-external-agents-mcp.mjs"],
        cwd: ".",
        env_vars: [
          "ARK_API_KEY",
          "VOLCENGINE_API_KEY",
          "API_KEY_DOUBAO_CODING",
          "OPENAI_API_KEY_DOUBAO",
        ],
      },
    });
    expect(mcpManifest.codex_external_agents).not.toHaveProperty("env");
    expect(JSON.stringify(mcpManifest)).not.toMatch(/[A-Za-z]:[\\/]/u);
  });

  it("accepts only safe relative npm launch paths on either platform", () => {
    for (const absolutePath of [
      "C:\\Program Files\\nodejs\\node.exe",
      "\\\\server\\share\\node.exe",
      "/usr/local/bin/node",
    ]) {
      expect(isAbsoluteOnAnyPlatform(absolutePath)).toBe(true);
      expect(isSafeRelativeLaunchPath(absolutePath)).toBe(false);
    }

    for (const relativePath of [
      "node",
      "./runtime/codex-external-agents-mcp.mjs",
      "runtime\\codex-external-agents-mcp.mjs",
    ]) {
      expect(isAbsoluteOnAnyPlatform(relativePath)).toBe(false);
      expect(isSafeRelativeLaunchPath(relativePath)).toBe(true);
    }

    expect(isSafeRelativeLaunchPath("")).toBe(false);
    expect(isSafeRelativeLaunchPath("   ")).toBe(false);
    for (const unsafeRelativePath of [
      "../escape",
      "..\\escape",
      "C:escape",
      "node\0suffix",
      "node\rsuffix",
      "node\nsuffix",
      " node",
      "node ",
    ]) {
      expect(isSafeRelativeLaunchPath(unsafeRelativePath)).toBe(false);
    }
  });

  it("publishes one Node 24 runtime baseline", () => {
    const packageManifest = readJson("package.json");
    const packageLock = readJson("package-lock.json");
    const packageLockPackages = packageLock.packages as Record<
      string,
      { engines?: unknown }
    >;

    expect(packageManifest.engines).toEqual({ node: ">=24" });
    expect(packageLockPackages[""]?.engines).toEqual({ node: ">=24" });
  });

  it("uses one build pipeline and publishes the exact package file surface", () => {
    const packageManifest = readJson("package.json");
    const scripts = packageManifest.scripts as Record<string, string>;
    const packageFiles = packageManifest.files as string[];

    expect(scripts["build:library"]).toBe("tsup");
    expect(scripts["build:plugin"]).toBe(
      "tsup --config tsup.plugin.config.ts",
    );
    expect(scripts.build).toBe(
      "npm run build:library && npm run build:plugin",
    );
    expect(scripts["acceptance:plugin:isolated"]).toBe(
      "npm run build && npm run acceptance:plugin:isolated:built",
    );
    expect(scripts["acceptance:plugin:isolated:built"]).toBe(
      "node scripts/plugin-isolated-acceptance.mjs",
    );
    expect(scripts).not.toHaveProperty("smoke:pi");
    const capabilityIndex = readJson(
      "docs/smoke/evidence/capabilities.json",
    );
    expect(packageFiles).toEqual([
      "dist/cli.js",
      "dist/mcp.js",
      "README.md",
      "LICENSE",
      "docs/operations.md",
      "docs/migration-from-codex-cc-tools.md",
      ".agents/plugins/marketplace.json",
      "plugins/codex-external-agents/.codex-plugin/plugin.json",
      "plugins/codex-external-agents/.mcp.json",
      "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
      "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe",
      "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256",
      "docs/smoke/evidence/capabilities.json",
      ...capabilitySourcePathsFromIndex(capabilityIndex),
    ]);
    expect(packageFilePathsFromManifest(packageManifest)).toEqual(
      packageFiles,
    );
    expect(dirname(pluginRoot)).toBe(
      resolve(repositoryRoot, "plugins"),
    );
  });

  it("packages exactly the verified Windows x64 managed job helper pair", async () => {
    const packageManifest = readJson("package.json");
    const packageFiles = packageManifest.files as string[];
    const helperFiles = [
      "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe",
      "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256",
    ];

    expect(
      packageFiles.filter((entry) =>
        entry.startsWith("plugins/codex-external-agents/native/"),
      ),
    ).toEqual(helperFiles);

    const resolved = await resolveWindowsJobHelperForModule(
      new URL("../../dist/cli.js", import.meta.url).href,
      "win32",
      "x64",
    );
    expect(resolved.executablePath).toBe(
      resolve(repositoryRoot, helperFiles[0]!),
    );
    expect(resolved.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("copies and runs the already-built MCP entry without repository dependencies", async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), "codex-plugin-artifact-"),
    );
    const isolatedRoot = resolve(temporaryRoot, "isolated");
    const isolatedBundle = resolve(
      isolatedRoot,
      "codex-external-agents-mcp.mjs",
    );
    const builtBundle = resolve(
      pluginRoot,
      "runtime/codex-external-agents-mcp.mjs",
    );
    const client = new Client({
      name: "plugin-artifact-test",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [isolatedBundle],
      cwd: isolatedRoot,
      stderr: "pipe",
    });

    try {
      expect(existsSync(builtBundle)).toBe(true);
      await mkdir(isolatedRoot, { recursive: true });
      await copyFile(builtBundle, isolatedBundle);
      expect(existsSync(resolve(temporaryRoot, "node_modules"))).toBe(false);

      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "external_delegate",
        "external_review",
      ]);

      const output = execFileSync(
        process.execPath,
        [isolatedBundle, "--help"],
        { cwd: isolatedRoot, encoding: "utf8" },
      );
      const bundle = readFileSync(isolatedBundle, "utf8");
      const staticImports = [
        ...bundle.matchAll(
          /^import\s+(?:[^;]+?\s+from\s+)?["']([^"']+)["'];/gmu,
        ),
      ].map((match) => match[1]!);

      expect(output).toContain(
        "codex-external-agents-mcp - codex_external_agents stdio MCP server",
      );
      expect(output).toContain(
        "Tools: external_review, external_delegate",
      );
      expect(staticImports.length).toBeGreaterThan(0);
      expect(
        [...new Set(staticImports)].filter(
          (specifier) => !isBuiltin(specifier),
        ),
      ).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
