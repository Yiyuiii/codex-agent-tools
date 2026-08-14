# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个外部 LLM 工具：只读审阅 `external_review` 和自主委派 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

当前开发候选登记五个固定逻辑 LLM，所有子进程均使用直连网络策略：

- `kimi-k3`：本机 Kimi Code ACP，直连；
- `ark-coding-plan`：隔离 Pi RPC / Ark Coding Plan / `ark-code-latest`，直连；
- `ark-agent-plan`：隔离 Pi RPC / Ark Agent Plan / `ark-code-latest`，直连；
- `ark-agent-deepseek-v4-flash`：隔离 Pi RPC / Ark Agent Plan / `deepseek-v4-flash`，直连。
- `deepseek-v4-flash`：隔离 Pi RPC / DeepSeek API / `deepseek-v4-flash`，直连；DeepSeek provider 内不登记其它模型。

Ark 与 Direct DeepSeek 使用分离的版本化 Pi 配置目录；任一路线都不加载另一侧 provider 或凭据占位符。

已发布的 `0.1.1` 仍是四个逻辑 LLM；它曾通过真实宿主加载验收，但 2026-08-13/14 当前任务的实时工具注册表没有本项目的两个工具，不能声称当前任务正在使用插件。它的最新真实批次在同一冻结候选上完成八项 review/delegate：8/8 passed、每项单次 client invocation、零 adapter/runtime retry、零 adapter/orchestrator fallback，且 owned process 全部排空。Direct DeepSeek 开发候选已确认宿主 `OPENAI_API_KEY_DEEPSEEK` 存在，但尚未取得两项真实资格证据；本次资格协议变化属于 Kimi/Pi 共享指纹输入，所以八项旧能力当前也全部 stale。因此当前开发候选的 `npm run verify:capabilities` 必须 fail closed，不能发布、安装或声称 Direct DeepSeek 已可调用。详情见 [Direct DeepSeek 接入状态](docs/smoke/deepseek.md)。

资格单位是一个精确的“逻辑 LLM × 任务”组合；历史 batch manifest 与 case evidence 永久不可变，不以额度恢复、文档更新或注册表旧 `passed` 文案替代当前指纹验证。最新终态、执行边界和恢复条件只在[执行承载手册](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/four-llm-qualification-execution-runbook.md)维护，运维与发布状态只在[运维说明](docs/operations.md)维护。Gemini 已从活动注册表、运行时、凭据与网络策略、doctor、smoke 和资格入口退役；既有 Gemini 调用只作为历史审计证据保留。

现行索引仍只保存已发布四路线的八项不可变证据；Direct DeepSeek 的 review/delegate 保持 pending，不以占位条目、旧 Ark Agent Plan 同名模型证据或手工改写指纹代替真实资格。当前源码指纹与索引不匹配时，唯一发布权威 `npm run verify:capabilities` 会拒绝候选。`0.1.1` 已由 GitHub Actions OIDC 发布到 npm `latest`、通过公共精确包隔离验收并升级为活动 installed/enabled 插件。维护者已跳过普通 Stop 交互验收，真实 `cancelled + owned-zero` 保持 unverified，不得暗示 PASS。2026-08-07 在新插件真实 Kimi 窄 review/delegate 通过且旧工具当前无可用后端后，旧 `codex_cc_tools` 经独立授权使用官方 MCP 命令移除；项目没有直接读取或写入 `~/.codex/config.toml`，也没有调用或修改 Claude Code。现行资格规则见[能力粒度资格设计](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/superpowers/specs/2026-07-29-capability-scoped-qualification-design.md)。

2026-07-27 的 105 秒演练只证明 `exec / wait` 可跨越旧的短时前台阈值；后续真实批次证明同一 cell 可承载到协调器正常终态，但不证明四小时存活。standing authorization 下的真实批次仍须使用 active long-term goal、至少 14,400,000 毫秒的内层 shell timeout、短周期 wait 与现有锁/终态协议。详见[承载演练报告](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/qualification-carrier-rehearsal.md)与[执行承载手册](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/four-llm-qualification-execution-runbook.md)。

项目不会调用、修改或卸载本机 Claude Code，也不提供 Anthropic Claude 或 OpenAI/Codex 后端。Direct DeepSeek 只通过隔离 Pi RPC 承载固定的 `deepseek-v4-flash`。

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

