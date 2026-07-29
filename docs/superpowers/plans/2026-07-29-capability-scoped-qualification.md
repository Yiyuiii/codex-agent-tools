# 能力级资格复用与 Ark Coding Plan 晋级实施计划

> 执行位置：`codex/gemini-retirement` 分支的隔离 worktree
>
> 分支：`codex/gemini-retirement`
>
> 设计依据：`docs/superpowers/specs/2026-07-29-capability-scoped-qualification-design.md`

**目标：** 用机器可验证的能力资格索引复用既有真实 passed evidence，使 Ark Coding Plan 的 `review` / `delegate` 正式启用，并用相关运行输入指纹替代无条件四模型同批重跑。

**明确不做：** 不调用任何真实模型，不调试 Ark Agent Plan，不触碰活动 `~/.codex/config.toml`、活动插件、Claude Code 或活动 `codex_cc_tools`，不发布、不推送、不合并、不 fast-forward。

## Task 1：锁定能力索引与指纹合同

**Files**

- Create: `src/qualification/capability-index.ts`
- Create: `test/qualification/capability-index.test.ts`

**TDD**

1. 先写失败测试，固定：
   - 索引 schema 与八个唯一、排序的 `llm × task` 条目；
   - 路径必须是仓库内规范相对路径，禁止绝对路径、遍历、符号链接和超大文件；
   - 指纹输入由代码端定义，索引不能自行缩小输入范围；
   - 指纹包含规范化 LLM 运行身份、任务身份、相关源文件路径与内容；
   - `pi-rpc` 与 `kimi-acp` 使用不同目录集合；
   - registry gate 元数据、派生 bundle、文档与 evidence 不进入运行输入指纹；
   - 文件内容或规范化 profile 身份变化使指纹变化，无关文档变化不影响。
2. 运行红灯：

   ```powershell
   npx vitest run test/qualification/capability-index.test.ts
   ```

3. 实现最小安全读取、确定性目录展开、SHA-256 与 profile 身份规范化。
4. 运行同一测试至绿。

## Task 2：验证 batch case 与受限 legacy evidence

**Files**

- Modify: `src/qualification/capability-index.ts`
- Modify: `test/qualification/capability-index.test.ts`

**TDD**

1. 添加 batch 来源失败测试：
   - 先调用既有 `immutable-evidence` verifier；
   - manifest/evidence 哈希必须精确；
   - case 必须是相同 `llm × task` 且 `result=passed`；
   - failed/notRun、身份错配、路径逃逸、哈希漂移全部 fail closed；
   - batch 整体可以 blocked，但不能伪称 batch passed。
2. 添加 legacy 来源失败测试：
   - 只允许精确的
     `ark-agent-deepseek-v4-flash/delegate`；
   - evidence 路径、SHA、schema v1、模型、provider、direct route、凭据目标、passed 状态和全部历史 checks 必须精确；
   - 不允许其它 LLM、review 或新增 legacy 条目。
3. 实现最小 union 验证逻辑并运行测试至绿。

## Task 3：建立八项资格索引并绑定注册表

**Files**

- Create: `docs/smoke/evidence/capabilities.json`
- Modify: `src/domain/types.ts`
- Modify: `src/llms/registry.ts`
- Modify: `test/llms/registry.test.ts`
- Modify: `test/qualification/capability-index.test.ts`

**TDD**

1. 先更新 registry 测试，要求：
   - Ark Coding Plan review/delegate 均为 passed；
   - 八个 passed gate 都精确引用
     `docs/smoke/evidence/capabilities.json#<llm>-<task>`；
   - `resolveLlm("ark-coding-plan", task)` 可用；
   - pending gate 的通用拒绝合同仍保留。
2. 先运行红灯。
3. 生成索引：
   - Coding Plan 两项使用最新 `2026-07-28T14-33...` batch case；
   - Kimi 两项使用同一最新 batch case；
   - Agent Plan review 使用最新 batch case，delegate 使用最近的 passed batch case；
   - Agent DeepSeek review 使用最近的 passed batch case；
   - Agent DeepSeek delegate 使用唯一受限 legacy standalone evidence；
   - 每项记录当前相关运行输入指纹。
4. 将 `QualityGate` 的 passed evidence 统一绑定索引 anchor，并保持深冻结与防御复制。
5. 运行 registry 与 capability-index 测试至绿。

## Task 4：增加只读 CLI 与 release smoke 门禁

**Files**

- Create: `scripts/verify-capabilities.ts`
- Create: `test/qualification/capability-verifier-cli.test.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`
- Modify: `scripts/release-smoke.mjs`
- Modify: `test/smoke/script-entrypoints.test.ts`

**TDD**

1. 先写失败测试，固定 CLI：

   ```text
   npm run verify:capabilities
   npm run verify:capabilities -- --help
   ```

   该入口只读、固定读取仓库内索引，不接受任意路径或真实模型参数；成功只输出脱敏汇总，失败使用固定错误。
