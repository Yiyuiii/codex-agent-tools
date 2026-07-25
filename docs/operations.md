# 官方插件运维流程

本文只描述 `codex_external_agents` 的官方插件候选构建、隔离验收、逐动作授权安装与官方回滚。它不是当前真实安装授权；截至 2026-07-25，活动 Codex 尚未安装本插件。

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
- 隔离验收先证明 pending 的 Gemini 会被已安装 MCP 明确拒绝，再用 qualified 的 Ark Agent profile 与 fake Pi 证明固定模型、direct 路由、父进程代理清除、Agent 凭据规范化和进程清理门禁通过；
- Gemini 固定 `proxy-10808` 的环境替换由确定性环境测试与真实 smoke evidence 覆盖；当前隔离 fake Pi 验收不声称成功调用 pending Gemini；
- 官方 remove 后列表语义回滚，残留状态可解释；
- 报告结论没有被扩张成真实 Codex App 已通过。

任一项失败即停止，不准备真实安装。

## 5. 准备真实安装权限包

只有五项逻辑 LLM 的 review/delegate 十项真实门禁全部 passed，才能准备可供授权的 ready 权限包。当前原始门禁为 8 passed / 2 failed，成对注册表为 6 passed / 4 pending，因此本阶段只生成 `blocked / not ready` 状态包，记录失败证据和重入条件；不提出真实安装授权问题，也不接受固定授权语句作为越过门禁的依据。

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
- 只有确定性检查、隔离生命周期、五项十门禁和真实 Codex App 宿主门禁全部通过后，才可说新插件具备替代旧工具的条件。
