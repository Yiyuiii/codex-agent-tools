# Kimi Qualification Command Observation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Kimi ACP late tool input, derive deterministic command observations, and emit sanitized qualification diagnostics without weakening the exact command gate or changing the public MCP result schema.

**Architecture:** The Kimi ACP client preserves only protocol fields needed by command observation. A focused task-layer module folds tool events by `toolCallId`, safely extracts one final command observation per execute call, and the service reports those observations through an internal context callback while keeping `commandsRun: string[]`. Kimi smoke converts the internal observations to enum-only evidence, and the immutable verifier validates the optional diagnostic field when present while retaining historical evidence compatibility.

**Tech Stack:** TypeScript 5.9, Node.js 20+, `@agentclientprotocol/sdk` 1.2.1, Vitest 4, existing smoke evidence and qualification verifier infrastructure.

---

## Scope and fixed invariants

Implement against:

- Design: `docs/superpowers/specs/2026-07-27-kimi-command-observation-and-package-closure-design.md`
- Starting design commit: `a279524876b67cdfff8b3e178d5e2dc116306d52`
- Latest immutable batch: `docs/smoke/evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/manifest.json`

Do not change:

- `commandsRun.includes("git status --short")`;
- Kimi model, direct route, permissions, credential handling, single-attempt or retry/fallback policy;
- public `ExternalDelegateResult` or MCP schemas;
- existing evidence JSON;
- active qualification plan, manifest or checkpoint schema;
- registry status `6 passed / 2 pending`.

## File responsibility map

- `test/fakes/fake-kimi-acp.mjs`: deterministic ACP late-update fixture.
- `src/adapters/kimi/client.ts`: preserve selected ACP update fields without interpreting commands.
- `test/adapters/kimi/client.test.ts`: prove the real ACP client delivers late fields.
- `src/tasks/command-observations.ts`: safe fold/extraction logic and internal types.
- `test/tasks/command-observations.test.ts`: exhaustive fold, source and safety semantics.
- `src/tasks/service.ts`: report observations once through `TaskExecutionContext` and derive public `commandsRun`.
- `test/tasks/service.test.ts`: integration and public-surface non-regression.
- `src/smoke/command-observation.ts`: target-specific enum-only match classification.
- `test/smoke/command-observation.test.ts`: exact/trim/embedded/other classification.
- `src/smoke/kimi.ts`: strengthened prompt, internal observer, sanitized evidence.
- `test/smoke/kimi.test.ts`: qualification prompt/evidence/strict-validator coverage.
- `src/qualification/verifier.ts`: optional diagnostic-shape consistency checks.
- `test/qualification/verifier.test.ts`: new evidence validation and historical compatibility.

### Task 1: Preserve ACP late tool fields

**Files:**

- Modify: `test/fakes/fake-kimi-acp.mjs`
- Modify: `test/adapters/kimi/client.test.ts`
- Modify: `src/adapters/kimi/client.ts`

- [x] **Step 1: Add a fake ACP late-input scenario**

Add a branch in `fake-kimi-acp.mjs` that emits:

```js
{
  sessionUpdate: "tool_call",
  toolCallId: "execute-late-1",
  title: "Run verification",
  kind: "execute",
  status: "in_progress",
  locations: []
}
```

followed by:

```js
{
  sessionUpdate: "tool_call_update",
  toolCallId: "execute-late-1",
  status: "completed",
  rawInput: { command: "git status --short" }
}
```

The fixture must return normally and must not write a file or include the command in its message text.

- [x] **Step 2: Write the failing Kimi client test**

Add a test named `preserves command input first delivered by a tool-call update`:

```ts
const result = await runKimiAcp(
  baseRequest({
    environment: {
      ...process.env,
      FAKE_KIMI_SCENARIO: "late-execute-input",
    },
  }),
);

expect(result.status).toBe("completed");
expect(result.events).toContainEqual({
  type: "tool_call_update",
  toolCallId: "execute-late-1",
  status: "completed",
  rawInput: { command: "git status --short" },
});
expect(result.diagnostics.join("\n")).not.toContain("git status --short");
```

- [x] **Step 3: Run the test and verify RED**

Run:

```powershell
npx.cmd vitest run test/adapters/kimi/client.test.ts -t "preserves command input first delivered by a tool-call update"
```

Expected: FAIL because `tool_call_update` currently drops `rawInput`.

- [x] **Step 4: Extend the update event type and collector**

Change the update branch to:

```ts
{
  type: "tool_call_update";
  toolCallId: string;
  kind?: string | null;
  status?: string | null;
  title?: string | null;
  rawInput?: unknown;
}
```

