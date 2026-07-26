# Gemini Retirement and Four-LLM Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Gemini from the active plugin surface without invalidating historical evidence, migrate qualification to a versioned four-LLM/eight-case protocol, and run exactly one authorized atomic qualification batch before stopping at the real-install boundary.

**Architecture:** Freeze the existing five-LLM protocol as a read-only legacy codec before changing the active registry. New execution uses `four-llm-v1`, manifest/checkpoint/preflight schema v2, and qualification evidence schema v3; every parser dispatches by recorded schema and plan before inspecting inner identities. Active runtime then contracts to Kimi plus three Ark logical profiles, all direct, while historical Gemini evidence remains packaged and hash-verifiable.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Vitest 4, tsup, MCP SDK, ACP SDK, Pi RPC, PowerShell, Git.

---

## Source of Truth and Execution Constraints

Design specification:

- `docs/superpowers/specs/2026-07-26-gemini-retirement-and-four-llm-qualification-design.md`

The following constraints apply to every task:

- Work on an isolated `codex/` branch/worktree created from commit `e24b942`.
- Use RED → GREEN → REFACTOR for every behavior change.
- After each task: implementer self-review, independent spec review, independent code-quality review, then main-agent fresh verification.
- Do not read, write, back up, or restore active `~/.codex/config.toml`.
- Do not install/remove the plugin in active Codex; isolated temporary `CODEX_HOME` acceptance is allowed.
- Do not call or modify Claude Code or `codex_cc_tools`.
- Do not run `acceptance:local`, standalone real smoke, or a qualification command carrying `--authorization-ref` before Task 13.
- Do not modify, reformat, or reserialize the 14 historical Gemini/batch evidence files enumerated in the hash baseline below.
- The user's “没有问题，请你继续” authorizes one `four-llm-v1` batch only after Task 12 freezes a clean candidate. Any terminal failure consumes that authorization and forbids a restart.

### Historical evidence hash baseline

The following SHA-256 values were captured before production edits from base commit `e24b942`. Tasks 4, 11, 12, and 14 must compare all 14 files byte-for-byte against this table:

| SHA-256 | Repository path |
| --- | --- |
| `3e30fd8879f26cbd51359c0383ca71ed288364d899a96dde3f8b32f3d5fa49a1` | `docs/smoke/evidence/2026-07-18T08-33-35.891Z-gemini-3.5-flash-review-pi.json` |
| `85b0302d6e5d1e81a33e62697c12d62fe1d56654d915c3c77cdcbe2a81660ca1` | `docs/smoke/evidence/2026-07-18T08-33-56.352Z-gemini-3.5-flash-delegate-pi.json` |
| `ba5aea6c9cb0a158b079e3ca6a2dbaa7f682924d193fb53bb62ff9529290f7ea` | `docs/smoke/evidence/2026-07-18T08-35-31.179Z-gemini-3.5-flash-delegate-pi.json` |
| `7105920a222337ee456f59a4ca37888c04ec90e673fb56a832147c0545aab160` | `docs/smoke/evidence/2026-07-18T10-24-35.508Z-gemini-3.5-flash-review-pi.json` |
| `bd87b76a1d29d1ece12781cdd2068f8efdbf881e09c801f7213416da88091559` | `docs/smoke/evidence/2026-07-18T11-14-05.781Z-gemini-3.5-flash-review-pi.json` |
| `4c4656c0d5210555e641af05616e973508826b5aa549eaca9e3d9b24b8bc7e8d` | `docs/smoke/evidence/2026-07-20T07-30-18.646Z-gemini-3.5-flash-review-pi.json` |
| `9863ec964cfe4c070bf8d76369ae240431f4b3f373c34999a27d8fae6889c5dc` | `docs/smoke/evidence/2026-07-20T07-33-34.354Z-gemini-3.5-flash-delegate-pi.json` |
| `09f78efdaea50a3f05ef8e8365fda4aab0127152c9ac65600ec76a83d28d663b` | `docs/smoke/evidence/2026-07-25T15-47-08.146Z-gemini-3.5-flash-review-pi.json` |
| `890e546ff993e17f4f9303b88bb10dcb82fbd45a8bf0252f629c458db5a7d5c0` | `docs/smoke/evidence/2026-07-25T15-48-28.600Z-gemini-3.5-flash-delegate-pi.json` |
| `ed2e5c79c4cfbf851c7901aeeee5be885055ef244aefcf4ee11dca6ccbccf484` | `docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/cases/2026-07-26T09-01-07.689Z-gemini-3.5-flash-delegate-pi.json` |
| `acf04a1a7e811f0a60e2b84005e9f18b9bd6eb77c3a8d6554caf5d63a6233e3c` | `docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/checkpoints/000000.json` |
| `27c3b3b5b673cf17e680a0dc83bf382b146491d11cb8d1547cb4c597062f369f` | `docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/checkpoints/000001.json` |
| `e12145f05e9520c409bf748eab5321b93160cee31c02af9c5ad275f64041b15f` | `docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/checkpoints/000002.json` |
| `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5` | `docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json` |

## File Responsibility Map

New focused files:

- `src/qualification/protocol.ts`: immutable plan IDs, schedules, and envelope-to-plan dispatch.
- `test/qualification/protocol.test.ts`: protocol version/schedule unit contract.

Existing qualification files:

- `src/qualification/types.ts`: versioned public/internal record types.
- `src/qualification/preflight.ts`: create only current v2 preflight records.
- `src/qualification/manifest.ts`: legacy/current codecs, ledger, immutable publishing, recovery records.
- `src/qualification/lock.ts`: versioned lock owners and ownership comparison.
- `src/qualification/coordinator.ts`: active eight-case execution only.
- `src/qualification/verifier.ts`: historical immutable audit plus current frozen-candidate verification.

Active product files:

- `src/llms/registry.ts`, `src/domain/types.ts`, `src/runtime/environment.ts`, `src/cli/doctor.ts`.
- `src/adapters/pi/adapter.ts`, `src/adapters/pi/client.ts`, `src/adapters/pi/config.ts`.
- `src/smoke/evidence.ts`, `src/smoke/pi.ts`, `src/smoke/ark.ts`, `src/smoke/kimi.ts`.

Plugin/release files:

- `scripts/gate-requalification.ts`, `scripts/local-acceptance.mjs`, `scripts/plugin-isolated-acceptance.mjs`, `scripts/release-smoke.mjs`.
- `package.json`, `tsup.config.ts`, `docs/release/plugin-isolated-state.md`.

## Task 0: Make the Windows Worktree Baseline Newline-Portable

**Files:**

- Modify: `test/adapters/pi/config.test.ts`
- Modify: `test/plugin/isolated-report.test.ts`

- [x] **Step 1: Preserve the observed RED evidence**

On a fresh Windows worktree under system `core.autocrlf=true`, run:

```powershell
npm test
```

Expected baseline: three failures only. Two compare LF-generated Pi config with a CRLF checkout fixture; one compares a multiline LF literal with a CRLF checkout script. This is a test portability defect, not a runtime regression.

