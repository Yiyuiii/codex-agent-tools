import { describe, expect, it, vi } from "vitest";

import {
  assertAllowedPackFiles,
  assertCapabilitySourcesPackaged,
  assertNoSensitiveContent,
  assertPackageDocumentLinkClosure,
  assertPackageLocalLinks,
  capabilitySourcePathsFromIndex,
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
        "docs/release/qualification-carrier-rehearsal.md",
        "docs/release/four-llm-qualification-execution-runbook.md",
        "docs/release/real-plugin-install-review.md",
        "docs/release/plugin-isolated-state.md",
        "docs/superpowers/plans/2026-07-27-authorized-four-llm-qualification-and-convergence.md",
        "docs/superpowers/plans/2026-07-29-capability-scoped-qualification.md",
        "docs/superpowers/specs/2026-07-29-capability-scoped-qualification-design.md",
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

  it("requires the actual npm package to contain every verified capability source", () => {
    const capabilityIndex = "docs/smoke/evidence/capabilities.json";
    const manifest =
      "docs/smoke/evidence/batches/current/manifest.json";
    const evidence =
      "docs/smoke/evidence/batches/current/cases/review.json";
    const verifiedSources = {
      indexPath: capabilityIndex,
      sourcePaths: [manifest, evidence],
    };

    expect(() =>
      assertCapabilitySourcesPackaged(
        [capabilityIndex, manifest, evidence, "package.json"],
        verifiedSources,
      ),
    ).not.toThrow();
    expect(() =>
      assertCapabilitySourcesPackaged(
        [capabilityIndex, manifest, "package.json"],
        verifiedSources,
      ),
    ).toThrow(/Capability qualification source is missing/u);
    expect(() =>
      assertCapabilitySourcesPackaged(
        [manifest, evidence, "package.json"],
        verifiedSources,
      ),
    ).toThrow(/Capability qualification source is missing/u);
    expect(() =>
      assertCapabilitySourcesPackaged(
        [capabilityIndex, manifest, evidence],
        {
          indexPath: capabilityIndex,
          sourcePaths: ["../outside.json"],
        },
      ),
    ).toThrow(/Unsafe npm package path/u);
  });

  it("extracts only canonical evidence paths from batch and legacy capability sources", () => {
    const manifest =
      "docs/smoke/evidence/batches/current/manifest.json";
    const batchEvidence =
      "docs/smoke/evidence/batches/current/cases/review.json";
    const legacyEvidence = "docs/smoke/evidence/legacy.json";

    expect(
      capabilitySourcePathsFromIndex({
        schemaVersion: 1,
        entries: [
          {
            source: {
              kind: "batch-case",
              manifestPath: manifest,
              evidencePath: batchEvidence,
            },
          },
          {
            source: {
              kind: "legacy-standalone",
              evidencePath: legacyEvidence,
            },
          },
        ],
      }),
    ).toEqual([legacyEvidence, manifest, batchEvidence].sort());
    expect(() =>
      capabilitySourcePathsFromIndex({
        schemaVersion: 1,
        entries: [
          {
            source: {
              kind: "batch-case",
              manifestPath: manifest,
              evidencePath: "docs/smoke/evidence/../outside.json",
            },
          },
        ],
      }),
    ).toThrow(/Capability qualification index is invalid/u);
    expect(() =>
      capabilitySourcePathsFromIndex({
        schemaVersion: 1,
        entries: [{ source: { kind: "unknown" } }],
      }),
    ).toThrow(/Capability qualification index is invalid/u);
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

  it.each([
    [
      "Markdown reference link",
      "docs/release/checklist.md",
      "[Missing][ref]\n\n[ref]: missing.md",
    ],
    [
      "raw HTML in Markdown",
      "docs/release/checklist.md",
      '<a href="missing.md">Missing</a>',
    ],
    [
      "unquoted href in HTML",
      "docs/release/result.html",
      "<a href=missing.md>Missing</a>",
    ],
  ])("detects a missing local target in a %s", (_kind, name, content) => {
    expect(() =>
      assertPackageLocalLinks([{ name, content }], [name]),
    ).toThrow(/Local package link target is missing/u);
  });

  it("accepts closed reference, raw HTML, and unquoted HTML links while ignoring external links and fragments", () => {
    const markdownName = "docs/release/checklist.md";
    const htmlName = "docs/release/result.html";

    expect(() =>
      assertPackageLocalLinks(
        [
          {
            name: markdownName,
            content: [
              "[Result][result]",
              "[Angle][angle]",
              "[Web][web]",
              "[Section][section]",
              "",
              "[result]: result.html#decision",
              '[angle]: <result.html?view=review#decision> "Result"',
              "[web]: https://example.com/reference",
              "[section]: #status",
              '<a href="result.html">Raw local</a>',
              "<a href=https://example.com/reference>Raw web</a>",
              "<a href=#status>Raw section</a>",
            ].join("\n"),
          },
          {
            name: htmlName,
            content: [
              "<a href=checklist.md>Checklist</a>",
              "<a href=https://example.com/reference>Web</a>",
              "<a href=#decision>Section</a>",
            ].join("\n"),
          },
        ],
        [markdownName, htmlName],
      ),
    ).not.toThrow();
  });

  it("ignores Markdown code and escaped link openers while preserving angle destinations", () => {
    const sourceName = "docs/release/checklist.md";

    expect(() =>
      assertPackageLocalLinks(
        [
          {
            name: sourceName,
            content: [
              "[Result](<result.html>)",
              "\\[Escaped](missing-escaped.md)",
              '\\<a href="missing-escaped-html.md">Escaped HTML</a>',
              "`[Inline code](missing-inline.md)`",
              "```md",
              "[Code](missing-code.md)",
              "[code-ref]: missing-reference.md",
              '<a href="missing-raw-html.md">Code sample</a>',
              "```",
            ].join("\n"),
          },
        ],
        [sourceName, "docs/release/result.html"],
      ),
    ).not.toThrow();
  });

  it.each(
    ["docs/release/result.html", "docs/release/checklist.md"].flatMap(
      (name) => [
        [
          "data-href attribute",
          name,
          "<a data-href=missing-data-attribute.md>Example</a>",
        ],
        [
          "href-like quoted attribute value",
          name,
          '<a title="href=missing-title-value.md">Example</a>',
        ],
        [
          "HTML comment",
          name,
          "<!-- <a href=missing-comment.md>Commented example</a> -->",
        ],
        [
          "script raw text",
          name,
          '<script>const example = "<a href=missing-script.md>";</script>',
        ],
        [
          "style raw text",
          name,
          '<style>/* <a href=missing-style.md> */</style>',
        ],
        [
          "textarea RCDATA",
          name,
          "<textarea><a href=missing-textarea.md>Example</a></textarea>",
        ],
        [
          "title RCDATA",
          name,
          "<title><a href=missing-title.md>Example</a></title>",
        ],
      ],
    ),
  )("ignores a %s in %s", (_kind, name, content) => {
    expect(() =>
      assertPackageLocalLinks([{ name, content }], [name]),
    ).not.toThrow();
  });

  it.each([
    [
      "raw-text end tag with attributes",
      "<script>text</script data-x><a href=missing-after-script.md>Real</a>",
    ],
    [
      "RCDATA end tag with attributes",
      "<textarea>text</textarea data-x><a href=missing-after-textarea.md>Real</a>",
    ],
    [
      "raw-text end tag with a self-closing flag",
      "<script>text</script/><a href=missing-after-self-closing.md>Real</a>",
    ],
  ])("checks a real link after a %s", (_kind, content) => {
    const sourceName = "docs/release/result.html";

    expect(() =>
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
    ).toThrow(/Local package link target is missing/u);
  });

  it("ignores link-like text inside a Markdown code span that crosses lines", () => {
    const sourceName = "docs/release/checklist.md";
    const content = "`code\n[not a link](missing.md)\n`";

    expect(() =>
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
    ).not.toThrow();
  });

  it.each([
    "iframe",
    "noembed",
    "noframes",
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
  ])(
    "does not parse Markdown links inside an inline HTML %s text-only element",
    (tag) => {
      const sourceName = "docs/release/checklist.md";
      const content = `Text <${tag}>[Not a link](missing-inline-${tag}.md)</${tag}> text.`;

      expect(() =>
        assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
      ).not.toThrow();
    },
  );

  it("keeps suppressing Markdown links after a plaintext closing-tag spelling", () => {
    const sourceName = "docs/release/checklist.md";
    const content =
      "Text <plaintext>[First](missing-first.md)</plaintext> [Second](missing-second.md)";

    expect(() =>
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
    ).not.toThrow();
  });

  it.each(
    [
      "iframe",
      "noembed",
      "noframes",
      "plaintext",
      "script",
      "style",
      "textarea",
      "title",
      "xmp",
    ].flatMap((tag) => [
      [tag, "docs/release/result.html", `<${tag}/><a href=missing-${tag}.md>Not a link</a></${tag}>`],
      [
        tag,
        "docs/release/checklist.md",
        `Text <${tag}/>[Not a link](missing-${tag}.md)</${tag}> text.`,
      ],
    ]),
  )(
    "ignores the self-closing flag on a non-void %s start tag in %s",
    (_tag, name, content) => {
      expect(() =>
        assertPackageLocalLinks([{ name, content }], [name]),
      ).not.toThrow();
    },
  );

  it.each([
    ["Markdown", "docs/release/checklist.md", "[]()"],
    ["HTML", "docs/release/result.html", '<a href="">Self</a>'],
  ])("allows an empty %s destination as a same-document link", (_kind, name, content) => {
    expect(() =>
      assertPackageLocalLinks([{ name, content }], [name]),
    ).not.toThrow();
  });

  it.each([
    ["Markdown", "docs/release/checklist.md", "[Self](?view=review)"],
    ["HTML", "docs/release/result.html", '<a href="?view=review">Self</a>'],
  ])("allows a query-only %s destination as a same-document link", (_kind, name, content) => {
    expect(() =>
      assertPackageLocalLinks([{ name, content }], [name]),
    ).not.toThrow();
  });

  it("checks a Markdown link in an indented list-item paragraph", () => {
    const sourceName = "docs/release/checklist.md";
    const content = "- item\n\n    [Result](result.md)";

    expect(() =>
      assertPackageLocalLinks(
        [{ name: sourceName, content }],
        [sourceName, "docs/release/result.md"],
      ),
    ).not.toThrow();
    expect(() =>
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
    ).toThrow(/Local package link target is missing/u);
  });

  it("checks a blockquoted Markdown reference link", () => {
    const sourceName = "docs/release/checklist.md";
    const content = "> [Result][ref]\n>\n> [ref]: result.md";

    expect(() =>
      assertPackageLocalLinks(
        [{ name: sourceName, content }],
        [sourceName, "docs/release/result.md"],
      ),
    ).not.toThrow();
    expect(() =>
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
    ).toThrow(/Local package link target is missing/u);
  });

  it.each([
    ["HTML comment", "<!-- [Not a link](missing-comment.md) -->"],
    [
      "script raw text",
      "<script>const example = '[Not a link](missing-script.md)';</script>",
    ],
  ])("does not parse Markdown-style links inside %s", (_kind, content) => {
    const sourceName = "docs/release/checklist.md";

    expect(() =>
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
    ).not.toThrow();
  });

  it.each([
    ["balanced parentheses", "[Result](result_(part).md)"],
    ["escaped parentheses", "[Result](result_\\(part\\).md)"],
  ])(
    "accepts an existing inline Markdown destination with %s",
    (_kind, content) => {
      const sourceName = "docs/release/checklist.md";

      expect(() =>
        assertPackageLocalLinks(
          [{ name: sourceName, content }],
          [sourceName, "docs/release/result_(part).md"],
        ),
      ).not.toThrow();
    },
  );

  it.each([
    [
      "balanced parentheses",
      "[Missing](missing_(part).md)",
      "docs/release/missing_(part",
    ],
    [
      "escaped parentheses",
      "[Missing](missing_\\(part\\).md)",
      "docs/release/missing_(part).md.prefix",
    ],
  ])(
    "rejects a missing full inline Markdown destination with %s",
    (_kind, content, misleadingPrefix) => {
      const sourceName = "docs/release/checklist.md";

      expect(() =>
        assertPackageLocalLinks(
          [{ name: sourceName, content }],
          [sourceName, misleadingPrefix],
        ),
      ).toThrow(/Local package link target is missing/u);
    },
  );

  it("checks a reference definition destination after one line ending", () => {
    const sourceName = "docs/release/checklist.md";
    const content = "[Result][ref]\n\n[ref]:\n  result.md";

    expect(() =>
      assertPackageLocalLinks(
        [{ name: sourceName, content }],
        [sourceName, "docs/release/result.md"],
      ),
    ).not.toThrow();
    expect(() =>
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
    ).toThrow(/Local package link target is missing/u);
  });

  it("rejects and redacts an unsafe reference destination after one line ending", () => {
    const sourceName = "docs/release/checklist.md";
    const unsafeTarget = "javascript:reference-target-secret";
    const content = `[Unsafe][ref]\n\n[ref]:\n  ${unsafeTarget}`;
    let failure: unknown;
    try {
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Unsafe package link/u);
    expect((failure as Error).message).toContain(sourceName);
    expect((failure as Error).message).not.toContain(unsafeTarget);
    expect((failure as Error).message).not.toContain(
      "reference-target-secret",
    );
  });

  it.each([
    ["escaped closing bracket", "[foo\\]](missing.md)"],
    ["nested brackets", "[foo [bar]](missing.md)"],
  ])(
    "checks an inline Markdown link with %s in its label",
    (_kind, missingContent) => {
      const sourceName = "docs/release/checklist.md";
      const existingContent = missingContent.replace("missing.md", "result.md");

      expect(() =>
        assertPackageLocalLinks(
          [{ name: sourceName, content: existingContent }],
          [sourceName, "docs/release/result.md"],
        ),
      ).not.toThrow();
      expect(() =>
        assertPackageLocalLinks(
          [{ name: sourceName, content: missingContent }],
          [sourceName],
        ),
      ).toThrow(/Local package link target is missing/u);
    },
  );

  it("does not treat a backtick fence with a backtick in its info string as a code fence", () => {
    const sourceName = "docs/release/checklist.md";
    const content = [
      "``` bad`info",
      "[Not code](missing.md)",
      "```",
    ].join("\n");

    expect(() =>
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
    ).toThrow(/Local package link target is missing/u);
  });

  it.each([
    [
      "unbalanced parenthesis nesting",
      "[Secret](missing_(target-secret.md)",
    ],
    ["unterminated angle destination", "[Secret](<target-secret.md)"],
    [
      "more than one line ending before a reference destination",
      "[ref]:\n\n  target-secret.md",
    ],
  ])(
    "treats CommonMark %s as ordinary text",
    (_kind, content) => {
      const sourceName = "docs/release/checklist.md";

      expect(() =>
        assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
      ).not.toThrow();
    },
  );

  it("checks a deeply balanced destination that CommonMark parses as a link", () => {
    const sourceName = "docs/release/checklist.md";
    const target = `${"(".repeat(33)}target-secret${")".repeat(33)}`;
    const content = `[Secret](${target})`;
    let failure: unknown;
    try {
      assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /Local package link target is missing/u,
    );
    expect((failure as Error).message).toContain(sourceName);
    expect((failure as Error).message).not.toContain(target);
    expect((failure as Error).message).not.toContain("target-secret");
  });

  it(
    "processes many malformed HTML tag openers without repeatedly rescanning the tail",
    () => {
      const sourceName = "docs/release/result.html";
      const content = "<a ".repeat(15_000);

      expect(() =>
        assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
      ).not.toThrow();
    },
    750,
  );

  it(
    "skips many non-matching raw-text end-tag candidates in linear time",
    () => {
      const sourceName = "docs/release/result.html";
      const content = `<script>${"</a ".repeat(15_000)}`;

      expect(() =>
        assertPackageLocalLinks([{ name: sourceName, content }], [sourceName]),
      ).not.toThrow();
    },
    750,
  );

  it.each([
    [
      "Markdown reference definition",
      "docs/release/checklist.md",
      "[Unsafe][ref]\n\n[ref]: javascript:sensitive-target",
      "javascript:sensitive-target",
    ],
    [
      "raw HTML in Markdown",
      "docs/release/checklist.md",
      '<a href="../../../sensitive-target.md">document-body-secret-sentinel</a>',
      "../../../sensitive-target.md",
    ],
    [
      "unquoted href in HTML",
      "docs/release/result.html",
      "<a href=data:text/plain,sensitive-target>document-body-secret-sentinel</a>",
      "data:text/plain,sensitive-target",
    ],
  ])(
    "redacts an unsafe target and document body from a %s failure",
    (_kind, name, content, target) => {
      let failure: unknown;
      try {
        assertPackageLocalLinks([{ name, content }], [name]);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        /Unsafe package link|Local package link escapes the package/u,
      );
      expect((failure as Error).message).not.toContain(target);
      expect((failure as Error).message).not.toContain(
        "document-body-secret-sentinel",
      );
      expect((failure as Error).message).not.toContain("sensitive-target");
    },
  );

  it("requires every packaged Markdown document to be inspected", () => {
    expect(() =>
      assertPackageDocumentLinkClosure(
        [
          {
            name: "README.md",
            content: "[Extra](docs/extra.md)",
          },
        ],
        ["README.md", "docs/extra.md"],
      ),
    ).toThrow(/Package document was not inspected/u);
  });

  it("checks a closed document graph selected from the actual package files", () => {
    expect(() =>
      assertPackageDocumentLinkClosure(
        [
          {
            name: "README.md",
            content: "[Runbook](docs/runbook.md)",
          },
          {
            name: "docs/runbook.md",
            content: "[Home](../README.md)",
          },
        ],
        ["README.md", "docs/runbook.md", "package.json", "dist/cli.js"],
      ),
    ).not.toThrow();
  });

  it("requires packaged HTML but not packaged JSON or JavaScript to be inspected", () => {
    expect(() =>
      assertPackageDocumentLinkClosure(
        [{ name: "README.md", content: "Release overview." }],
        ["README.md", "docs/result.html", "package.json", "dist/cli.js"],
      ),
    ).toThrow(/Package document was not inspected: docs\/result\.html/u);

    expect(() =>
      assertPackageDocumentLinkClosure(
        [{ name: "README.md", content: "Release overview." }],
        ["README.md", "package.json", "dist/cli.js"],
      ),
    ).not.toThrow();
  });

  it("checks links in every additional packaged Markdown document", () => {
    expect(() =>
      assertPackageDocumentLinkClosure(
        [
          { name: "README.md", content: "[Extra](docs/extra.md)" },
          {
            name: "docs/extra.md",
            content: "[Missing](missing-target.md)",
          },
        ],
        ["README.md", "docs/extra.md"],
      ),
    ).toThrow(/Local package link target is missing for docs\/extra\.md/u);
  });

  it("recognizes packaged document extensions case-insensitively", () => {
    expect(() =>
      assertPackageDocumentLinkClosure(
        [
          { name: "README.MD", content: "[Result](docs/result.HTML)" },
          {
            name: "docs/result.HTML",
            content: '<a href="../README.MD">Home</a>',
          },
        ],
        ["README.MD", "docs/result.HTML"],
      ),
    ).not.toThrow();
  });

  it("rejects duplicate inspected entries after path normalization", () => {
    expect(() =>
      assertPackageDocumentLinkClosure(
        [
          { name: "docs/runbook.md", content: "First." },
          { name: "docs\\runbook.md", content: "Second." },
        ],
        ["docs/runbook.md"],
      ),
    ).toThrow(/Package entry was inspected more than once: docs\/runbook\.md/u);
  });

  it("does not let unpackaged document entries expand the package link graph", () => {
    expect(() =>
      assertPackageDocumentLinkClosure(
        [
          { name: "README.md", content: "Release overview." },
          {
            name: "notes/internal.md",
            content: "[Not packaged](missing-target.md)",
          },
        ],
        ["README.md", "package.json"],
      ),
    ).not.toThrow();
  });

  it.each([
    ["file", "file:///sensitive-target"],
    ["data", "data:text/plain,sensitive-target"],
    ["javascript", "javascript:sensitive-target"],
    ["absolute", "/sensitive-target.md"],
    ["escaping", "../../../sensitive-target.md"],
  ])(
    "keeps unsafe %s document-closure link failures redacted",
    (_kind, target) => {
      const sourceName = "docs/release/result.html";
      const secretBody = "document-body-secret-sentinel";
      let failure: unknown;
      try {
        assertPackageDocumentLinkClosure(
          [
            {
              name: sourceName,
              content: `<a href="${target}">${secretBody}</a>`,
            },
          ],
          [sourceName],
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(sourceName);
      expect((failure as Error).message).not.toContain(target);
      expect((failure as Error).message).not.toContain(secretBody);
    },
  );

  it("rejects unsafe package and entry paths before checking document closure", () => {
    expect(() =>
      assertPackageDocumentLinkClosure([], ["../README.md"]),
    ).toThrow(/Unsafe npm package path/u);
    expect(() =>
      assertPackageDocumentLinkClosure(
        [{ name: "../README.md", content: "Unsafe source." }],
        ["README.md"],
      ),
    ).toThrow(/Unsafe npm package path/u);
  });

  it("redacts an unsafe package file path from document-closure errors", () => {
    const unsafePath = "../package-path-secret-sentinel.md";
    let failure: unknown;
    try {
      assertPackageDocumentLinkClosure([], [unsafePath]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Unsafe npm package path/u);
    expect((failure as Error).message).not.toContain(unsafePath);
    expect((failure as Error).message).not.toContain("secret-sentinel");
  });

  it("redacts an unsafe entry name from document-closure errors", () => {
    const unsafePath = "../entry-path-secret-sentinel.md";
    let failure: unknown;
    try {
      assertPackageDocumentLinkClosure(
        [{ name: unsafePath, content: "Sensitive document body." }],
        ["README.md"],
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Unsafe npm package path/u);
    expect((failure as Error).message).not.toContain(unsafePath);
    expect((failure as Error).message).not.toContain("secret-sentinel");
  });

  it("redacts a Windows absolute package file path from closure errors", () => {
    const unsafePath = "C:\\package-path-secret-sentinel.md";
    let failure: unknown;
    try {
      assertPackageDocumentLinkClosure([], [unsafePath]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Unsafe npm package path/u);
    expect((failure as Error).message).not.toContain(unsafePath);
    expect((failure as Error).message).not.toContain("secret-sentinel");
  });

  it("redacts a Windows absolute entry name from closure errors", () => {
    const unsafePath = "C:\\entry-path-secret-sentinel.md";
    let failure: unknown;
    try {
      assertPackageDocumentLinkClosure(
        [{ name: unsafePath, content: "Sensitive document body." }],
        [],
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Unsafe npm package path/u);
    expect((failure as Error).message).not.toContain(unsafePath);
    expect((failure as Error).message).not.toContain("secret-sentinel");
  });

  it.each([
    ["Windows drive path", "C:\\release\\README.md"],
    ["slash-normalized Windows drive path", "C:/release/README.md"],
    ["Windows UNC path", "\\\\server\\share\\README.md"],
  ])(
    "rejects a %s at the shared package path safety gate",
    (_kind, unsafePath) => {
      expect(() => assertAllowedPackFiles([unsafePath])).toThrow(
        /Unsafe npm package path/u,
      );
      expect(() => resolvePackInspectionPath(unsafePath, [])).toThrow(
        /Unsafe npm package path/u,
      );
    },
  );

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
