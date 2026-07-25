import { describe, expect, it } from "vitest";

import {
  assertAllowedPackFiles,
  assertNoSensitiveContent,
} from "../../src/release/assurance.js";

const PLUGIN_BUNDLE_NAME =
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs";
const RELEASE_SCAN_OPTIONS = { forbiddenPaths: [], secrets: [] } as const;

function assertBundleContent(content: string): void {
  assertNoSensitiveContent(
    [{ name: PLUGIN_BUNDLE_NAME, content }],
    RELEASE_SCAN_OPTIONS,
  );
}

describe("release assurance", () => {
  it("accepts only the documented runtime package surface", () => {
    expect(() =>
      assertAllowedPackFiles([
        "package.json",
        "README.md",
        "LICENSE",
        "docs/operations.md",
        "docs/migration-from-codex-cc-tools.md",
        "docs/release/checklist.md",
        "dist/cli.js",
        "dist/mcp.js",
        "dist/index.d.ts",
        ".agents/plugins/marketplace.json",
        "plugins/codex-external-agents/.codex-plugin/plugin.json",
        "plugins/codex-external-agents/.mcp.json",
        "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
      ]),
    ).not.toThrow();

    expect(() =>
      assertAllowedPackFiles(["package.json", "src/cli/main.ts"]),
    ).toThrow(/src\/cli\/main\.ts/);
    expect(() =>
      assertAllowedPackFiles(["package.json", "AGENTS.md"]),
    ).toThrow(/AGENTS\.md/);
    expect(() =>
      assertAllowedPackFiles([
        "plugins/codex-external-agents/node_modules/zod/index.js",
      ]),
    ).toThrow(/Unexpected file/u);
    expect(() =>
      assertAllowedPackFiles(["dist/node_modules/zod/index.js"]),
    ).toThrow(/Unexpected file/u);
    expect(() =>
      assertAllowedPackFiles([
        "plugins/codex-external-agents/runtime/unexpected.js",
      ]),
    ).toThrow(/Unexpected file/u);
    expect(() =>
      assertAllowedPackFiles([
        ".agents/plugins/another-marketplace.json",
      ]),
    ).toThrow(/Unexpected file/u);
  });

  it("rejects development-machine paths and supplied secret values", () => {
    expect(() =>
      assertNoSensitiveContent(
        [{ name: "dist/cli.js", content: "D:\\Codes\\codex-agent-tools" }],
        { forbiddenPaths: ["D:\\Codes\\codex-agent-tools"], secrets: [] },
      ),
    ).toThrow(/dist\/cli\.js/);

    expect(() =>
      assertNoSensitiveContent(
        [{ name: "README.md", content: "token=super-secret-value" }],
        { forbiddenPaths: [], secrets: ["super-secret-value"] },
      ),
    ).toThrow(/README\.md/);

    expect(() =>
      assertNoSensitiveContent(
        [{ name: "dist/mcp.js", content: "relative source paths only" }],
        { forbiddenPaths: ["D:\\Codes\\codex-agent-tools"], secrets: [] },
      ),
    ).not.toThrow();
  });

  it("rejects unsafe paths, credentials, and production imports in the plugin bundle", () => {
    const bundleName =
      "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs";
    const options = {
      forbiddenPaths: [
        "D:\\Codes\\codex-agent-tools",
        "/home/maintainer/codex-agent-tools",
      ],
      secrets: ["real-secret-sentinel"],
    };

    for (const content of [
      "const root = 'D:\\\\Codes\\\\codex-agent-tools';",
      "const root = '/home/maintainer/codex-agent-tools';",
      "import '../dist/mcp.js';",
      'import { z } from "zod";',
      'const zod = require("zod");',
      'import {\n  z,\n} from "zod";',
      'export {\n  z,\n} from "zod";',
      'await import(\n  "zod"\n);',
      'import "package-that-is-not-installed";',
    ]) {
      expect(() =>
        assertNoSensitiveContent([{ name: bundleName, content }], options),
      ).toThrow();
    }

    let secretFailure: unknown;
    try {
      assertNoSensitiveContent(
        [
          {
            name: bundleName,
            content: "const credential = 'real-secret-sentinel';",
          },
        ],
        options,
      );
    } catch (error) {
      secretFailure = error;
    }
    expect(secretFailure).toBeInstanceOf(Error);
    expect((secretFailure as Error).message).not.toContain(
      "real-secret-sentinel",
    );

    expect(() =>
      assertNoSensitiveContent(
        [
          {
            name: bundleName,
            content: [
              'import path from "node:path";',
              'import { readFile } from "fs/promises";',
              'import {\n  createRequire,\n} from "node:module";',
              'export {\n  readFile,\n} from "node:fs/promises";',
              'await import(\n  "node:path"\n);',
              'const os = require("node:os");',
              "// node_modules/zod is bundled below; this is not an import",
            ].join("\n"),
          },
        ],
        options,
      ),
    ).not.toThrow();
  });

  it.each([
    ["module export", 'module.exports = require("zod");'],
    ["conditional require", 'condition ? require("zod") : null;'],
    [
      "import options",
      'import("zod", { with: { type: "json" } });',
    ],
    ["commented import clause", 'import /*comment*/ z from "zod";'],
    ["commented export clause", 'export * /*comment*/ from "zod";'],
    ["template require", "require(`zod`);"],
  ])("rejects a real non-builtin dependency through %s", (_label, content) => {
    expect(() => assertBundleContent(content)).toThrow(
      /Non-builtin production import/u,
    );
  });

  it.each([
    ["block comment", '/*\nimport z from "zod";\n*/'],
    ["line comment", '// import z from "zod";'],
    [
      "ordinary string",
      "const text = '\\\nimport z from \"zod\"';",
    ],
    ["template literal", 'const text = `\nimport z from "zod";\n`;'],
  ])("ignores dependency-like text inside a %s", (_label, content) => {
    expect(() => assertBundleContent(content)).not.toThrow();
  });

  it.each([
    ["dynamic import", "import(selectModule());"],
    ["require", "condition ? require(selectModule()) : null;"],
    ["esbuild require", "__require(selectModule());"],
    ["template expression", "require(`package/${variant}`);"],
  ])("fails closed for a non-literal %s specifier", (_label, content) => {
    expect(() => assertBundleContent(content)).toThrow(
      /Non-literal production import/u,
    );
  });

  it.each([
    ["module export", 'module.exports = require("node:path");'],
    [
      "conditional require",
      'condition ? require("node:path") : null;',
    ],
    [
      "import options",
      'import("node:fs", { with: { type: "json" } });',
    ],
    [
      "commented import clause",
      'import /*comment*/ path from "node:path";',
    ],
    [
      "commented export clause",
      'export * /*comment*/ from "node:fs";',
    ],
    ["template require", "require(`node:path`);"],
  ])("allows a Node builtin dependency through %s", (_label, content) => {
    expect(() => assertBundleContent(content)).not.toThrow();
  });

  it("fails closed on invalid JavaScript without echoing source text", () => {
    const secretSource = "const broken = ; // parse-secret-sentinel";

    let failure: unknown;
    try {
      assertBundleContent(secretSource);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /Unable to parse plugin bundle/u,
    );
    expect((failure as Error).message).not.toContain(
      "parse-secret-sentinel",
    );
  });
});