- [x] **Step 2: Normalize only checkout text at assertion boundaries**

Normalize the fixture/script strings from `\r\n` to `\n` inside the two tests. Keep generated runtime output byte assertions and hashes unchanged; do not change production serialization.

- [x] **Step 3: Verify the focused tests and complete baseline**

```powershell
npm exec -- vitest run test/adapters/pi/config.test.ts test/plugin/isolated-report.test.ts
npm run typecheck
npm test
```

Expected: focused and full baseline PASS.

- [x] **Step 4: Commit**

```powershell
git add -- test/adapters/pi/config.test.ts test/plugin/isolated-report.test.ts docs/superpowers/plans/2026-07-26-gemini-retirement-and-four-llm-qualification.md
git diff --cached --check
git commit -m "test: make Windows worktree assertions newline-portable"
```

## Task 1: Add Immutable Versioned Qualification Protocol Definitions

**Files:**

- Create: `src/qualification/protocol.ts`
- Create: `test/qualification/protocol.test.ts`
- Modify: `src/qualification/types.ts`
- Modify: `src/qualification/manifest.ts`
- Modify: `src/qualification/coordinator.ts`
- Modify: `src/qualification/verifier.ts`
- Modify: `test/qualification/manifest.test.ts`
- Modify: `test/qualification/coordinator.test.ts`
- Modify: `test/qualification/verifier.test.ts`

- [x] **Step 1: Write protocol RED tests**

Create tests that fix both schedules and reject ambiguous envelope combinations:

```ts
import { describe, expect, it } from "vitest";
import {
  ACTIVE_QUALIFICATION_CASES,
  ACTIVE_QUALIFICATION_PLAN_ID,
  LEGACY_QUALIFICATION_CASES,
  LEGACY_QUALIFICATION_PLAN_ID,
  qualificationPlanForEnvelope,
  qualificationSchedule,
} from "../../src/qualification/protocol.js";

describe("qualification protocol", () => {
  it("freezes the historical ten-case schedule", () => {
    expect(LEGACY_QUALIFICATION_PLAN_ID).toBe("five-llm-v1");
    expect(LEGACY_QUALIFICATION_CASES).toHaveLength(10);
    expect(LEGACY_QUALIFICATION_CASES.slice(0, 4)).toEqual([
      { ordinal: 1, llm: "gemini-3.5-flash", task: "delegate" },
      { ordinal: 2, llm: "gemini-3.5-flash", task: "review" },
      { ordinal: 3, llm: "ark-coding-plan", task: "delegate" },
      { ordinal: 4, llm: "ark-coding-plan", task: "review" },
    ]);
  });

  it("fixes the active eight-case risk-first schedule", () => {
    expect(ACTIVE_QUALIFICATION_PLAN_ID).toBe("four-llm-v1");
    expect(ACTIVE_QUALIFICATION_CASES).toEqual([
      { ordinal: 1, llm: "ark-coding-plan", task: "delegate" },
      { ordinal: 2, llm: "ark-coding-plan", task: "review" },
      { ordinal: 3, llm: "kimi-k3", task: "review" },
      { ordinal: 4, llm: "kimi-k3", task: "delegate" },
      { ordinal: 5, llm: "ark-agent-plan", task: "review" },
      { ordinal: 6, llm: "ark-agent-plan", task: "delegate" },
      {
        ordinal: 7,
        llm: "ark-agent-deepseek-v4-flash",
        task: "review",
      },
      {
        ordinal: 8,
        llm: "ark-agent-deepseek-v4-flash",
        task: "delegate",
      },
    ]);
  });

  it("dispatches envelopes without guessing a plan", () => {
    expect(qualificationPlanForEnvelope(1, undefined)).toBe(
      LEGACY_QUALIFICATION_PLAN_ID,
    );
    expect(
      qualificationPlanForEnvelope(2, ACTIVE_QUALIFICATION_PLAN_ID),
    ).toBe(ACTIVE_QUALIFICATION_PLAN_ID);
    expect(() => qualificationPlanForEnvelope(1, "four-llm-v1")).toThrow();
    expect(() => qualificationPlanForEnvelope(2, undefined)).toThrow();
    expect(() => qualificationPlanForEnvelope(2, "five-llm-v1")).toThrow();
    expect(() => qualificationPlanForEnvelope(3, "four-llm-v1")).toThrow();
  });

  it("returns frozen copies instead of exposing mutable schedules", () => {
    const schedule = qualificationSchedule(ACTIVE_QUALIFICATION_PLAN_ID);
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(schedule[0])).toBe(true);
  });
});
```

- [x] **Step 2: Run the protocol test and observe RED**

```powershell
npm exec -- vitest run test/qualification/protocol.test.ts
```

Expected: FAIL because `src/qualification/protocol.ts` and its exports do not exist.

- [x] **Step 3: Implement the minimal protocol module**

Create immutable constants and fail-closed dispatch:

```ts
import type { QualificationCaseIdentity } from "./types.js";

export const LEGACY_QUALIFICATION_PLAN_ID = "five-llm-v1" as const;
export const ACTIVE_QUALIFICATION_PLAN_ID = "four-llm-v1" as const;

export type QualificationPlanId =
  | typeof LEGACY_QUALIFICATION_PLAN_ID
  | typeof ACTIVE_QUALIFICATION_PLAN_ID;

function frozenSchedule(
  cases: readonly QualificationCaseIdentity[],
): readonly QualificationCaseIdentity[] {
  return Object.freeze(
    cases.map((identity) => Object.freeze({ ...identity })),
  );
}

export const LEGACY_QUALIFICATION_CASES = frozenSchedule([
  { ordinal: 1, llm: "gemini-3.5-flash", task: "delegate" },
  { ordinal: 2, llm: "gemini-3.5-flash", task: "review" },
  { ordinal: 3, llm: "ark-coding-plan", task: "delegate" },
  { ordinal: 4, llm: "ark-coding-plan", task: "review" },
  { ordinal: 5, llm: "kimi-k3", task: "review" },
  { ordinal: 6, llm: "kimi-k3", task: "delegate" },
  { ordinal: 7, llm: "ark-agent-plan", task: "review" },
  { ordinal: 8, llm: "ark-agent-plan", task: "delegate" },
  { ordinal: 9, llm: "ark-agent-deepseek-v4-flash", task: "review" },
  { ordinal: 10, llm: "ark-agent-deepseek-v4-flash", task: "delegate" },
]);

export const ACTIVE_QUALIFICATION_CASES = frozenSchedule([
  { ordinal: 1, llm: "ark-coding-plan", task: "delegate" },
  { ordinal: 2, llm: "ark-coding-plan", task: "review" },
  { ordinal: 3, llm: "kimi-k3", task: "review" },
  { ordinal: 4, llm: "kimi-k3", task: "delegate" },
  { ordinal: 5, llm: "ark-agent-plan", task: "review" },
  { ordinal: 6, llm: "ark-agent-plan", task: "delegate" },
  { ordinal: 7, llm: "ark-agent-deepseek-v4-flash", task: "review" },
  { ordinal: 8, llm: "ark-agent-deepseek-v4-flash", task: "delegate" },
]);

export function qualificationSchedule(
  planId: QualificationPlanId,
): readonly QualificationCaseIdentity[] {
  if (planId === LEGACY_QUALIFICATION_PLAN_ID) {
    return LEGACY_QUALIFICATION_CASES;
  }
  if (planId === ACTIVE_QUALIFICATION_PLAN_ID) {
    return ACTIVE_QUALIFICATION_CASES;
  }
  throw new Error(`Unknown qualification plan: ${String(planId)}`);
}

export function qualificationPlanForEnvelope(
  schemaVersion: unknown,
  recordedPlanId: unknown,
): QualificationPlanId {
  if (schemaVersion === 1 && recordedPlanId === undefined) {
    return LEGACY_QUALIFICATION_PLAN_ID;
  }
  if (
    schemaVersion === 2 &&
    recordedPlanId === ACTIVE_QUALIFICATION_PLAN_ID
  ) {
    return ACTIVE_QUALIFICATION_PLAN_ID;
  }
  throw new Error("Qualification schema and plan identity do not match");
}
```

