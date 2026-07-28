# Pi Write Command Lifecycle Diagnostics Implementation Plan

> **Historical authorization note:** Any per-batch human authorization stop in this completed plan is superseded by `../specs/2026-07-28-standing-experiment-authorization-design.md`; its diagnostic and protocol constraints remain unchanged.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add qualification-only, enum-only Pi write-command lifecycle diagnostics that distinguish command formation, tool outcome, and final artifact layers without changing prompts, acceptance, public results, routing, retries, or historical evidence.

**Architecture:** Preserve a safe boolean `isError` on oversized Pi end events, then fold mapped Pi `tool_call` / `tool_result` events through a new independent task-layer lifecycle module. Report the internal observations once through `TaskExecutionContext`, sanitize them against the existing fixed write command only inside current Pi qualification delegates, and strictly validate the optional evidence field while accepting unchanged historical schema v3 evidence.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Vitest 4, Pi RPC 0.80.10, existing smoke evidence/qualification verifier infrastructure, PowerShell, Git.

---

## Source of truth

- Approved design: `docs/superpowers/specs/2026-07-28-pi-write-command-lifecycle-diagnostics-design.md`
- Human review: `docs/release/pi-write-command-diagnostics-design-review.html`
- Failed batch: `docs/smoke/evidence/batches/2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678/manifest.json`
- Failed case: `docs/smoke/evidence/batches/2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678/cases/2026-07-28T02-05-37.999Z-ark-agent-deepseek-v4-flash-delegate-ark.json`
- Planning parent: `a8aa4d8`

## Execution status on 2026-07-28

- Tasks 0–5 are complete. The approved planning baseline was committed as `bfecc7c`; behavior implementation and review fixes are `8261736`, `652b13d` / `5e209e1` / `16cdad5`, `293e745`, `969e546` / `0852691` / `d9eb28a`, and `4bd2439`.
- Every task-level specification and quality review passed. Whole-change specification and security reviews also passed.
- Two Kimi external reviews produced no conclusion: the design-level review across several implementation surfaces timed out after about 604.5 seconds with read progress only; the post-implementation review of two inlined excerpts and one invariant timed out after about 181.8 seconds with an empty review body. Neither is PASS or a blocker, and neither shape was retried.
- Fresh offline verification passed with 48 test files, 837 passed / 1 platform-conditional skipped / 0 failed, plus typecheck, build, release smoke, isolated check-report, both help commands and diff check.
- All 5/5 retained manifests passed immutable verification. Evidence is unchanged relative to `a8aa4d8`, evidence untracked count is 0, target process counts are 0/0/0, the qualification lock is absent, and no persistent `.tgz` exists.
- npm dry-run reports 171 files / 15 Markdown-or-HTML files / 3 plugin files, size 536161 and unpackedSize 2703085.
- The implementation preserves prompts, validators, public MCP results, `commandsRun` / `commandCount`, provider/model/route/credential/retry/fallback, manifest/checkpoint/protocol and historical JSON. The qualification-only schema v3 field has not yet been exercised by a new real batch.
- Task 6 status documentation was committed as `8c9a8a6`. The first post-documentation full run exposed a test-only 1-second `waitFor` race around real workspace snapshots; production limiter behavior was exonerated by focused, full-suite and independent stress evidence, and the service test was split to assert profile-to-limiter-key mapping while the existing limiter suite retains the cross-key concurrency proof. The clean re-verification, allow-empty freeze, exact 40-character frozen SHA and new real-batch authorization remain pending. Do not infer a final SHA from this plan and do not mark the final freeze complete.
- No active plugin was installed; active `~/.codex/config.toml` was not accessed or modified; `codex_cc_tools` was not removed; Claude Code was not invoked or modified; no publish, push, merge or formal-worktree fast-forward occurred.

## Fixed invariants

Do not change:

- `buildPiDelegateSmokeContract()` output or any qualification prompt;
- result-file, file-range or `commandsRun.includes("git status --short")` acceptance;
- `CommandObservation`, `extractCommandObservations`, `commandsFromObservations` or `CommandObservationPolicy`;
- `ExternalDelegateResult`, its Zod schema or MCP structured content;
- logical LLM, provider, model, direct route, credential, concurrency, retry or fallback policy;
- `four-llm-v1`, manifest/checkpoint schema v2 or qualification evidence schema v3;
- any existing JSON under `docs/smoke/evidence/`;
- registry status `6 passed / 2 pending` or install status `blocked / not ready`.

Do not invoke:

- `qualify:gates` with an authorization reference;
- `smoke:ark`, `smoke:kimi`, `acceptance:local` or another real-model path;
- active plugin add/remove;
- active Codex config access;
- Claude Code, npm publish, Git push, merge or formal-worktree fast-forward.

`acceptance:plugin:isolated -- --check-report` is allowed because it uses an isolated temporary `CODEX_HOME` and performs no active installation.

## File responsibility map

