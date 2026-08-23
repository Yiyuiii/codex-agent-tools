# 从 codex-cc-tools 迁移到五模型 beta

`codex-agent-tools@0.1.2-beta.1` 使用 MCP 服务 `codex_external_agents`，只公开 `external_review` 与 `external_delegate`。两个工具都要求显式选择 `llm`。

可选逻辑 LLM：

- `kimi-k3`
- `ark-coding-plan`
- `ark-agent-plan`
- `ark-agent-deepseek-v4-flash`
- `deepseek-v4-flash`

Direct DeepSeek 固定使用 Pi RPC / provider `deepseek` / `https://api.deepseek.com` / `openai-completions` / 模型 `deepseek-v4-flash`。Ark 与 Kimi 的固定绑定见 [README](../README.md)。Gemini、Claude 与 OpenAI/Codex 路线不属于公开产品面。

## 凭据迁移

- Kimi 沿用本机 Kimi Code 登录态；
- Ark Coding 依次读取 `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING`；
- Ark Agent 两条路线读取 `OPENAI_API_KEY_DOUBAO`；
- Direct DeepSeek 读取 `OPENAI_API_KEY_DEEPSEEK`。

调用方不选择 backend、provider、模型或代理。每个逻辑 LLM 的绑定由项目版本固定维护。

## 边界

- 新插件不调用、修改或卸载 Claude Code。
- 发布不会自动安装、启用、替换或卸载活动插件或 MCP。
- 项目代码不读取或修改活动 `~/.codex/config.toml`。
- 活动插件 add/remove/upgrade 需要针对该次动作的明确授权，并使用官方 Codex 插件命令。
- 旧工具是否退役属于独立决定。

发布后的消费者验收在临时 `CODEX_HOME` 中完成，不继承活动插件状态。具体命令见 [五模型 beta 运维流程](operations.md)。
