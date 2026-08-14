# 从 codex-cc-tools 迁移到 DeepSeek-only beta

`codex-agent-tools@0.1.2-beta.0` 使用 MCP 服务 `codex_external_agents`，公开 `external_review` 与 `external_delegate`。两个工具都要求显式选择：

```json
{ "llm": "deepseek-v4-flash" }
```

该 beta 仅承载 Direct DeepSeek API：Pi RPC / provider `deepseek` / `https://api.deepseek.com` / `openai-completions` / 固定模型 `deepseek-v4-flash`。宿主凭据名为 `OPENAI_API_KEY_DEEPSEEK`。

旧 Kimi、Ark、Gemini、Claude 与 OpenAI/Codex 路线都不属于该 beta 的公开产品面。历史实现与证据仍留在仓库供审计，不会被 npm 包能力索引或插件凭据白名单加载。

## 边界

- 新插件不调用、修改或卸载 Claude Code。
- 发布 beta 不会自动安装、启用、替换或卸载任何活动插件或 MCP。
- 项目代码不读取或修改活动 `~/.codex/config.toml`。
- 任何活动插件 add/remove/upgrade 都需要针对该次动作的明确授权，并使用官方 Codex 插件命令。
- 旧工具是否退役属于独立决定，不由本 beta 发布自动推导。

发布后的消费者验收在临时 `CODEX_HOME` 中完成，不继承活动插件状态。具体命令见 [DeepSeek-only beta 运维流程](operations.md)。
