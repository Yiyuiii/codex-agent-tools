# Authorized Four-LLM Qualification and Convergence Implementation Plan

> **For agentic workers:** This plan is the durable execution source for the single authorized `four-llm-v1` batch and the result-dependent offline convergence. Re-read it after every context compaction. Never persist the raw authorization reference.

**Goal:** 在精确冻结候选上只运行一次新的四模型八项真实资格批次；若未 8/8 通过，冻结失败事实并停止；若同批 8/8 通过，则完成 Ark Coding Plan 成对晋级、文档与 `ready` 状态收敛，并停在正式仓库切换或活动安装之前。

**Architecture:** 真实资格由现有串行协调器负责，固定执行八个 `LLM × task` 案例并发布不可覆盖的 case evidence schema v3、checkpoint schema v2 与终态 manifest schema v2。协调器不改源码；8/8 后由 Codex 先用 frozen-candidate verifier 锁定冻结候选与证据，再单独提交 evidence，随后以 TDD 更新注册表并用 immutable-evidence verifier 复验。失败分支只保存事实和审阅材料，不修改资格协议或重试。

**Tech stack:** TypeScript、Node.js、Vitest、PowerShell、Git、Pi RPC、Kimi Code ACP、Codex 官方插件隔离生命周期测试。

---

## 1. 授权、冻结点与硬边界

### 1.1 当前唯一授权

- 仓库/工作树：`D:\Codes\codex-agent-tools\.worktrees\gemini-retirement`
- 分支：`codex/gemini-retirement`
- 精确冻结提交：`287b9a8bfa14805f84707adff6c7f2af19065475`
- 资格计划：`four-llm-v1`
- 授权范围：一次新的完整八项真实资格批次，以及该批结果允许的离线收敛。
- 授权引用：运行时在内存中生成一个新 UUID，仅传给标准入口；不得写入本计划、仓库文档、聊天、日志或其它持久文件。
- 上一条只约束一次性授权 UUID。协调器另行生成的 batch UUID 与 lock nonce 是协议身份；batch UUID 必然进入 batchId、stdout 摘要、evidence 路径、checkpoint 和 manifest，必须按现有协议持久化。不得把 batch UUID 误当授权 UUID 删除或脱敏。
- 标准入口通过 argv 接收授权引用，因此展开后的授权 UUID 会短暂存在于 `npm`/`tsx` 子进程命令行；批准材料禁止的是文档、聊天和日志持久化，并未要求对同机 OS 进程观察者隐藏。运行期间禁止记录完整命令行，不开启 transcript 或 shell trace。

### 1.2 固定串行顺序

1. `ark-coding-plan` / `delegate`
2. `ark-coding-plan` / `review`
3. `kimi-k3` / `review`
4. `kimi-k3` / `delegate`
5. `ark-agent-plan` / `review`
6. `ark-agent-plan` / `delegate`
7. `ark-agent-deepseek-v4-flash` / `review`
8. `ark-agent-deepseek-v4-flash` / `delegate`

### 1.3 禁止事项

- 不 retry、fallback、resume、跳项、复用旧 evidence 或启动第二批。
- 不因为 preflight 失败、generic failure、blocked 或 interrupted 而重新运行标准入口。
- 不修改 provider/model/route/credential、validator、schema、protocol 或重试策略。
- 不访问、读取、比较、备份、修改或恢复活动 `~/.codex/config.toml`。
- 不执行活动 marketplace/plugin add/remove，不移除 `codex_cc_tools`。
- 不调用或修改 Claude Code，不调用 `cc_review` / `cc_delegate`，不额外调用外部 LLM。
- 不执行 npm/marketplace 发布。
- 不 fast-forward 正式仓库或切换正式安装来源。
- 不在真实批次运行期间检查或输出目标进程的完整命令行，避免把授权引用从子进程 argv 泄露到日志。

### 1.4 计划文件的临时位置

冻结候选在运行前必须保持精确 clean，所以本计划暂存于仓库外：

`C:\Users\Administrator\.codex\agent-memory\codex-agent-tools-authorized-four-llm-execution-2026-07-27.md`

批次发布终态后，把计划内容迁入仓库的 `docs/superpowers/plans/2026-07-27-authorized-four-llm-qualification-and-convergence.md`，在 `AGENTS.md` 索引，并删除本临时文件。迁移不得发生在 frozen-candidate verifier 之前。

---

## 2. Task 1：运行前冻结审计

