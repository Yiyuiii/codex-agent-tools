# Qualification Carrier Hardening and Reauthorization Preparation Implementation Plan

> **Historical authorization note (2026-07-28):** The per-batch human reauthorization stop in this completed plan is superseded by `2026-07-28-standing-experiment-authorization-design.md`. Its carrier, one-entry/one-cell, fail-closed, and evidence-integrity requirements remain applicable.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a Codex-native long-running carrier without any model or network call, preserve the qualification production protocol unchanged, freeze a fully verified candidate, and stop with a new Chinese reauthorization review package.

**Architecture:** Keep `gate-requalification`, the coordinator, locks, manifests, checkpoints, evidence, model routing, credentials, and retry policy unchanged. Exercise the actual Codex `functions.exec → tools.shell_command → functions.wait` control path with a deterministic 105-second local Node process, persist only non-secret rehearsal facts, then add a new package-closed reauthorization page and freeze the candidate. The plan never generates an authorization reference or invokes a real qualification entry.

**Tech Stack:** Codex desktop execution cells, PowerShell, Node.js 20+, TypeScript 5.9, Vitest 4, tsup, Git, HTML/CSS, npm pack release assurance.

**Planning status (2026-07-27):** Draft prepared after the only authorized batch ended as `interrupted / process_interrupted`. No implementation step is authorized by this document. The active registry remains 6 passed / 2 pending and installation remains `blocked / not ready`. One broad Kimi K3 review attempt timed out after about 601.5 seconds and one narrowed Ark Agent Plan attempt aborted after about 302.7 seconds; neither produced a conclusion or changed files, so neither is recorded as PASS. The plan was subsequently tightened to require narrow external review and independent Codex reviews.

---

## Source of truth

- Design: `docs/superpowers/specs/2026-07-27-qualification-carrier-and-reauthorization-design.md`
- Latest result review: `docs/release/four-llm-qualification-result-review.html`
- Latest interrupted manifest: `docs/smoke/evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json`
- Historical consumed execution plan: `docs/superpowers/plans/2026-07-27-authorized-four-llm-qualification-and-convergence.md`
- Starting branch: `codex/gemini-retirement`
- Starting commit: `109886f1754f58c440955d4a0667dfa5e36abef6`

## Execution constraints

- Work only in `D:\Codes\codex-agent-tools\.worktrees\gemini-retirement`.
- The design, this plan, and the AGENTS index update must be committed before implementation.
- Do not invoke any command carrying `--authorization-ref`.
- Do not run `smoke:kimi`, `smoke:ark`, `acceptance:local`, qualification recovery, or any standalone real smoke.
- Do not generate an authorization UUID, even temporarily.
- Do not read, compare, back up, write, or restore active `~/.codex/config.toml`.
- Do not install, remove, upgrade, or roll back active plugins.
- Do not modify or invoke Claude Code or `codex_cc_tools`.
- Do not modify any file under `docs/smoke/evidence/`.
- Do not modify `scripts/gate-requalification.ts`, `src/qualification/`, `src/smoke/`, `src/adapters/`, `src/llms/registry.ts`, or qualification schemas.
- Do not run `npm publish`, create a release/tag, push, merge, or fast-forward the formal worktree.
- `acceptance:plugin:isolated -- --check-report` is allowed because it uses a temporary `CODEX_HOME` and compares the committed isolated report.
- `external_review` may be used only as the plan's explicit read-only `kimi-k3` runbook review with Git diff and untracked collection disabled. It must not be used as qualification evidence.
- Any external review must be constrained to one file or one explicit question and roughly 20k–30k characters. A timeout or partial trace is recorded as no conclusion, never as PASS, and is not retried with the same scope.
- If an offline check exposes a product-code defect, stop and revise the design; do not silently expand this no-production-change plan.

## File responsibility map

- `docs/release/qualification-carrier-rehearsal.md`: non-secret evidence from the 105-second execution-cell rehearsal.
- `docs/release/four-llm-qualification-execution-runbook.md`: Codex-only carrier, wait, observation, and fail-closed recovery contract.
- `docs/release/four-llm-qualification-reauthorization-review.html`: new human review entry; it is not authorization.
- `src/release/assurance.ts`: exact package allowlist for the new review page only.
- `test/release/assurance.test.ts`: RED/GREEN coverage for the exact new package file.
- `scripts/release-smoke.mjs`: requires and link-checks the new review page in a real `npm pack --dry-run --json`.
- `package.json`: includes the new review page in the package.
- `README.md`, `docs/operations.md`, `docs/release/checklist.md`, `docs/smoke/ark.md`: report that carrier rehearsal and reauthorization preparation are complete while qualification remains 6/2.
- `AGENTS.md`: indexes the design, plan, runbook, rehearsal report, and current authorization boundary.

