# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个外部 LLM 工具：只读审阅 `external_review` 和自主委派 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

当前阶段已接入本机 Kimi Code，以及由隔离 Pi RPC 承载的 Gemini 与 Ark；Ark 逻辑 LLM 已注册但在真实门禁通过前保持禁用。项目不会调用、修改或卸载本机 Claude Code，也不提供 Anthropic Claude、OpenAI/Codex 或 DeepSeek 模型来源。

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
codex-agent-tools install
codex-agent-tools doctor
```

安装命令只维护带有 `# managed-by: codex-agent-tools` 标记的 `[mcp_servers.codex_external_agents]` 配置块；遇到用户自建的同名配置会拒绝覆盖。安装后重启 Codex 以加载 MCP 服务。

从 `codex_cc_tools` 正式替换时使用 `codex-agent-tools install --replace-codex-cc-tools`。该流程在所有目标门禁通过前拒绝写入，成功时创建备份并进行 MCP 自检，失败则自动恢复。详见 [迁移说明](docs/migration-from-codex-cc-tools.md)。

当前 Kimi 逻辑 ID 为：

- `kimi-k2.7`
- `kimi-k2.7-highspeed`
- `kimi-k3`

Pi/Gemini 逻辑 ID 为 `gemini-3.5-flash`，固定映射到 Pi、Google provider、同名真实模型和 direct 网络策略。review/delegate 均已通过独立真实门禁，证据见 [Pi / Gemini 真实能力门禁](docs/smoke/pi-gemini.md)。

Ark 逻辑 ID 为 `ark-coding-plan`、`ark-agent-glm-5.2` 与 `ark-agent-doubao-seed-2.0-pro`，分别固定映射到隔离 Pi 中的 Coding Plan 或 Agent Plan provider，全部使用 direct 网络策略。2026-07-18 的六项真实门禁因 Coding Plan 缺少凭据、Agent Plan 周额度耗尽而未通过，因此这些 ID 会被明确拒绝而不会回退到其它模型；证据和复跑条件见 [Ark / Pi 真实能力门禁](docs/smoke/ark.md)。

每个“逻辑 LLM × 任务”只有通过真实烟测后才会启用。当前三个 Kimi 逻辑 LLM 的 review/delegate 六个组合均已通过，证据见 [Kimi 真实能力门禁](docs/smoke/kimi.md)。未来新增或重新验证中的 pending 能力会被明确拒绝，而不会静默改用另一个模型。

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
- Kimi 固定使用直连并清除继承代理；后续 Pi 模型按注册表分别固定为直连、`10808` 或 `11808`。
- 诊断、错误和模型输出在离开适配器前进行令牌与认证头脱敏。
- 取消、硬超时和异常退出会触发进程树清理；并发按固定模型或共享 provider 配额池限制。
- 委派一旦开始不会自动重试，避免重复写入。

## 发布状态

当前版本为开发期 alpha。三个 Kimi 逻辑 LLM和一个 Pi/Gemini 逻辑 LLM的两类任务均已获得真实烟测证据；三个 Ark 逻辑 LLM 已固定注册但仍等待逐项真实门禁。尚未获得证据的能力保持禁用，不会因为出现在模型清单中而自动开放。