Move the existing ten-case constant out of `types.ts`. In the same change, mechanically migrate every current import in the manifest, coordinator, verifier, and their tests from the removed context-free `QUALIFICATION_CASES` name to the explicit `LEGACY_QUALIFICATION_CASES` name. This keeps pre-migration behavior and typecheck green until later tasks move each write/current path to `ACTIVE_QUALIFICATION_CASES`. Do not introduce even a temporary context-free alias: every call site must state whether it is legacy or active.

- [x] **Step 4: Verify GREEN and type safety**

```powershell
npm exec -- vitest run test/qualification/protocol.test.ts
npm run typecheck
```

Expected: protocol tests PASS and typecheck exits 0.

- [x] **Step 5: Commit**

```powershell
git add src/qualification/protocol.ts src/qualification/types.ts src/qualification/manifest.ts src/qualification/coordinator.ts src/qualification/verifier.ts test/qualification/protocol.test.ts test/qualification/manifest.test.ts test/qualification/coordinator.test.ts test/qualification/verifier.test.ts
git commit -m "feat: add versioned qualification protocols"
```

## Task 2: Version Preflight Records Without Breaking Historical Decoding

**Files:**

- Modify: `src/qualification/types.ts`
- Modify: `src/qualification/preflight.ts`
- Modify: `src/qualification/manifest.ts`
- Modify: `test/qualification/preflight.test.ts`
- Modify: `test/qualification/manifest.test.ts`

- [x] **Step 1: Add RED fixtures for legacy and current preflight**

Tests must assert:

```ts
expect(freezePreflightRecord(historicalV1Record)).toEqual(
  historicalV1Record,
);
expect(() => freezePreflightRecord(historicalV1Record)).not.toThrow();

expect(currentRecord).toMatchObject({
  schemaVersion: 2,
  qualificationPlanId: "four-llm-v1",
});
expect(currentRecord.logicalLlms.map(({ llm }) => llm)).toEqual([
  "ark-agent-deepseek-v4-flash",
  "ark-agent-plan",
  "ark-coding-plan",
  "kimi-k3",
]);
expect(currentRecord.logicalLlms.every(({ route }) => route === "direct")).toBe(
  true,
);
expect(currentRecord).not.toHaveProperty("proxy10808");
expect(currentRecord.buildArtifacts.map(({ path }) => path)).not.toContain(
  "dist/pi-smoke.js",
);
```

Use the real historical `000000.json` fixture to prove the legacy codec accepts its embedded v1 preflight without calling active registry helpers.

- [x] **Step 2: Observe RED**

```powershell
npm exec -- vitest run test/qualification/preflight.test.ts test/qualification/manifest.test.ts
```

Expected: FAIL because only schema v1 exists and current parsing uses global active identities.

- [x] **Step 3: Implement versioned preflight types and codecs**

Define:

```ts
export interface LegacyFrozenPreflightRecord {
  schemaVersion: 1;
  // Preserve the existing v1 fields, including proxy10808 and old artifacts.
}

export interface CurrentFrozenPreflightRecord {
  schemaVersion: 2;
  qualificationPlanId: "four-llm-v1";
  // Preserve common frozen identity fields.
  // Do not include proxy10808.
}

export type FrozenPreflightRecord =
  | LegacyFrozenPreflightRecord
  | CurrentFrozenPreflightRecord;
```

Split `freezePreflightRecord()`:

```ts
export function freezePreflightRecord(value: unknown): FrozenPreflightRecord {
  const record = plainRecord(value);
  if (record.schemaVersion === 1) {
    return freezeLegacyPreflightRecord(record);
  }
  if (
    record.schemaVersion === 2 &&
    record.qualificationPlanId === ACTIVE_QUALIFICATION_PLAN_ID
  ) {
    return freezeCurrentPreflightRecord(record);
  }
  throw new QualificationLedgerError("Unsupported preflight protocol");
}
```

`freezeLegacyPreflightRecord()` must use frozen constants for the five historical model/provider/route/credential identities, `proxy10808`, `dist/pi-smoke.js`, and other v1 artifacts. It must not call `resolveLlm()`, `supportedLlmIds()`, access current `dist`, or require retired files to exist.

`runQualificationPreflight()` must emit only schema v2/current records, omit the proxy listener stage, and freeze exactly the new artifact set. Keep clean-HEAD, build identity, credential-source, isolated Pi config, and zero-process checks.

- [x] **Step 4: Verify both codecs**

```powershell
npm exec -- vitest run test/qualification/preflight.test.ts test/qualification/manifest.test.ts
npm run typecheck
```

Expected: historical fixture and new current record tests PASS.

- [x] **Step 5: Commit**

```powershell
git add src/qualification/types.ts src/qualification/preflight.ts src/qualification/manifest.ts test/qualification/preflight.test.ts test/qualification/manifest.test.ts
git commit -m "feat: version qualification preflight records"
```

## Task 2A: Preserve Immutable Evidence Bytes in Windows Worktrees

**Files:**

- Create: `.gitattributes`
- Modify: `test/qualification/manifest.test.ts`

- [x] **Step 1: Record the Windows checkout RED**

On the fresh isolated worktree with system `core.autocrlf=true`, verify:

```powershell
git ls-files --eol docs/smoke/evidence
Get-FileHash -Algorithm SHA256 docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json
```

Observed: Git reports `i/lf w/crlf`; the worktree manifest SHA-256 is `01db7dc3f75db40aa0df4a5446aaf161f8955122ba6b79a9ad35bc1da2af2c7e`, not the published baseline `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`. Direct terminal inspection therefore fails even though Git shows no content diff.

- [x] **Step 2: Pin qualification evidence to LF**

Add:

