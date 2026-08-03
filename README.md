# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个外部 LLM 工具：只读审阅 `external_review` 和自主委派 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

当前代码公开四个固定逻辑 LLM，所有活动子进程均使用直连网络策略：

- `kimi-k3`：本机 Kimi Code ACP，直连；
- `ark-coding-plan`：隔离 Pi RPC / Ark Coding Plan / `ark-code-latest`，直连；
- `ark-agent-plan`：隔离 Pi RPC / Ark Agent Plan / `ark-code-latest`，直连；
- `ark-agent-deepseek-v4-flash`：隔离 Pi RPC / Ark Agent Plan / `deepseek-v4-flash`，直连。

八项 review/delegate 的旧索引仍引用不可变、已通过的真实 case evidence，但当前运行时变更已使八项能力指纹全部 stale。当前宿主实现、原生辅助层与冻结证据已经完成；最新真实批次在首项 `ark-coding-plan/delegate` 因服务报告 `account_quota_exceeded` 首错停止，其余七项未运行。新证据形成前，`capabilities.json` 保持原样，`npm run verify:capabilities` 必须以脱敏错误和退出码 1 fail closed，因此此分支不可发布。

资格单位是一个精确的“逻辑 LLM × 任务”组合；历史 batch manifest 与 case evidence 永久不可变，不以额度恢复、文档更新或注册表旧 `passed` 文案替代当前指纹验证。最新终态、执行边界和恢复条件只在[执行承载手册](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/four-llm-qualification-execution-runbook.md)维护，运维与发布状态只在[运维说明](docs/operations.md)维护。Gemini 已从活动注册表、运行时、凭据与网络策略、doctor、smoke 和资格入口退役；既有 Gemini 调用只作为历史审计证据保留。

注册表仍保留 8 passed / 0 pending 的历史文案，[`docs/smoke/evidence/capabilities.json`](docs/smoke/evidence/capabilities.json) 是当前候选的现行索引；当前源码指纹与索引不匹配时，唯一发布权威 `npm run verify:capabilities` 会拒绝候选。维护者本机已通过官方命令把活动插件升级到 `0.1.1-beta.1` 并移除同名开发期直连；旧 `codex_cc_tools` 保持启用，项目没有直接读取或写入 `~/.codex/config.toml`，也没有调用或修改 Claude Code。现行资格规则见[能力粒度资格设计](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/superpowers/specs/2026-07-29-capability-scoped-qualification-design.md)。

2026-07-27 的 105 秒演练只证明 `exec / wait` 可跨越旧的短时前台阈值；后续真实批次证明同一 cell 可承载到协调器正常终态，但不证明四小时存活。standing authorization 下的真实批次仍须使用 active long-term goal、至少 14,400,000 毫秒的内层 shell timeout、短周期 wait 与现有锁/终态协议。详见[承载演练报告](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/qualification-carrier-rehearsal.md)与[执行承载手册](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/four-llm-qualification-execution-runbook.md)。

项目不会调用、修改或卸载本机 Claude Code，也不提供 Anthropic Claude、OpenAI/Codex 或独立 DeepSeek 后端。

## 执行预算与取消合同

- `timeoutMs` 是调用方为单次请求显式设置的可选值；它不是外部 CLI 的全局配置，也不会持久化。
- 省略时，Kimi 与 Pi 都不设置模型执行 deadline，让外部 CLI 使用自身原生执行预算；不存在 profile 级的 600 秒或 900 秒执行上限。
- 显式 deadline 到期只结束该次请求，并返回超时语义；普通调用方取消保持 cancelled 语义。
- stdio 的 end、close、error 与 SIGINT、SIGTERM 都会触发幂等 session shutdown；shutdown 调用 `server.close()`，由 SDK abort handlers 取消在途请求，再等待 owned 子进程树与 tracker drain，最后才允许 session 结束。
- Pi 生产路径的原生 retry 策略保持不变；只在资格模式中沿用既有的 single-attempt、零 retry/fallback 合同。

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

要求 Node.js 24+；当前真实宿主为 v24.14.1，公开验证只覆盖这套维护者本机环境，不构成其它 Node 或 Windows 版本的兼容认证。还需安装并登录本机 Kimi Code；Kimi 使用本机 OAuth 会话，本项目不复制或保存其令牌。

仓库已包含本地 marketplace、官方插件 manifest、直接 server-map `.mcp.json` 和自包含 MCP bundle。当前发布线只验证维护者这套 Windows x64 / Node 24 宿主；确定性、隔离插件、包闭包和真实宿主门禁的现行结果统一见[发布验收清单](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/checklist.md)，README 不重复维护易过期的测试计数。

