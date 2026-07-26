# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个外部 LLM 工具：只读审阅 `external_review` 和自主委派 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

当前代码公开四个固定逻辑 LLM，所有活动子进程均使用直连网络策略：

- `kimi-k3`：本机 Kimi Code ACP，直连；
- `ark-coding-plan`：隔离 Pi RPC / Ark Coding Plan / `ark-code-latest`，直连；
- `ark-agent-plan`：隔离 Pi RPC / Ark Agent Plan / `ark-code-latest`，直连；
- `ark-agent-deepseek-v4-flash`：隔离 Pi RPC / Ark Agent Plan / `deepseek-v4-flash`，直连。

当前八项 review/delegate 能力的过渡状态为 6 passed / 2 pending：`kimi-k3`、`ark-agent-plan` 与 `ark-agent-deepseek-v4-flash` 各两项 passed，只有 `ark-coding-plan` 的两项能力 pending。Gemini 已从活动注册表、运行时、凭据与网络策略、doctor、smoke 和资格入口退役；既有 Gemini 调用和 2026-07-26 五模型 blocked 批次只作为历史审计证据保留。pending 能力会明确拒绝，不会复用单项通过、旧模型证据或静默切换到其它 LLM。

下一次资格认证必须以 `four-llm-v1` 协议在同一冻结候选上产生完整的 8/8 passed 批次；不能只补跑 Ark Coding Plan，也不能把历史证据拼接成当前资格。

项目不会调用、修改或卸载本机 Claude Code，也不提供 Anthropic Claude、OpenAI/Codex 或独立 DeepSeek 后端。

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
  "llm": "kimi-k3",
  "prompt": "修复测试所描述的问题，运行相关测试并汇报实际改动。",
  "cwd": "D:\\work\\isolated-worktree"
}
```

`external_review` 在应用层拒绝写入和命令执行，并在调用前后比较工作区证据；它不是操作系统级沙箱。如果审阅进程仍改变了工作区，结果会标记为 `workspace_changed`。`external_delegate` 明确可写且具有破坏性，调用方应先选择合适的工作目录、worktree、容器或操作系统隔离边界。

## 官方插件集成状态

要求 Node.js 20+，并已安装、登录本机 Kimi Code。Kimi 使用本机 OAuth 会话，本项目不复制或保存其令牌。

仓库已包含本地 marketplace、官方插件 manifest、直接 server-map `.mcp.json` 和自包含 MCP bundle。当前候选的第 2 层隔离官方插件生命周期已经通过：Codex CLI 0.135.0 已在唯一临时 `CODEX_HOME` 中完成官方 marketplace/plugin 的 add、list、缓存副本启动与 remove 生命周期；这只证明隔离 CLI 生命周期，不代表活动 Codex App 已安装或可用。当前候选的第 1 层确定性单测、类型检查、构建与 release smoke 尚待 Task 12 fresh verification，不能沿用旧五模型阶段的检查结果宣称通过。

当前尚未执行真实官方安装。项目代码绝不直接读取或写入活动 `~/.codex/config.toml`；只有 `four-llm-v1` 同批八项全部 passed、隔离验收完成、阻断状态包重新收敛为 ready 权限包，并取得针对本次动作的明确许可后，维护者才可使用官方 `codex plugin` 命令。当前仍有两项注册表能力 pending，因此真实安装授权准备处于 blocked / not ready。任何真实安装、升级或回滚都必须逐次授权，且不得用手工编辑配置代替官方机制。

完整流程见 [运维说明](docs/operations.md)，与旧工具的共存边界见 [迁移说明](docs/migration-from-codex-cc-tools.md)，四层门禁状态见 [发布验收清单](docs/release/checklist.md)。

## 模型证据

- 当前 Kimi 只支持 K3；K2.7 记录仅作为历史证据保留，见 [Kimi 真实能力门禁](docs/smoke/kimi.md)。
- Gemini 已退役，不再是当前 provider；旧 Google / `proxy-10808` 路由、额度失败和 blocked 批次只作为历史证据保留，见 [Pi / Gemini 退役历史](docs/smoke/pi-gemini.md)。
- 三条 Ark 路线全部固定直连；Coding Plan 的 review 原始门禁通过但 delegate 失败，成对策略使两项注册表能力均为 pending；两个 Agent Plan profile 各自的 review/delegate 均为 passed，见 [Ark / Pi 真实能力门禁](docs/smoke/ark.md)。

终端用户不需要手工维护 Pi 模型配置；Pi 使用由本项目在应用缓存下生成的版本化隔离配置，不读取或修改用户日常 `~/.pi/agent`。

## 开发验证

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated
```

真实 Kimi/Pi 烟测会实际消耗本机计划额度，并使用全机进程快照检查残留，因此只在精确能力门禁中串行运行。例如：

```powershell
npm run smoke:kimi -- --llm kimi-k3 --task review
```

## 安全边界

- 子进程只继承最小环境白名单；凭据仅按逻辑 LLM 配置显式传入。
- 四个活动逻辑 LLM 均使用 `direct`；子进程会清除从父进程继承的 HTTP(S)/ALL proxy。
- 诊断、错误和模型输出在离开适配器前进行令牌与认证头脱敏。
- 取消、硬超时和异常退出会触发进程树清理；并发按固定模型或共享 provider 配额池限制。
- 两个 Agent Plan 逻辑 LLM 共享并发上限为 1 的配额池。
- 委派一旦开始不会自动重试，避免重复写入。

## 发布状态

当前版本为开发期 `0.1.0-alpha.1`，尚未执行 `npm publish`，也尚未获得真实官方安装许可。当前候选的第 1 层尚待 Task 12 fresh verification，未复核为 passed；第 2 层隔离官方插件生命周期已经通过。四模型八项能力处于 6 passed / 2 pending，新的 `four-llm-v1` 8/8 批次尚未执行，真实 Codex App 宿主门禁也尚未执行。因此当前只能称为“官方插件候选已完成隔离取证”，不能称为已安装、已替代旧工具或可公开发布。