## Task 1: Commit the approved planning baseline

**Files:**

- Create: `docs/superpowers/specs/2026-07-27-qualification-carrier-and-reauthorization-design.md`
- Create: `docs/superpowers/plans/2026-07-27-qualification-carrier-and-reauthorization.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Confirm user approval is limited to implementation preparation**

The user response must approve this design or explicitly authorize its implementation. A request to “run the batch,” an ambiguous “continue,” or an authorization that omits the frozen-candidate preparation boundary must be clarified before work begins.

Expected interpretation after approval:

```text
Allowed: offline carrier rehearsal, runbook, package/review-page changes,
deterministic and isolated verification, read-only review, clean freeze.
Forbidden: authorization UUID generation and every real qualification call.
```

- [ ] **Step 2: Verify the starting branch and tree**

Run:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
git diff --check
```

Expected:

```text
codex/gemini-retirement
109886f1754f58c440955d4a0667dfa5e36abef6
```

`git status --short` prints only the three approved planning-document changes before the planning commit. `git diff --check` exits 0.

- [ ] **Step 3: Self-review the design and plan**

Run:

```powershell
rg -n "T[B]D|T[O]DO|authorization-ref [0-9a-f]|npm publish|config\.toml" docs/superpowers/specs/2026-07-27-qualification-carrier-and-reauthorization-design.md docs/superpowers/plans/2026-07-27-qualification-carrier-and-reauthorization.md
git diff --check
```

Expected:

- no unresolved marker;
- no literal authorization UUID;
- occurrences of forbidden actions only describe explicit prohibitions;
- diff check exits 0.

- [ ] **Step 4: Commit the planning baseline**

Run:

```powershell
git add AGENTS.md docs/superpowers/specs/2026-07-27-qualification-carrier-and-reauthorization-design.md docs/superpowers/plans/2026-07-27-qualification-carrier-and-reauthorization.md
git commit -m "docs: plan qualification carrier hardening"
git status --short
```

Expected: commit succeeds and status is empty.

## Task 2: Re-establish immutable baseline facts before the rehearsal

**Files:**

- Read only: `docs/smoke/evidence/**`
- Read only: `docs/release/four-llm-qualification-result-review.html`

- [ ] **Step 1: Verify the three retained batch manifests**

Run:

```powershell
npm.cmd run verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json
npm.cmd run verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json
npm.cmd run verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json
```

Expected:

- latest `four-llm-v1`: `interrupted`, `promotionEligible=false`;
- previous `four-llm-v1`: `blocked`, `promotionEligible=false`;
- historical `five-llm-v1`: `blocked`, `promotionEligible=false`.

- [ ] **Step 2: Verify the latest manifest identity**

Run:

```powershell
$manifest = 'docs/smoke/evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json'
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.ToLowerInvariant()
if ($sha -ne '3e200dca507fe886d4e3a4bbf67cc811cca485120e6969e7632f933537ba902b') {
  throw 'Interrupted manifest changed'
}
Write-Output "interruptedManifestSha256=$sha"
```

Expected: exact recorded SHA-256.

- [ ] **Step 3: Confirm no target process and no qualification lock**

Run:

```powershell
npx.cmd tsx -e "import('./src/runtime/agent-processes.ts').then(async ({ classifyAgentProcesses }) => { const counts = await classifyAgentProcesses(); console.log(JSON.stringify(counts)); if (counts.kimi.count !== 0 || counts.piRpc.count !== 0 || counts.realSmoke.count !== 0) process.exitCode = 1; })"
npx.cmd tsx -e "import('./src/qualification/lock.ts').then(async (m) => { const fs = await import('node:fs/promises'); const location = await m.qualificationLockLocation(process.cwd()); try { await fs.lstat(location.lockDirectory); process.stdout.write(JSON.stringify({lockState:'present'})); process.exitCode=1; } catch (error) { if (error?.code==='ENOENT') { process.stdout.write(JSON.stringify({lockState:'absent'})); return; } throw error; } }).catch(()=>{process.exitCode=4;})"
```