2. 让 build 输出 capability verifier 依赖入口。
3. 在 release smoke 的联网 npm 名称检查之前运行能力索引验证，并要求打包文件面包含索引及其引用的 evidence/manifest。
4. 运行目标测试、build 和 release smoke。

## Task 5：迁移有效政策与产品状态

**Files**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/release/four-llm-qualification-execution-runbook.md`
- Modify: `docs/release/four-llm-qualification-next-authorization-review.html`
- Modify: `docs/release/four-llm-qualification-result-review.html`
- Modify: `docs/release/real-plugin-install-review.md`
- Modify: `docs/smoke/ark.md`
- Modify: `docs/smoke/kimi.md`
- Modify: `docs/superpowers/specs/2026-07-28-standing-experiment-authorization-design.md`
- Modify: `docs/superpowers/plans/2026-07-28-standing-authorization-and-autonomous-qualification.md`
- Modify: `package.json`

**要求**

- 当前状态改为八项能力 gate 全部 passed；
- 最新 batch 继续写成 blocked，不改历史事实；
- 删除有效政策中的“必须同批 8/8 才能候选”，历史叙述保留并标明当时政策；
- Ark Agent Plan 额度耗尽写成瞬时运行可用性，不再是 Coding Plan 或离线候选阻碍；
- `four-llm-v1` 改为历史审计/可选广域回归工具，不自动运行；
- 候选门禁明确为能力索引有效加确定性发布矩阵；
- 将新设计、计划和能力索引纳入 npm package 与本地链接闭包。

## Task 6：独立审阅与完整确定性验证

**先运行聚焦验证**

```powershell
npx vitest run test/qualification/capability-index.test.ts test/qualification/capability-verifier-cli.test.ts test/llms/registry.test.ts test/smoke/script-entrypoints.test.ts
npm run typecheck
npm run build
npm run verify:capabilities
npm run verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c/manifest.json
npm run smoke:release
```

**然后外部审阅**

- 用 Ark Coding Plan `cc_review` 做规格符合性审阅；
- 用 Kimi 或可用独立来源做代码质量/安全审阅；
- Codex 逐条复核，不直接照单全收；
- 修复必须先补或保持失败测试。

**最后完整验证**

```powershell
npm test
npm run typecheck
npm run build
npm run verify:capabilities
npm run smoke:release
```

再运行：

- 隔离 `CODEX_HOME` 官方插件 `--check-report`；
- retained manifests 全量 immutable verification；
- 能力索引引用的所有 SHA 复核；
- npm pack dry-run、文档链接与精确插件工件检查；
- Kimi ACP / Pi RPC / real-smoke 目标进程快照；
- 资格锁不存在；
- `git diff --check` 与 clean-tree 检查。

整个计划禁止真实模型 smoke；外部代码审阅只允许使用现有开发审阅工具，不通过产品资格入口调用 Agent Plan。

## 完成条件

- Ark Coding Plan 两项可由公开 MCP 正常解析；
- 八项公开 gate 均有机器可验证索引；
- 相关运行输入漂移会 fail closed；
- 无关文档变化不会触发重跑；
- 最新 blocked batch 保持不可变且不再连带阻断 passed case；
- 完整确定性矩阵与独立审阅通过；
- 活动配置、活动插件、Claude Code、旧工具、发布与远端 Git 状态均未改变。

## 中断恢复状态（2026-07-29）

已恢复并重新验证：

- 行为实现已由 `79e70c8`、`78a276f`、`d9d0179`、`27b3b85` 分四步提交；
- 51 个测试文件独占运行通过，871 passed / 1 个平台条件 skipped；
- 类型检查、build、8/8 能力索引、release smoke 与 `git diff --check` 通过；
- 7 份 retained manifest 全部通过 `immutable-evidence` verifier，历史 blocked/interrupted 状态未改写；
- 隔离官方插件 `--check-report` 通过；
- Kimi ACP / Pi RPC / real-smoke 目标进程为 0/0/0，资格锁不存在，没有持久 `.tgz`；
- 没有调用产品真实模型，没有读取或修改活动配置，也没有安装、发布、推送、合并或 fast-forward。

恢复时第一次把全量测试与能力 verifier、类型检查并行，导致一个 manifest 文件系统用例命中 30 秒超时；该用例单独复跑耗时 1.73 秒且通过，全量测试独占复跑全绿。该结果按资源竞争处理，没有修改生产代码或放宽测试超时。

尚未闭合：设计阶段外审已有记录，但能力级实现完成后的独立规格/质量复审没有可核验证据。本轮恢复遵守“不调用任何真实模型”，因此不补跑外部模型审阅。完成该复审并重新执行受影响的确定性门禁后，才能把 Task 6 和本计划标为全部完成。
