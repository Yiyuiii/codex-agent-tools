# Pi Windows Shell Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Pi 0.80.10's built-in Windows Git Bash discovery without weakening the project's child-process environment isolation.

**Architecture:** Keep shell selection inside Pi. Extend the existing non-secret base environment allowlist with the two Windows installation-root variables that Pi already reads, and cover the exact allowlist behavior with a synthetic, platform-independent unit test. Do not add project-owned shell discovery, PATH mutation, host-specific Pi configuration, retry, fallback, or qualification changes.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, Pi Coding Agent 0.80.10, PowerShell 5.1 for host probes.

---

### Task 1: Reproduce and close the environment allowlist gap

**Files:**
- Modify: `test/runtime/environment.test.ts`
- Modify: `src/runtime/environment.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("child environment", ...)` block:

```ts
it("preserves Windows program roots needed by Pi shell discovery", () => {
  const env = buildChildEnvironment(
    { network: "direct", credentialEnv: [] },
    {
      PROGRAMFILES: "C:\\Program Files",
      "programfiles(x86)": "C:\\Program Files (x86)",
      ProgramW6432: "C:\\Program Files",
      HTTP_PROXY: "http://parent:1",
    },
  );

  expect(env).toEqual({
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  });
});
```

The synthetic mixed-case input proves that the existing case-insensitive lookup
is reused. The exact object assertion also proves `ProgramW6432` and
`HTTP_PROXY` are still excluded.

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npm.cmd test -- test/runtime/environment.test.ts
```

Expected: the new test fails because the returned object is `{}` instead of
containing `ProgramFiles` and `ProgramFiles(x86)`. Existing tests must still
pass.

- [ ] **Step 3: Add the minimal production allowlist entries**

In `BASE_ENVIRONMENT_KEYS`, add exactly:

```ts
  "ProgramFiles",
  "ProgramFiles(x86)",
```

Place them with the other Windows system variables. Do not add
`ProgramW6432`, proxies, credentials, shell paths, or PATH rewriting.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npm.cmd test -- test/runtime/environment.test.ts
npm.cmd test -- test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts test/smoke/pi.test.ts
npm.cmd run typecheck
```

Expected: all selected tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the TDD fix**

```powershell
git add -- test/runtime/environment.test.ts src/runtime/environment.ts
git diff --cached --check
git commit -m "fix: preserve Pi Windows shell roots"
```

### Task 2: Independently review the minimal implementation

**Files:**
- Review: `src/runtime/environment.ts`
- Review: `test/runtime/environment.test.ts`
- Review: `docs/superpowers/specs/2026-07-28-pi-windows-shell-environment-design.md`

- [ ] **Step 1: Run a specification review**

Check that the diff:

- adds only `ProgramFiles` and `ProgramFiles(x86)` to the base allowlist;
- uses the existing case-insensitive lookup;
- does not change credential, proxy, model, route, prompt, validator,
  retry/fallback, qualification, plugin, or active configuration behavior.

Expected: PASS with no unmet requirement.

- [ ] **Step 2: Run a code-quality and security review**

Check that:

- no secret values are logged or persisted;
- the new test fails on the pre-fix parent and passes on the fix;
- `ProgramW6432` and inherited proxies remain excluded;
- no host-specific absolute Git path enters production code.

Expected: PASS or a bounded patch request. Apply any valid patch through a new
RED→GREEN cycle before proceeding.

### Task 3: Verify the real Pi shell boundary offline

**Files:**
- Read only: installed Pi 0.80.10 `dist/utils/shell.js`
- Temporary only: one system-temp probe directory

- [ ] **Step 1: Verify shell discovery with the production environment builder**

Use `buildChildEnvironment({ network: "direct", credentialEnv: [] })` to create
the exact non-secret base environment, spawn a child Node process with
`extendEnv: false`, import the installed Pi `getShellConfig()`, and serialize
only success/error plus the resolved shell path.

Expected on this host:

```json
{"ok":true,"config":{"shell":"C:\\Program Files\\Git\\bin\\bash.exe","args":["-c"]}}
```

The probe must not print the environment or any credential.

- [ ] **Step 2: Verify the exact qualification write command**

In a fresh system-temp directory, use Node
`spawnSync(shell, ["-c", command])` with the exact
`ark-agent-plan` qualification write command.

Expected:

- exit code `0`;
- one 28-byte `ark-agent-plan-smoke.txt`;
- raw SHA-256
  `81fcf9156bbf05c9deccd3a31abd32ec54bfb7c20a27357b9efb7f6a4b640370`;
- normalized content `ARK_SMOKE_OK:ark-agent-plan`;
- verified cleanup of the exact temp directory.

Do not call Pi RPC or any external model.

### Task 4: Update durable status and freeze a new candidate

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/release/four-llm-qualification-execution-runbook.md`
- Modify: `docs/release/four-llm-qualification-next-authorization-review.html`
- Modify if needed: `docs/smoke/ark.md`

- [ ] **Step 1: Record the consumed batch without overstating the cause**

Document:

- batch ID and original frozen SHA;
- ordinal 1–5 passed, ordinal 6 failed, ordinal 7–8 not run;
- `blocked / case_failed`, `promotionEligible=false`;
- quota failure, extra `where.cmd`, valid result file, and all-error lifecycle
  observations as separate facts;
- the offline proof that missing Windows program roots caused Pi bash
  discovery to fail;
- no retry, fallback, resume,补跑, second entry, or second batch.

- [ ] **Step 2: Record the bounded offline fix**

Document the two-variable allowlist fix, tests, reviews, and offline shell
probe. State explicitly that it does not solve or bypass the external Ark
quota condition.

- [ ] **Step 3: Run the full deterministic matrix**

Run fresh:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:release
npm.cmd run acceptance:plugin:isolated -- --check-report
git diff --check
```

Expected:

- typecheck/build/release/isolated acceptance all exit 0;
- all tests pass except only the established platform-conditional skip;
- the committed isolated report remains current.

- [ ] **Step 4: Verify retained evidence and runtime cleanup**

For every retained batch manifest, run:

```powershell
npm.cmd run --silent verify:qualification -- --mode immutable-evidence --manifest <relative-manifest-path>
```

Expected: every result has `verified=true`. Also require:

- Kimi ACP / Pi RPC / real-smoke counts `0/0/0`;
- qualification lock absent;
- no persistent `.tgz`;
- no access to active `~/.codex/config.toml`.

- [ ] **Step 5: Commit status documents**

```powershell
git add -- AGENTS.md docs/release/four-llm-qualification-execution-runbook.md docs/release/four-llm-qualification-next-authorization-review.html docs/smoke/ark.md
git diff --cached --check
git commit -m "docs: record Pi shell qualification blocker"
```

Omit `docs/smoke/ark.md` from `git add` if it required no change.

- [ ] **Step 6: Freeze and stop at authorization**

Re-run the focused environment test, typecheck, `git diff --check`, exact HEAD,
clean-tree, target-process, lock, and retained-evidence checks after the
documentation commit. Report the resulting 40-character SHA.

Do not generate a qualification UUID or run any real model. A new complete
`four-llm-v1` batch requires a new explicit authorization bound to that exact
SHA.