Expected:

```json
{"kimi":{"count":0},"piRpc":{"count":0},"realSmoke":{"count":0}}
{"lockState":"absent"}
```

If either command fails, stop before the carrier rehearsal.

## Task 3: Prove the Codex execution-cell carrier with no network

**Files:**

- Create after successful measurement: `docs/release/qualification-carrier-rehearsal.md`

- [ ] **Step 1: Confirm both execution tools are available**

The active Codex turn must expose:

- `functions.exec`;
- `functions.wait`.

If either is absent, record no rehearsal, make no fallback code change, and stop for a new design.

- [ ] **Step 2: Start the exact 105-second local probe through `functions.exec`**

Call `functions.exec` with this raw JavaScript:

```js
// @exec: {"yield_time_ms": 1000, "max_output_tokens": 2000}
const command = String.raw`@'
let sequence = 0;
const startedAt = Date.now();
process.stdout.write(JSON.stringify({ event: "started", sequence }) + "\n");
const timer = setInterval(() => {
  sequence += 1;
  process.stdout.write(JSON.stringify({ event: "heartbeat", sequence }) + "\n");
  if (sequence === 7) {
    clearInterval(timer);
    process.stdout.write(
      JSON.stringify({
        event: "completed",
        sequence,
        elapsedBucket: Math.round((Date.now() - startedAt) / 15000),
      }) + "\n",
    );
  }
}, 15000);
'@ | node -`;
const result = await tools.shell_command({
  command,
  workdir: "D:\\Codes\\codex-agent-tools\\.worktrees\\gemini-retirement",
  timeout_ms: 180000,
});
text(result);
```

Expected first return within the yield window:

```text
Script running with cell ID ...
```

The tool must not return timeout, completion, or termination at this point.

- [ ] **Step 3: Continue only the yielded cell**

Call `functions.wait` repeatedly. Pass the exact opaque `cell_id` returned by Step 2 unchanged, with `yield_time_ms: 30000` and `max_tokens: 2000`. Do not invent, normalize, persist, or substitute the identifier. Between waits, send concise user progress updates so the user is not left without commentary for more than 60 seconds.

Expected:

- at least three wait cycles occur before completion;
- the final result exits 0;
- output contains one `started`, heartbeats 1 through 7 in order, and one `completed`;
- `completed.elapsedBucket` equals 7;
- no second `functions.exec` or shell command starts the probe.

- [ ] **Step 4: Verify cleanup after the probe**

Run the two process/lock commands from Task 2 Step 3 again.

Expected: target processes remain 0/0/0 and lock remains absent.

- [ ] **Step 5: Persist the minimal rehearsal report**

Create `docs/release/qualification-carrier-rehearsal.md` with these sections:

```markdown
# 资格长时承载离线演练

## 结论

Codex 原生 execution cell 在当前线程中完成 105 秒无网络演练；外层及时 yield，后续只等待同一 cell，进程正常退出且没有资格锁或目标进程残留。

## 已验证事实

- 外层：`functions.exec`
- 内层：单个 `tools.shell_command`
- 继续机制：`functions.wait`
- 事件：1 started / 7 ordered heartbeats / 1 completed
- wait：至少 3 个独立周期
- 退出：0
- 演练后：资格锁 absent；Kimi ACP / Pi RPC / real-smoke 为 0/0/0

## 适用边界