```gitattributes
docs/smoke/evidence/** text eol=lf
```

Commit the policy before refreshing the worktree:

```powershell
git add -- .gitattributes docs/superpowers/plans/2026-07-26-gemini-retirement-and-four-llm-qualification.md
git diff --cached --check
git commit -m "chore: preserve qualification evidence bytes"
```

- [ ] **Step 3: Recreate the clean isolated worktree**

From the primary repository, first prove the isolated path resolves under `D:\Codes\codex-agent-tools\.worktrees`, the branch is committed and clean, and no subagent is using it. Then use `git worktree remove --force` only for that exact isolated path and immediately re-add `codex/gemini-retirement` at the same path. Run `npm ci`.

- [ ] **Step 4: Verify actual checked-out bytes and terminal**

Require all of the following on the recreated worktree:

```powershell
git ls-files --eol docs/smoke/evidence
```

- all 14 immutable files report `i/lf w/lf`;
- every SHA-256 matches the complete baseline table at the top of this plan;
- `inspectQualificationTerminal()` succeeds directly against the real checked-out blocked batch, without copying or normalizing files.

Replace the temporary LF-copy test helper with direct actual-path inspection and run:

```powershell
npm exec -- vitest run test/qualification/manifest.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 5: Commit the direct-path regression**

```powershell
git add -- test/qualification/manifest.test.ts docs/superpowers/plans/2026-07-26-gemini-retirement-and-four-llm-qualification.md
git diff --cached --check
git commit -m "test: verify historical evidence in place"
```

## Task 3: Emit Schema v3 Evidence for New Qualification Cases

**Files:**

- Modify: `src/smoke/evidence.ts`
- Modify: `src/smoke/kimi.ts`
- Modify: `src/smoke/pi.ts`
- Modify: `test/smoke/evidence.test.ts`
- Modify: `test/smoke/kimi.test.ts`
- Modify: `test/smoke/pi.test.ts`
- Modify: `test/smoke/ark.test.ts`
- Modify: `test/smoke/script-entrypoints.test.ts`

- [ ] **Step 1: Add RED tests for the evidence union**

Fix the intended discriminants:

```ts
expect(standaloneEvidence).toMatchObject({
  schemaVersion: 2,
  qualification: null,
});

expect(qualificationEvidence).toMatchObject({
  schemaVersion: 3,
  qualification: {
    qualificationPlanId: "four-llm-v1",
    batchId,
    ordinal: 1,
  },
});

expect(() =>
  normalizeSmokeQualificationContext({
    ...validContext,
    qualificationPlanId: "five-llm-v1",
  }),
).toThrow();
```

Also reject schema v2 with non-null qualification, schema v3 with null qualification, unknown plan IDs, extra keys, and an ordinal/LLM/task combination outside the active schedule.

- [ ] **Step 2: Observe RED**

```powershell
npm exec -- vitest run test/smoke/evidence.test.ts test/smoke/kimi.test.ts test/smoke/pi.test.ts test/smoke/ark.test.ts test/smoke/script-entrypoints.test.ts
```

Expected: FAIL because qualification evidence is still schema v2 and has no plan identity.

- [ ] **Step 3: Implement the versioned evidence union**

Add:

```ts
export interface SmokeQualificationContext {
  qualificationPlanId: "four-llm-v1";
  batchId: string;
  ordinal: number;
  llm: string;
  task: "review" | "delegate";
  frozenCommit: string;
  frozenBuildIdentity: string;
  authorizationReferenceSha256: string;
  orchestratorFallbackUsed: false;
}

export type SmokeEvidenceEnvelope<T> =
  | ({ schemaVersion: 2; qualification: null } & T)
  | ({
      schemaVersion: 3;
      qualification: Readonly<SmokeQualificationContext>;
    } & T);
```

Update normalization, descriptor freezing, equality, infrastructure evidence, Kimi evidence, and Pi/Ark evidence so the schema follows qualification presence. Current runtime must never emit legacy qualification v2 evidence.

- [ ] **Step 4: Verify GREEN**

```powershell
npm exec -- vitest run test/smoke/evidence.test.ts test/smoke/kimi.test.ts test/smoke/pi.test.ts test/smoke/ark.test.ts test/smoke/script-entrypoints.test.ts
npm run typecheck
```

Expected: targeted tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/smoke/evidence.ts src/smoke/kimi.ts src/smoke/pi.ts test/smoke/evidence.test.ts test/smoke/kimi.test.ts test/smoke/pi.test.ts test/smoke/ark.test.ts test/smoke/script-entrypoints.test.ts
git commit -m "feat: version qualification smoke evidence"
```

## Task 4: Make Ledger, Checkpoints, and Manifests Protocol-Aware

**Files:**

- Modify: `src/qualification/types.ts`
- Modify: `src/qualification/manifest.ts`
- Modify: `test/qualification/manifest.test.ts`

- [ ] **Step 1: Add RED coverage for both disk protocols**

Tests must cover:

```ts
expect(readAndValidateManifest(realHistoricalBatchPath)).toMatchObject({
  schemaVersion: 1,
  status: "blocked",
});

expect(currentPassedManifest).toMatchObject({
  schemaVersion: 2,
  qualificationPlanId: "four-llm-v1",
  promotionEligible: true,
});
expect(currentPassedManifest.cases).toHaveLength(8);
```

Add rejection tests for:

- schema v1 plus a plan ID;
- schema v2 without `four-llm-v1`;
- v2 manifest with v2 qualification evidence;
- v1 manifest with v3 evidence;
- eight/ten schedule mixing;
- ordinal drift;
- `google_free_tier_quota` in current v2 records;
- changed bytes in a copied historical evidence file.

- [ ] **Step 2: Observe RED**

```powershell
npm exec -- vitest run test/qualification/manifest.test.ts
```

Expected: FAIL on new schema/current schedule expectations.

- [ ] **Step 3: Refactor parsing around a protocol object**

Create an internal protocol descriptor:

```ts
interface QualificationProtocol {
  planId: QualificationPlanId;
  manifestSchemaVersion: 1 | 2;
  checkpointSchemaVersion: 1 | 2;
  evidenceSchemaVersion: 2 | 3;
  schedule: readonly QualificationCaseIdentity[];
  allowGoogleFreeTierQuota: boolean;
  freezePreflight: (value: unknown) => FrozenPreflightRecord;
}
```

Every disk parser must first select this descriptor from outer schema/plan. Update `normalizeCaseIdentity`, `normalizeCheckpoint`, `loadLedgerState`, `validateEvidenceForIdentity`, `normalizeNotRun`, `buildManifest`, `readAndValidateManifest`, `inspectQualificationTerminal`, `findUncommittedEvidence`, `recoverInterruptedQualificationBatch`, and `assertAuthorizationReferenceUnused`.

New write paths must emit only schema v2/checkpoints and schema v3 evidence under `four-llm-v1`. Legacy paths are read-only. No function may consult an unqualified global case array.

- [ ] **Step 4: Verify historical and current behavior**