维护者本机已通过逐动作许可和官方 `codex plugin` 命令安装、升级 `codex-external-agents`；项目代码没有直接读取或写入活动 `~/.codex/config.toml`。`0.1.1` 发布并完整重启后，新任务已发现 `external_review` / `external_delegate`；发布后真实 Kimi K3 窄 review 为 38.291 秒，隔离 delegate 为 13.913 秒，文件、命令与 owned-zero 均经独立复核。随后维护者独立授权旧工具退役，`codex mcp remove codex_cc_tools` 成功且全局提示词已改用两个新工具。维护者再次完整重启后，新任务工具发现面与官方 MCP 列表均不含旧服务；新宿主中的 Kimi K3 窄 review 在 13.215 秒返回精确 `RESTART_OK`，零诊断、零文件变化。真实 App 普通 Stop 仍为 skipped / unverified，因此替代结论只覆盖日常 review/delegate 路径，不覆盖未完成的宿主取消证明。

完整流程见 [运维说明](docs/operations.md)，与旧工具的共存边界见 [迁移说明](docs/migration-from-codex-cc-tools.md)，四层门禁状态见 [发布验收清单](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/checklist.md)。

## 模型证据

- 当前 Kimi 只支持 K3；K2.7 记录仅作为历史证据保留，见 [Kimi 真实能力门禁](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/kimi.md)。
- Gemini 已退役，不再是当前 provider；旧 Google / `proxy-10808` 路由、额度失败和 blocked 批次只作为历史证据保留，见 [Pi / Gemini 退役历史](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/pi-gemini.md)。
- 三条 Ark 路线全部固定直连；六项 Ark 能力与两项 Kimi 能力均已由当前候选的新 passed evidence 重新确认，叙述与历史见 [Ark / Pi 真实能力门禁](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/smoke/ark.md)。

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
npm run acceptance:npm-package -- --version 0.1.1
```

真实 Kimi/Pi 烟测会实际消耗本机计划额度，并以本次调用的 `ownedProcessDrained` / Job 归零证据检查残留，不扫描全机或要求无关 Kimi/Pi 进程为空，因此只在精确能力门禁中串行运行。例如：

```powershell
npm run smoke:kimi -- --llm kimi-k3 --task review
```

## 安全边界

- 子进程只继承最小环境白名单；凭据仅按逻辑 LLM 配置显式传入。
- 五个登记逻辑 LLM 均使用 `direct`；子进程会清除从父进程继承的 HTTP(S)/ALL proxy。Direct DeepSeek 在资格完成前仍不可调用。
- 诊断、错误和模型输出在离开适配器前进行令牌与认证头脱敏。
- 调用方显式取消、单次显式 deadline 和宿主异常退出都会触发进程树清理；并发按固定模型或共享 provider 配额池限制。
- 两个 Agent Plan 逻辑 LLM 共享并发上限为 1 的配额池。
- 委派一旦开始不会自动重试，避免重复写入。

## 发布状态

`0.1.1` stable 已由 GitHub Actions OIDC 发布并完成公共本机验收；当时的活动官方插件为 installed/enabled 0.1.1，旧 `codex_cc_tools` 已经独立授权退役。该发布版本的能力索引快照为 8 current / 0 legacy；当前 Direct DeepSeek 开发候选因共享资格协议变化保持 8 stale + 2 missing，直到新的双计划资格证据与十项索引通过 verifier。

维护者于 2026-08-07 终止继续重试普通 Stop observer。两次会话都没有形成 PASS receipt，因此 `0.1.1` 只通过严格 `skipped_by_maintainer / host_stop_unverified` 决策状态晋级；该状态硬锁到 `0.1.1-beta.4 → 0.1.1`，不能泛化到其它版本或门禁。stable 只由 GitHub Actions OIDC 发布，禁止本地 `npm publish`。

真实 App 普通 Stop 仍未验证；确定性取消、Job ownership、drain 测试和旧工具退役都不能改写这一事实。Kimi 0.34.0 的 swarm/思考强度探测见[研究记录](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/research/kimi-0.34-swarm-acp.md)：当前不新增无法由 ACP 保证的公开参数。
