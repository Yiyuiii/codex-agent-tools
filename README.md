# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个外部 LLM 工具：只读审阅 `external_review` 和自主委派 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

当前已接入本机 Kimi Code，以及由隔离 Pi RPC 承载的 Gemini 与 Ark；七个逻辑 LLM 的 `review` / `delegate` 均已通过独立真实门禁并启用。项目不会调用、修改或卸载本机 Claude Code，也不提供 Anthropic Claude、OpenAI/Codex 或 DeepSeek 模型来源。

## 公开契约

每次调用都必须显式选择逻辑 `llm`。调用者不能覆盖后端、真实模型、代理、工具集或推理强度；每个逻辑 LLM 的运行时、真实模型和网络策略由版本化注册表固定绑定。

```json
{
  "llm": "kimi-k3",
  "task": "review_diff",
  "prompt": "检查当前改动中的正确性问题，并给出文件与位置证据。",
  "cwd": "D:\\work\\project"
}
```

```json
{
  "llm": "kimi-k2.7-highspeed",
  "prompt": "修复测试所描述的问题，运行相关测试并汇报实际改动。",
  "cwd": "D:\\work\\isolated-worktree"
}
```

`external_review` 在应用层拒绝写入和命令执行，并在调用前后比较工作区证据；它不是操作系统级沙箱。如果审阅进程仍改变了工作区，结果会标记为 `workspace_changed`。`external_delegate` 明确可写且具有破坏性，调用方应先选择合适的工作目录、worktree、容器或操作系统隔离边界。

## 安装

要求 Node.js 20+，并已安装、登录本机 Kimi Code。Kimi 使用本机 OAuth 会话，本项目不复制或保存其令牌。

```powershell
npm install -g codex-agent-tools
```

2026-07-24 起，本项目不建议自动修改活动的 `~/.codex/config.toml`：历史 cutover 在独立检查通过后仍导致 Codex App 重启异常，用户已恢复原始配置。开发期 `install` 只能与 `--config <测试副本>` 配合；默认使用只读 doctor、候选配置和离线验证。

不要对活动配置运行 `install --replace-codex-cc-tools` 或 `restore`。后续正式接入优先采用 Codex 官方插件安装机制；若无法绕开活动配置写入，必须先向用户展示精确差异、验证与回滚方案，并取得针对该次操作的明确许可。详见 [迁移说明](docs/migration-from-codex-cc-tools.md)。

当前 Kimi 逻辑 ID 为：

- `kimi-k2.7`
- `kimi-k2.7-highspeed`
- `kimi-k3`

Pi/Gemini 逻辑 ID 为 `gemini-3.5-flash`，固定映射到 Pi、Google provider、同名真实模型和 `proxy-10808` 网络策略。2026-07-20 的 review/delegate 均通过真实门禁；证据见 [Pi / Gemini 真实能力门禁](docs/smoke/pi-gemini.md)。

Ark 逻辑 ID 为 `ark-coding-plan`、`ark-agent-glm-5.2` 与 `ark-agent-doubao-seed-2.0-pro`，分别固定映射到隔离 Pi 中的 Coding Plan 或 Agent Plan provider，全部使用 direct 网络策略。2026-07-20 的六项 review/delegate 门禁全部通过；Ark Coding 同时兼容本机用户环境变量名 `API_KEY_DOUBAO_CODING`。证据见 [Ark / Pi 真实能力门禁](docs/smoke/ark.md)。

每个“逻辑 LLM × 任务”只有通过真实烟测后才会启用。当前 Kimi、Gemini 与 Ark 的 14 个组合均已通过；未来新增或重新验证中的 pending 能力会被明确拒绝，而不会静默改用另一个模型。

完整的安装、诊断、卸载和故障处理见 [运维说明](docs/operations.md)。终端用户不需要手工维护 Pi 模型配置；Pi 接入后，其隔离配置将由本包随版本生成和维护。

## 开发验证

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
```

真实 Kimi 烟测会实际消耗本机计划额度，只在明确验证模型能力时运行：

```powershell
npm run smoke:kimi -- --llm kimi-k3 --task review
```

## 安全边界

- 子进程只继承最小环境白名单；凭据仅按逻辑 LLM 配置显式传入。
- Kimi 固定使用直连并清除继承代理；Gemini 固定使用 `10808`，Ark 固定直连。注册表保留 `11808` 网络策略能力，但当前没有逻辑 LLM 使用它。
- 诊断、错误和模型输出在离开适配器前进行令牌与认证头脱敏。
- 取消、硬超时和异常退出会触发进程树清理；并发按固定模型或共享 provider 配额池限制。
- 委派一旦开始不会自动重试，避免重复写入。

## 发布状态

当前版本为开发期 alpha。Kimi、Gemini 与三个 Ark 逻辑 LLM 的 14 项能力均已获得当前路由下的真实烟测证据，但真实 Codex App 集成因配置事故已回滚，不能视为可安装版本。尚未获得当前绑定证据的未来能力仍保持禁用，不会因为出现在模型清单中而自动开放。

本次确定性验证、独立 MCP 验收、自动 cutover 事故和当前安全约束见 [0.1.0-alpha.1 本机替换验收记录](docs/release/checklist.md)。
