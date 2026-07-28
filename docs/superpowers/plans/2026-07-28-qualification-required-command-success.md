# Qualification Required Command Success Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a Pi qualification delegate from passing when the required bash commands were only proposed but their tool lifecycles failed.

**Architecture:** Keep the existing `four-llm-v1`, manifest v2, and evidence v3 envelopes. Extend the enum-only Pi lifecycle evidence with a `status_exact` match, compute a strict two-command success contract inside the qualification producer, and make the verifier require/recompute that contract for any future promotable terminal while retaining blocked/interrupted historical evidence unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, strict JSON evidence verifier.

---

### Task 1: Classify the required status command without leaking it

**Files:**
- Modify: `src/smoke/pi-write-command-observation.ts`
- Modify: `test/smoke/pi-write-command-observation.test.ts`

- [ ] **Step 1: Write the failing sanitizer test**

Extend the existing sanitizer test with this lifecycle item:

```ts
{
  source: "raw_input",
  command: "git status --short",
  origin: "raw_input",
  outcome: "success",
},
```

Pass `"git status --short"` as the third sanitizer argument and add this
expected item at the same position:

```ts
{ source: "raw_input", match: "status_exact", outcome: "success" }
```

Keep the existing field-key and sentinel scans. Also assert the full serialized
array does not contain `"git status --short"`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npm.cmd test -- test/smoke/pi-write-command-observation.test.ts
```

Expected: TypeScript/Vitest fails because the sanitizer accepts only two
arguments and the expected `status_exact` enum is not produced.

- [ ] **Step 3: Implement the minimal enum extension**

Change the match type to:

```ts
export type PiWriteCommandMatch =
  | "exact"
  | "status_exact"
  | "trim_only"
  | "embedded"
  | "other";
```

Change the matcher and public function so the third argument is optional:

```ts
function matchCommand(
  command: string,
  target: string,
  statusTarget?: string,
): PiWriteCommandMatch {
  if (command === target) return "exact";
  if (statusTarget !== undefined && command === statusTarget) {
    return "status_exact";
  }
  if (command.trim() === target) return "trim_only";
  if (command.includes(target)) return "embedded";
  return "other";
}
```

Forward `statusTarget` from `sanitizePiWriteCommandObservations()` into
`matchCommand()`. Do not persist either target.

- [ ] **Step 4: Run sanitizer tests and verify GREEN**

Run:

```powershell
npm.cmd test -- test/smoke/pi-write-command-observation.test.ts
npm.cmd run typecheck
```

Expected: sanitizer test passes; typecheck exits 0.

- [ ] **Step 5: Commit**

```powershell
git add -- src/smoke/pi-write-command-observation.ts test/smoke/pi-write-command-observation.test.ts
git diff --cached --check
git commit -m "test: classify Pi status command lifecycle"
```

### Task 2: Make qualification producer require two successful lifecycles

**Files:**
- Modify: `src/smoke/pi.ts`
- Modify: `test/smoke/pi.test.ts`

- [ ] **Step 1: Write a failing false-positive regression**

Add a qualification delegate test whose fake service:

1. writes the exact expected result file;
2. reports only that file in `filesChanged`;
3. reports `commandsRun: [contract.writeCommand, "git status --short"]`;
4. reports valid telemetry;
5. reports lifecycle observations:

```ts
[
  {
    source: "raw_input",
    command: contract.writeCommand,
    origin: "raw_input",
    outcome: "error",
  },
  {
    source: "raw_input",
    command: "git status --short",
    origin: "raw_input",
    outcome: "success",
  },
]
```

Assert:

```ts
expect(evidence).toMatchObject({
  passed: false,
  failureReason: "acceptance_failed",
  checks: { requiredCommandObserved: false },
  writeCommandObservations: [
    { source: "raw_input", match: "exact", outcome: "error" },
    { source: "raw_input", match: "status_exact", outcome: "success" },
  ],
});
```

All other acceptance checks must be true so the failure is caused only by the
required command success contract.

- [ ] **Step 2: Add RED cases for status missing/error/duplicate**

Use `it.each` to run lifecycle arrays in which:

- the status observation is absent;
- the status outcome is `error`;
- two exact status observations both report success.

For each case, create the valid expected result file and assert
`requiredCommandObserved=false`, `passed=false`, and
`failureReason="acceptance_failed"`.

- [ ] **Step 3: Run Pi smoke tests and verify RED**

Run:

```powershell
npm.cmd test -- test/smoke/pi.test.ts
```

Expected: the new cases fail because the current producer checks only
`commandsRun.includes("git status --short")`.

- [ ] **Step 4: Implement the strict qualification-only helper**

Add:

```ts
const REQUIRED_STATUS_COMMAND = "git status --short";

