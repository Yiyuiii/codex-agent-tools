# 官方插件运维流程

本文只描述 `codex_external_agents` 的官方插件候选构建、隔离验收、逐动作授权安装与官方回滚。它不是当前真实安装授权；活动 Codex 尚未安装本插件，四模型八项能力当前为 6 passed / 2 pending。最新 `four-llm-v1` 批次在首项 Ark Coding Plan delegate 的结果文件内容验收失败后形成 `blocked` 终态，未产生 8/8 资格，因此仍处于 `blocked / not ready`。

该失败文件已通过双哈希确定为 `ARK_SMOKE_OK:ark-coding-plan;\n`。实现提交 `76504d7d165366ad291e6ff08026b7236f862fc8` 已用精确 Node + Base64 Bash 命令和独立 payload 代码块消除提示词分隔歧义，且 validator、固定 provider/model/direct route、凭据、single-attempt、无 retry/fallback、telemetry、资格 schema/protocol 与既有 evidence 均保持不变。独立双审阅及 44 个测试文件、569 passed / 1 skipped / 0 failed 的完整离线验证已通过，但本轮没有新的真实模型调用；Ark Coding Plan 仍未重新取得资格。新的完整八项批次必须先取得[单独的资格批次授权](release/four-llm-qualification-authorization-review.html)，该授权不包含本页后述的活动安装或回滚。

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

只有四个活动逻辑 LLM 的 review/delegate 在同一个 `four-llm-v1` 批次中 8/8 passed，才能准备可供授权的 ready 权限包。当前过渡注册表为 6 passed / 2 pending，只有 Ark Coding Plan 的 review/delegate pending；历史五模型结果和最新 blocked 批次都不能参与当前晋级。最新批次的授权已消费且没有重试；未来重入必须取得新的明确授权，并从首项重新运行完整八项。因此本阶段只保持 `blocked / not ready` 状态包，不提出真实安装授权问题；资格批次授权材料中的建议回复只覆盖一次八项批次，不能作为越过安装门禁的依据。

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