该演练只证明当前 Codex 执行承载可跨越先前约 14 秒的前台工具超时；它不调用模型、不证明模型资格，也不授权真实批次。真实批次仍需绑定精确 frozen commit 的另一份用户明确授权。
```

在适用边界中再明确：该 105 秒结果不声称证明 4 小时存活；未来真实批次必须同时使用 active long-term goal、至少 14,400,000 毫秒的内层 shell timeout、短周期 wait 与现有锁/恢复协议。

Add the actual date, non-secret thread id, exact wait-cycle count, and measured elapsed range. Do not record the cell id, PID, environment values, user paths, authorization data, or full command line.

- [ ] **Step 6: Commit the rehearsal report**

Run:

```powershell
git add docs/release/qualification-carrier-rehearsal.md
git commit -m "docs: record qualification carrier rehearsal"
git status --short
```

Expected: commit succeeds and status is empty.

## Task 4: Write the fail-closed execution runbook and current status

**Files:**

- Create: `docs/release/four-llm-qualification-execution-runbook.md`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/smoke/ark.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write the execution runbook**

The runbook must be a maintainer document, not an executable authorization script. It must contain:

1. authorization-precondition checklist;
2. one-cell/one-entry invariant;
3. active long-term goal precondition、4 小时内层 shell 预算、`exec` yield 和 `wait` cadence;
4. user commentary cadence;
5. safe read-only lock/checkpoint/terminal observations;
6. the exact cell-loss decision tree from design section 5.4;
7. one-time same-batch interrupted recovery boundary;
8. success, failure, and ambiguity stop conditions;
9. explicit prohibitions on retry, fallback, resume, second batch, active config, install, publish, Claude Code, old-tool removal, and formal-worktree mutation;
10. statement that the runbook and review page never grant authorization.

Do not include an authorization UUID or a copy-paste command containing one.

- [ ] **Step 2: Update current status documents**

Update the five status surfaces to say:

- the latest real qualification result remains interrupted and non-promotable;
- registry remains 6 passed / 2 pending;
- installation remains `blocked / not ready`;
- the 105-second carrier rehearsal is offline infrastructure evidence only;
- a new frozen candidate and explicit reauthorization are still required;
- the historical authorization page remains consumed.

Do not change any historical evidence count, manifest status, model result, or promotion statement.

- [ ] **Step 3: Validate links and status consistency**

Run:

```powershell
rg -n "6 passed / 2 pending|blocked / not ready|process_interrupted|105 秒|重新授权" README.md AGENTS.md docs/operations.md docs/release/checklist.md docs/smoke/ark.md docs/release/qualification-carrier-rehearsal.md docs/release/four-llm-qualification-execution-runbook.md
git diff --check
```

Expected: all current status surfaces contain consistent blocked semantics and diff check exits 0.

- [ ] **Step 4: Commit the runbook and status update**

Run:

```powershell
git add AGENTS.md README.md docs/operations.md docs/release/checklist.md docs/smoke/ark.md docs/release/four-llm-qualification-execution-runbook.md
git commit -m "docs: define qualification execution carrier"
git status --short
```

Expected: commit succeeds and status is empty.

## Task 5: Add the new reauthorization page to the package with TDD

**Files:**

- Create: `docs/release/four-llm-qualification-reauthorization-review.html`
- Modify: `test/release/assurance.test.ts`
- Modify: `src/release/assurance.ts`
- Modify: `package.json`
- Modify: `scripts/release-smoke.mjs`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write the RED exact-file allowlist test**

In `test/release/assurance.test.ts`, add:

```ts
"docs/release/four-llm-qualification-reauthorization-review.html",
```

to the accepted package-file array immediately after the historical authorization page.

Run:

```powershell
npx.cmd vitest run test/release/assurance.test.ts
```

Expected: FAIL with an unexpected-file error for the new reauthorization page because `EXACT_PUBLIC_FILES` does not yet allow it.

- [ ] **Step 2: Implement the exact package allowlist**

In `src/release/assurance.ts`, add:

```ts
"docs/release/four-llm-qualification-reauthorization-review.html",
```

to `EXACT_PUBLIC_FILES` immediately after:

```ts
"docs/release/four-llm-qualification-authorization-review.html",
```

Run:

```powershell
npx.cmd vitest run test/release/assurance.test.ts
```

Expected: PASS.

- [ ] **Step 3: Write the new Chinese review page**

Create a self-contained responsive HTML page with:

- title `四模型八项资格批次重新授权审阅`;
- top conclusion: carrier rehearsal passed, but no model qualification has run and status remains 6/2 blocked;
- previous interruption timeline and exact manifest SHA;
- why `exec`/`wait` fixes the control layer without changing qualification semantics;
- 105-second rehearsal facts and residual-process/lock results;
- unchanged model/provider/network/credential/retry/evidence boundaries;
- full deterministic, isolated, immutable-evidence, package, and visual verification results;
- the single requested decision;
- explicit statement that the page itself is not authorization;
- explicit exclusions for active config, install, old-tool removal, Claude Code, publish, and formal-worktree fast-forward;
- links only to package-included result review, checklist, operations, Ark status, interrupted manifest, and historical authorization page.

The page must not contain a literal authorization UUID, cell id, PID, environment value, absolute development path, secret, or uncommitted frozen SHA. The exact frozen SHA will be supplied in the final handoff after the page is committed.

- [ ] **Step 4: Register the page in package and release smoke**

In `package.json`, add:

```json
"docs/release/four-llm-qualification-reauthorization-review.html",
```

immediately after the historical authorization page.

In `scripts/release-smoke.mjs`, add the same string to `reviewPackageSources` immediately after the historical authorization page. This makes the real pack smoke require the file, scan it for secrets/development paths, and validate its local-link closure.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx.cmd vitest run test/release/assurance.test.ts
npm.cmd run typecheck
npm.cmd run build
npm.cmd run smoke:release
```