```powershell
npm exec -- vitest run test/qualification/manifest.test.ts
npm run typecheck
```

Expected: all manifest tests PASS; historical repository evidence hashes remain unchanged.

- [ ] **Step 5: Commit**

```powershell
git add src/qualification/types.ts src/qualification/manifest.ts test/qualification/manifest.test.ts
git commit -m "feat: support versioned qualification ledgers"
```

## Task 5: Bind Lock Ownership and Crash Recovery to the Plan

**Files:**

- Modify: `src/qualification/types.ts`
- Modify: `src/qualification/lock.ts`
- Modify: `src/qualification/manifest.ts`
- Modify: `test/qualification/lock.test.ts`
- Modify: `test/qualification/manifest.test.ts`

- [ ] **Step 1: Add lock/recovery RED cases**

Specify the owner union:

```ts
const legacyOwner = {
  schemaVersion: 1,
  batchId,
  authorizationReferenceSha256,
  // existing v1 owner fields
};

const currentOwner = {
  schemaVersion: 2,
  qualificationPlanId: "four-llm-v1",
  batchId,
  authorizationReferenceSha256,
  // existing owner fields
};
```

Tests must prove:

- v1 maps only to `five-llm-v1`;
- v2 requires `four-llm-v1`;
- owner equality includes plan identity;
- stale v2 owner before `batch_started` publishes interrupted with eight not-run cases and consumes authorization;
- stale v1 owner selects ten historical cases;
- owner/checkpoint/manifest plan conflict retains the lock and publishes nothing.

- [ ] **Step 2: Observe RED**

```powershell
npm exec -- vitest run test/qualification/lock.test.ts test/qualification/manifest.test.ts
```

Expected: FAIL because owner schema v1 has no plan-aware dispatch.

- [ ] **Step 3: Implement owner v2 and plan-aware recovery**

Use:

```ts
export type QualificationLockOwner =
  | LegacyQualificationLockOwner
  | CurrentQualificationLockOwner;

export function qualificationPlanForOwner(
  owner: QualificationLockOwner,
): QualificationPlanId {
  return owner.schemaVersion === 1
    ? LEGACY_QUALIFICATION_PLAN_ID
    : owner.qualificationPlanId;
}
```

`acquireQualificationLock()` must create only v2/current owners. `normalizeOwner()`, `ownersEqual()`, release, stale inspection, and recovery must validate plan identity. Recovery may choose a schedule only after owner/checkpoint/manifest identity agreement. Unknown or conflicting identity must fail closed without releasing a lock or writing a second terminal.

- [ ] **Step 4: Verify GREEN**

```powershell
npm exec -- vitest run test/qualification/lock.test.ts test/qualification/manifest.test.ts
npm run typecheck
```

Expected: lock and recovery tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/qualification/types.ts src/qualification/lock.ts src/qualification/manifest.ts test/qualification/lock.test.ts test/qualification/manifest.test.ts
git commit -m "feat: bind qualification locks to plan identity"
```

## Task 6: Switch Coordinator and Maintainer Entrypoints to Eight Cases

**Files:**

- Modify: `src/qualification/coordinator.ts`
- Modify: `scripts/gate-requalification.ts`
- Modify: `test/qualification/coordinator.test.ts`
- Modify: `test/smoke/script-entrypoints.test.ts`

- [ ] **Step 1: Replace ten-case expectations with RED eight-case assertions**

```ts
expect(startedCases).toEqual(ACTIVE_QUALIFICATION_CASES);
expect(maximumConcurrentCases).toBe(1);
expect(firstFailure.notRun).toEqual(ACTIVE_QUALIFICATION_CASES.slice(1));
expect(passedTerminal).toMatchObject({
  schemaVersion: 2,
  qualificationPlanId: "four-llm-v1",
  promotionEligible: true,
});
```

Assert every smoke context has `qualificationPlanId`, adapter invocation 1, retry counts 0, and both fallback flags false.

- [ ] **Step 2: Observe RED**

```powershell
npm exec -- vitest run test/qualification/coordinator.test.ts test/smoke/script-entrypoints.test.ts
```

Expected: FAIL because coordinator still executes ten cases and routes Gemini to `real-pi-smoke.mjs`.

- [ ] **Step 3: Implement the active coordinator**

`runQualificationBatch()` must bind one `QualificationProtocol` at entry and use its schedule throughout. Dependencies for lock, preflight, ledger, case context, not-run, terminal, and recovery must receive the plan explicitly. Remove the Gemini smoke-module branch:

```ts
async function smokeModule(identity: QualificationCaseIdentity) {
  if (identity.llm === "kimi-k3") {
    return import("../scripts/real-kimi-smoke.mjs");
  }
  return import("../scripts/real-ark-smoke.mjs");
}
```

Do not expose a CLI plan selector; production execution can only start `four-llm-v1`.

- [ ] **Step 4: Verify GREEN**

```powershell
npm exec -- vitest run test/qualification/coordinator.test.ts test/smoke/script-entrypoints.test.ts
npm run typecheck
```

Expected: coordinator tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/qualification/coordinator.ts scripts/gate-requalification.ts test/qualification/coordinator.test.ts test/smoke/script-entrypoints.test.ts
git commit -m "feat: run the four-llm qualification schedule"
```

## Task 7: Verify Historical and Current Batches by Recorded Protocol

**Files:**

- Modify: `src/qualification/verifier.ts`
- Modify: `scripts/verify-qualification.ts`
- Modify: `test/qualification/verifier.test.ts`

- [ ] **Step 1: Add verifier RED cases**

Tests must prove:

```ts
expect(verifyImmutableEvidence({ batchPath: historicalPath })).toMatchObject({
  qualificationPlanId: "five-llm-v1",
  status: "blocked",
});

expect(verifyFrozenQualificationBatch({ batchPath: currentPassedPath }))
  .toMatchObject({
    qualificationPlanId: "four-llm-v1",
    promotionEligible: true,
  });
```

Reject legacy manifests from frozen-candidate promotion, mixed evidence schemas, unknown plan IDs, ordinal drift, and tampered hashes.

- [ ] **Step 2: Observe RED**

```powershell
npm exec -- vitest run test/qualification/verifier.test.ts
```

Expected: FAIL because verifier uses the global ten-case schedule and current registry.

- [ ] **Step 3: Implement verifier protocol dispatch**

All verifier entrypoints must call the manifest envelope dispatcher first. Legacy immutable verification uses frozen historical identities and never compares old build artifacts to the current tree. Current frozen-candidate verification requires `four-llm-v1`, eight schema v3 cases, current HEAD/build/preflight identity, and exact telemetry. `expectedResultLine()` receives a plan-bound identity; only the legacy codec knows `PI_SMOKE_OK`.

- [ ] **Step 4: Verify GREEN**

```powershell
npm exec -- vitest run test/qualification/verifier.test.ts
npm run typecheck
```

