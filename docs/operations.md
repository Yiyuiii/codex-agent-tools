# 官方插件运维流程

本文只描述 `codex_external_agents` 的官方插件候选构建、隔离验收、逐动作授权安装与官方回滚。它不是当前真实安装授权；活动 Codex 尚未安装本插件，四模型八项能力当前为 6 passed / 2 pending，因此仍处于 `blocked / not ready`。

本轮唯一获授权的最新真实批次绑定 frozen commit `cb9434b4b540e70f5384224e4e98823a3ea2dbae`，批次 ID 为 `2026-07-28T10-56-09.704Z-649886e3-233e-4da1-ac80-185227342bef`。标准入口和 `functions.exec` cell 各只有一个；批次按首错停为 6 completed / 5 passed、`blocked / case_failed`、`promotionEligible=false`，ordinal 7–8 notRun。没有 resume、retry、fallback、补跑、第二入口或第二批。manifest SHA-256 为 `61051a8eb8107759cdd1a10d5d44a7fe6d8a3f2c6b3b8e03773c8db8de4cd88d`，证据提交为 `b1682cb`。

ordinal 1–5 passed；ordinal 6 `ark-agent-plan/delegate` 的 provider、model、direct route、凭据和 telemetry 正确，结果文件有效，但以 `account_quota_exceeded` 失败。该项变更还含来源不明的 `where.cmd`，18 个 Pi bash 生命周期全部为 error，精确写入命令也是 error；shell 缺陷不能被写成额度失败的原因。ordinal 1 在旧资格门禁下 passed，但其 5 个 bash 生命周期全部为 error、精确写入命令也是 error，是历史假阳性。

离线调查确认 Pi Windows 子进程环境遗漏 `ProgramFiles` 与 `ProgramFiles(x86)`，导致 Git Bash resolver 失败；提交 `2a815c7` 修复后，真实 resolver 与精确 Node spawn 探针离线成功，代理和凭据边界保持不变。资格合同提交 `e750052`、`b5a691f`、`3d85315`、`ceb8e9c` 要求未来资格 Pi delegate 的精确写入与精确 `git status --short` 生命周期各恰好一次且均为 success，并由未来整批 passed verifier 重算；历史 blocked/interrupted 继续兼容。schema/plan、公开 MCP、provider/model/route/credential、提示词、结果 validator、retry/fallback 均未改变；独立质量复审为 PASS、无 P0–P3。

48 个测试文件、837 passed / 1 skipped / 0 failed 与 171 files / 15 Markdown/HTML / 3 plugin files 是旧候选历史数字。当前冻结前 fresh 矩阵已经通过：49 个测试文件、853 passed / 1 skipped / 0 failed，类型检查、构建、release smoke、隔离官方插件 `--check-report`、6/6 retained manifests immutable verifier 与最新 evidence 不变检查均通过；npm pack dry-run 为 191 files 且没有持久 `.tgz`。生产隔离环境中的 Pi resolver 找到 `C:\Program Files\Git\bin\bash.exe`，`ProgramFiles` 两键存在、代理变量为 0，精确 Ark Agent Plan 写入探针 exit 0、28 bytes、SHA-256 `81fcf915...`；目标进程为 0/0/0，资格锁 absent。

全量测试曾暴露 Kimi ACP client 早于 child close 返回的既有竞态，98/100 时序探针可观察；提交 `4af8b34` 加入 close 等待、1000ms 有界失败、stdio 销毁与两个确定性回归测试，独立复审 PASS、无 P0–P3，最终全量已经包含。状态文档提交与最终 clean frozen SHA 仍由主线程完成。

当前未安装活动插件，未访问或修改 `~/.codex/config.toml`，未移除 `codex_cc_tools`，未调用或修改 Claude Code，也未发布、推送、合并或 fast-forward。维护者已对项目内真实资格实验给出 standing authorization：状态文档提交、完整复核和 clean freeze 后，Codex 自行生成每批 fresh 内部执行引用并运行新的完整 `four-llm-v1` 八项，无需用户逐字回复 SHA。每批仍从 ordinal 1 开始，single entry/cell、按首错停，绝不在同一批内 resume/retry/fallback/补跑；终态证据提交并完成可修缺陷的新 clean freeze 后，才可自主启动新批。仓库内 `docs/release/four-llm-qualification-next-authorization-review.html` 记录当前边界但不随 npm 包发布；[本轮重新授权材料](release/four-llm-qualification-reauthorization-review.html)、[更早授权材料](release/four-llm-qualification-authorization-review.html)与[阻断结果审阅](release/four-llm-qualification-result-review.html)都只作历史审计。

2026-07-27 的 105 秒演练只构成离线基础设施证据；后续真实批次证明同一 cell 可以承载到协调器正常终态，但不证明四小时存活。standing authorization 下的唯一承载和 fail-closed 边界见[执行承载手册](release/four-llm-qualification-execution-runbook.md)，演练原始结论见[承载演练报告](release/qualification-carrier-rehearsal.md)。package/release assurance 只证明离线候选，不构成资格、安装或发布。

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

只有四个活动逻辑 LLM 的 review/delegate 在同一个 `four-llm-v1` 批次中 8/8 passed，才能准备可供授权的 ready 权限包。当前过渡注册表为 6 passed / 2 pending，只有 Ark Coding Plan 的 review/delegate pending；历史五模型结果以及所有 blocked/interrupted 批次，包括最新 6 completed / 5 passed 批次，都不能参与当前晋级，也不能与其它批次拼接。最新历史批次没有 retry、fallback、resume 或第二批；未来重入仍须绑定新的 clean frozen SHA、生成 fresh 内部执行引用并从 ordinal 1 运行全新的完整八项，但 standing authorization 已取代逐批人工许可。本阶段在真实批次 8/8 前只保持 `blocked / not ready` 状态包，不提出真实安装授权问题；默认实验授权不能越过活动安装门禁。

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