- `test/fakes/fake-pi-rpc.mjs`: deterministic oversized Pi end-event fixtures.
- `test/adapters/pi/client.test.ts`: prove safe boolean retention without raw oversized payload.
- `src/adapters/pi/client.ts`: preserve only boolean `isError` in oversized summaries.
- `test/adapters/pi/adapter.test.ts`: prove missing/non-boolean state is not converted to false.
- `src/adapters/pi/adapter.ts`: map boolean result state without fail-open coercion.
- `src/tasks/pi-command-lifecycle.ts`: independent Pi-only lifecycle folding.
- `test/tasks/pi-command-lifecycle.test.ts`: state-machine, order and hostile-input coverage.
- `src/tasks/service.ts`: one internal Pi-only callback; public result stays unchanged.
- `test/tasks/service.test.ts`: callback cardinality, runtime isolation and public non-regression.
- `test/mcp/server.test.ts`: structured-content non-regression.
- `src/smoke/pi-write-command-observation.ts`: target-specific enum-only sanitizer.
- `test/smoke/pi-write-command-observation.test.ts`: match/outcome/privacy tests.
- `src/smoke/pi.ts`: qualification-only observer and evidence producer.
- `test/smoke/pi.test.ts`: producer cardinality, scope and failure-layer evidence.
- `test/smoke/ark.test.ts`: all three standalone Ark delegates remain field-free.
- `src/qualification/verifier.ts`: optional strict current Pi delegate validation.
- `test/qualification/verifier.test.ts`: valid/invalid shape, count and historical compatibility.
- `AGENTS.md` and release/status docs: durable approved/implemented/frozen state.

## Review protocol for every behavior task

After each Task 1–5 implementation commit:

1. Dispatch a fresh read-only specification reviewer with the full task text, approved design, base SHA and head SHA.
2. If it finds a reproducible gap, send the finding back to the same implementer, require a new failing test, observe RED, apply the smallest fix, observe GREEN, then re-run the specification reviewer.
3. Only after specification PASS, dispatch a fresh code-quality reviewer.
4. Fix every reproducible Critical/Important issue through RED → GREEN and request re-review.
5. Do not move to the next task while either review has an open substantive issue.

Reviewers must not call real models, edit files, inspect active config, or touch historical evidence.

## Task 0: Commit the approved planning baseline

**Files:**

- Create: `docs/superpowers/specs/2026-07-28-pi-write-command-lifecycle-diagnostics-design.md`
- Create: `docs/superpowers/plans/2026-07-28-pi-write-command-lifecycle-diagnostics.md`
- Modify: `AGENTS.md`
- Modify: `docs/release/pi-write-command-diagnostics-design-review.html`

- [x] **Step 1: Record approval and index both documents**

Add the maintainer approval to `AGENTS.md`, replace the review index label `待批准` with `已批准`, and link this design and plan. In the HTML, change the status copy from “用于批准” to “方案已批准、等待实现”, while retaining the statement that it does not authorize a real batch.

- [x] **Step 2: Self-review design/plan coverage**

Check each approved design requirement maps to a plan task:

```powershell
rg -n "isError|unknown|Pi-only|writeCommandObservations|commandCount|公开 MCP|历史|真实批次" `
  docs/superpowers/specs/2026-07-28-pi-write-command-lifecycle-diagnostics-design.md `
  docs/superpowers/plans/2026-07-28-pi-write-command-lifecycle-diagnostics.md
```

Expected: every invariant appears in both the design and an implementation task.

- [x] **Step 3: Scan the plan for placeholders**

```powershell
$planPath = "docs/superpowers/plans/2026-07-28-pi-write-command-lifecycle-diagnostics.md"
$forbidden = @(
  ("T" + "BD"),
  ("TO" + "DO"),
  ("implement " + "later"),
  ("fill " + "in"),
  ("类似 " + "Task"),
  ("适当" + "处理"),
  ("稍后" + "实现")
)
foreach ($pattern in $forbidden) {
  if (Select-String -LiteralPath $planPath -SimpleMatch $pattern) {
    throw "Plan contains placeholder: $pattern"
  }
}
```

Expected: no matches.

- [x] **Step 4: Request read-only planning review**

The reviewer must check state-machine completeness, Pi compatibility counting, qualification-only scope, historical optionality, privacy, exact non-goals and TDD ordering. Correct documentation-only issues before implementation.

- [x] **Step 5: Commit the planning baseline**

```powershell
git add -- `
  AGENTS.md `
  docs/release/pi-write-command-diagnostics-design-review.html `
  docs/superpowers/specs/2026-07-28-pi-write-command-lifecycle-diagnostics-design.md `
  docs/superpowers/plans/2026-07-28-pi-write-command-lifecycle-diagnostics.md
git diff --cached --check
git commit -m "docs: approve Pi lifecycle diagnostic design"
git status --short
```

Expected: commit succeeds and the final status is empty.

## Task 1: Preserve tri-state Pi tool outcomes

**Files:**

- Modify: `test/fakes/fake-pi-rpc.mjs`
- Modify: `test/adapters/pi/client.test.ts`
- Modify: `src/adapters/pi/client.ts`
- Modify: `test/adapters/pi/adapter.test.ts`
- Modify: `src/adapters/pi/adapter.ts`

- [x] **Step 1: Add oversized end-event fixtures**

In the fake default event branch, select end data from `FAKE_PI_SCENARIO`:

```js
const oversizedEnd =
  scenario === "oversized-tool-end-error" ||
  scenario === "oversized-tool-end-nonboolean";
const endEvent = {
  type: "tool_execution_end",
  toolCallId: "tool-1",
  toolName,
  result: {
    content: [
      {
        type: "text",
        text: oversizedEnd ? "x".repeat(70_000) : "ok",
      },
    ],
  },
  isError:
    scenario === "oversized-tool-end-error"
      ? true
      : scenario === "oversized-tool-end-nonboolean"
        ? "false"
        : false,
};
emit(endEvent);
```