In `collectUpdate`, copy only `kind`, `status`, `title`, and `rawInput` when the SDK update field is not `undefined`. Preserve explicit `null` for protocol fields that allow it. Do not stringify or log `rawInput`.

- [x] **Step 5: Run focused client tests and typecheck**

Run:

```powershell
npx.cmd vitest run test/adapters/kimi/client.test.ts
npm.cmd run typecheck
```

Expected: all Kimi client tests pass and typecheck exits 0.

- [x] **Step 6: Commit Task 1**

```powershell
git add -- test/fakes/fake-kimi-acp.mjs test/adapters/kimi/client.test.ts src/adapters/kimi/client.ts
git commit -m "fix: preserve Kimi ACP late tool inputs"
```

Actual commit: `d681f8f`.

### Task 2: Fold and safely extract command observations

**Files:**

- Create: `src/tasks/command-observations.ts`
- Create: `test/tasks/command-observations.test.ts`

- [x] **Step 1: Write table-driven failing tests**

Define tests for these final observations:

```ts
[
  {
    name: "initial raw input",
    events: [{
      type: "tool_call",
      toolCallId: "a",
      kind: "execute",
      title: "Run",
      rawInput: { command: "npm test" },
    }],
    expected: [{ source: "raw_input", command: "npm test" }],
  },
  {
    name: "initial title fallback",
    events: [{
      type: "tool_call",
      toolCallId: "a",
      kind: "execute",
      title: "Run tests",
    }],
    expected: [{ source: "title_fallback", command: "Run tests" }],
  },
  {
    name: "late raw input",
    events: [
      { type: "tool_call", toolCallId: "a", kind: "execute", title: "Run" },
      {
        type: "tool_call_update",
        toolCallId: "a",
        rawInput: { command: "git status --short" },
      },
    ],
    expected: [{ source: "late_update", command: "git status --short" }],
  },
  {
    name: "unextractable execute",
    events: [{
      type: "tool_call",
      toolCallId: "a",
      kind: "execute",
      title: "",
    }],
    expected: [{ source: "unextractable", command: null }],
  },
]
```

Also test:

- update-before-initial merges if the initial call later arrives;
- orphan update produces no observation;
- non-execute calls produce no observation;
- repeated updates use final state;
- two IDs preserve first-seen tool-call order;
- a late `kind="execute"` marks the source `late_update`;
- Proxy, accessor `command`, inherited `command`, non-string command and non-plain raw input never invoke user code and fall back safely.

- [x] **Step 2: Run the new test and verify RED**

Run:

```powershell
npx.cmd vitest run test/tasks/command-observations.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the internal types**

Create:

```ts
export type CommandObservationSource =
  | "raw_input"
  | "title_fallback"
  | "late_update"
  | "unextractable";

export interface CommandObservation {
  source: CommandObservationSource;
  command: string | null;
}
```

Export:

```ts
export function extractCommandObservations(
  events: readonly unknown[],
): readonly CommandObservation[];

export function commandsFromObservations(
  observations: readonly CommandObservation[],
): string[];
```

- [x] **Step 4: Implement fail-closed folding**

Use a `Map<string, FoldedToolCall>` keyed by string `toolCallId`, plus first-seen order. Accept only `tool_call` and `tool_call_update` records. Track whether final `kind`, raw command, or title material was first supplied or replaced by an update.

For raw input:

```ts
if (
  typeof rawInput === "object" &&
  rawInput !== null &&
  !types.isProxy(rawInput) &&
  Object.getPrototypeOf(rawInput) === Object.prototype
) {
  const descriptor = Object.getOwnPropertyDescriptor(rawInput, "command");
  if (descriptor !== undefined && "value" in descriptor &&
      typeof descriptor.value === "string") {
    return descriptor.value;
  }
}
```

Do not call getters, `toString`, iterators or serialization methods. A late field material to the final command yields `late_update`; otherwise prefer initial raw input, then initial non-empty title, then `unextractable`.

- [x] **Step 5: Run focused tests**

Run:

```powershell
npx.cmd vitest run test/tasks/command-observations.test.ts
npm.cmd run typecheck
```

Expected: all new tests pass and typecheck exits 0.

- [x] **Step 6: Commit Task 2**

```powershell
git add -- src/tasks/command-observations.ts test/tasks/command-observations.test.ts
git commit -m "feat: derive sanitized command observations"
```

Actual commit: `6c92cf0`.

### Task 3: Integrate observations into the task service

**Files:**

- Modify: `src/tasks/service.ts`
- Modify: `test/tasks/service.test.ts`

- [x] **Step 1: Write failing service tests**

Add tests that:

```ts
const observed: readonly CommandObservation[][] = [];
const result = await service.delegate(
  { llm: "kimi-k3", prompt: "Run", cwd },
  { onCommandObservations: (value) => observed.push(value) },
);