**读取范围**

- `AGENTS.md`
- `docs/release/four-llm-qualification-authorization-review.html`
- `docs/superpowers/specs/2026-07-27-ark-coding-qualification-prompt-disambiguation-design.md`
- `docs/superpowers/plans/2026-07-27-ark-coding-qualification-prompt-disambiguation.md`
- `scripts/gate-requalification.ts`
- `src/qualification/coordinator.ts`
- `src/qualification/preflight.ts`
- `src/qualification/protocol.ts`
- `src/qualification/verifier.ts`

**必须确认**

- `git rev-parse HEAD` 精确等于冻结提交。
- `git status --porcelain=v1 --untracked-files=all` 为空。
- 记录运行前 `docs/smoke/evidence/batches/` 的目录集合。
- Kimi ACP、Pi RPC、real-smoke 目标进程均为 0。
- 使用 Task 3 的脱敏 owner probe 确认预运行 qualification lock 不存在（exit 3）。若存在任何旧/stale owner，不启动标准入口；只按旧 batch 身份诊断并停止，不擅自恢复或让新授权与旧锁混合。
- 标准入口只接受维护者提供的 `--authorization-ref`，并使用固定八项 schedule。
- 终态只可能为 `passed`、`blocked` 或崩溃后显式恢复发布的 `interrupted`。
- 授权哈希唯一性检查覆盖旧 batch、当前 lock 和 terminal/checkpoint。

**目标进程命令**

```powershell
npx tsx -e "import('./src/runtime/agent-processes.ts').then(async ({ classifyAgentProcesses }) => { const counts = await classifyAgentProcesses(); console.log(JSON.stringify(counts)); if (counts.kimi.count !== 0 || counts.piRpc.count !== 0 || counts.realSmoke.count !== 0) process.exitCode = 1; })"
```

任一冻结条件不成立：不运行真实批次，保留授权未使用事实，先诊断；若需要改行为或重新冻结，必须停下并取得新的用户决定。

---

## 3. Task 2：只启动一次标准资格入口

### 3.1 唯一允许的启动形态

在一个 PowerShell 进程内生成授权引用，不打印、不持久化：

```powershell
$authorizationReference = [guid]::NewGuid().ToString('D').ToLowerInvariant()
try {
  & npm.cmd run --silent qualify:gates -- --authorization-ref $authorizationReference
  $code = $LASTEXITCODE
} finally {
  Remove-Variable authorizationReference -ErrorAction SilentlyContinue
}
exit $code
```

执行要求：

- 命令文本本身不得包含实际 UUID。
- 使用 `npm run --silent`，防止 npm banner 回显调用参数。
- 只调用一次。
- 运行期间只轮询该原始进程输出/退出状态，不启动其它模型任务。
- 每次阶段更新只报告 case、状态和非秘密事实，不输出 argv 或授权引用。

### 3.2 退出语义

- stdout 出现终态 JSON 且 `status: "passed"`、退出码 0：进入成功验证分支。
- stdout 出现终态 JSON 且 `status: "blocked"`、退出码 1：进入失败验证分支。`completedCases: 8` 也不能替代 `status` 与 `promotionEligible` 判断。
- 只出现 `Gate requalification failed` 或其它 generic failure：绝不重跑。进入 Task 3 的唯一批次发现/崩溃恢复审计。

---

## 4. Task 3：终态发现与崩溃恢复

### 4.1 唯一批次发现

比较运行前后 `docs/smoke/evidence/batches/` 目录集合，并独立探测系统临时目录中的 qualification lock owner：

- 恰好一个新目录：它是本轮唯一候选 batch。
- 多个新目录：违反单批不变量，停止，不选择、不修补、不运行恢复。
- 零个新目录不能单独证明“preflight 早期失败”；仍须确认没有 stale lock。preflight 后锁释放失败可能在 `batch_started` 前留下 owner，显式 recovery 会为该 batch 发布 `interrupted` 并消费授权。

锁探测必须只返回 owner 的 batchId，不打印授权哈希、nonce、PID 命令行或其它字段：

```powershell
$ownerJson = & npx.cmd tsx -e "import('./src/qualification/lock.ts').then(async (m) => { const fs = await import('node:fs/promises'); const location = await m.qualificationLockLocation(process.cwd()); try { await fs.lstat(location.lockDirectory); } catch (error) { if (error?.code === 'ENOENT') { process.exitCode = 3; return; } throw error; } const owner = await m.readQualificationLockOwner(location.lockDirectory); process.stdout.write(JSON.stringify({ batchId: owner.batchId })); }).catch(() => { process.exitCode = 4; })"
$ownerProbeExitCode = $LASTEXITCODE
```