Do not put a secret or target command in the oversized payload.

- [x] **Step 2: Write RED client tests**

Add:

```ts
it.each([
  {
    scenario: "oversized-tool-end-error",
    expected: {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      isError: true,
      truncated: true,
    },
  },
  {
    scenario: "oversized-tool-end-nonboolean",
    expected: {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      truncated: true,
    },
  },
] as const)(
  "sanitizes $scenario without inventing a boolean outcome",
  async ({ scenario, expected }) => {
    const cwd = await tempDirectory();
    const result = await runPiRpc({
      ...baseRequest(
        cwd,
        {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          FAKE_PI_SCENARIO: scenario,
        },
        "delegate",
      ),
    });
    const end = result.events.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "tool_execution_end",
    );
    expect(end).toEqual(expected);
    expect(JSON.stringify(end)).not.toContain("x".repeat(128));
  },
);
```

- [x] **Step 3: Run client RED**

```powershell
npx.cmd vitest run test/adapters/pi/client.test.ts -t "without inventing a boolean outcome"
```

Expected: the boolean-error case lacks `isError:true`; observe that exact failure before production edits.

- [x] **Step 4: Implement safe oversized summary**

Replace the oversized branch with:

```ts
const summary: Record<string, unknown> = {
  type: event.type,
  toolCallId: event.toolCallId,
  toolName: event.toolName,
  truncated: true,
};
if (typeof event.isError === "boolean") {
  summary.isError = event.isError;
}
return summary;
```

Do not add any other event property.

- [x] **Step 5: Write RED adapter tests for missing and non-boolean values**

Create a table-driven test whose injected client returns one start and one end. For each `isError` value `undefined`, `"false"`, `0`, and `{ value: false }`, assert:

```ts
const toolResult = result.events.find(
  (event) =>
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "tool_result",
);
expect(toolResult).not.toHaveProperty("isError");
```

Keep the existing boolean false expectation as a positive control.

- [x] **Step 6: Run adapter RED**

```powershell
npx.cmd vitest run test/adapters/pi/adapter.test.ts -t "does not invent"
```

Expected: FAIL because the current mapper produces `isError:false`.

- [x] **Step 7: Implement tri-state adapter mapping**

Use:

```ts
const mapped: Record<string, unknown> = {
  type: "tool_result",
  runtime: "pi-rpc",
  title: toolName,
  rawOutput: record.result,
  toolCallId: record.toolCallId,
};
if (typeof record.isError === "boolean") {
  mapped.isError = record.isError;
}
return mapped;
```

Do not infer success from absence.

- [x] **Step 8: Run focused GREEN**

```powershell
npx.cmd vitest run test/adapters/pi/client.test.ts test/adapters/pi/adapter.test.ts
npm.cmd run typecheck
git diff --check
```

Expected: both files pass, typecheck exits 0, diff check exits 0.

- [x] **Step 9: Commit and complete two-stage review**

```powershell
git add -- `
  test/fakes/fake-pi-rpc.mjs `
  test/adapters/pi/client.test.ts `
  src/adapters/pi/client.ts `
  test/adapters/pi/adapter.test.ts `
  src/adapters/pi/adapter.ts
git commit -m "fix: preserve Pi tool outcome uncertainty"
```

Then follow the review protocol before Task 2.

## Task 2: Fold Pi command lifecycle independently

**Files:**

- Create: `src/tasks/pi-command-lifecycle.ts`
- Create: `test/tasks/pi-command-lifecycle.test.ts`

- [x] **Step 1: Write RED behavior tests**

Create table-driven tests for:

```ts
[
  {
    name: "exact raw input succeeds",
    events: [
      {
        type: "tool_call",
        runtime: "pi-rpc",
        toolCallId: "a",
        kind: "execute",
        title: "bash",
        rawInput: { command: "write" },
      },
      {
        type: "tool_result",
        runtime: "pi-rpc",
        toolCallId: "a",
        title: "bash",
        isError: false,
      },
    ],
    expected: [
      {
        source: "raw_input",
        command: "write",
        origin: "raw_input",
        outcome: "success",
      },
    ],
  },
  {
    name: "boolean error remains error",
    events: [
      {
        type: "tool_call",
        runtime: "pi-rpc",
        toolCallId: "a",
        kind: "execute",
        title: "bash",
        rawInput: { command: "write" },
      },
      {
        type: "tool_result",
        runtime: "pi-rpc",
        toolCallId: "a",
        title: "bash",
        isError: true,
      },
    ],
    expected: [
      {
        source: "raw_input",
        command: "write",
        origin: "raw_input",
        outcome: "error",
      },
    ],
  },
  {
    name: "missing result remains missing",
    events: [
      {
        type: "tool_call",
        runtime: "pi-rpc",
        toolCallId: "a",
        kind: "execute",
        title: "bash",
        rawInput: { command: "write" },
      },
    ],
    expected: [
      {
        source: "raw_input",
        command: "write",
        origin: "raw_input",
        outcome: "missing",
      },
    ],
  },
  {
    name: "missing boolean remains unknown",
    events: [
      {
        type: "tool_call",
        runtime: "pi-rpc",
        toolCallId: "a",
        kind: "execute",
        title: "bash",
        rawInput: { command: "write" },
      },
      {
        type: "tool_result",
        runtime: "pi-rpc",
        toolCallId: "a",
        title: "bash",
      },
    ],
    expected: [
      {
        source: "raw_input",
        command: "write",
        origin: "raw_input",
        outcome: "unknown",
      },
    ],
  },
];
```

Also cover:

- title fallback and unextractable start;
- two IDs preserve first start order;
- result before start;
- duplicate start;
- duplicate equal results;
- conflicting results;
- mismatched/missing result title;
- non-boolean `isError`;
- orphan result;
- first non-execute followed by duplicate execute;
- Kimi runtime events ignored;
- empty/non-string IDs ignored;
- Proxy event/rawInput, accessor/inherited/symbol command and throwing getters never execute user code.

- [x] **Step 2: Run lifecycle RED**

```powershell
npx.cmd vitest run test/tasks/pi-command-lifecycle.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement exact exported types**

