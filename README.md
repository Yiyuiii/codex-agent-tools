# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个外部 LLM 工具：只读审阅 `external_review` 和自主委派 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

当前代码公开四个固定逻辑 LLM，所有活动子进程均使用直连网络策略：

- `kimi-k3`：本机 Kimi Code ACP，直连；
- `ark-coding-plan`：隔离 Pi RPC / Ark Coding Plan / `ark-code-latest`，直连；
- `ark-agent-plan`：隔离 Pi RPC / Ark Agent Plan / `ark-code-latest`，直连；
- `ark-agent-deepseek-v4-flash`：隔离 Pi RPC / Ark Agent Plan / `deepseek-v4-flash`，直连。

当前八项 review/delegate 能力的过渡状态为 6 passed / 2 pending：`kimi-k3`、`ark-agent-plan` 与 `ark-agent-deepseek-v4-flash` 各两项 passed，只有 `ark-coding-plan` 的两项能力 pending。Gemini 已从活动注册表、运行时、凭据与网络策略、doctor、smoke 和资格入口退役；既有 Gemini 调用和 2026-07-26 五模型 blocked 批次只作为历史审计证据保留。pending 能力会明确拒绝，不会复用单项通过、旧模型证据或静默切换到其它 LLM。

2026-07-27 在 frozen commit `652e14ac637bfc04d90c448179ecc5838f2f8450` 上只调用一次标准入口，启动 `four-llm-v1` 批次 `2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa`。一个 `functions.exec` cell 内的单个四小时预算前台 shell 持续承载约 979 秒并取得协调器正常终态；没有发生 cell 丢失或 recovery。

ordinal 1 Ark Coding Plan delegate、ordinal 2 Ark Coding Plan review 与 ordinal 3 Kimi review 通过。ordinal 4 Kimi delegate 的实际模型、direct 路由、文件范围、14-byte 单行结果、进程清理与 `1 / 0 / 0 / false / false` telemetry 均正确，但严格检查没有观测到一个与 `git status --short` 完全相等的命令数组项，因此以 `acceptance_failed` 停止；ordinal 5–8 均未运行。证据协议不保存原始命令正文，所以不能断言该状态检查是完全省略还是被合并进其它命令，也不能据此放宽 validator。

该 manifest 为 schema v2、`blocked / case_failed`、`promotionEligible=false`，包含 4 个 completed case、4 个 notRun、9 个 checkpoint，且 `uncommittedEvidence=null`；SHA-256 为 `d7be5e6ba3884075d80fe399dd3c2d72caaa1a3833f92e529928655e623b7b69`。immutable-evidence verifier 通过，批次后 Kimi ACP / Pi RPC / real-smoke 为 0/0/0，资格锁不存在；14 个新证据文件由独立提交 `4f816f0` 保存。没有 retry、fallback、resume、跳项、补跑或第二批。

同批前三项通过不能与历史证据拼接晋级，注册表继续保持 6 passed / 2 pending，安装继续保持 `blocked / not ready`。本轮授权已经消费；下一步先审阅 Kimi 资格命令观测的离线修复设计，不请求新的真实批次。当前最小证据见[四模型八项资格批次阻断结果审阅](docs/release/four-llm-qualification-result-review.html)；[本轮重新授权材料](docs/release/four-llm-qualification-reauthorization-review.html)与[更早授权材料](docs/release/four-llm-qualification-authorization-review.html)都只作已消费历史记录。

2026-07-27 的 105 秒演练只证明 `exec / wait` 可跨越旧的短时前台阈值；本轮约 979 秒真实批次进一步证明同一 cell 可承载到协调器正常终态，但两者都不证明四小时存活或任何未执行模型资格。未来真实批次仍须使用 active long-term goal、至少 14,400,000 毫秒的内层 shell timeout、短周期 wait 与现有锁/终态协议，并在新 frozen candidate 上取得另一份明确授权。详见[承载演练报告](docs/release/qualification-carrier-rehearsal.md)与[执行承载手册](docs/release/four-llm-qualification-execution-runbook.md)。

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

仓库已包含本地 marketplace、官方插件 manifest、直接 server-map `.mcp.json` 和自包含 MCP bundle。当前阻断结果收敛候选的第 1 层确定性验证已经新鲜通过：类型检查、44 个测试文件（584 passed / 1 个平台条件 skipped / 0 failed）、完整构建、release smoke、隔离报告 check-only、资格入口 help 与 diff check 全部成功，生产进程分类器复核 Kimi ACP、Pi RPC、real-smoke 均为 0。当前候选的第 2 层隔离官方插件生命周期也已经通过：Codex CLI 0.135.0 已在唯一临时 `CODEX_HOME` 中完成官方 marketplace/plugin 的 add、list、缓存副本启动与 remove 生命周期；这只证明隔离 CLI 生命周期，不代表活动 Codex App 已安装或可用。

当前尚未执行真实官方安装。项目代码绝不直接读取或写入活动 `~/.codex/config.toml`；只有 `four-llm-v1` 同批八项全部 passed、隔离验收完成、阻断状态包重新收敛为 ready 权限包，并取得针对本次动作的明确许可后，维护者才可使用官方 `codex plugin` 命令。当前仍有两项注册表能力 pending，最新批次也以 `blocked / case_failed` 结束，因此真实安装授权准备处于 blocked / not ready。任何真实安装、升级或回滚都必须逐次授权，且不得用手工编辑配置代替官方机制。

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

当前版本为开发期 `0.1.0-alpha.1`，尚未执行 `npm publish`，也尚未获得真实官方安装许可。当前候选的第 1 层确定性验证和第 2 层隔离官方插件生命周期均已通过。四模型八项能力仍处于 6 passed / 2 pending；最新 `four-llm-v1` 批次已由同一 execution cell 正常承载到协调器终态，但在第 4 项 Kimi delegate 的严格命令观测验收处形成 `blocked / case_failed`，未产生同批 8/8 资格，真实 Codex App 宿主门禁也尚未执行。因此当前只能称为“第 1、2 层已通过、模型资格被阻断的官方插件候选”，不能称为已安装、已替代旧工具或可公开发布。