- exit 3：锁不存在。
- exit 0：锁存在；解析 owner batchId，并要求它与目录差集发现的 batchId（如有）一致。
- exit 4：锁存在但无法安全读取，或发生其它异常；立即停止人工排查。

终态发现固定为四类：

1. 恰好一个新目录且有 valid manifest：正常终态；若同时遗留匹配该 terminal 的 stale owner，按 4.3 做 release-only recovery。
2. 无新目录、无 checkpoint/manifest、无锁：preflight/lock 前置失败；未证明耐久消费，但本轮命令已经用完，不重跑。
3. 锁存在：只有身份唯一且原进程/目标进程均结束后，才对同一 batch 做 terminal-only stale recovery。
4. 新路径无 terminal 且锁不存在，或目录/锁身份不一致：协议异常，fail closed，不制造证据、不重跑。

### 4.2 正常终态

新目录存在 `manifest.json` 时：

- 解析 schema、planId、status、cases、notRun、checkpoints、promotionEligible。
- 不更改任何 batch JSON。
- 确认原始协调器进程已结束，目标进程回到 0/0/0。
- 若 qualification lock 不存在，直接进入证据验证。
- 若 qualification lock 仍存在且 owner batchId 与 terminal 完全匹配，只允许按 4.3 做 release-only recovery；若 owner/terminal 身份不匹配，fail closed。

### 4.3 Stale owner 的 terminal-only / release-only recovery

只有同时满足下列条件时，才允许使用：

```powershell
npm.cmd run --silent qualify:gates -- --recover-interrupted <batchId>
```

条件：

- batchId 已由 lock owner 唯一确定；如有新 batch 目录，二者身份完全一致；
- 原始协调器进程已经结束；
- Kimi ACP、Pi RPC、real-smoke 目标进程均为 0；
- 若没有终态 manifest：恢复操作只把现有 running 身份发布为 `interrupted`。
- 若已有 valid terminal：terminal 必须与 owner 身份匹配，恢复操作只释放 stale owner，不发布第二终态。
- 两种恢复都不得 resume、运行模型或重试；恢复后必须重新读取磁盘 manifest，并确认 lock 已消失。

若 batchId 无法唯一确定、terminal invalid、owner/terminal 身份不一致或恢复命令失败：停止，保留现场，不再次调用标准入口。

---

## 5. Task 4：验证并冻结新证据

### 5.1 通用检查

- 新 batch 计划必须是 `four-llm-v1`。
- commit/build identity 必须绑定冻结提交及其构建。
- 文件路径必须全部位于唯一 batch 目录。
- 证据、checkpoint、manifest 必须为不可覆盖发布且通过身份验证。
- 不得出现明文授权 UUID、token、credential value、代理凭据或原始模型正文泄露。
- 目标进程必须为 0/0/0。
- 正常 terminal 或 recovery 后 qualification lock 必须消失；仍有锁时停止。
- `git rev-parse HEAD` 仍须等于冻结提交；tracked worktree 必须无漂移，允许的 untracked 变化只能是唯一新 batch 目录。

### 5.2 8/8 成功的严格形状

- `schemaVersion: 2`
- `status: "passed"`
- `promotionEligible: true`
- `stopReason: null`
- `uncommittedEvidence: null`
- 8 cases、0 notRun、17 checkpoints
- `cases/` 恰好 8 个文件，`checkpoints/` 恰好 17 个文件
- 八项顺序与固定 schedule 完全相同
- 每项 `passed: true`，所有任务验收为 true
- telemetry 均为 `1 / 0 / 0 / false / false`
- model/provider/direct route/credential target/Pi config 与 frozen preflight 一致
- delegate 规范化结果恰好一行且内容哈希匹配

在任何提交或源码修改前依次运行：

```powershell
npm run --silent verify:qualification -- --mode immutable-evidence --manifest <manifest>
npm run --silent verify:qualification -- --mode frozen-candidate --manifest <manifest>
```

任一不通过：不得晋级，按技术阻断处理。

### 5.3 blocked/interrupted 终态