Create:

```ts
export type PiCommandLifecycleSource =
  "raw_input" | "title_fallback" | "unextractable";

export type PiCommandLifecycleOrigin = "raw_input" | "title" | null;

export type PiCommandLifecycleOutcome =
  "success" | "error" | "missing" | "unknown";

export interface PiCommandLifecycleObservation {
  readonly source: PiCommandLifecycleSource;
  readonly command: string | null;
  readonly origin: PiCommandLifecycleOrigin;
  readonly outcome: PiCommandLifecycleOutcome;
}
```

- [x] **Step 4: Implement fail-closed parsing and folding**

Use non-evaluating descriptor reads:

```ts
import { types } from "node:util";

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    return undefined;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function dataValue(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function rawCommand(rawInput: unknown): string | undefined {
  const record = plainRecord(rawInput);
  if (record === undefined) return undefined;
  const value = dataValue(record, "command");
  return typeof value === "string" ? value : undefined;
}
```

Represent each ID as:

```ts
interface StartMaterial {
  readonly source: PiCommandLifecycleSource;
  readonly command: string | null;
  readonly origin: PiCommandLifecycleOrigin;
  readonly title: string | null;
}

interface EndMaterial {
  readonly title: string | null;
  readonly isError: boolean | undefined;
}

interface CallState {
  startSeen: boolean;
  executeStart?: StartMaterial;
  duplicateStart: boolean;
  endBeforeStart: boolean;
  ends: EndMaterial[];
}
```

Process events in input order. Only own data fields from `runtime="pi-rpc"` records are accepted. The first start fixes the kind; only a first `kind="execute"` enters output order. Every result is retained for its ID, and a result observed before the first start sets `endBeforeStart=true`.

Derive outcome exactly:

```ts
function outcomeFor(state: CallState): PiCommandLifecycleOutcome {
  if (state.duplicateStart || state.endBeforeStart) return "unknown";
  if (state.ends.length === 0) return "missing";
  if (state.ends.length !== 1) return "unknown";
  const start = state.executeStart!;
  const end = state.ends[0]!;
  if (
    start.title === null ||
    end.title === null ||
    start.title !== end.title ||
    end.isError === undefined
  ) {
    return "unknown";
  }
  return end.isError ? "error" : "success";
}
```

Return one observation per first execute start, in first-start order. Never include tool-call ID or output in the returned object.

- [x] **Step 5: Run lifecycle GREEN and characterization**

```powershell
npx.cmd vitest run `
  test/tasks/pi-command-lifecycle.test.ts `
  test/tasks/command-observations.test.ts
npm.cmd run typecheck
git diff --check
```

Expected: both the new lifecycle suite and unchanged command-observation suite pass.

- [x] **Step 6: Commit and complete two-stage review**

```powershell
git add -- `
  src/tasks/pi-command-lifecycle.ts `
  test/tasks/pi-command-lifecycle.test.ts
git commit -m "feat: fold Pi command lifecycle observations"
```

Then follow the review protocol before Task 3.

## Task 3: Report lifecycle internally without public drift

**Files:**

- Modify: `src/tasks/service.ts`
- Modify: `test/tasks/service.test.ts`
- Modify: `test/mcp/server.test.ts`

- [x] **Step 1: Write RED Pi-only observer tests**

Add a service test with Pi start/end events and:

```ts
const reports: readonly PiCommandLifecycleObservation[][] = [];
const result = await service.delegate(
  { llm: "ark-agent-plan", prompt: "Run", cwd },
  {
    onPiCommandLifecycleObservations: (value) => reports.push(value),
  },
);

expect(reports).toEqual([
  [
    {
      source: "raw_input",
      command: "node -e write",
      origin: "raw_input",
      outcome: "error",
    },
  ],
]);
expect(result.commandsRun).toEqual(["node -e write"]);
expect(result).not.toHaveProperty("piCommandLifecycleObservations");
expect(JSON.stringify(result)).not.toContain("piCommandLifecycleObservations");
```

Add tests proving:

- adapter throw still reports exactly once with `[]`;
- zero events reports exactly once with `[]`;
- Kimi delegate never invokes this observer;
- observer receives frozen array and frozen items;
- observer throw adds only fixed `Internal Pi command lifecycle callback failed`;
- existing `onCommandObservations` result and command policy remain unchanged.

- [x] **Step 2: Run service RED**

```powershell
npx.cmd vitest run test/tasks/service.test.ts -t "Pi command lifecycle"
```

Expected: FAIL because the context callback does not exist.

- [x] **Step 3: Integrate the internal observer**

Add:

