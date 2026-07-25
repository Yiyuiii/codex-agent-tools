import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
    if (Array.isArray(defaultPrompt)) {
      expect(defaultPrompt.length).toBeLessThanOrEqual(3);
      for (const prompt of defaultPrompt) {
        expect(typeof prompt).toBe("string");
        expect((prompt as string).length).toBeLessThanOrEqual(128);
      }
    } else {
      expect(typeof defaultPrompt).toBe("string");
      expect((defaultPrompt as string).length).toBeLessThanOrEqual(128);
    }
  });

  it("starts exactly one MCP server through the bundled relative path", () => {
    const mcpManifest = readJson(
      "plugins/codex-external-agents/.mcp.json",
    );

    expect(mcpManifest).toEqual({
      codex_external_agents: {
        command: "node",
        args: ["./runtime/codex-external-agents-mcp.mjs"],
      },
    });
    expect(JSON.stringify(mcpManifest)).not.toMatch(
      /(?:\benv\b|[A-Za-z]:[\\/]|(?:api[_-]?key|secret|token))/iu,
    );
  });

  it("builds the MCP entry as a self-contained plugin runtime", () => {
    const buildConfig = readFileSync(
      resolve(repositoryRoot, "tsup.plugin.config.ts"),
      "utf8",
    );

    expect(buildConfig).toMatch(
      /entry:\s*\{\s*"codex-external-agents-mcp":\s*"src\/mcp\/main\.ts",?\s*\}/u,
    );
    expect(buildConfig).toContain(
      'outDir: "plugins/codex-external-agents/runtime"',
    );
    expect(buildConfig).toContain('format: ["esm"]');
    expect(buildConfig).toContain(
      'outExtension: () => ({ js: ".mjs" })',
    );
    expect(buildConfig).toContain('platform: "node"');
    expect(buildConfig).toContain('target: "node20"');
    expect(buildConfig).toContain("bundle: true");
    expect(buildConfig).toContain("noExternal: [/.*/u]");
    expect(buildConfig).toContain("splitting: false");
    expect(buildConfig).toContain("dts: false");
    expect(buildConfig).toContain("sourcemap: false");
    expect(buildConfig).toContain("clean: true");
  });

  it("runs library then plugin builds and ignores only the runtime directory", () => {
    const packageManifest = readJson("package.json");
    const scripts = packageManifest.scripts as Record<string, string>;
    const gitignoreLines = readFileSync(
      resolve(repositoryRoot, ".gitignore"),
      "utf8",
    )
      .split(/\r?\n/u)
      .filter(Boolean);

    expect(scripts["build:library"]).toBe("tsup");
    expect(scripts["build:plugin"]).toBe(
      "tsup --config tsup.plugin.config.ts",
    );
    expect(scripts.build).toBe(
      "npm run build:library && npm run build:plugin",
    );
    expect(gitignoreLines).toContain(
      "plugins/codex-external-agents/runtime/",
    );
    expect(dirname(pluginRoot)).toBe(
      resolve(repositoryRoot, "plugins"),
    );
  });

  it("runs the bundled MCP entry without repository dependencies", () => {
    const bundlePath = resolve(
      pluginRoot,
      "runtime/codex-external-agents-mcp.mjs",
    );
    const output = execFileSync(
      process.execPath,
      [bundlePath, "--help"],
      { encoding: "utf8" },
    );
    const bundle = readFileSync(bundlePath, "utf8");
    const staticImports = [
      ...bundle.matchAll(
        /^import\s+(?:[^;]+?\s+from\s+)?["']([^"']+)["'];/gmu,
      ),
    ].map((match) => match[1]!);

    expect(output).toContain(
      "codex-external-agents-mcp - codex_external_agents stdio MCP server",
    );
    expect(output).toContain("Tools: external_review, external_delegate");
    expect(staticImports.length).toBeGreaterThan(0);
    expect(
      [...new Set(staticImports)].filter(
        (specifier) => !isBuiltin(specifier),
      ),
    ).toEqual([]);
  });
});