expect(observed).toEqual([[
  { source: "late_update", command: "git status --short" },
]]);
expect(result.commandsRun).toEqual(["git status --short"]);
expect(result).not.toHaveProperty("commandObservations");
```

Use adapter events containing an initial execute call and a late raw-input update. Add a second test proving the callback fires exactly once with `[]` when adapter execution throws or has no execute events.

- [x] **Step 2: Run the focused service test and verify RED**

Run:

```powershell
npx.cmd vitest run test/tasks/service.test.ts -t "command observation"
```

Expected: FAIL because `TaskExecutionContext` has no observer and service ignores updates.

- [x] **Step 3: Add the internal callback and use the extractor**

Extend context:

```ts
onCommandObservations?: (
  observations: readonly CommandObservation[],
) => void;
```

In `#runDelegate`, derive observations once after adapter completion:

```ts
const commandObservations = extractCommandObservations(adapterResult.events);
context.onCommandObservations?.(commandObservations);
```

Return:

```ts
commandsRun: commandsFromObservations(commandObservations)
```

Remove the old local `extractCommands`. Do not add the internal array to `ExternalDelegateResult`, Zod schemas or MCP structured content.

- [x] **Step 4: Run service and MCP non-regression tests**

Run:

```powershell
npx.cmd vitest run test/tasks/service.test.ts test/mcp/server.test.ts
npm.cmd run typecheck
```

Expected: all tests pass; MCP results still contain no internal observer field.

- [x] **Step 5: Commit Task 3**

```powershell
git add -- src/tasks/service.ts test/tasks/service.test.ts
git commit -m "feat: report internal command observations"
```

Actual commits: `86a21ac`, `bc5069e`, `55a7f51`.

### Task 4: Emit sanitized Kimi qualification evidence

**Files:**

- Create: `src/smoke/command-observation.ts`
- Create: `test/smoke/command-observation.test.ts`
- Modify: `src/smoke/kimi.ts`
- Modify: `test/smoke/kimi.test.ts`

- [x] **Step 1: Write classification tests**

Test:

```ts
expect(sanitizeCommandObservations(
  [
    { source: "raw_input", command: "git status --short" },
    { source: "raw_input", command: " git status --short\n" },
    { source: "late_update", command: "echo ok && git status --short" },
    { source: "unextractable", command: null },
  ],
  "git status --short",
)).toEqual([
  { source: "raw_input", match: "exact" },
  { source: "raw_input", match: "trim_only" },
  { source: "late_update", match: "embedded" },
  { source: "unextractable", match: "other" },
]);
```

Verify returned objects contain only `source` and `match`, and invalid source/command pairs cannot be constructed through the typed API.

- [x] **Step 2: Run classification test and verify RED**

