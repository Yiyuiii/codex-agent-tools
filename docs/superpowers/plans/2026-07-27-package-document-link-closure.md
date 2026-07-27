# Npm Package Document Link Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include the two qualification carrier documents in the npm package and fail release smoke whenever any actually packaged Markdown or HTML document contains a missing or unsafe local link.

**Architecture:** Release assurance gains a package-document closure function that derives its source set from the actual resolved pack file list, verifies every packaged Markdown/HTML was inspected, and delegates target validation to the existing safe link parser. The release smoke retains fixed required product documents but no longer uses that fixed list as the link-scanning boundary.

**Tech Stack:** TypeScript 5.9, Node.js 20+, npm pack JSON, Vitest 4, existing release assurance and release smoke.

---

## Scope and fixed invariants

Implement against:

- Design: `docs/superpowers/specs/2026-07-27-kimi-command-observation-and-package-closure-design.md`
- Starting design commit: `a279524876b67cdfff8b3e178d5e2dc116306d52`

Do not:

- broaden package paths beyond the two carrier documents;
- weaken unsafe-link, path escape, secret or development-path rejection;
- generate a persistent `.tgz`;
- install or publish a package;
- alter plugin runtime file exactness.

## File responsibility map

- `src/release/assurance.ts`: allowed package files and generalized document-closure helper.
- `test/release/assurance.test.ts`: document selection, missing inspection, missing target and unsafe target tests.
- `package.json`: npm file inclusion.
- `scripts/release-smoke.mjs`: required files and actual pack-document scan.
- `docs/release/qualification-carrier-rehearsal.md`: newly packaged existing document.
- `docs/release/four-llm-qualification-execution-runbook.md`: newly packaged existing document.
- `README.md`, `docs/operations.md`, `docs/release/checklist.md`, `docs/smoke/ark.md`: existing sources whose missing targets become closed.

### Task 1: Derive link sources from actual package documents

**Files:**

- Modify: `src/release/assurance.ts`
- Modify: `test/release/assurance.test.ts`

- [x] **Step 1: Write a failing test for an unlisted packaged Markdown file**

Add:

```ts
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
```

This proves the helper cannot silently skip a packaged Markdown file merely because a fixed caller list omitted it.

- [x] **Step 2: Write closure success and failure tests**

Cover:

```ts
const entries = [
  { name: "README.md", content: "[Runbook](docs/runbook.md)" },
  { name: "docs/runbook.md", content: "[Home](../README.md)" },
];
const files = ["README.md", "docs/runbook.md", "dist/cli.js"];
expect(() => assertPackageDocumentLinkClosure(entries, files)).not.toThrow();
```

Also assert:

- a packaged HTML omitted from entries fails inspection;
- a packaged JSON omitted from entries does not matter;
- a scanned extra Markdown with a missing target fails;
- unsafe `file:`, `data:`, absolute and escaping targets retain existing redacted errors.

- [x] **Step 3: Run release assurance tests and verify RED**

```powershell
npx.cmd vitest run test/release/assurance.test.ts
```

Expected: FAIL because `assertPackageDocumentLinkClosure` does not exist.

- [x] **Step 4: Implement the generalized helper**

Export:

```ts
export function assertPackageDocumentLinkClosure(
  entries: readonly ReleaseTextEntry[],
  packageFiles: readonly string[],
): void;
```

Implementation rules:

1. Normalize every package path with `assertSafePackPath`.
2. Select every `.md` and `.html` case-insensitively.
3. Build a unique entry map and reject duplicate names.
4. Require every selected document to have exactly one inspected entry.
5. Ignore non-document text entries for link closure.
6. Call `assertPackageLocalLinks(documentEntries, normalizedPackageFiles)`.
7. Errors identify only the safe source name, never link target or body content.

- [x] **Step 5: Run focused tests and typecheck**

```powershell
npx.cmd vitest run test/release/assurance.test.ts
npm.cmd run typecheck
```

Expected: all release assurance tests pass and typecheck exits 0.

- [x] **Step 6: Commit Task 1**

```powershell
git add -- src/release/assurance.ts test/release/assurance.test.ts
git commit -m "fix: scan every packaged document link"
```

Actual commits: `68d59eb`, `0388d89`, `ca74018`, `c416462`.

