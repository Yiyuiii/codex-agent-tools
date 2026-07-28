# 官方插件运维流程

本文只描述 `codex_external_agents` 的官方插件候选构建、隔离验收、逐动作授权安装与官方回滚。它不是当前真实安装授权；活动 Codex 尚未安装本插件，四模型八项能力当前为 6 passed / 2 pending，因此仍处于 `blocked / not ready`。

最新真实批次绑定 frozen commit `07fd0d79e6885ee1e0af4a021e12170ef6c9f470`，批次 ID 为 `2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678`。标准入口只调用一次；同一 `functions.exec` cell 从 ordinal 1 完整执行八项，8 completed、7 passed。ordinal 8 `ark-agent-deepseek-v4-flash/delegate` 的 provider、model、direct route、凭据隔离、single-attempt、0 retry/fallback、命令数 6、精确 `git status --short` 观测和进程清理均正确，但结果文件完全缺失，因而 `acceptance_failed`。manifest SHA-256 为 `eb3d2fd7827e4c14b35ffa97eb5d55bcfd2f0b8f6557eca04dab30241cb80556`，证据提交为 `1d5d2c4`。没有 resume、retry、fallback、补跑、第二入口或第二批；旧 evidence 不能证明写入命令的生命周期。

方案 B 的离线实现已经完成：超大 Pi 结束事件只安全保留 boolean `isError`；独立 Pi-only observer 产生 `source / match / outcome`；qualification-only schema v3 producer 才可写入 `writeCommandObservations`；optional verifier 在字段存在时严格校验。该诊断只定位命令形成、工具结果与最终制品层，不声称已经识别四种具体根因。提示词、validator、公开 MCP、`commandsRun` / `commandCount`、provider/model/route/credential/retry/fallback、manifest/checkpoint/protocol 与历史 JSON 均未修改，新字段尚未由新真实批次实测。

实现与审阅提交链为 `8261736`、`652b13d` / `5e209e1` / `16cdad5`、`293e745`、`969e546` / `0852691` / `d9eb28a`、`4bd2439`。逐任务规格/质量审阅与整体规格/安全审阅均 PASS；本轮两次 Kimi 外部复核均无结论：设计级跨多实现面审阅约 604.5 秒 `timed_out`，只返回读取进度；实现后两个内嵌摘录的单一不变量审阅约 181.8 秒 `timed_out`，review 正文为空。二者不计 PASS、不阻断，也未重试同形任务。fresh 离线矩阵为 48 个测试文件、837 passed / 1 skipped / 0 failed；类型检查、构建、release smoke、隔离 check-report、两个 help 与 diff check 均通过。5/5 retained manifests 通过 immutable verifier，evidence 相对 `a8aa4d8` 无变更且 untracked 为 0；Kimi ACP / Pi RPC / real-smoke 为 0/0/0，资格锁 absent，持久 `.tgz` 为 0。npm dry-run 的稳定文件面为 171 files / 15 Markdown/HTML / 3 plugin files；精确 byte size 不写入包内文档，避免打包元数据自引用。

当前未安装活动插件，未访问或修改 `~/.codex/config.toml`，未移除 `codex_cc_tools`，未调用或修改 Claude Code，也未发布、推送、合并或 fast-forward。新的完整八项批次尚未授权；本轮状态文档提交和 clean allow-empty freeze 完成后，最终 40 位 frozen SHA 只能由交接消息提供。用户若决定授权，必须在回复中逐字带上该 SHA，并授权“一次全新完整 `four-llm-v1` 八项，从 ordinal 1，single entry/cell，按首错停，绝不 resume/retry/fallback/补跑/第二批”。下一次授权审阅页只作为仓库内人工审阅材料，由最终交接直接提供入口，页面本身不构成授权；[本轮重新授权材料](release/four-llm-qualification-reauthorization-review.html)、[更早授权材料](release/four-llm-qualification-authorization-review.html)与[阻断结果审阅](release/four-llm-qualification-result-review.html)都只作历史审计。

2026-07-27 的 105 秒演练只构成离线基础设施证据；后续真实批次证明同一 cell 可以承载到协调器正常终态，但不证明四小时存活。未来另获授权后的唯一承载和 fail-closed 边界见[执行承载手册](release/four-llm-qualification-execution-runbook.md)，演练原始结论见[承载演练报告](release/qualification-carrier-rehearsal.md)。package/release assurance 只证明离线候选，不构成资格、安装或发布。

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

只有四个活动逻辑 LLM 的 review/delegate 在同一个 `four-llm-v1` 批次中 8/8 passed，才能准备可供授权的 ready 权限包。当前过渡注册表为 6 passed / 2 pending，只有 Ark Coding Plan 的 review/delegate pending；历史五模型结果、旧 blocked/interrupted 批次和最新 8 completed / 7 passed 批次都不能参与当前晋级，也不能与其它批次拼接。最新批次的授权已消费，且没有 retry、fallback、resume 或第二批；未来重入必须取得绑定新 frozen SHA 的明确授权，并从 ordinal 1 重新运行全新的完整八项。因此本阶段只保持 `blocked / not ready` 状态包，不提出真实安装授权问题；资格授权不能越过安装门禁。

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
