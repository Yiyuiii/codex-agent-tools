# 从 codex-cc-tools 迁移

## 目标边界

本项目目标是以 MCP 服务 `codex_external_agents`、工具 `external_review` 与 `external_delegate` 替代 `codex_cc_tools`。2026-07-20 的自动 `config.toml` cutover 在独立检查通过后仍导致重启后的 Codex App 无法正常运行；用户已于 2026-07-24 恢复原始配置。后续迁移不得默认修改活动的 `~/.codex/config.toml`，也不会运行旧包卸载器、修改 `D:\Codes\codex-cc-tools`，或调用、修改、卸载本机 Claude Code。

新工具每次都要求显式选择逻辑 `llm`。调用者不能指定 backend、provider、真实模型、代理、工具集或推理强度。

## 来源映射

| 旧来源或用途 | 新逻辑 LLM | 当前状态 |
| --- | --- | --- |
| Kimi Code 外部审阅/委派 | `kimi-k2.7`、`kimi-k2.7-highspeed`、`kimi-k3` | review/delegate 已通过真实门禁 |
| Gemini direct review | `gemini-3.5-flash`（Pi/Google/`proxy-10808`） | review/delegate 已通过新路由真实门禁 |
| Ark Coding Plan | `ark-coding-plan`（Pi/`ark-code-latest`） | review/delegate 已通过真实门禁 |
| Ark Agent Plan GLM | `ark-agent-glm-5.2`（Pi/`glm-5.2`） | review/delegate 已通过真实门禁 |
| Ark Agent Plan Doubao | `ark-agent-doubao-seed-2.0-pro`（Pi/同名模型） | review/delegate 已通过真实门禁 |
| Anthropic Claude / Claude Code 后端 | 无 | 从新产品面删除；本机 Claude Code 安装保留 |
| DeepSeek | 无 | 按维护者要求不迁移 |
| OpenAI/Codex 模型家族 | 无 | 不作为外部来源引入，因为顶层已是 Codex |

Ark 当前证据和复跑条件见 [Ark / Pi 真实能力门禁](smoke/ark.md)。禁用能力不会静默切换到其它 LLM。

## 历史自动切换（禁止用于活动配置）

以下命令仍存在于历史实现中，但不得对本机活动配置执行：

```powershell
# 历史命令，仅记录，不要对活动配置执行
codex-agent-tools install --replace-codex-cc-tools
```

流程为：

1. 运行 fail-closed readiness 检查；失败时配置零写入、零备份。
2. 获取同配置文件锁。
3. 在原目录创建带 UTC 时间戳的逐字节备份。
4. 只删除 `[mcp_servers.codex_cc_tools]` 表，安装带拥有标记的 `[mcp_servers.codex_external_agents]`。
5. 通过临时文件、文件同步和 rename 原子替换。
6. 启动新 MCP 并验证 initialize/listTools 只暴露两个批准工具。
7. 任一写后验证失败时从内存中的原始字节自动恢复；备份保留供审计。

2026-07-20 该命令曾通过文件级和独立 MCP 自检，但真实 Codex App 重启后异常，说明原 readiness 不足以授权活动配置写入。它只能配合 `--config <显式测试副本>` 做开发验证。

## 历史显式回滚

成功切换会输出备份绝对路径。需要回滚时执行：

```powershell
# 历史命令，仅记录，不要对活动配置执行
codex-agent-tools restore --backup "<输出的备份绝对路径>"
```

`restore` 同样不得对活动配置执行。用户已经自行恢复原始配置；未经明确请求，不读取、比较或覆盖恢复结果。测试时只能配合显式临时配置副本。

## 后续安全迁移原则

1. 默认只读，不探测恢复后的活动配置内容。
2. 在仓库或临时目录生成候选 TOML 和精确 diff。
3. 对候选文件做 TOML 解析、MCP initialize/listTools 和与当前 Codex 版本相符的兼容性验证。
4. 优先使用 Codex 官方插件安装机制；若当前机制不能满足目标，先改进打包与安装方案。
5. 只有用户针对一次具体写入明确许可后，才可考虑活动配置变更；许可不能从过去的 cutover 授权推断。

## 测试副本复核（非集成完成证据）

```powershell
codex-agent-tools doctor --json
```

只在显式测试副本上确认：

- `codex_external_agents` 注册归本包所有；
- 公开工具只有 `external_review` 与 `external_delegate`；
- 候选配置中的旧表删除范围符合预期；
- 本机 Claude Code 文件与旧项目源码没有变化；
- 每个启用能力仍有真实门禁证据。

这些检查不能证明真实 Codex App 重启后可用；在增加真实启动兼容性验证之前，不得恢复自动 cutover。