Expected: verifier tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/qualification/verifier.ts scripts/verify-qualification.ts test/qualification/verifier.test.ts
git commit -m "feat: verify qualification records by protocol"
```

## Task 8: Retire Gemini From the Active Registry, Environment, and Doctor

**Files:**

- Modify: `src/llms/registry.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/environment.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `test/llms/registry.test.ts`
- Modify: `test/runtime/environment.test.ts`
- Modify: `test/cli/doctor.test.ts`

- [ ] **Step 1: Write active-surface RED tests**

```ts
expect(supportedLlmIds()).toEqual([
  "ark-agent-deepseek-v4-flash",
  "ark-agent-plan",
  "ark-coding-plan",
  "kimi-k3",
]);
expect(() => resolveLlm("gemini-3.5-flash")).toThrow(
  /Unknown logical llm/u,
);
expect(credentialEnvironmentNames()).not.toContain("GEMINI_API_KEY");
expect(credentialEnvironmentNames()).not.toContain("GOOGLE_API_KEY");
expect(report.checks.some(({ name }) => /Gemini/u.test(name))).toBe(false);
expect(report.checks.filter(({ name }) => name.startsWith("LLM "))).toHaveLength(
  4,
);
```

Add compile-time coverage that active `NetworkPolicy` is only `"direct"`. Retain exact Ark endpoints, credentials, models, concurrency keys, and pending/passed gates.

- [ ] **Step 2: Observe RED**

```powershell
npm exec -- vitest run test/llms/registry.test.ts test/runtime/environment.test.ts test/cli/doctor.test.ts
npm run typecheck
```

Expected: FAIL because Gemini and proxy policy remain active.

- [ ] **Step 3: Remove active Gemini**

Delete the Gemini profile, Google credential collection, active proxy branch, and doctor checks. Keep direct child-environment proxy clearing. Keep legacy route/credential definitions only inside qualification codecs, not active domain types.

- [ ] **Step 4: Verify GREEN**

```powershell
npm exec -- vitest run test/llms/registry.test.ts test/runtime/environment.test.ts test/cli/doctor.test.ts
npm run typecheck
```

Expected: targeted tests and typecheck PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/llms/registry.ts src/domain/types.ts src/runtime/environment.ts src/cli/doctor.ts test/llms/registry.test.ts test/runtime/environment.test.ts test/cli/doctor.test.ts
git commit -m "refactor: retire Gemini from the active registry"
```

## Task 9: Remove Gemini-Specific Pi Retry and Standalone Smoke

**Files:**

- Modify: `src/adapters/pi/adapter.ts`
- Modify: `src/adapters/pi/client.ts`
- Modify: `src/smoke/evidence.ts`
- Modify: `src/smoke/pi.ts`
- Modify: `src/smoke/ark.ts`
- Verify unchanged: `src/runtime/agent-processes.ts`
- Modify: `test/fakes/fake-pi-rpc.mjs`
- Modify: `test/adapters/pi/adapter.test.ts`
- Modify: `test/adapters/pi/client.test.ts`
- Modify: `test/smoke/pi.test.ts`
- Modify: `test/smoke/ark.test.ts`
- Modify: `test/smoke/script-entrypoints.test.ts`
- Modify: `test/runtime/agent-processes.test.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`
- Delete: `scripts/real-pi-smoke.mjs`

- [ ] **Step 1: Add RED tests for the contracted runtime**

Assert:

```ts
expectTypeOf<PiAdapterDependencies>().not.toHaveProperty("waitForRetry");
expectTypeOf<SmokeKind>().toEqualTypeOf<"ark" | "kimi">();
expect(packageJson.scripts).not.toHaveProperty("smoke:pi");
await expect(
  classifyAgentProcesses({
    platform: "win32",
    rows: [
      {
        processId: 41,
        commandLine: "node scripts/real-pi-smoke.mjs",
      },
    ],
  }),
).resolves.toEqual({
  kimi: { count: 0 },
  piRpc: { count: 0 },
  realSmoke: { count: 1 },
});
```

Import `SmokeKind` from the evidence module and `classifyAgentProcesses` from the process-classification module in the relevant tests. Convert generic Pi fixtures to Ark identities. Keep runtime retry/fallback telemetry tests because they protect Ark qualification. Add an Ark regression showing Google quota text is not classified as the retired active failure reason. Preserve the count-only process-reporting boundary; do not add command names to the public classification result. The retired launcher remains a recognized process-safety signature so an old worktree cannot hide a live historical smoke process.

- [ ] **Step 2: Observe RED**

```powershell
npm exec -- vitest run test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts test/smoke/pi.test.ts test/smoke/ark.test.ts test/smoke/script-entrypoints.test.ts test/runtime/agent-processes.test.ts
npm run typecheck
```

Expected: FAIL on Gemini retry, smoke kind, smoke script, and build entry. The historical launcher process-classification characterization already passes and must stay green.

- [ ] **Step 3: Remove only Gemini-specific active behavior**

Delete adapter outer retry and `waitForRetry`; each adapter call invokes the client once. Retain Pi-reported retry/compaction/fallback observation and qualification single-attempt controls. Keep `src/smoke/pi.ts` as the Ark harness, but remove Gemini argument parsing, Google endpoint, proxy expectation, `PI_SMOKE_OK`, and active `google_free_tier_quota`. Remove package and tsup entrypoints for standalone Pi smoke and delete its script. Do not remove `real-pi-smoke.mjs` from the conservative historical process-signature set.

Set fake Pi defaults to `ark-agent-plan` / `ark-code-latest` and retain neutral retry/fallback scenarios.

- [ ] **Step 4: Verify GREEN and Ark invariants**

```powershell
npm exec -- vitest run test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts test/adapters/pi/config.test.ts test/smoke/pi.test.ts test/smoke/ark.test.ts test/smoke/script-entrypoints.test.ts test/runtime/agent-processes.test.ts
npm run typecheck
```

Expected: targeted tests PASS; config still contains exactly the two Ark providers and three Ark models.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/pi/adapter.ts src/adapters/pi/client.ts src/smoke/evidence.ts src/smoke/pi.ts src/smoke/ark.ts test/fakes/fake-pi-rpc.mjs test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts test/smoke/pi.test.ts test/smoke/ark.test.ts test/smoke/script-entrypoints.test.ts test/runtime/agent-processes.test.ts package.json tsup.config.ts
git rm scripts/real-pi-smoke.mjs
git commit -m "refactor: remove standalone Gemini runtime paths"
```

## Task 10: Align Plugin Acceptance and Package Assurance

**Files:**

- Modify: `scripts/local-acceptance.mjs`
- Modify: `scripts/plugin-isolated-acceptance.mjs`
- Modify: `scripts/release-smoke.mjs`
- Modify: `test/acceptance/local.test.ts`
- Modify: `test/plugin/artifact.test.ts`
- Modify: `test/release/assurance.test.ts`
- Modify: `test/tasks/service.test.ts`

- [ ] **Step 1: Add acceptance/package RED tests**

Assert unknown Gemini fails before adapter startup:

```ts
expect(result.isError).toBe(true);
expect(result.structuredContent).toBeUndefined();
expect(result.content).toContainEqual(
  expect.objectContaining({
    text: expect.stringMatching(
      /Unknown logical llm.*ark-agent-deepseek-v4-flash, ark-agent-plan, ark-coding-plan, kimi-k3/u,
    ),
  }),
);
expect(fakePiInvocationCount).toBe(0);
```

Assert Google credentials are excluded, `smoke:pi` is absent, and historical Gemini docs/evidence remain in `package.json.files`.

- [ ] **Step 2: Observe RED**

```powershell
npm exec -- vitest run test/acceptance/local.test.ts test/plugin/artifact.test.ts test/release/assurance.test.ts test/tasks/service.test.ts
```

Expected: FAIL because acceptance still treats Gemini as pending and package scripts still expose Pi smoke.

- [ ] **Step 3: Implement four-LLM acceptance**

Change isolated acceptance to:

1. call retired Gemini and require unknown-model error plus zero Pi calls;
2. call `ark-agent-deepseek-v4-flash` through fake Pi exactly once;
3. assert direct proxy clearing and target-only Ark credential injection;
4. keep both tools and required `llm` schema unchanged.

Release smoke must compare exact doctor LLM names, retain the historical page/evidence package surface, resolve npm `***` paths uniquely, and scan all retained history for secrets and developer-machine absolute paths.

Do not run `scripts/local-acceptance.mjs`; only update its real route from Gemini to the already-qualified Ark Flash profile.

- [ ] **Step 4: Verify GREEN**

```powershell
npm exec -- vitest run test/acceptance/local.test.ts test/plugin/artifact.test.ts test/release/assurance.test.ts test/tasks/service.test.ts
npm run build
```

Expected: targeted tests and build PASS.

- [ ] **Step 5: Commit**

```powershell
git add scripts/local-acceptance.mjs scripts/plugin-isolated-acceptance.mjs scripts/release-smoke.mjs test/acceptance/local.test.ts test/plugin/artifact.test.ts test/release/assurance.test.ts test/tasks/service.test.ts
git commit -m "test: align plugin acceptance with four llms"
```

## Task 11: Reframe Current Documentation and Regenerate Isolated Evidence

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/operations.md`
- Modify: `docs/migration-from-codex-cc-tools.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/release/real-plugin-install-review.md`
- Modify: `docs/release/plugin-isolated-state.md`
- Modify: `docs/smoke/ark.md`
- Modify: `docs/smoke/kimi.md`
- Modify: `docs/smoke/pi-gemini.md`
- Modify: `docs/superpowers/specs/2026-07-26-gate-requalification-design.md`
- Modify: `docs/superpowers/plans/2026-07-26-gate-requalification.md`
- Modify: `docs/superpowers/specs/2026-07-25-official-plugin-integration-design.md`
- Modify: `docs/superpowers/plans/2026-07-25-official-plugin-integration.md`
- Modify: `docs/superpowers/plans/2026-07-26-gemini-retirement-and-four-llm-qualification.md`

- [ ] **Step 1: Establish documentation RED**

After script changes but before regenerating the isolated report:

```powershell
npm run build
npm run acceptance:plugin:isolated -- --check-report
```

Expected: FAIL with report drift and no report write.

- [ ] **Step 2: Update current-state documents**

Current-facing documents must consistently state:

- four active logical LLMs, all direct;
- eight review/delegate capabilities;
- transitional 6 passed / 2 pending;
- only Ark Coding Plan is pending;
- Gemini is retired historical evidence, not a current provider;
- new qualification requires one `four-llm-v1` 8/8 batch;
- active install remains `blocked / not ready`.

Historical specs/plans receive only a concise superseded note and keep their original narrative. `docs/smoke/pi-gemini.md` becomes the retired-history page while retaining every historical evidence link/hash.

- [ ] **Step 3: Regenerate and check isolated lifecycle evidence**

```powershell
npm run acceptance:plugin:isolated
npm run acceptance:plugin:isolated -- --check-report
```

Expected: first command completes the temporary official add/list/remove lifecycle and updates the tracked report; second command confirms byte equality. Neither command uses active Codex home or real models.

- [ ] **Step 4: Verify historical evidence bytes**

Record and compare SHA-256 for the nine standalone Gemini files plus five blocked-batch files against the complete 14-file table in “Historical evidence hash baseline”. Additionally, compare each file's bytes with `git show e24b942:<path>` so a mistaken table edit cannot silently become the new baseline.

Expected: all historical hashes unchanged.

- [ ] **Step 5: Commit**

```powershell
git add README.md AGENTS.md docs scripts/plugin-isolated-acceptance.mjs
git commit -m "docs: reframe the candidate around four llms"
```

## Task 12: Deterministic Review, Full Verification, and Candidate Freeze

**Files:**

- Modify only if review finds a reproducible issue; every behavior fix requires a new RED test.

- [ ] **Step 1: Run fresh deterministic verification**

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated -- --check-report
npm run qualify:gates -- --help
git diff --check
git status --short
```

Expected: every command exits 0; working tree is clean; no real smoke or authorization-bearing qualification runs.

- [ ] **Step 2: Verify process baseline**

Use `classifyAgentProcesses()` and require:

```json
{
  "kimi": { "count": 0 },
  "piRpc": { "count": 0 },
  "realSmoke": { "count": 0 }
}
```

- [ ] **Step 3: Run independent specification and quality reviews**

Provide reviewers the design, this plan, base SHA `e24b942`, current HEAD, test evidence, and explicit stop lines. Fix every reproducible Critical/Important issue with TDD; technically evaluate Minor findings.

- [ ] **Step 4: Re-run the complete verification after review fixes**

Repeat Step 1 and Step 2. Recompute all historical hashes.

- [ ] **Step 5: Freeze candidate**

```powershell
git commit --allow-empty -m "chore: freeze four-llm qualification candidate"
```

Keep the full 40-character commit in the main agent's execution state and pass it unchanged to the coordinator. Do not edit tracked files after this commit and before Task 13. Record the freeze SHA in `AGENTS.md` only in the post-batch terminal-state commit, because a commit cannot contain its own final SHA.

## Task 13: Run the Authorized Four-LLM Batch Exactly Once

**Files:**

- Create only through coordinator: one new child directory under `docs/smoke/evidence/batches/`

- [ ] **Step 1: Run production preflight through the fixed coordinator**

Generate a fresh UUID authorization reference in memory without printing it. Invoke exactly once:

```powershell
$authorizationRef = [guid]::NewGuid().ToString()
try {
  npm run --silent qualify:gates -- --authorization-ref $authorizationRef
  $qualificationExitCode = $LASTEXITCODE
} finally {
  Remove-Variable authorizationRef -ErrorAction SilentlyContinue
}
Write-Output "qualificationExitCode=$qualificationExitCode"
```

The UUID value must not be written to docs, logs, shell history, or chat. Only its SHA-256 may enter the lock/checkpoints/manifest.

