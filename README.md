# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个 MCP 工具：只读的 `external_review` 与可写的 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

## 五模型 beta

`0.1.2-beta.1` 统一公开五个逻辑 LLM。调用方只选择 `llm`，不能覆盖 provider、真实模型、endpoint、代理或推理配置。

| 逻辑 LLM | 载体与固定模型 | 宿主凭据 |
| --- | --- | --- |
| `kimi-k3` | Kimi ACP / `kimi-code/k3` | 本机 Kimi Code 登录态 |
| `ark-coding-plan` | Pi RPC / `ark-coding-plan` / `ark-code-latest` | `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING` 依次择一 |
| `ark-agent-plan` | Pi RPC / `ark-agent-plan` / `ark-code-latest` | `OPENAI_API_KEY_DOUBAO` |
| `ark-agent-deepseek-v4-flash` | Pi RPC / `ark-agent-plan` / `deepseek-v4-flash` | `OPENAI_API_KEY_DOUBAO` |
| `deepseek-v4-flash` | Pi RPC / `deepseek` / `deepseek-v4-flash` | `OPENAI_API_KEY_DEEPSEEK` |

所有 Pi 路线均为直连。项目在自身缓存中生成版本化 Pi 配置，只把当前路线所需凭据规范化后注入子进程，不保存或输出密钥值，也不读取用户日常的 `~/.pi/agent`。

## 公开契约

两个工具都要求显式传入 `llm`。只读审阅示例：

```json
{
  "llm": "kimi-k3",
  "task": "review_diff",
  "prompt": "检查当前改动中的正确性问题，并给出文件与位置证据。",
  "cwd": "D:\\work\\project"
}
```

委派示例：

```json
{
  "llm": "deepseek-v4-flash",
  "prompt": "实现需求并运行相关测试，最后汇报实际改动。",
  "cwd": "D:\\work\\isolated-worktree"
}
```

`external_review` 会比较调用前后的工作区，并拒绝 Pi 的命令、编辑或写入事件。`external_delegate` 明确可写，调用方应提供合适的 worktree 或其它隔离目录。

`external_review` 的只读保证属于应用层约束：Kimi ACP 拒绝写入，Pi 只启用只读工具，服务再比较 `cwd` 内的工作区变化。它不是操作系统沙箱；`.git`、`node_modules`、`dist` 与 `cwd` 外路径不属于文件快照证据范围。

## 运行要求

- Node.js 24+；
- `@earendil-works/pi-coding-agent` 0.80.10；
- Kimi 路线需要可用的本机 Kimi Code；
- Pi 路线需要上表对应的用户环境变量。

项目不调用或修改 Claude Code，也不提供 Anthropic Claude、OpenAI/Codex 或 Gemini 后端。

## 开发与隔离验收

```powershell
npm ci
npm run gate:offline
npm run acceptance:plugin:isolated:built
```

`gate:offline` 执行构建、类型检查、确定性测试、十项能力验证与 release smoke。隔离插件验收只在临时 `CODEX_HOME` 中执行官方 marketplace/plugin 生命周期、启动缓存副本 MCP 并调用 fake Pi；它不访问活动 Codex home，也不调用真实模型。

公共版本发布后，可从 npm 对精确版本执行消费者验收：

```powershell
npm run acceptance:npm-package -- --version 0.1.2-beta.1
```

## 安全与发布边界

- 子进程只继承最小系统环境和当前路线的规范化凭据。
- 模型输出、诊断和错误在离开适配器前进行密钥与认证头脱敏。
- 显式取消、单次 deadline 与宿主异常退出都会触发 owned 进程树清理。
- 项目代码不直接读取、写入、备份或恢复活动 `~/.codex/config.toml`。
- beta 只通过 GitHub Actions OIDC 发布，禁止本地 `npm publish`。
- 发布不自动安装或升级活动插件；该动作需要独立授权、官方插件命令、完整重启和新任务验收。

能力状态见 GitHub 上的 [Kimi](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/kimi.md)、[Ark](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/ark.md) 与 [Direct DeepSeek](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/deepseek.md)，维护流程见 [官方插件运维说明](docs/operations.md)。