- 运行 immutable-evidence verifier。
- 核对 stopReason、最后 case 或 uncommittedEvidence、notRun、checkpoint 链、telemetry 与进程 0/0/0。
- verifier 不通过时停止，不修改或“修补” evidence。

### 5.4 证据独立提交

只有验证通过且恰好一个新 batch 目录时：

```powershell
git add -- docs/smoke/evidence/batches/<batchId>
git diff --cached --check
git diff --cached --name-status
git commit -m "test: record four-llm qualification evidence"
```

该提交只包含新 batch 目录。不得混入源码、测试、计划或状态文档。

---

## 6. Task 5A：未通过分支

适用于：

- preflight 在 durable `batch_started` 前失败；
- `blocked`；
- `interrupted`；
- passed manifest 但 frozen-candidate verifier 失败；
- evidence/identity/verifier 存在任何歧义。

### 6.1 行为边界

- 不改 `src/`、`test/`、资格协议、prompt、validator、route 或 registry。
- registry 保持 6 passed / 2 pending。
- 安装状态保持 `blocked / not ready`。
- 不启动第二批。

### 6.2 有终态 evidence 时的状态文档

按实际触达的模型更新：

- `AGENTS.md`
- `README.md`
- `docs/operations.md`
- `docs/smoke/ark.md`
- 必要时 `docs/smoke/kimi.md`
- `docs/release/checklist.md`
- `docs/release/real-plugin-install-review.md`
- `docs/release/four-llm-qualification-authorization-review.html`
- 新增单文件中文 HTML 人工审阅稿 `docs/release/four-llm-qualification-result-review.html`
- 把本计划迁入 `docs/superpowers/plans/2026-07-27-authorized-four-llm-qualification-and-convergence.md` 并由 `AGENTS.md` 索引

审阅稿必须给出：发生了什么、为什么重要、冻结 commit/build、batchId、manifest SHA、notRun、0/0/0、verifier 结果、无 retry/fallback/resume/第二批，以及未来动作需要的最小新判断。若存在失败 case 或 uncommitted evidence，必须给出其 SHA、ordinal/LLM/task/reason 与 telemetry；若 pre-`batch_started` stale-owner recovery 没有任何 case/uncommitted evidence，则明确写“无 case evidence”，并给出 interrupted stage 与 checkpoint 状态，不得虚构缺失字段。

状态文档单独提交：

```powershell
git commit -m "docs: record blocked four-llm qualification"
```

### 6.3 preflight 早期失败

若没有新 batch 目录、没有任何 checkpoint/manifest 且 qualification lock 也不存在：

- 不提交 evidence；
- 不创建虚假 terminal；
- 不改 registry；
- 只在仓库外计划/goal 状态和最终中文汇报中记录非秘密失败 stage；
- 本轮停止，不重跑。

若没有新 batch 目录但存在 stale owner，不走本小节，必须按 Task 3 对同一 batch 做 terminal-only recovery；恢复出的 `interrupted` 终态视为授权已耐久消费。

---

## 7. Task 5B：8/8 通过后的离线晋级

### 7.1 TDD：先写失败测试

修改：

- `test/llms/registry.test.ts`
- `test/cli/doctor.test.ts`

预期：

- `ark-coding-plan` 的 review/delegate 都为 passed；
- 两个任务引用稳定 `docs/smoke/ark.md#ark-coding-plan-review` / `#ark-coding-plan-delegate` anchors；
- 两个任务都可 resolve；
- doctor 对两项报告 `ok/passed`；
- 需要 pending profile 的通用测试改用测试内合成 profile。

运行并记录 RED：

```powershell
npm test -- --run test/llms/registry.test.ts test/cli/doctor.test.ts
```

### 7.2 最小实现

修改：

- `src/llms/registry.ts`

把 `ark-coding-plan` 从 `pendingTasks()` 改为：

```ts
...qualifiedTasks("docs/smoke/ark.md", "ark-coding-plan")
```

若 `pendingTasks()` 无调用者则删除。不得修改 `src/qualification/**`、协调器、verifier、smoke validator 或 doctor 行为代码。

运行同一测试并记录 GREEN。

### 7.3 文档与 ready 状态

更新：