```ts
onPiCommandLifecycleObservations?: (
  observations: readonly PiCommandLifecycleObservation[],
) => void;
```

After existing command observation extraction, and only for `profile.runtime === "pi-rpc"`:

```ts
const lifecycleObservations = extractPiCommandLifecycleObservations(
  adapterResult.events,
);
const lifecycleView: readonly PiCommandLifecycleObservation[] = Object.freeze(
  lifecycleObservations.map((observation) => Object.freeze({ ...observation })),
);
try {
  context.onPiCommandLifecycleObservations?.(lifecycleView);
} catch {
  adapterResult = {
    ...adapterResult,
    diagnostics: [
      ...adapterResult.diagnostics,
      INTERNAL_PI_COMMAND_LIFECYCLE_CALLBACK_FAILED,
    ],
  };
}
```

Use only the fixed diagnostic:

```ts
const INTERNAL_PI_COMMAND_LIFECYCLE_CALLBACK_FAILED =
  "Internal Pi command lifecycle callback failed";
```

Do not change `commandsRun`, result interfaces or Zod schemas.

- [x] **Step 4: Add MCP byte-shape non-regression**

In the delegate MCP test, assert the sorted structured-content keys remain exactly:

```ts
expect(Object.keys(result.structuredContent).sort()).toEqual([
  "actualModel",
  "commandsRun",
  "diagnostics",
  "elapsedMs",
  "filesChanged",
  "llm",
  "ok",
  "risks",
  "sessionId",
  "status",
  "summary",
  "verification",
]);
expect(JSON.stringify(result.structuredContent)).not.toContain(
  "LifecycleObservation",
);
```

Create the delegate fixture with both `actualModel` and `sessionId`, so the exact key set above is deterministic.

- [x] **Step 5: Run GREEN and public non-regression**

```powershell
npx.cmd vitest run `
  test/tasks/service.test.ts `
  test/mcp/server.test.ts `
  test/tasks/command-observations.test.ts `
  test/tasks/pi-command-lifecycle.test.ts
npm.cmd run typecheck
git diff --check
```

Expected: all pass; existing Kimi command tests remain unchanged.

- [x] **Step 6: Commit and complete two-stage review**

```powershell
git add -- `
  src/tasks/service.ts `
  test/tasks/service.test.ts `
  test/mcp/server.test.ts
git commit -m "feat: report internal Pi lifecycle evidence"
```

Then follow the review protocol before Task 4.

## Task 4: Produce enum-only qualification diagnostics

**Files:**

- Create: `src/smoke/pi-write-command-observation.ts`
- Create: `test/smoke/pi-write-command-observation.test.ts`
- Modify: `src/smoke/pi.ts`
- Modify: `test/smoke/pi.test.ts`
- Modify: `test/smoke/ark.test.ts`

- [x] **Step 1: Write sanitizer RED tests**

Test:

```ts
const sanitized = sanitizePiWriteCommandObservations(
  [
    {
      source: "raw_input",
      command: "write",
      origin: "raw_input",
      outcome: "success",
    },
    {
      source: "raw_input",
      command: " write\n",
      origin: "raw_input",
      outcome: "error",
    },
    {
      source: "raw_input",
      command: "echo before && write",
      origin: "raw_input",
      outcome: "unknown",
    },
    {
      source: "title_fallback",
      command: "write",
      origin: "title",
      outcome: "missing",
    },
    {
      source: "unextractable",
      command: null,
      origin: null,
      outcome: "unknown",
    },
  ],
  "write",
);

expect(sanitized).toEqual([
  { source: "raw_input", match: "exact", outcome: "success" },
  { source: "raw_input", match: "trim_only", outcome: "error" },
  { source: "raw_input", match: "embedded", outcome: "unknown" },
  { source: "title_fallback", match: "other", outcome: "missing" },
  { source: "unextractable", match: "other", outcome: "unknown" },
]);
expect(Object.keys(sanitized[0]!).sort()).toEqual([
  "match",
  "outcome",
  "source",
]);
expect(JSON.stringify(sanitized)).not.toContain("echo before");
```

- [x] **Step 2: Run sanitizer RED**

```powershell
npx.cmd vitest run test/smoke/pi-write-command-observation.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the enum-only sanitizer**

Create:

```ts
import type {
  PiCommandLifecycleObservation,
  PiCommandLifecycleOutcome,
  PiCommandLifecycleSource,
} from "../tasks/pi-command-lifecycle.js";

export type PiWriteCommandMatch = "exact" | "trim_only" | "embedded" | "other";

export interface SanitizedPiWriteCommandObservation {
  readonly source: PiCommandLifecycleSource;
  readonly match: PiWriteCommandMatch;
  readonly outcome: PiCommandLifecycleOutcome;
}

function matchCommand(command: string, target: string): PiWriteCommandMatch {
  if (command === target) return "exact";
  if (command.trim() === target) return "trim_only";
  if (command.includes(target)) return "embedded";
  return "other";
}

export function sanitizePiWriteCommandObservations(
  observations: readonly PiCommandLifecycleObservation[],
  target: string,
): SanitizedPiWriteCommandObservation[] {
  return observations.map((observation) => ({
    source: observation.source,
    match:
      observation.origin === "raw_input" && observation.command !== null
        ? matchCommand(observation.command, target)
        : "other",
    outcome: observation.outcome,
  }));
}
```

- [x] **Step 4: Write qualification producer RED tests**

Create a delegate qualification context for ordinal 8 and a fake service that reports:

```ts
context?.onExecutionTelemetry?.(validPiTelemetry);
context?.onPiCommandLifecycleObservations?.([
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
]);
```

Return `commandsRun: [contract.writeCommand, "git status --short"]`,
`filesChanged: []`, and do not create the result file. Assert:

```ts
expect(evidence).toMatchObject({
  schemaVersion: 3,
  passed: false,
  failureReason: "acceptance_failed",
  commandCount: 2,
  resultFileReadStatus: "missing",
  writeCommandObservations: [
    { source: "raw_input", match: "exact", outcome: "error" },
    { source: "raw_input", match: "other", outcome: "success" },
  ],
});
const serialized = JSON.stringify(evidence);
expect(serialized).not.toContain(contract.writeCommand);
expect(serialized).not.toContain(contract.resultFileName);
expect(serialized).not.toContain("tool-call");
```

Also assert:

- standalone Pi delegate has no observer and no field;
- qualification Pi review has no field;
- all three standalone Ark delegate tests have no field;
- missing observer report throws `SmokeInfrastructureError` at `task_execution`;
- two observer reports throw the same infrastructure error;
- title fallback equal to the target remains `match="other"`;
- the new field does not change `passed` or `checks`.

- [x] **Step 5: Run producer RED**

```powershell
npx.cmd vitest run `
  test/smoke/pi-write-command-observation.test.ts `
  test/smoke/pi.test.ts `
  test/smoke/ark.test.ts
```

Expected: sanitizer import or expected qualification field fails before production edits.

- [x] **Step 6: Wire qualification-only observer**

Add optional payload typing:

```ts
writeCommandObservations?: SanitizedPiWriteCommandObservation[];
```

Before the delegate call:

```ts
let lifecycleObservations: readonly PiCommandLifecycleObservation[] | undefined;
let lifecycleReportCount = 0;
if (qualification !== null) {
  context.onPiCommandLifecycleObservations = (observations) => {
    lifecycleReportCount += 1;
    lifecycleObservations = observations;
  };
}
```

Inside the existing `task_execution` stage, after `service.delegate` resolves:

```ts
if (
  qualification !== null &&
  (lifecycleReportCount !== 1 || lifecycleObservations === undefined)
) {
  throw new Error("Internal Pi command lifecycle report contract violated");
}
```

Use the existing contract:

```ts
const contract = buildPiDelegateSmokeContract(options.llm);
```

Return the existing evidence plus:

```ts
...(qualification === null
  ? {}
  : {
      writeCommandObservations:
        sanitizePiWriteCommandObservations(
          lifecycleObservations!,
          contract.writeCommand,
        ),
    }),
```

Do not add the callback or field to review/standalone paths.

- [x] **Step 7: Run producer GREEN**

```powershell
npx.cmd vitest run `
  test/smoke/pi-write-command-observation.test.ts `
  test/smoke/pi.test.ts `
  test/smoke/ark.test.ts `
  test/smoke/kimi.test.ts `
  test/smoke/script-entrypoints.test.ts
npm.cmd run typecheck
git diff --check
```

Expected: all pass; Kimi evidence shape and exact validator remain unchanged.

- [x] **Step 8: Commit and complete two-stage review**

```powershell
git add -- `
  src/smoke/pi-write-command-observation.ts `
  test/smoke/pi-write-command-observation.test.ts `
  src/smoke/pi.ts `
  test/smoke/pi.test.ts `
  test/smoke/ark.test.ts