function exactLifecycleSucceeded(
  observations: readonly PiCommandLifecycleObservation[],
  command: string,
): boolean {
  const matches = observations.filter(
    (observation) =>
      observation.source === "raw_input" &&
      observation.origin === "raw_input" &&
      observation.command === command,
  );
  return matches.length === 1 && matches[0]?.outcome === "success";
}

function requiredPiQualificationCommandsSucceeded(
  observations: readonly PiCommandLifecycleObservation[],
  writeCommand: string,
): boolean {
  return (
    exactLifecycleSucceeded(observations, writeCommand) &&
    exactLifecycleSucceeded(observations, REQUIRED_STATUS_COMMAND)
  );
}
```

Set `checks.requiredCommandObserved` to:

```ts
qualification === null
  ? result.commandsRun.includes(REQUIRED_STATUS_COMMAND)
  : requiredPiQualificationCommandsSucceeded(
      lifecycleObservations!,
      writeCommand,
    )
```

Pass `REQUIRED_STATUS_COMMAND` as the third argument to
`sanitizePiWriteCommandObservations()`.

- [ ] **Step 5: Verify GREEN and non-qualification compatibility**

Run:

```powershell
npm.cmd test -- test/smoke/pi.test.ts test/smoke/pi-write-command-observation.test.ts
npm.cmd test -- test/adapters/pi/adapter.test.ts test/tasks/pi-command-lifecycle.test.ts
npm.cmd run typecheck
```

Expected: all selected tests pass. Existing standalone smoke tests continue to
use command-observed semantics.

- [ ] **Step 6: Commit**

```powershell
git add -- src/smoke/pi.ts test/smoke/pi.test.ts
git diff --cached --check
git commit -m "fix: require successful Pi qualification commands"
```

### Task 3: Make future promotion evidence independently verifiable

**Files:**
- Modify: `src/qualification/verifier.ts`
- Modify: `test/qualification/verifier.test.ts`

- [ ] **Step 1: Update the valid future-passed fixture**

In `evidenceForCase()`, change the second Pi lifecycle match from `other` to:

```ts
{ source: "raw_input", match: "status_exact", outcome: "success" }
```

This represents evidence produced by the hardened producer.

- [ ] **Step 2: Write verifier RED tests**

For a synthetic terminal `passed`, independently mutate one Pi delegate
evidence into each invalid state and coherently republish its evidence
reference:

- delete `writeCommandObservations`;
- set write `outcome: "error"`;
- delete the `status_exact` item and reduce `commandCount`;
- set status `outcome: "error"`;
- duplicate `status_exact` and increase `commandCount`;
- set `checks.requiredCommandObserved=false` while both lifecycles succeed.

Each mutation must be rejected by `verifyQualification()` in
`immutable-evidence` mode. The deletion mutation must additionally be rejected
in `frozen-candidate` mode by supplying the existing `assertFrozenCandidate`
and `collectCurrentCandidate` fixture dependencies.

- [ ] **Step 3: Preserve a historical blocked regression**

Add a test that verifies the committed real batch:

```text
docs/smoke/evidence/batches/
2026-07-28T10-56-09.704Z-649886e3-233e-4da1-ac80-185227342bef/
manifest.json
```

in `immutable-evidence` mode and expects:

```ts
{
  verified: true,
  status: "blocked",
  promotionEligible: false,
}
```

Do not modify or copy-rewrite the retained evidence.

- [ ] **Step 4: Run verifier tests and verify RED**

Run:

```powershell
npm.cmd test -- test/qualification/verifier.test.ts
```

Expected: at least the future-passed deletion/error tests fail because current
diagnostics are optional and do not require lifecycle success.

- [ ] **Step 5: Implement terminal-aware strict validation**

Add `"status_exact"` to `PI_WRITE_MATCHES`.

Extend `validatePiWriteCommandDiagnostics()` with a boolean
`requireSuccessfulContract`. If the field is absent, throw only when this
boolean is true; otherwise retain the historical optional behavior.

While validating the array, collect all `exact` and `status_exact` items.
Compute:

```ts
const contractSucceeded =
  writeMatches.length === 1 &&
  writeMatches[0]?.outcome === "success" &&
  statusMatches.length === 1 &&
  statusMatches[0]?.outcome === "success";
