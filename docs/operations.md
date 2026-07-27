# 官方插件运维流程

本文只描述 `codex_external_agents` 的官方插件候选构建、隔离验收、逐动作授权安装与官方回滚。它不是当前真实安装授权；活动 Codex 尚未安装本插件，四模型八项能力当前为 6 passed / 2 pending。最新 `four-llm-v1` 批次在第 4 项 Kimi delegate 的严格命令证据验收处形成 `blocked / case_failed` 终态，未产生 8/8 资格，因此仍处于 `blocked / not ready`。

最新已执行真实批次的历史冻结 commit 为 `652e14ac637bfc04d90c448179ecc5838f2f8450`，preflight clean 且通过。标准入口只调用一次，并由一个 `functions.exec` cell 内的单个四小时预算前台 shell 承载约 979 秒到可信终态；没有发生 cell 丢失或 recovery。批次 `2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa` 的 ordinal 1 Ark Coding Plan delegate、ordinal 2 Ark Coding Plan review 与 ordinal 3 Kimi review 通过；ordinal 4 Kimi delegate 因 `requiredCommandObserved=false` 以 `acceptance_failed` 停止，ordinal 5–8 未运行。该 commit 只标识已消费的历史批次，不是当前离线实现最终冻结 SHA；新的冻结 SHA 只能在最终矩阵与 clean-tree 复核完成后记录。

manifest 为 schema v2、`blocked / case_failed`、4 completed / 4 notRun、9 checkpoints、`uncommittedEvidence=null`、`promotionEligible=false`，SHA-256 为 `d7be5e6ba3884075d80fe399dd3c2d72caaa1a3833f92e529928655e623b7b69`。immutable-evidence verifier、锁释放与目标进程 0/0/0 均已验证；证据由独立提交 `4f816f0` 保存。Kimi delegate 的模型、direct 路由、文件范围、结果内容、进程清理和 `1 / 0 / 0 / false / false` telemetry 全部通过，唯一失败检查是精确命令观测。证据不保存原始命令正文，因此不能进一步推断命令被省略还是合并，也不得放宽 validator。

同批前三项通过不能与历史证据拼接晋级。用户已经批准并完成 Kimi 命令观测的离线实现：资格提示词要求两个独立工具调用，ACP late fields 按 tool-call ID 归并，新 Kimi delegate producer 只输出来源/匹配枚举，optional verifier 在字段存在时严格校验；精确 `commandsRun.includes("git status --short")` 判定、公开结果、manifest/checkpoint schema 与既有 evidence 均未改变。本轮没有调用真实模型，因此最新批次仍为 `blocked / case_failed`，注册表仍为 6 passed / 2 pending。代码层独立规格与质量复审、最终离线矩阵和 clean candidate 冻结均已完成；当前授权已经消费，任何完整八项批次仍须取得另一份明确授权并从 ordinal 1 开始。[本轮重新授权材料](release/four-llm-qualification-reauthorization-review.html)、[更早授权材料](release/four-llm-qualification-authorization-review.html)与[阻断结果审阅](release/four-llm-qualification-result-review.html)都只作历史审计，不能解释为新的批次或安装许可。

2026-07-27 的 105 秒演练只构成离线基础设施证据；本轮约 979 秒真实批次进一步证明同一 cell 可以承载到协调器正常终态，但两者都不证明四小时存活或任何未执行模型资格。未来另获授权后的唯一承载和 fail-closed 边界见[执行承载手册](release/four-llm-qualification-execution-runbook.md)，演练原始结论见[承载演练报告](release/qualification-carrier-rehearsal.md)。两份承载文档现已纳入 npm package；release smoke 以实际 pack 文件面为准扫描全部 15 份 Markdown/HTML。当前 dry-run 为 145 files，插件面仍精确为 4 files，不保留 `.tgz`。这只闭合 package/release assurance，不构成资格、安装或发布。

项目代码和维护者都不得直接读取、写入、备份、恢复或手工编辑活动 `~/.codex/config.toml`。Codex 官方插件命令可能由官方机制更新该状态文件，因此真实 add/remove 每次都必须先准备权限包并取得针对该次动作的明确许可。

## 1. 安装依赖

在仓库根目录执行：

```powershell
npm ci
```

要求 Node.js 20+。真实 Kimi 调用还要求本机 Kimi Code 已安装并完成其原生 OAuth 登录；本项目不复制 OAuth 数据。

## 2. 构建候选产物

```powershell
npm run build
```

构建会同时生成库产物与 `plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs` 自包含 bundle。不要手工编辑 bundle。

## 3. 运行隔离官方生命周期验收

```powershell
npm run acceptance:plugin:isolated
```