git commit -m "feat: record sanitized Pi write lifecycle evidence"
```

Then follow the review protocol before Task 5.

## Task 5: Strictly validate optional Pi diagnostics

**Files:**

- Modify: `src/qualification/verifier.ts`
- Modify: `test/qualification/verifier.test.ts`

- [x] **Step 1: Add valid synthetic Pi delegate diagnostics**

In `evidenceForCase`, add for current Pi delegate cases:

```ts
commandCount: 2,
writeCommandObservations: [
  { source: "raw_input", match: "exact", outcome: "success" },
  { source: "raw_input", match: "other", outcome: "success" },
],
```

Keep the existing Kimi `commandObservations` fixture unchanged.

- [x] **Step 2: Write verifier RED tests**

Mutate current passed/blocked synthetic evidence to reject:

- field on Kimi evidence;
- field on Pi review;
- field under a legacy plan/schema;
- non-array;
- sparse/non-dense array;
- more than 256 items;
- non-record item;
- extra keys such as `command`, `toolCallId`, `rawInput`, `path` or `output`;
- unknown source/match/outcome;
- `title_fallback` or `unextractable` with non-`other` match;
- negative, fractional, unsafe or string commandCount;
- extractable observation count unequal to commandCount.

Add positive tests for:

- valid passed Pi delegate diagnostics;
- valid failed Pi delegate diagnostics with `exact/error`;
- `exact` does not need to equal `requiredCommandObserved`, because the targets differ;
- historical field absence remains accepted.

- [x] **Step 3: Run verifier RED**

```powershell
npx.cmd vitest run test/qualification/verifier.test.ts -t "Pi write command"
```

Expected: at least one invalid new-field case currently verifies.

- [x] **Step 4: Implement strict optional validation**

Add closed sets:

```ts
const PI_WRITE_SOURCES = new Set([
  "raw_input",
  "title_fallback",
  "unextractable",
]);
const PI_WRITE_MATCHES = new Set(["exact", "trim_only", "embedded", "other"]);
const PI_WRITE_OUTCOMES = new Set(["success", "error", "missing", "unknown"]);
```

Implement:

```ts
function validatePiWriteCommandDiagnostics(
  evidence: Record<string, unknown>,
  protocol: VerifierProtocol,
  identity: Readonly<QualificationCaseIdentity>,
  runtime: FrozenLogicalLlmIdentity["runtime"],
): void {
  if (!Object.hasOwn(evidence, "writeCommandObservations")) return;
  if (
    protocol !== CURRENT_VERIFIER_PROTOCOL ||
    evidence.schemaVersion !== 3 ||
    identity.task !== "delegate" ||
    runtime !== "pi-rpc"
  ) {
    throw new QualificationVerificationError();
  }

  const observations = evidence.writeCommandObservations;
  if (
    !Array.isArray(observations) ||
    nodeUtilTypes.isProxy(observations) ||
    Object.getPrototypeOf(observations) !== Array.prototype ||
    Object.getOwnPropertySymbols(observations).length !== 0 ||
    observations.length > 256
  ) {
    throw new QualificationVerificationError();
  }

  const descriptors = Object.getOwnPropertyDescriptors(observations);
  const lengthDescriptor = descriptors.length;
  const itemKeys = Object.keys(descriptors).filter((key) => key !== "length");
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    lengthDescriptor.value !== observations.length ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false ||
    lengthDescriptor.writable !== true ||
    itemKeys.length !== observations.length ||
    itemKeys.some((key, index) => key !== String(index))
  ) {
    throw new QualificationVerificationError();
  }

  let extractableCount = 0;
  for (const key of itemKeys) {
    const descriptor = descriptors[key]!;
    if (
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new QualificationVerificationError();
    }
    const observation = plainRecord(descriptor.value);
    const keys = Object.keys(observation).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "match" ||
      keys[1] !== "outcome" ||
      keys[2] !== "source" ||
      typeof observation.source !== "string" ||
      !PI_WRITE_SOURCES.has(observation.source) ||
      typeof observation.match !== "string" ||
      !PI_WRITE_MATCHES.has(observation.match) ||
      typeof observation.outcome !== "string" ||
      !PI_WRITE_OUTCOMES.has(observation.outcome) ||
      ((observation.source === "title_fallback" ||
        observation.source === "unextractable") &&
        observation.match !== "other")
    ) {
      throw new QualificationVerificationError();
    }
    if (observation.source !== "unextractable") {
      extractableCount += 1;
    }
  }

  const commandCount = evidence.commandCount;
  if (
    typeof commandCount !== "number" ||
    !Number.isSafeInteger(commandCount) ||
    commandCount < 0 ||
    extractableCount !== commandCount
  ) {
    throw new QualificationVerificationError();
  }
}
```

Call it immediately after existing Kimi diagnostics validation:

```ts
validateCommandObservationDiagnostics(evidence, identity, runtime);
validatePiWriteCommandDiagnostics(evidence, protocol, identity, runtime);
```

- [x] **Step 5: Run verifier GREEN and historical manifests**

```powershell
npx.cmd vitest run test/qualification/verifier.test.ts
$manifests = Get-ChildItem -LiteralPath docs/smoke/evidence/batches -Recurse -Filter manifest.json
foreach ($manifest in $manifests) {
  npm.cmd run --silent verify:qualification -- `
    --mode immutable-evidence `
    --manifest $manifest.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Immutable verifier failed: $($manifest.FullName)"
  }
}
npm.cmd run typecheck
git diff --check
```

Expected: verifier tests pass and every retained manifest verifies with its original status.

- [x] **Step 6: Prove historical bytes are untouched**

```powershell
git diff --quiet a8aa4d8 -- docs/smoke/evidence
if ($LASTEXITCODE -ne 0) {
  throw "Historical evidence changed"
}
$untrackedEvidence = @(
  git ls-files --others --exclude-standard -- docs/smoke/evidence
)
if ($untrackedEvidence.Count -ne 0) {
  throw "Unexpected untracked evidence"
}
```

Expected: no tracked or untracked evidence changes.

- [x] **Step 7: Commit and complete two-stage review**

```powershell
git add -- `
  src/qualification/verifier.ts `
  test/qualification/verifier.test.ts
git commit -m "fix: verify Pi write lifecycle diagnostics"
```

Then follow the review protocol before Task 6.

## Task 6: Full review, documentation, verification and clean freeze

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/smoke/ark.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/release/real-plugin-install-review.md`
- Modify: `docs/release/pi-write-command-diagnostics-design-review.html`
- Create: `docs/release/four-llm-qualification-next-authorization-review.html`
- Modify: this plan and its design only to record verified completion facts.

- [x] **Step 1: Dispatch whole-change specification review**

Give the reviewer:

- approved design;
- this plan;
- planning-baseline SHA;
- current HEAD;
- exact changed paths and focused test outputs.

Require it to verify every invariant, especially qualification-only field scope, Pi compatibility count, unknown semantics, title-spoof rejection, public MCP non-drift and unchanged historical evidence.

- [x] **Step 2: Dispatch whole-change quality/security review**

Require review of:

- descriptor/proxy/accessor safety;
- start/end state-machine conflicts;
- oversized-event privacy;
- callback failure behavior;
- producer cardinality;
- verifier dense-array/plain-object checks;
- test strength and no secret/command persistence.

