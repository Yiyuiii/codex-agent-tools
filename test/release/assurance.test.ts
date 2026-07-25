import { describe, expect, it } from "vitest";

import {
  assertAllowedPackFiles,
  assertNoSensitiveContent,
} from "../../src/release/assurance.js";

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
              "// node_modules/zod is bundled below; this is not an import",
            ].join("\n"),
          },
        ],
        options,
      ),
    ).not.toThrow();
  });
});
