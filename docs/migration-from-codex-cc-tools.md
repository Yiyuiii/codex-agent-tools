# 从 codex-cc-tools 迁移

## 当前结论：先共存

`codex-agent-tools` 的目标是让 MCP 服务 `codex_external_agents` 通过 `external_review` 与 `external_delegate` 提供 Codex 外部 LLM 能力。当前阶段采用新旧工具共存：

- 新插件不调用 `codex_cc_tools`，也不调用、修改或卸载本机 Claude Code；
- 本轮不卸载、禁用或修改旧 `codex_cc_tools`；
- 活动 Codex 当前已通过官方插件机制安装并启用已发布的 `0.1.1-beta.4`；该版本修复 beta.3 clean-tag 启动层证据装载缺口，已通过公共精确包验收且缓存五文件摘要与 marker 一致。待完整 App 重启与普通 Stop 的 `cancelled + owned-zero` receipt，真实宿主门禁仍为 partial；
- 项目代码不得直接读取或写入活动 `~/.codex/config.toml`；官方插件命令可能更新该状态文件，因此每次真实 add/remove 都必须先取得针对该动作的明确许可。

“共存”不是“已经替代”。在全部替代门槛通过前，旧工具保持原状，用户已有工作流不在本轮改动范围内。

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

## 具备替代条件的门槛

只有以下条件全部通过，才能说新插件“具备替代旧工具的条件”：

1. 确定性单测、类型检查、构建和 release smoke 通过；
2. 官方 marketplace/plugin 的 add、list、缓存副本 MCP 启动与 remove 在临时 `CODEX_HOME` 中通过；
3. 四个当前逻辑 LLM 的 review/delegate 均由当前能力索引绑定有效的 passed evidence 与运行时指纹；不同能力可以来自不同不可变批次，不要求同一批 8/8；
4. 从公共 npm 安装已由 GitHub Actions OIDC 发布的精确 beta，并通过官方插件机制升级；
5. 真实 Codex App 只发现两个批准工具，且二者 `llm` 必填；
6. 完整 App 重启后，只按 checked-in observer 输出完成旧宿主 Kimi review 握手与新宿主隔离 Kimi delegate；observer 发布 `REQUEST_STARTED` 后点击 App 普通 Stop，并取得精确 `cancelled + owned-zero` receipt；
7. 新旧工具共存状态经过验证，旧工具未被意外修改。

隔离 CLI 生命周期只能证明官方安装器和缓存副本可用，不能替代真实 Codex App 宿主门禁。四层状态和停止条件见 [发布验收清单](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/checklist.md)。

## 真实安装与回滚边界

真实安装前必须先完成 [官方插件运维流程](operations.md) 中的隔离验收，并提交只覆盖本次 add 与失败 remove 的权限包。未收到本次明确许可前，不执行官方 add/remove，也不直接检查或修补活动配置。

若获得许可后的真实宿主门禁失败，只使用权限包列出的官方 remove 命令回滚新插件和本地 marketplace。不得手工恢复 TOML，也不得在回滚中移除旧 `codex_cc_tools`。

## 旧工具移除是后续独立变更

即使新插件达到“具备替代条件”，移除旧 `codex_cc_tools` 仍是另一个独立阶段，必须重新：

1. 说明旧工具移除的必要性和精确影响；
2. 验证新插件覆盖了用户实际依赖的调用路径；
3. 提供独立验证与回滚方案；
4. 取得针对旧工具移除的明确授权。

本轮真实安装许可不能绑定或隐含 npm 发布、公共 marketplace 发布、未来升级、独立卸载或旧工具移除权限。

## 历史事故边界

2026-07-20 的应用内自动 cutover 曾通过候选文件、独立 MCP 与项目 doctor 检查，但重启后的 Codex App 无法正常运行；用户于 2026-07-24 恢复原始配置。历史实现中的配置写入命令当前已从公开 CLI 删除并禁用，不得用于活动配置。该事故证明候选 TOML 或独立 MCP 通过不能替代真实 App 验收，也是当前改用官方插件机制、隔离取证和逐动作授权的原因。