维护者本机已于 2026-07-30 取得逐动作许可，并通过官方 `codex plugin` 命令安装 `codex-external-agents`；项目代码没有直接读取或写入活动 `~/.codex/config.toml`。后续又用官方命令移除同名开发期直连，旧 `codex_cc_tools` 保持 enabled。`0.1.1-beta.0` 补齐 `cwd: "."` 后由 GitHub Actions OIDC 发布到 npm `next` 并完成官方升级。维护者真正终止后台宿主并重开后，新任务已发现 `external_review` / `external_delegate` 与旧两项工具共存，真实 Kimi K3 review 通过；Ark Coding Plan review 在启动 Pi 前报告缺少凭据。根因是插件 manifest 没有声明 stdio MCP `env_vars`，宿主按隔离边界没有把父 App 中已存在的 Coding Plan 凭据转发给 MCP。历史阶段的 `0.1.1-beta.1` 已发布到 npm `next` 并已安装到活动官方插件；该版本增加了精确四项变量名白名单且不保存任何值，其 handoff 取消门禁失败促成本轮修复。真实 App 宿主门禁仍为 partial，不能称为已替代旧工具。

完整流程见 [运维说明](docs/operations.md)，与旧工具的共存边界见 [迁移说明](docs/migration-from-codex-cc-tools.md)，四层门禁状态见 [发布验收清单](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/checklist.md)。

## 模型证据

- 当前 Kimi 只支持 K3；K2.7 记录仅作为历史证据保留，见 [Kimi 真实能力门禁](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/kimi.md)。
- Gemini 已退役，不再是当前 provider；旧 Google / `proxy-10808` 路由、额度失败和 blocked 批次只作为历史证据保留，见 [Pi / Gemini 退役历史](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/pi-gemini.md)。
- 三条 Ark 路线全部固定直连；旧八项索引中的六项 Ark 能力均有历史 passed evidence。当前候选必须等待 stale 能力证据更新后由 verifier 重新确认，叙述与历史见 [Ark / Pi 真实能力门禁](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/ark.md)。

终端用户不需要手工维护 Pi 模型配置；Pi 使用由本项目在应用缓存下生成的版本化隔离配置，不读取或修改用户日常 `~/.pi/agent`。

## 开发验证

```powershell
npm ci
npm run gate:offline
npm run acceptance:plugin:isolated:built
```

`gate:offline`只构建一次候选，随后依次复用该候选完成类型检查、单 worker 确定性测试与 release smoke；隔离插件验收继续复用同一 bundle。若只单独运行插件验收，使用自包含的`npm run acceptance:plugin:isolated`，它会先构建候选。

公共 beta 或 stable 已发布后，可从官方 registry 对精确版本运行一次不调用
真实模型、也不接触活动 Codex home 的消费者视角验收：

```powershell
npm run acceptance:npm-package -- --version 0.1.0
```

真实 Kimi/Pi 烟测会实际消耗本机计划额度，并以本次调用的 `ownedProcessDrained` / Job 归零证据检查残留，不扫描全机或要求无关 Kimi/Pi 进程为空，因此只在精确能力门禁中串行运行。例如：

```powershell
npm run smoke:kimi -- --llm kimi-k3 --task review
```

## 安全边界

- 子进程只继承最小环境白名单；凭据仅按逻辑 LLM 配置显式传入。
- 四个活动逻辑 LLM 均使用 `direct`；子进程会清除从父进程继承的 HTTP(S)/ALL proxy。
- 诊断、错误和模型输出在离开适配器前进行令牌与认证头脱敏。
- 调用方显式取消、单次显式 deadline 和宿主异常退出都会触发进程树清理；并发按固定模型或共享 provider 配额池限制。
- 两个 Agent Plan 逻辑 LLM 共享并发上限为 1 的配额池。
- 委派一旦开始不会自动重试，避免重复写入。

## 发布状态

当前稳定版本为 `0.1.0`，npm `latest` 仍指向该版本；npm `next` 仍是已发布的 `0.1.1-beta.1`。本轮正在闭合原生执行预算、stdio 取消传播和 owned 进程树清理的当前宿主离线实现与冻结，但八项能力指纹因此 stale，当前分支不可发布。

晋级顺序只有一条：当前宿主离线实现与冻结完成后，只重跑 stale、缺失、新增或证据失效的能力并更新同一索引；verifier 恢复通过后，由 GitHub Actions OIDC 把下一个 beta 发布到 npm `next`；再从公共 npm 安装精确版本、完成官方插件升级和完整 App 重启，并用真实 Stop/interrupt 证明 cancelled/interrupted、无完成标记、SDK abort 到达且 owned descendants zero；全部通过后才由 GitHub Actions OIDC 发布 stable。禁止本地 `npm publish`，也不预先指定下一个 beta 的版本号。

beta.1 handoff 只暴露了缺口，不是 stable Stop gate 的唯一证据。旧 `codex_cc_tools` 保持 enabled。