Expected: all exit 0 and release smoke prints `release smoke passed`.

- [ ] **Step 6: Commit the package-closed review page**

Run:

```powershell
git add AGENTS.md package.json src/release/assurance.ts test/release/assurance.test.ts scripts/release-smoke.mjs docs/release/four-llm-qualification-reauthorization-review.html
git commit -m "docs: prepare qualification reauthorization review"
git status --short
```

Expected: commit succeeds and status is empty.

## Task 6: Review, verify, and freeze the candidate

**Files:**

- Modify only if review finds a real issue: files introduced or changed by Tasks 3–5

- [ ] **Step 1: Run Codex self-review**

Check:

- design/plan/runbook/review-page scope consistency;
- no claim that carrier rehearsal proves model qualification;
- no route/model/credential conclusions from the interrupted batch;
- no executable authorization in a document;
- no historical evidence mutation;
- exact package links;
- no active-config or install implication;
- no unexplained English machine field in the main Chinese review narrative.

Fix any confirmed issue within the existing scope.

- [ ] **Step 2: Run independent Codex specification and quality reviews**

Use `superpowers:requesting-code-review` with fresh read-only reviewers. One reviewer checks the approved design and authorization boundaries; the other checks execution commands, package closure, cleanup, and validation evidence. Limit each reviewer to the files changed by Tasks 3–5 and at most five actionable findings.

Codex must reproduce each finding and either:

- fix it inside the approved scope and rerun the affected checks; or
- reject it with direct file/control-flow/test evidence.

Both independent reviews must reach PASS before freezing.

- [ ] **Step 3: Attempt one narrow read-only Kimi K3 review**

Call `external_review` with:

```json
{
  "llm": "kimi-k3",
  "task": "review_doc",
  "cwd": "D:\\Codes\\codex-agent-tools\\.worktrees\\gemini-retirement",
  "includeGitDiff": false,
  "includeUntracked": false,
  "timeoutMs": 300000,
  "prompt": "只读审阅 docs/release/four-llm-qualification-execution-runbook.md。只检查一个问题：cell 丢失或 wait 失败后，是否存在再次调用资格入口、错误 recovery、同时存在两个 owner/协调器或重复消费授权的路径。最多五条 findings，每条给出具体段落和因果链；没有实质问题则明确 PASS。不要读取其它历史计划，不修改文件。",
  "acceptanceCriteria": [
    "同一未来批次只允许一个 exec cell 和一次标准入口",
    "cell 异常不会触发 retry、resume、fallback 或第二批",
    "owner 存活时绝不 recovery",
    "只有 owner 已死、目标进程为零且 terminal 缺失时才允许一次 same-batch interrupted recovery"
  ]
}
```

Codex must reproduce and technically evaluate every completed finding. Accept confirmed issues, reject unsupported claims with evidence, and rerun the affected checks. If the call times out, aborts, or returns only a trace without a conclusion, record it as `no conclusion`, do not repeat the same review, and rely on the required independent Codex reviews plus deterministic checks.

- [ ] **Step 4: Run the full deterministic and isolated suite**

Run:

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

Expected: every command exits 0; isolated report is current; no qualification entry carrying an authorization reference runs.

- [ ] **Step 5: Re-run immutable and process checks**

Repeat Task 2 Steps 1–3. Also run the exact 5/5 current-blocked and 14/14 historical SHA/blob blocks preserved in:

`docs/superpowers/plans/2026-07-27-ark-coding-qualification-prompt-disambiguation.md`