Fix substantive findings only through new RED → GREEN tests and re-review until both reviewers PASS.

- [x] **Step 3: Attempt narrowly bounded external review**

Use `codex_external_agents.external_review` with explicit `llm: "kimi-k3"` only if the tool is healthy. Inline the single invariant under review and at most two focused code excerpts; cap findings at five. Do not ask Kimi to traverse the repository.

If it times out or returns no conclusion:

- record “无结论” in global model collaboration memory;
- do not retry the same shape;
- do not treat it as PASS or as a blocker after independent Codex reviews and deterministic tests.

- [x] **Step 4: Run fresh full offline verification**

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:release
npm.cmd run acceptance:plugin:isolated -- --check-report
npm.cmd run qualify:gates -- --help
npm.cmd run verify:qualification -- --help
git diff --check
```

Read every exit code and the full test file/pass/skip/fail count. Do not copy an older count into docs.

- [x] **Step 5: Run evidence, package, lock and process audits**

```powershell
$manifests = Get-ChildItem -LiteralPath docs/smoke/evidence/batches -Recurse -Filter manifest.json
foreach ($manifest in $manifests) {
  npm.cmd run --silent verify:qualification -- `
    --mode immutable-evidence `
    --manifest $manifest.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Immutable verifier failed: $($manifest.FullName)"
  }
}

git diff --quiet a8aa4d8 -- docs/smoke/evidence
if ($LASTEXITCODE -ne 0) {
  throw "Historical evidence changed"
}

npx.cmd tsx -e "import('./src/runtime/agent-processes.ts').then(async ({ classifyAgentProcesses }) => { const counts = await classifyAgentProcesses(); console.log(JSON.stringify(counts)); if (counts.kimi.count !== 0 || counts.piRpc.count !== 0 || counts.realSmoke.count !== 0) process.exitCode = 1; })"

if (Test-Path -LiteralPath ".codex-agent-tools-qualification.lock") {
  throw "Qualification lock is present"
}

$tgz = @(Get-ChildItem -LiteralPath . -Filter "*.tgz" -File)
if ($tgz.Count -ne 0) {
  throw "Unexpected persistent package archive"
}
```

Expected: all manifests verify, evidence diff is empty, target processes are 0/0/0, lock absent and no persistent `.tgz`.

- [ ] **Step 6: Update current status and create the next-authorization brief**

Document:

- latest batch remains 7/8 blocked and non-promotable;
- the diagnostic blind spot is implemented offline but not yet exercised by a new real batch;
- registry remains 6 passed / 2 pending;
- install remains blocked / not ready;
- exact fresh verification counts;
- no prompt/validator/public MCP/provider/model/route/credential/retry/history change;
- no new real qualification batch ran during implementation; the two explicitly selected Kimi read-only reviews above remain recorded as inconclusive external calls;
- the next batch requires a new exact frozen SHA authorization.

The Chinese HTML authorization brief must include background, changed scope, automatically verified evidence, risks, exact one-batch scope, no retry/fallback/resume/second batch, excluded actions, links and the exact authorization reply. It must state that the page itself is not authorization.

- [ ] **Step 7: Render and link-check the HTML**

Serve the repository only on localhost with a hidden process, open the page through Playwright at 1440×1000 and 390×844, and verify:

- title correct;
- `scrollWidth <= clientWidth`;
- all local links return 200;
- console has 0 errors and 0 warnings.

Stop the exact local server and browser session, then remove only verified `.playwright-cli` artifacts inside this worktree.

- [ ] **Step 8: Commit status documentation**

```powershell
git add -- `
  AGENTS.md `
  README.md `
  docs/operations.md `
  docs/smoke/ark.md `
  docs/release/checklist.md `
  docs/release/real-plugin-install-review.md `
  docs/release/pi-write-command-diagnostics-design-review.html `
  docs/release/four-llm-qualification-next-authorization-review.html `
  docs/superpowers/specs/2026-07-28-pi-write-command-lifecycle-diagnostics-design.md `
  docs/superpowers/plans/2026-07-28-pi-write-command-lifecycle-diagnostics.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: prepare next four-llm qualification review"
```

Expected: no evidence JSON is staged.

- [ ] **Step 9: Re-run the complete verification on the clean documentation commit**

Repeat Steps 4–5 plus HTML validation. Require `git status --short` to be empty before freezing.

- [ ] **Step 10: Create the explicit frozen-candidate commit**

```powershell
git commit --allow-empty -m "chore: freeze Pi lifecycle diagnostics candidate"
git rev-parse HEAD
```

Record the exact 40-character SHA only after the commit succeeds. Do not edit tracked files after this point.

- [ ] **Step 11: Verify the exact frozen HEAD**

Freshly repeat Steps 4–5, then:

```powershell
git diff --check HEAD^ HEAD
git status --short
git rev-parse HEAD
```

Expected: all commands exit 0, the tree is clean, and the printed SHA equals the candidate supplied to the maintainer.

- [ ] **Step 12: Stop before all real calls**

The handoff must include:

- exact 40-character frozen SHA;
- clickable next-authorization HTML;
- fresh test/build/release/isolated/evidence/process/lock results;
- confirmation that no real model batch, active install/config, old-tool removal, Claude Code, publish, push, merge or formal-worktree fast-forward occurred;
- exact authorization sentence.

Do not start `qualify:gates` in this goal. Mark the offline goal complete only after the clean candidate and review package are verified.