- `docs/smoke/ark.md`
- `docs/smoke/kimi.md`
- `README.md`
- `AGENTS.md`
- `docs/operations.md`
- `docs/migration-from-codex-cc-tools.md`
- `docs/release/checklist.md`
- `docs/release/real-plugin-install-review.md`
- `docs/release/four-llm-qualification-authorization-review.html`
- 新增单文件中文 ready 审阅稿 `docs/release/four-llm-qualification-result-review.html`
- `docs/superpowers/specs/2026-07-27-ark-coding-qualification-prompt-disambiguation-design.md`
- `docs/superpowers/plans/2026-07-27-ark-coding-qualification-prompt-disambiguation.md`
- 把本计划迁入 `docs/superpowers/plans/2026-07-27-authorized-four-llm-qualification-and-convergence.md` 并由 `AGENTS.md` 索引

`ready` 的含义必须限定为“资格层已通过，可以准备下一次活动安装授权审阅”，不得写成已安装、已替换或已获得安装授权。

ready 状态包至少记录：

- batchId、planId、冻结 commit/build、manifest SHA；
- manifest/checkpoint schema v2、case evidence schema v3、8 cases、17 checkpoints、8/8、`promotionEligible=true`；
- 八份 evidence 的路径/SHA/固定 model/provider/direct route；
- 八项 telemetry 与所有验收结果；
- 批次前后进程 0/0/0、无 retry/fallback/resume/第二批；
- frozen-candidate verifier 在 evidence commit 前通过；
- 晋级后 immutable-evidence verifier 通过；
- registry/doctor 8 passed / 0 pending；
- 最新实际测试、typecheck、build、release、隔离 lifecycle 结果；
- 历史 Gemini、旧五模型 batch、旧 Kimi/Ark evidence 未改写且可验真；
- 正式仓库未 fast-forward，活动插件未安装，旧工具未移除，发布未执行。

### 7.4 晋级提交白名单

只允许上述 registry、两份测试和文档/计划文件。先检查意外路径，再提交：

```powershell
git diff --check
git diff --name-only
git add -- <reviewed-allowlist>
git diff --cached --check
git diff --cached --name-status
git commit -m "feat: promote four-llm qualification"
```

---

## 8. Task 6：独立复核与完整验收

### 8.1 复核

在不调用外部模型、不写入共享文件的条件下，使用内部只读 Codex 子代理：

1. 规格复核：授权边界、状态机、8/8 晋级条件、文档事实是否一致。
2. 代码质量复核：TDD、registry/doctor、证据索引、打包/隔离、秘密与历史证据完整性。

Codex 必须逐条复核反馈，接受有证据的问题，反驳不成立项；若修复行为，补测试并重跑。

### 8.2 全量验证

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated -- --check-report
npm run qualify:gates -- --help
npm run verify:qualification -- --help
npm run --silent verify:qualification -- --mode immutable-evidence --manifest <new-manifest>
npm run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json
npm run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json
npx tsx -e "import('./src/runtime/agent-processes.ts').then(async ({ classifyAgentProcesses }) => { const counts = await classifyAgentProcesses(); console.log(JSON.stringify(counts)); if (counts.kimi.count !== 0 || counts.piRpc.count !== 0 || counts.realSmoke.count !== 0) process.exitCode = 1; })"
git diff --check
git status --short
```

另外复用既有计划中的精确哈希块，复验：

- 当前旧 blocked batch 5/5；
- 历史 Gemini 14/14；
- 历史 immutable verifier；
- 隔离报告 `--check-report` 字节不漂移。

不得沿用旧的测试计数；只写入本轮 fresh verification 的实际结果。

### 8.3 最终冻结

- 所有提交后重新运行 immutable verifier、完整确定性套件、目标进程 0/0/0。
- `git status --short` 必须为空。
- 记录最终 HEAD 与提交边界。
- 更新 goal 为 complete 仅当所有授权内工作完成且没有遗漏。

---

## 9. 必须停止并交给人工的新边界

无论资格成功与否，下列动作都不属于本目标：

- 再运行任何真实资格批次；
- 正式仓库 pure fast-forward；
- 活动 marketplace/plugin 安装、升级、卸载或切换；
- 读取或修改活动 `config.toml`；
- 移除旧 `codex_cc_tools`；
- 修改或卸载 Claude Code；
- npm 或公共 marketplace 发布；
- 改 provider/model/route/credential、放宽 validator、加入 retry/fallback 或更改协议。

8/8 成功后的预期人工节点是：审阅 ready 状态包，并分别决定正式仓库 fast-forward 与活动官方插件安装。失败后的预期人工节点是：阅读最小中文失败审阅稿，决定是停止、修改设计，还是给未来新批次一份新的明确授权。
