# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个 MCP 工具：只读的 `external_review` 与可写的 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

## DeepSeek-only beta

`0.1.2-beta.0` 只公开一个逻辑 LLM：`deepseek-v4-flash`。

- 载体：隔离的 Pi RPC；
- provider：`deepseek`；
- API：`https://api.deepseek.com`；
- 协议：`openai-completions`；
- 模型：固定为 `deepseek-v4-flash`；
- 网络：直连，并清除子进程继承的 HTTP(S)/ALL proxy；
- 并发：`deepseek` 池上限为 1。

插件只转发宿主环境变量 `OPENAI_API_KEY_DEEPSEEK`。运行时将它规范化为 Pi 子进程专用的 `CODEX_AGENT_DEEPSEEK_KEY`；不会保存或输出密钥值。DeepSeek provider 不登记其它模型。

历史 Kimi/Ark 实现与不可变证据仍保留在仓库中用于审计，但不属于该 beta 的公开注册表、凭据白名单、能力索引或 npm 证据集合。

## 公开契约

两个工具都要求显式传入 `llm: "deepseek-v4-flash"`。调用方不能覆盖 provider、真实模型、endpoint、代理或推理配置。

只读审阅示例：

```json
{
  "llm": "deepseek-v4-flash",
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

`external_review` 会在调用前后比较工作区，并拒绝 Pi 的命令、编辑或写入事件；若工作区发生变化，结果会标记为 `workspace_changed`。`external_delegate` 明确可写且具破坏性提示，调用方应提供合适的 worktree 或其它隔离目录。

## 运行要求

- Node.js 24+；
- `@earendil-works/pi-coding-agent` 0.80.10；
- 用户环境中存在 `OPENAI_API_KEY_DEEPSEEK`。

项目在自身缓存下生成版本化 Pi 配置，不读取或修改用户日常的 `~/.pi/agent`。项目也不调用或修改 Claude Code，不提供 Anthropic Claude 或 OpenAI/Codex 后端。

## 开发与隔离验收

```powershell
npm ci
npm run gate:offline
npm run acceptance:plugin:isolated:built
```

`gate:offline` 执行构建、类型检查、单 worker 确定性测试、两项能力验证与 release smoke。隔离插件验收只在自动创建的临时 `CODEX_HOME` 中执行官方 marketplace/plugin add、启动缓存副本 MCP、调用 fake Pi，并执行 remove；它不读取或修改活动 Codex home，也不调用真实模型。

公共版本发布后，可从 npm 对精确版本执行消费者视角验收：

```powershell
npm run acceptance:npm-package -- --version 0.1.2-beta.0
```

该流程固定使用公共 npm registry、禁用 lifecycle scripts、安装到一次性目录，并在临时 `CODEX_HOME` 中完成官方插件生命周期与包内能力证据闭包校验。

## 安全与发布边界

- 子进程只继承最小系统环境和当前路线的规范化凭据。
- 模型输出、诊断和错误在离开适配器前进行密钥与认证头脱敏。
- 显式取消、单次 deadline 与宿主异常退出都会触发 owned 进程树清理。
- 项目代码不直接读取、写入、备份或恢复活动 `~/.codex/config.toml`。
- beta 发布只通过 GitHub Actions OIDC 完成；禁止本地 `npm publish`。
- 发布 beta 不等于安装或升级活动插件；活动插件变更需要独立、明确授权。

真实 Direct DeepSeek review/delegate 的不可变资格证据见 [Direct DeepSeek 接入状态](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/deepseek.md)，运维流程见 [官方插件运维说明](docs/operations.md)。