```powershell
npx.cmd vitest run test/smoke/command-observation.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement classifier**

Export `CommandMatchClass`, `SanitizedCommandObservation`, and:

```ts
export function sanitizeCommandObservations(
  observations: readonly CommandObservation[],
  target: string,
): readonly SanitizedCommandObservation[];
```

Match in exact → trim-only → embedded → other order. Never return the command.

- [x] **Step 4: Write failing Kimi smoke tests**

Extend the delegate fixture to invoke both internal callbacks. Assert:

```ts
expect(evidence.commandObservations).toEqual([
  { source: "late_update", match: "exact" },
]);
expect(JSON.stringify(evidence)).not.toContain("echo secret");
```

Add a prompt-capture test requiring:

- two separate tool calls;
- a standalone code line `git status --short`;
- explicit prohibition on chaining, pipes, redirects and wrappers.

Keep the existing compound command test and assert it remains `passed=false`, `requiredCommandObserved=false`, with `match="embedded"`.

- [x] **Step 5: Run Kimi smoke tests and verify RED**

```powershell
npx.cmd vitest run test/smoke/kimi.test.ts
```

Expected: FAIL because the smoke does not observe or persist classifications and prompt wording is old.

- [x] **Step 6: Wire the observer and strengthen the prompt**

Track `commandObservations` and report count through `TaskExecutionContext`. For delegate evidence add:

```ts
commandObservations: sanitizeCommandObservations(
  commandObservations ?? [],
  "git status --short",
)
```

The prompt must require file creation and the exact command in separate tool calls. Continue deriving `requiredCommandObserved` only from `result.commandsRun.includes(...)`.

Do not include the field for review evidence. Do not add raw commands to diagnostics.

- [x] **Step 7: Run focused smoke and entrypoint tests**

```powershell
npx.cmd vitest run test/smoke/command-observation.test.ts test/smoke/kimi.test.ts test/smoke/script-entrypoints.test.ts
npm.cmd run typecheck
```

Expected: all tests pass and exact-validator regression remains green.

- [x] **Step 8: Commit Task 4**

```powershell
git add -- src/smoke/command-observation.ts test/smoke/command-observation.test.ts src/smoke/kimi.ts test/smoke/kimi.test.ts
git commit -m "feat: record sanitized Kimi command evidence"
```

Actual commits: `00e48e2`, `393274e`.

### Task 5: Validate optional diagnostics without breaking history

**Files:**

- Modify: `src/qualification/verifier.ts`
- Modify: `test/qualification/verifier.test.ts`

- [x] **Step 1: Add valid diagnostic data to generated Kimi delegate evidence**

In `evidenceForCase`, include only for `kimi-k3` delegate:

```ts
commandCount: 1,
commandObservations: [{ source: "raw_input", match: "exact" }],
```

Keep other cases unchanged.

- [x] **Step 2: Write failing verifier tests**

Use `createPassedBatch` mutations to assert rejection of:

- unknown source or match enum;
- extra object key such as `command`;
- more than 256 entries;
- array length smaller than `commandCount`;
- `unextractable` paired with a non-`other` match;
- exact-match presence inconsistent with `checks.requiredCommandObserved`;
- field attached to Kimi review or any Pi evidence.

Add a positive test for a valid Kimi delegate array. Keep `copyHistoricalBatch` and the four retained immutable verifier commands as compatibility gates.

- [x] **Step 3: Run verifier tests and verify RED**

```powershell
npx.cmd vitest run test/qualification/verifier.test.ts -t "command observation"
```

Expected: invalid diagnostic shapes currently pass.

- [x] **Step 4: Implement optional strict validation**

Add `validateCommandObservationDiagnostics(evidence, identity, runtime)`. Return immediately when the field is absent. When present, require Kimi delegate identity, a plain array of at most 256 two-key plain records, allowed enum values, `length >= commandCount`, valid unextractable pairing, and exact-match equivalence with `requiredCommandObserved`.

Call it for both passed and failed current evidence after identity validation. Do not require the field for historical evidence.

- [x] **Step 5: Run verifier and retained immutable checks**

```powershell
npx.cmd vitest run test/qualification/verifier.test.ts
npm.cmd run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/manifest.json
npm.cmd run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json
npm.cmd run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json
npm.cmd run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json
```

Expected: unit tests pass; all four immutable verifiers return `verified:true` with their original status.

- [x] **Step 6: Commit Task 5**

```powershell
git add -- src/qualification/verifier.ts test/qualification/verifier.test.ts
git commit -m "fix: validate Kimi command audit evidence"
```

Actual commits: `03cd172`, `ebb8082`.

### Task 6: Update Kimi status documentation and verify the subsystem

**Files:**

- Modify: `docs/smoke/kimi.md`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/release/real-plugin-install-review.md`
- Modify: `AGENTS.md`

- [x] **Step 1: Document implementation status without claiming qualification**

Record:

- exact validator unchanged;
- new prompt and enum-only diagnostics;
- historical evidence unchanged;
- registry still `6 passed / 2 pending`;
- latest batch still blocked;
- no real batch authorization exists.

Do not replace historical facts or claim Kimi delegate passed.

- [x] **Step 2: Run subsystem verification**

```powershell
npm.cmd run typecheck
npx.cmd vitest run test/adapters/kimi/client.test.ts test/tasks/command-observations.test.ts test/tasks/service.test.ts test/smoke/command-observation.test.ts test/smoke/kimi.test.ts test/qualification/verifier.test.ts
npm.cmd run build
git diff --check
```

Expected: all commands exit 0.

- [x] **Step 3: Request independent specification and quality review**

Provide reviewers:

- approved design;
- this plan;
- diff from `a279524876b67cdfff8b3e178d5e2dc116306d52`;
- focused test output;
- explicit no-real-batch boundary.

Accept only reproducible findings. Fix Critical/Important items with RED→GREEN tests; technically adjudicate Minor items.

Review follow-up commit: `696bfa6`. It prevents title-derived command text from satisfying the Kimi qualification validator while preserving the compatibility behavior of ordinary delegate results. The final code/specification and quality/security reviews both passed after the follow-up RED→GREEN matrix.

Fresh full verification before documentation commit: 46 test files, 759 passed / 1 platform-conditional skipped / 0 failed; typecheck, focused subsystem tests, build, release smoke and diff check passed.

- [x] **Step 4: Commit subsystem documentation**

```powershell
git add -- docs/smoke/kimi.md README.md docs/operations.md docs/release/checklist.md docs/release/real-plugin-install-review.md AGENTS.md
git commit -m "docs: record Kimi command observation hardening"
```

Expected: the commit contains documentation and memory only; no evidence JSON.