```

After shape/count validation:

```ts
const checks = plainRecord(evidence.checks);
const containsStatusExact = statusMatches.length > 0;
if (
  (containsStatusExact &&
    checks.requiredCommandObserved !== contractSucceeded) ||
  (requireSuccessfulContract &&
    (checks.requiredCommandObserved !== true || !contractSucceeded))
) {
  throw new QualificationVerificationError();
}
```

Thread `manifest.status === "passed"` from `validateManifestEvidence()` through
`validateEvidenceIdentityAndAcceptance()` and pass true to the Pi diagnostic
validator only for Pi delegate evidence. Do not make blocked/interrupted
historical case entries satisfy the new producer contract.

- [ ] **Step 6: Verify GREEN and all retained evidence**

Run:

```powershell
npm.cmd test -- test/qualification/verifier.test.ts
npm.cmd run typecheck
```

Then run the immutable verifier against every retained manifest. Expected:
all synthetic tests pass and every retained manifest still returns
`verified=true`.

- [ ] **Step 7: Commit**

```powershell
git add -- src/qualification/verifier.ts test/qualification/verifier.test.ts
git diff --cached --check
git commit -m "fix: verify Pi qualification command success"
```

### Task 4: Review, document, and freeze

**Files:**
- Review: all Task 1–3 code and tests
- Modify: `AGENTS.md`
- Modify: `docs/release/four-llm-qualification-execution-runbook.md`
- Modify: `docs/release/four-llm-qualification-next-authorization-review.html`
- Modify if needed: `docs/smoke/ark.md`

- [ ] **Step 1: Run independent specification review**

Require proof that:

- producer rejects error/missing/duplicate required lifecycles;
- verifier blocks future terminal passed evidence without the same proof;
- historical blocked/interrupted evidence remains immutable and verifiable;
- no command text or new secret-bearing field enters evidence;
- public MCP, normal delegate, model/provider/route/credential,
  retry/fallback, prompt and validator remain unchanged.

- [ ] **Step 2: Run independent quality/security review**

Check strict array handling, duplicate counting, terminal-status threading,
enum compatibility, non-qualification branch behavior, and no raw command
leakage.

- [ ] **Step 3: Update durable status**

Record the consumed batch, the distinction between quota failure and shell
root cause, the historical ordinal 1 false-positive semantics, both offline
fixes, review results, and the fact that a new real batch still needs an exact
SHA authorization.

- [ ] **Step 4: Run the full deterministic matrix**

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:release
npm.cmd run acceptance:plugin:isolated -- --check-report
git diff --check
```

Expected: all commands exit 0; only the established platform-conditional test
is skipped.

- [ ] **Step 5: Verify evidence and cleanup**

Require:

- every retained manifest `verified=true`;
- Kimi ACP / Pi RPC / real-smoke `0/0/0`;
- qualification lock absent;
- persistent `.tgz` count 0;
- no active config/plugin/Claude/cc-tools/publication operation.

- [ ] **Step 6: Commit status and freeze**

Commit only the intended status files, then re-run focused tests, typecheck,
diff check, exact HEAD, clean tree, retained evidence, target process and lock
checks.

Stop and report the new 40-character SHA. Do not generate a UUID or start a
real model batch without a new exact authorization.