Expected:

```text
currentBlockedEvidence=5/5
historicalEvidence=14/14
```

All three immutable verifiers pass, targets are 0/0/0, and the qualification lock is absent.

- [ ] **Step 6: Visually inspect the new review page**

Use the Playwright skill and a temporary local HTTP server. Inspect:

- 1440 × 1000 desktop viewport;
- 390 × 844 narrow viewport;
- page title and top conclusion;
- decision section;
- console errors and warnings.

Expected: no clipping or horizontal overflow, links are legible, the blocked conclusion appears before detailed evidence, and console has 0 errors / 0 warnings. Stop the temporary server and close the browser session afterward.

- [ ] **Step 7: Commit review fixes, if any**

If review caused changes:

```powershell
git add AGENTS.md README.md package.json src/release/assurance.ts test/release/assurance.test.ts scripts/release-smoke.mjs docs/operations.md docs/release/checklist.md docs/smoke/ark.md docs/release/qualification-carrier-rehearsal.md docs/release/four-llm-qualification-execution-runbook.md docs/release/four-llm-qualification-reauthorization-review.html
git commit -m "fix: close qualification reauthorization review"
```

Use an explicit file list from `git status --short`; never stage unrelated files.

## Task 7: Final clean freeze and human handoff

**Files:**

- Modify: `AGENTS.md` only if final verification facts are not already current

- [ ] **Step 1: Record final facts without embedding a self-referential commit**

AGENTS must record:

- carrier rehearsal result and report path;
- execution runbook and design/plan paths;
- final test/pass/skip counts;
- typecheck/build/release/isolated status;
- immutable evidence, 5/5, 14/14, 0/0/0, and lock-absent status;
- status remains 6 passed / 2 pending and `blocked / not ready`;
- no real qualification call occurred;
- new explicit authorization is still required.

Do not embed the final commit SHA in a tracked file that would change that SHA.

- [ ] **Step 2: Commit final memory adjustment, if needed**

Run:

```powershell
git add AGENTS.md
git commit -m "docs: finalize qualification carrier candidate"
```

Skip this commit when AGENTS is already exact and no file changed.

- [ ] **Step 3: Run post-commit freeze checks**

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:release
npm.cmd run acceptance:plugin:isolated -- --check-report
git diff --check
git status --short
git rev-parse HEAD
```

Expected:

- all commands exit 0;
- status is empty;
- the final command prints one full 40-character frozen SHA.

Reconfirm target processes 0/0/0 and lock absent after all commands.

- [ ] **Step 4: Stop and present the one human decision**

Provide:

- exact frozen SHA;
- clickable link to `docs/release/four-llm-qualification-reauthorization-review.html`;
- carrier rehearsal evidence;
- fresh test/build/release/isolated/evidence/process results;
- confirmation that no real model batch, active config, install, old-tool removal, Claude Code, publish, push, merge, or formal-worktree fast-forward occurred.

Ask the user to either:

1. explicitly authorize one new complete `four-llm-v1` batch on that exact frozen SHA; or
2. keep the candidate blocked.

Do not create a goal for the real batch and do not generate an authorization reference until the user gives the explicit batch authorization.

The later real-batch goal must require an active goal before authorization consumption and an inner `shell_command.timeout_ms` of at least `14_400_000`; the 105-second rehearsal must not be described as proof of four-hour survival.

## Implementation-phase goal prompt

After user approval of this design, create a long-running goal with this exact objective:

> 在 `D:\Codes\codex-agent-tools\.worktrees\gemini-retirement` 中实施 `docs/superpowers/plans/2026-07-27-qualification-carrier-and-reauthorization.md`：只完成 Codex `exec/wait` 的 105 秒无网络承载演练、执行手册、新重新授权审阅页、npm package 闭包、只读审阅、完整确定性与隔离验收和 clean candidate 冻结；不得生成授权 UUID，不得运行任何真实 smoke 或资格入口，不得访问活动 config.toml、修改活动插件、移除 codex_cc_tools、调用或修改 Claude Code、发布、推送、合并或 fast-forward 正式工作树。形成精确 frozen SHA 和最小中文人工授权材料后停止。

The execution goal is complete when Task 7 stops at the human authorization gate. A later real qualification batch requires a separate user authorization and a separate goal.