- [ ] **Step 2: Enforce the fixed order and stop semantics**

Expected order:

1. Ark Coding Plan delegate
2. Ark Coding Plan review
3. Kimi K3 review
4. Kimi K3 delegate
5. Ark Agent Plan review
6. Ark Agent Plan delegate
7. Ark Agent DeepSeek V4 Flash review
8. Ark Agent DeepSeek V4 Flash delegate

At the first failed/blocked/interrupted case: stop, publish terminal evidence, mark remaining cases not run, and do not retry, resume, fall back, or start a second batch.

- [ ] **Step 3: Verify the terminal from disk**

Run immutable inspection. It has three possible outcomes:

1. If the same manifest records 8/8 passed and `promotionEligible=true`, run frozen-candidate verification and continue to Task 14 success branch.
2. If exactly one new manifest records a failed/blocked/interrupted terminal, continue to Task 14 blocked branch.
3. If production preflight fails before `batch_started`, no batch directory or manifest is expected. Continue to Task 14 no-terminal/preflight-failed branch. Do not manufacture evidence, rerun the command, reuse the destroyed UUID, or claim the authorization was durably consumed.

- [ ] **Step 4: Verify process cleanup**

Require Kimi ACP, Pi RPC, and real-smoke target process counts all return to zero.

- [ ] **Step 5: Commit immutable batch evidence when a terminal exists**

Only for outcomes 1 or 2, derive the single new batch ID from untracked paths and stage only that directory:

```powershell
$batchIds = @(
  git status --porcelain=v1 --untracked-files=all |
    ForEach-Object {
      if ($_ -match '^\?\? docs/smoke/evidence/batches/([^/\\]+)/') {
        $Matches[1]
      }
    } |
    Sort-Object -Unique
)
if ($batchIds.Count -ne 1) {
  throw "Expected exactly one new qualification batch directory"
}
$batchId = $batchIds[0]
git add -- "docs/smoke/evidence/batches/$batchId"
git commit -m "test: record four-llm qualification evidence"
```

For outcome 3, assert there is no new batch path and do not create an evidence commit. The one production command invocation has occurred and must not be repeated in this turn, even though authorization was not durably consumed.

## Task 14: Publish the Correct Terminal Product State

### Success branch — only after same-batch 8/8 and frozen verifier PASS

**Files:**

- Modify: `src/llms/registry.ts`
- Modify: relevant registry/doctor/acceptance tests
- Modify: `README.md`, `AGENTS.md`, operations/migration/release/smoke docs
- Modify: `docs/release/real-plugin-install-review.md`

- [ ] Write RED tests that expect Ark Coding Plan review/delegate to resolve as passed with anchors to the new evidence.
- [ ] Observe RED, implement pairwise promotion, and run targeted GREEN tests.
- [ ] Update all four-LLM documents to 8 passed / 0 pending.
- [ ] Rewrite the install review package as `ready`, but do not request or execute installation within this task.
- [ ] Run complete deterministic verification, independent final review, and the 14-file plus new-batch immutable checks before staging.
- [ ] Stage the exact implementation, test, and current-status document paths; inspect `git diff --cached --check` and the cached name list; then commit:

```powershell
git add -- src/llms/registry.ts test/llms/registry.test.ts test/cli/doctor.test.ts test/acceptance/local.test.ts test/plugin/artifact.test.ts README.md AGENTS.md docs/operations.md docs/migration-from-codex-cc-tools.md docs/release/checklist.md docs/release/real-plugin-install-review.md docs/release/plugin-isolated-state.md docs/smoke/ark.md docs/smoke/kimi.md
git diff --cached --check
git diff --cached --name-status
git commit -m "feat: promote four-llm qualification"
```

- [ ] After the commit, rerun the immutable-evidence verifier, full deterministic suite, and `git status --short`. If a fix is required, make a separate fix commit and repeat the post-commit checks.

### Blocked branch — any failed/blocked/interrupted terminal

**Files:**

- Modify only current status/index documents needed to explain the new terminal.

- [ ] Keep registry at 6 passed / 2 pending.
- [ ] Keep installation state `blocked / not ready`.
- [ ] Link the new manifest/evidence and record SHA-256, exact failure layer, telemetry, not-run count, and process cleanup.
- [ ] Record that the current authorization is consumed and no retry occurred.
- [ ] Run release smoke, documentation consistency review, and historical/new evidence hash checks before staging.
- [ ] Stage only the exact current-status/index documents changed for this terminal. Compute the changed set from the following whitelist, fail if any other tracked file changed, then inspect `git diff --cached --check` and the cached name list before committing:

```powershell
$allowedStatusPaths = @(
  "AGENTS.md",
  "README.md",
  "docs/operations.md",
  "docs/migration-from-codex-cc-tools.md",
  "docs/release/checklist.md",
  "docs/release/real-plugin-install-review.md",
  "docs/release/plugin-isolated-state.md",
  "docs/smoke/ark.md",
  "docs/smoke/kimi.md"
)
$allChanged = @(git diff --name-only)
$unexpected = @($allChanged | Where-Object { $_ -notin $allowedStatusPaths })
if ($unexpected.Count -gt 0) {
  throw "Unexpected blocked-branch changes: $($unexpected -join ', ')"
}
if ($allChanged.Count -eq 0) {
  throw "Expected at least one blocked status document change"
}
git add -- $allChanged
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: record blocked four-llm qualification"
```

- [ ] After the commit, rerun historical/new immutable checks, the full deterministic suite, and `git status --short`. If a fix is required, make a separate fix commit and repeat the post-commit checks.

### No-terminal/preflight-failed branch — only before `batch_started`

- [ ] Prove there is no new batch directory, manifest, checkpoint, case evidence, or staged evidence path.
- [ ] Keep the registry at 6 passed / 2 pending and installation state `blocked / not ready`.
- [ ] Report the fixed preflight stage and non-secret failure evidence. State precisely that the one authorized command invocation occurred, no terminal exists, and authorization was not durably consumed because `batch_started` was never published.
- [ ] Do not rerun in this turn. Stop and request a new explicit user decision before any future authorization-bearing attempt.
- [ ] Do not create a qualification evidence or terminal-state commit. If the worktree is unexpectedly dirty, inspect it and restore only generated/ignored artifacts that are provably safe; otherwise stop with evidence.

All three branches stop before active plugin install, npm publish, `config.toml` access, old-tool removal, or Claude Code changes.

## Final Handoff

The implementation is complete only when:

- all deterministic checks pass;
- the worktree is clean;
- historical Gemini evidence hashes are unchanged;
- the single authorized invocation either has one valid terminal, or is reported through the explicit no-terminal/preflight-failed branch;
- when a terminal exists, the product state matches that terminal;
- process counts are zero;
- no active install/config/old-tool action occurred.

If the success branch reaches `ready`, prepare a separate Chinese review package for a future exact official install authorization. Do not treat `ready` as installation permission.