The review follow-up replaced the growing handwritten Markdown scanner with the exact `commonmark@0.31.2` AST. The remaining HTML tokenizer handles HTML text-only elements, browser-compatible start/end tag edge cases, safe redacted targets and adversarial input in linear time.

### Task 2: Close the actual npm package file set

**Files:**

- Modify: `package.json`
- Modify: `scripts/release-smoke.mjs`
- Modify: `test/release/assurance.test.ts`

- [x] **Step 1: Add failing allowlist tests**

Change the existing `assertAllowedPackFiles` positive test to include:

```ts
"docs/release/qualification-carrier-rehearsal.md",
"docs/release/four-llm-qualification-execution-runbook.md",
```

Expected RED: both files are rejected as unexpected.

- [x] **Step 2: Run the allowlist test and verify RED**

```powershell
npx.cmd vitest run test/release/assurance.test.ts -t "package"
```

Expected: FAIL with `Unexpected file in npm package`.

- [x] **Step 3: Add the exact public files**

Add both paths to:

- `package.json.files`;
- `EXACT_PUBLIC_FILES` in `src/release/assurance.ts`;
- the required pack files in `scripts/release-smoke.mjs`.

Keep the plugin exact file set unchanged.

- [x] **Step 4: Replace the fixed link-source filter**

Import and call:

```js
assertPackageDocumentLinkClosure(textEntries, [...actualPackFileNames]);
```

Remove the `packageLinkEntries` filter and its equality check against `reviewPackageSources`. Keep `reviewPackageSources` only if it remains the fixed required-product-document list; rename it to `requiredReviewPackageSources` so it cannot be mistaken for scan coverage.

- [x] **Step 5: Run the full release smoke**

```powershell
npm.cmd run smoke:release
```

Expected:

- build succeeds;
- npm dry-run contains both carrier documents;
- all actually packaged Markdown/HTML links close;
- release smoke prints `release smoke passed`;
- no `.tgz` remains in the repository.

- [x] **Step 6: Inspect the actual pack document set**

Run a read-only npm pack JSON audit and confirm:

- both carrier documents appear;
- every `.md`/`.html` has an inspected entry;
- no missing local link remains;
- exact plugin file set remains four files.

Do not persist the npm archive.

- [x] **Step 7: Commit Task 2**

```powershell
git add -- package.json src/release/assurance.ts scripts/release-smoke.mjs test/release/assurance.test.ts
git commit -m "fix: close qualification document package links"
```

Actual commit: `1b38b72`.

### Task 3: Document the package closure and review it

**Files:**

- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/release/real-plugin-install-review.md`
- Modify: `docs/smoke/ark.md`
- Modify: `AGENTS.md`

- [x] **Step 1: Replace the known-gap wording**

Record that:

- both carrier documents are now packaged;
- all actual pack Markdown/HTML are scanned;
- this is a release-assurance improvement, not model qualification;
- registry and installation status remain blocked;
- no publish or installation occurred.

- [x] **Step 2: Run documentation and package verification**

```powershell
npm.cmd run typecheck
npx.cmd vitest run test/release/assurance.test.ts
npm.cmd run smoke:release
git diff --check
```

Expected: all commands exit 0.

- [x] **Step 3: Request independent specification and quality review**

Give reviewers the approved design, this plan, actual pack file list, link-closure test output, and diff. Fix reproducible Critical/Important issues with TDD and technically adjudicate Minor issues.

Independent specification and quality/security reviews passed after the CommonMark/HTML follow-up. Fresh pack evidence is 145 files / 15 Markdown-or-HTML documents / 4 exact plugin files, with no retained archive. Commit `4766b6a` also updates the bundled `fast-uri` to 3.1.4; production audit high/critical is zero. The remaining Hono moderate is an upstream MCP SDK dependency whose HTTP/static path is absent from this stdio plugin bundle.

- [x] **Step 4: Commit package documentation**

```powershell
git add -- README.md docs/operations.md docs/release/checklist.md docs/release/real-plugin-install-review.md docs/smoke/ark.md AGENTS.md
git commit -m "docs: record package document closure"
```

Expected: no evidence JSON, activity configuration or plugin state file is changed.
