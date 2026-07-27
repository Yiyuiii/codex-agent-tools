# Kimi Observation and Package Closure Long-Term Goal

## Objective

On branch `codex/gemini-retirement` in worktree `D:\Codes\codex-agent-tools\.worktrees\gemini-retirement`, implement the user-approved design at `docs/superpowers/specs/2026-07-27-kimi-command-observation-and-package-closure-design.md` through the two detailed TDD plans:

1. `docs/superpowers/plans/2026-07-27-kimi-command-observation-hardening.md`
2. `docs/superpowers/plans/2026-07-27-package-document-link-closure.md`

Continue autonomously until the repository contains a clean, independently reviewed, fully verified offline candidate or until a genuinely non-self-resolvable blocker requires user judgment.

## Starting state

- Approved design commit: `a279524876b67cdfff8b3e178d5e2dc116306d52`
- Evidence commit: `4f816f012d68e247d215ad4c7ef1b11aca27cfca`
- Latest result-doc commit: `47a932ed20505c0d7fb54cebf1f9834b4a018ed8`
- Registry: `6 passed / 2 pending`
- Installation state: `blocked / not ready`
- Latest real batch: immutable `blocked / case_failed`
- Worktree must be clean before implementation.

## Execution method

Use `superpowers:using-git-worktrees` to verify isolation, `superpowers:subagent-driven-development` for task execution, and `superpowers:test-driven-development` for every behavior change. A fresh subagent may implement one bounded task at a time. The root agent owns:

- plan adherence;
- write-scope conflict prevention;
- RED/GREEN evidence;
- diff inspection;
- specification review;
- code-quality review;
- acceptance of findings;
- full verification;
- final status and human handoff.

Do not run two writable subagents over overlapping files. Read-only reviews may run in parallel when they inspect independent scopes.

## Required sequence

1. Verify branch, worktree isolation, clean status and starting commit.
2. Execute Kimi plan Tasks 1–5 in order, with a commit after each task.
3. Execute package plan Tasks 1–2, with a commit after each task.
4. Reconcile overlapping documentation once, then complete both documentation tasks in one reviewed commit if that avoids conflicting edits.
5. Run independent specification and code-quality review for:
   - Kimi event/observation/evidence changes;
   - package file/link closure changes;
   - combined repository diff and status documentation.
6. Fix every reproducible Critical/Important issue through TDD; adjudicate Minor issues with evidence.
7. Run the complete verification matrix below.
8. Update `AGENTS.md`, relevant status docs, the implementation plan checkboxes, and global model-collaboration memory only when observed model behavior adds a reusable fact.
9. Commit final documentation and ensure the worktree is clean.
10. Freeze the clean offline candidate without running a real batch. Report the exact final HEAD in the human handoff; do not attempt a self-referential tracked SHA.

## Complete verification matrix

Run fresh after the final implementation/documentation commit:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:release
npm.cmd run acceptance:plugin:isolated -- --check-report
npm.cmd run qualify:gates -- --help
npm.cmd run verify:qualification -- --help
```

Run all four immutable verifiers:

```powershell
npm.cmd run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/manifest.json
npm.cmd run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json
npm.cmd run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json
npm.cmd run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json
```

Reuse the exact 5/5 current blocked and 14/14 historical SHA/blob blocks from `docs/superpowers/plans/2026-07-27-ark-coding-qualification-prompt-disambiguation.md`. Also verify:

- Kimi ACP / Pi RPC / real-smoke target processes are `0 / 0 / 0`;
- qualification lock is absent;
- actual npm pack contains both carrier documents;
- every actual packaged Markdown/HTML passes link closure;
- exact plugin package file set remains unchanged;
- no persistent `.tgz` or temporary browser/test artifact remains;
- `git diff --check` passes;
- `git status --short` is empty.

## Hard stop lines

This goal does not authorize:

- any real Kimi or Pi/Ark qualification call;
- generating or consuming a qualification authorization UUID;
- retry, fallback, resume, partial rerun or second batch;
- reading or writing active `~/.codex/config.toml`;
- adding, removing or upgrading the active plugin;
- removing `codex_cc_tools`;
- calling, modifying or uninstalling Claude Code;
- npm publish;
- push, pull request, merge or formal-worktree fast-forward.

If implementation discovers that correctness requires any of these actions, stop and prepare the minimum Chinese human-review package instead of assuming authority.

## Completion and next human decision

The goal is complete when implementation, reviews, verification, documentation and clean candidate freeze are all complete. The next human decision must then be limited to whether to authorize a new full eight-case qualification batch on the exact reported frozen HEAD. Offline completion does not itself authorize that batch.
