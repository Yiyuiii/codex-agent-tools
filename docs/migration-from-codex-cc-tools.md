# 从 codex-cc-tools 迁移

## 当前结论：官方配置退役完成，宿主缓存待重启确认

`codex-agent-tools` 现在由 MCP 服务 `codex_external_agents` 通过 `external_review` 与 `external_delegate` 提供 Codex 外部 LLM 能力。2026-08-07 已完成本机替代：

- 新插件不调用 `codex_cc_tools`，也不调用、修改或卸载本机 Claude Code；
- 活动 Codex 已通过官方插件机制安装并启用公开稳定版 `0.1.1`，完整重启后的新任务已发现两个新工具，真实 Kimi K3 窄 review/delegate 均通过；
- 新插件已经覆盖维护者实际使用的 review/delegate 路径，维护者明确决定结束共存；旧 `codex_cc_tools` 的公开 provider 集不含当前唯一可用的 Kimi，Ark 额度耗尽、DeepSeek 欠费、Anthropic 不可用只是本次移除时的动态环境背景，不是永久退役规则。Codex 使用 `codex mcp remove codex_cc_tools` 官方命令移除后，官方列表复核旧服务已不存在；
- 全局 `AGENTS.md` 已把协作入口从 `cc_review` / `cc_delegate` 更新为 `external_review` / `external_delegate`；
- 本次移除发生在当前 App 任务运行期间，因此该任务的工具缓存仍可能显示旧定义。必须完整退出并重开 App，再在新任务中确认旧工具消失；这不影响官方配置列表已完成移除的事实；
- 维护者此前跳过普通 Stop 交互验收，没有 PASS receipt；`0.1.1` 继续保留 `host_stop_unverified`，不得声称真实宿主取消已通过；
- 项目代码不得直接读取或写入活动 `~/.codex/config.toml`；官方插件命令可能更新该状态文件，因此每次真实 add/remove 都必须先取得针对该动作的明确许可。

这次退役只表示维护者当前环境的活动入口已经切换，不抹去旧仓库和历史证据，也不把新插件的 `host_stop_unverified` 改写为通过。

## 当前来源映射

| 外部来源或用途 | 新逻辑 LLM | 固定路由 | 当前门禁 |
| --- | --- | --- | --- |
| Kimi Code 审阅/委派 | `kimi-k3` | Kimi ACP / `kimi-code/k3` / direct | review/delegate current passed |
| Ark Coding Plan | `ark-coding-plan` | Pi / `ark-coding-plan` / `ark-code-latest` / direct | review/delegate current passed |
| Ark Agent Plan 主档 | `ark-agent-plan` | Pi / `ark-agent-plan` / `ark-code-latest` / direct | review/delegate current passed |
| Ark Agent Plan 经济档 | `ark-agent-deepseek-v4-flash` | Pi / `ark-agent-plan` / `deepseek-v4-flash` / direct | review/delegate current passed |
| Anthropic Claude / Claude Code 后端 | 无 | 不进入新产品面 | 不迁移 |
| OpenAI/Codex 模型家族 | 无 | 顶层已经是 Codex | 不作为外部来源 |

当前 Kimi 只公开 K3；旧 Kimi、旧 Agent Plan 模型和 Gemini 记录只作为历史证据保留，不属于当前注册表。Gemini 的历史 Google / `proxy-10808` 路由与额度失败见 [退役历史页](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/pi-gemini.md)，不构成当前 provider 或待晋级能力。发布资格以能力索引和 verifier 为准：2026-08-03 新批次已使八项全部 current passed，现行索引为 8 current / 0 legacy。只有未来发生 stale、缺失、新增或证据失效时才定向运行对应精确能力；不因临时额度恢复重复运行，不静默切换到其它 LLM，也不改写历史 evidence。

## 已满足的替代证据

本次决定依据以下证据：

1. 确定性单测、类型检查、构建和 release smoke 通过；
2. 官方 marketplace/plugin 的 add、list、缓存副本 MCP 启动与 remove 在临时 `CODEX_HOME` 中通过；
3. 四个当前逻辑 LLM 的 review/delegate 均由当前能力索引绑定有效的 passed evidence 与运行时指纹；不同能力可以来自不同不可变批次，不要求同一批 8/8；
4. 从公共 npm 安装已由 GitHub Actions OIDC 发布的精确 beta，并通过官方插件机制升级；
5. 真实 Codex App 已发现两个新工具且二者 `llm` 必填；旧 MCP 移除后的官方列表已不含旧服务，最终 App 工具发现面仍需重启后在新任务确认；
6. stable marker 精确绑定 beta.4 公共身份，并把维护者跳过普通 Stop 的决定记录为 `skipped_by_maintainer / host_stop_unverified`；该状态不等于 PASS，也不能泛化到其它版本；
7. 0.1.1 重启后的真实 Kimi K3 窄 review 在 38.291 秒成功，隔离 delegate 在 13.913 秒成功，文件、命令与 owned-zero 证据均经独立复核；升级到 Kimi 0.34.0 后的五事实窄 review 又在 57.505 秒成功；
8. 旧工具的现行 schema 没有 Kimi 路由，而新插件的 Kimi 路由已加载并可用。

隔离 CLI 生命周期只能证明官方安装器和缓存副本可用，不能替代真实 Codex App 宿主门禁。四层状态和停止条件见 [发布验收清单](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/checklist.md)。

## 当前回滚边界

如需恢复旧 MCP，只能使用官方命令重新注册已记录的旧启动器，不能手工编辑活动 TOML：

```powershell
codex mcp add codex_cc_tools -- "<旧启动器绝对路径>"
```

随后完整退出并重开 App，在新任务中验证 `cc_review` / `cc_delegate`。该命令只恢复 stdio 启动注册；移除前记录的旧状态还包括 `enabled_tools = ["cc_review", "cc_delegate"]`、60 秒启动超时与 900 秒工具超时，而当前官方 `mcp add` 不提供这些持久化选项。若必须逐字段复原，应先单独设计官方可支持的恢复路线并取得授权，不得用手工 TOML 绕过。

若新插件本身需要回滚，继续使用 [官方插件运维流程](operations.md) 中的 `codex plugin remove` 路线；不要为了恢复旧工具而删除新插件，除非用户另行要求。

## 退役记录

旧工具移除是独立于 0.1.1 发布的外部状态变更。移除前已说明必要性、核对新插件覆盖、记录旧 transport 与回滚入口，并取得维护者明确授权；执行后只通过官方 `codex mcp list/get` 复核，没有直接读取或写入活动 `config.toml`。本次授权已经消费，不能自动扩张成未来插件卸载、重装或其它 MCP 变更许可。

## 历史事故边界

2026-07-20 的应用内自动 cutover 曾通过候选文件、独立 MCP 与项目 doctor 检查，但重启后的 Codex App 无法正常运行；用户于 2026-07-24 恢复原始配置。历史实现中的配置写入命令当前已从公开 CLI 删除并禁用，不得用于活动配置。该事故证明候选 TOML 或独立 MCP 通过不能替代真实 App 验收，也是当前改用官方插件机制、隔离取证和逐动作授权的原因。