脚本只在自动创建的临时 `CODEX_HOME` 中调用官方 marketplace/plugin add、list 与 remove，并从官方缓存副本启动 MCP。它不得使用活动 Codex home，也不构成真实 Codex App 宿主门禁。

## 4. 查看隔离证据

检查 [官方插件隔离状态报告](release/plugin-isolated-state.md)，确认：

- 临时 `CODEX_HOME` 隔离边界成立；
- 官方安装器接受插件 manifest、直接 server-map `.mcp.json` 与自包含 bundle；
- 缓存副本只公开 `external_review` 与 `external_delegate`，且 `llm` 必填；
- 隔离验收先证明已退役的 Gemini 被已安装 MCP 以 unknown logical LLM 明确拒绝，错误列出精确四项活动 LLM，且没有启动 Pi 或返回伪造的结构化成功结果；
- 再用 qualified 的 `ark-agent-deepseek-v4-flash` 与 fake Pi 证明恰好一次调用、固定模型、direct 路由、父进程代理清除、只注入目标 Agent 凭据和进程清理门禁通过；
- 官方 remove 后列表语义回滚，残留状态可解释；
- 报告结论没有被扩张成真实 Codex App 已通过。

任一项失败即停止，不准备真实安装。

## 5. 准备真实安装权限包

只有四个活动逻辑 LLM 的 review/delegate 在同一个 `four-llm-v1` 批次中 8/8 passed，才能准备可供授权的 ready 权限包。当前过渡注册表为 6 passed / 2 pending，只有 Ark Coding Plan 的 review/delegate pending；历史五模型结果、旧 blocked/interrupted 批次和本轮只完成四项的 blocked 批次都不能参与当前晋级。本轮前三项通过也不能与历史证据拼接。最新批次的授权已消费，且没有 retry、fallback、resume 或第二批；未来重入必须取得新的明确授权，并从首项重新运行全新的完整八项。因此本阶段只保持 `blocked / not ready` 状态包，不提出真实安装授权问题；已消费的资格授权材料不能作为未来批次或越过安装门禁的依据。

权限包必须列出：

- 为什么只有真实官方安装才能验证 Codex App 宿主；
- 当前尚未执行真实安装；
- 隔离取证支持的预计新增、修改和删除范围；
- 官方安装后的验证步骤；
- 官方 remove 回滚步骤；
- 失败时不手工恢复或编辑活动 `config.toml`；
- 旧 `codex_cc_tools` 保持原状，本轮不移除；
- 本轮不执行 npm 或公共 marketplace 发布。

权限包必须先交给用户审阅。过去关于采用官方插件机制的同意不能推定为本次 add/remove 的许可。

## 6. 仅在明确许可后执行真实安装

只有收到针对本次真实安装的明确许可后，才可在本仓库根目录逐条执行：

```powershell
$repoRoot = (Resolve-Path "." -ErrorAction Stop).Path
codex plugin marketplace add $repoRoot
if ($LASTEXITCODE -ne 0) { throw "Codex marketplace add 失败，停止安装。" }
codex plugin add codex-external-agents@codex-external-agents-local
if ($LASTEXITCODE -ne 0) { throw "Codex plugin add 失败，停止安装。" }
```

执行后必须使用官方列表和真实 Codex App 完成工具发现、代表性调用、取消与进程清理门禁。不得直接打开、比较或修改活动 `config.toml`。命令结果若与权限包或隔离证据不一致，立即停止，不追加自定义配置修复。

## 7. 失败时使用官方回滚

本次权限包必须明确包含失败回滚授权。宿主门禁失败时只执行：

```powershell
codex plugin remove codex-external-agents@codex-external-agents-local
if ($LASTEXITCODE -ne 0) { throw "Codex plugin remove 失败，停止回滚。" }
codex plugin marketplace remove codex-external-agents-local
if ($LASTEXITCODE -ne 0) { throw "Codex marketplace remove 失败，停止回滚。" }
```

随后使用官方列表确认目标插件与 marketplace 已移除。若官方回滚也异常，停止并报告；不得手工恢复、重写或修补活动 `config.toml`。

## 8. 长期维护边界

- 每次真实安装、升级或独立卸载都是新的外部状态变更，必须重新逐动作授权。
- 永远不以手工编辑活动 `config.toml` 代替官方插件机制。
- 本轮不移除旧 `codex_cc_tools`，不调用或修改 Claude Code，不执行 `npm publish`。
- 只有确定性检查、隔离生命周期、`four-llm-v1` 四模型八门禁和真实 Codex App 宿主门禁全部通过后，才可说新插件具备替代旧工具的条件。
