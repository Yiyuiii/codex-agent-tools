import { describe, expect, it, vi } from "vitest";

import {
  assertAllowedPackFiles,
  assertNoSensitiveContent,
  assertPackageLocalLinks,
  resolveAllowedPackInspectionPaths,
  resolvePackInspectionPath,
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
  it("resolves an npm-redacted package path to exactly one local file", () => {
    const actual =
      "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json";

    expect(
      resolvePackInspectionPath(
        "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-***/manifest.json",
        [actual, "docs/smoke/evidence/other.json"],
      ),
    ).toBe(actual);
    expect(
      resolvePackInspectionPath("docs/smoke/evidence/other.json", [actual]),
    ).toBe("docs/smoke/evidence/other.json");
  });

  it("fails closed when an npm-redacted package path is missing or ambiguous", () => {
    const redacted =
      "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-***/manifest.json";
    const first =
      "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-first/manifest.json";
    const second =
      "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-second/manifest.json";

    expect(() => resolvePackInspectionPath(redacted, [])).toThrow(
      /Unable to resolve redacted npm package path/u,
    );
    expect(() => resolvePackInspectionPath(redacted, [first, second])).toThrow(
      /Unable to resolve redacted npm package path/u,
    );
    expect(() => resolvePackInspectionPath("../***", ["../escape"])).toThrow(
      /Unsafe npm package path/u,
    );
  });

  it.each([
    [["../../secret.md"]],
    [["../../***"]],
    [["docs/release/unreviewed.md"]],
    [["docs/smoke/evidence/batches/invalid*/manifest.json"]],
    [
      [
        "docs/smoke/evidence/batches/2026-07-27T04-27-07.245Z-***/manifest.json",
        "../../secret.md",
      ],
    ],
    [
      [
        "docs/smoke/evidence/batches/2026-07-27T04-27-07.245Z-***/manifest.json",
        "docs/smoke/evidence/batches/invalid*/manifest.json",
      ],
    ],
  ])(
    "rejects unsafe or unapproved raw package paths before candidate I/O",
    async (fileNames) => {
      const listCandidates = vi.fn(async () => [
        "docs/smoke/evidence/batches/unexpected/manifest.json",
      ]);

      await expect(
        resolveAllowedPackInspectionPaths(fileNames, listCandidates),
      ).rejects.toThrow();
      expect(listCandidates).not.toHaveBeenCalled();
    },
  );

  it("resolves an allowed redacted path with one candidate read", async () => {
    const redacted =
      "docs/smoke/evidence/batches/2026-07-27T04-27-07.245Z-***/manifest.json";
    const actual =
      "docs/smoke/evidence/batches/2026-07-27T04-27-07.245Z-batch/manifest.json";
    const listCandidates = vi.fn(async (candidateDirectory: string) => {
      expect(candidateDirectory).toBe("docs/smoke/evidence/batches");
      return [actual];
    });

    await expect(
      resolveAllowedPackInspectionPaths([redacted], listCandidates),
    ).resolves.toEqual([actual]);
    expect(listCandidates).toHaveBeenCalledTimes(1);
  });

  it("revalidates resolved package paths after candidate I/O", async () => {
    const listCandidates = vi.fn(async () => ["docs/smoke/node_modules"]);

    await expect(
      resolveAllowedPackInspectionPaths(["docs/smoke/***"], listCandidates),
    ).rejects.toThrow(/Unexpected file in npm package/u);
    expect(listCandidates).toHaveBeenCalledTimes(1);
  });

  it("accepts only the documented runtime package surface", () => {
    expect(() =>
      assertAllowedPackFiles([
        "package.json",
        "README.md",
        "LICENSE",
        "docs/operations.md",
        "docs/migration-from-codex-cc-tools.md",
        "docs/release/checklist.md",
        "docs/release/four-llm-qualification-result-review.html",
        "docs/release/four-llm-qualification-authorization-review.html",
        "docs/release/four-llm-qualification-reauthorization-review.html",
        "docs/release/real-plugin-install-review.md",
        "docs/release/plugin-isolated-state.md",
        "docs/superpowers/plans/2026-07-27-authorized-four-llm-qualification-and-convergence.md",
        "docs/smoke/pi-gemini.md",
        "docs/smoke/evidence/gemini-review.json",
        "docs/smoke/evidence/batches/legacy/manifest.json",
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
    expect(() => assertAllowedPackFiles(["package.json", "AGENTS.md"])).toThrow(
      /AGENTS\.md/,
    );
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
      assertAllowedPackFiles([".agents/plugins/another-marketplace.json"]),
    ).toThrow(/Unexpected file/u);
    expect(() =>
      assertAllowedPackFiles(["docs/release/unreviewed-status.md"]),
    ).toThrow(/Unexpected file/u);
    expect(() =>
      assertAllowedPackFiles([
        "docs/superpowers/plans/unreviewed-execution-plan.md",
      ]),
    ).toThrow(/Unexpected file/u);
    expect(() => assertAllowedPackFiles(["../../secret.md"])).toThrow(
      /Unsafe npm package path/u,
    );
    expect(() => assertAllowedPackFiles(["../../***"])).toThrow(
      /Unsafe npm package path/u,
    );
  });

  it("accepts closed HTML and Markdown package-local links while ignoring external links", () => {
    const packageFiles = [
      "docs/release/result.html",
      "docs/release/checklist.md",
      "docs/smoke/evidence/batches/current/manifest.json",
    ];

    expect(() =>
      assertPackageLocalLinks(
        [
          {
            name: "docs/release/result.html",
            content: [
              '<a href="checklist.md?view=review#status">checklist</a>',
              '<a href="../smoke/evidence/batches/current/manifest.json#result">manifest</a>',
              '<a href="https://example.com/reference">web</a>',
              '<a href="mailto:maintainer@example.com">mail</a>',
              '<a href="//cdn.example.com/reference">cdn</a>',
              '<a href="#decision">section</a>',
            ].join("\n"),
          },
          {
            name: "docs/release/checklist.md",
            content: [
              "[Result](result.html#decision)",
              "[Manifest](../smoke/evidence/batches/current/manifest.json?raw=1)",
              "[Web](http://example.com/reference)",
              "[Mail](mailto:maintainer@example.com)",
              "[Section](#status)",
            ].join("\n"),
          },
        ],
        packageFiles,
      ),
    ).not.toThrow();
  });

  it("fails closed for missing or escaping package-local links without echoing document content", () => {
    const secretBody = "link-body-secret-sentinel";
    let missingFailure: unknown;
    try {
      assertPackageLocalLinks(
        [
          {
            name: "docs/release/result.html",
            content: `<a href="missing.md">${secretBody}</a>`,
          },
        ],
        ["docs/release/result.html"],
      );
    } catch (error) {
      missingFailure = error;
    }
    expect(missingFailure).toBeInstanceOf(Error);
    expect((missingFailure as Error).message).toMatch(
      /Local package link target is missing/u,
    );
    expect((missingFailure as Error).message).not.toContain(secretBody);

    expect(() =>
      assertPackageLocalLinks(
        [
          {
            name: "docs/release/checklist.md",
            content: "[Escape](../../../outside.md)",
          },
        ],
        ["docs/release/checklist.md"],
      ),
    ).toThrow(/Local package link escapes the package/u);
  });

  it.each([
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["data", "data:text/plain,secret"],
    ["ftp", "ftp://example.com/release"],
    ["absolute", "/outside.md"],
  ])(
    "rejects unsafe %s package links without echoing the target or document body",
    (_kind, target) => {
      const secretBody = "unsafe-link-body-secret-sentinel";
      let failure: unknown;
      try {
        assertPackageLocalLinks(
          [
            {
              name: "docs/release/result.html",
              content: `<a href="${target}">${secretBody}</a>`,
            },
          ],
          ["docs/release/result.html"],
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/Unsafe package link/u);
      expect((failure as Error).message).not.toContain(target);
      expect((failure as Error).message).not.toContain(secretBody);
    },
  );

  it("scans retained historical documents and evidence with the same secret and path policy", () => {
    const options = {
      forbiddenPaths: ["D:\\Codes\\codex-agent-tools"],
      secrets: ["historical-secret-sentinel"],
    };

    expect(() =>
      assertNoSensitiveContent(
        [
          {
            name: "docs/smoke/pi-gemini.md",
            content: "Retired Gemini history without machine-local values.",
          },
          {
            name: "docs/smoke/evidence/gemini-review.json",
            content: '{"status":"failed","reason":"quota"}',
          },
        ],
        options,
      ),
    ).not.toThrow();
    expect(() =>
      assertNoSensitiveContent(
        [
          {
            name: "docs/smoke/evidence/gemini-review.json",
            content: '{"credential":"historical-secret-sentinel"}',
          },
        ],
        options,
      ),
    ).toThrow(/gemini-review\.json/u);
    expect(() =>
      assertNoSensitiveContent(
        [
          {
            name: "docs/smoke/pi-gemini.md",
            content: "D:\\Codes\\codex-agent-tools",
          },
        ],
        options,
      ),
    ).toThrow(/pi-gemini\.md/u);
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
    ["import options", 'import("zod", { with: { type: "json" } });'],
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
    ["ordinary string", "const text = '\\\nimport z from \"zod\"';"],
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
    ["conditional require", 'condition ? require("node:path") : null;'],
    ["import options", 'import("node:fs", { with: { type: "json" } });'],
    ["commented import clause", 'import /*comment*/ path from "node:path";'],
    ["commented export clause", 'export * /*comment*/ from "node:fs";'],
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
    expect((failure as Error).message).not.toContain("parse-secret-sentinel");
  });
});
