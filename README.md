# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个外部 LLM 工具：只读审阅 `external_review` 和自主委派 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

当前代码公开四个固定逻辑 LLM，所有活动子进程均使用直连网络策略：

- `kimi-k3`：本机 Kimi Code ACP，直连；
- `ark-coding-plan`：隔离 Pi RPC / Ark Coding Plan / `ark-code-latest`，直连；
- `ark-agent-plan`：隔离 Pi RPC / Ark Agent Plan / `ark-code-latest`，直连；
- `ark-agent-deepseek-v4-flash`：隔离 Pi RPC / Ark Agent Plan / `deepseek-v4-flash`，直连。

当前八项 review/delegate 能力均已通过机器可验证的能力资格索引。资格单位是一个精确的“逻辑 LLM × 任务”组合；每项记录固定运行时指纹，并引用不可变、已通过的真实 case evidence。相关运行时代码、模型绑定、路由、凭据来源或验收语义变化后，只有受影响能力会变为 stale 并需要重跑，不再因无关能力的临时额度或服务状态重复烧完整八项。Gemini 已从活动注册表、运行时、凭据与网络策略、doctor、smoke 和资格入口退役；既有 Gemini 调用只作为历史审计证据保留。

standing authorization 下的最新真实批次绑定 frozen commit `0113da97a6b1fef35cc4c45025caa9e36a002176`，批次 ID 为 `2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c`。标准入口和 `functions.exec` cell 各只有一个；批次按首错停在 ordinal 6，形成 6 completed / 5 passed、`blocked / case_failed`、`promotionEligible=false`，ordinal 7–8 为 notRun。没有 resume、retry、fallback、补跑、第二入口或第二批。manifest SHA-256 为 `f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`，20 个不可变证据文件由提交 `6b4217d` 保存。

ordinal 1–5 均 passed；ordinal 6 `ark-agent-plan/delegate` 的 provider、`ark-code-latest` 模型、direct route、Agent Plan 凭据来源、single-attempt 和零 retry/fallback 均正确，结果文件精确通过，但以 `account_quota_exceeded` 失败。ordinal 1 与 ordinal 6 的精确写入和精确 `git status --short` 都各观察到一次 `raw_input / exact-or-status_exact / success`，文件范围也只包含预期结果文件；这证明此前 Pi Windows shell 与资格假阳性缺口已经由真实批次闭合，当前失败不是本地 shell、validator、route 或 fallback 问题。

离线根因提交 `2a815c7` 与资格合同提交链 `e750052`、`b5a691f`、`3d85315`、`ceb8e9c` 已得到上述真实命令成功证据。所有六个已执行项均保持一次 client invocation、零 adapter/runtime retry、零 adapter/orchestrator fallback。immutable-evidence verifier 通过，批次后 Kimi ACP / Pi RPC / real-smoke 为 0/0/0，资格锁 absent。该批次的 `account_quota_exceeded` 仍是 Ark Agent Plan 当时的服务可用性事实，但不再撤销其它已通过能力，也不阻断 Coding Plan；需要实际调用 Agent Plan 时仍可能受当前账户额度影响。

此前 48 个测试文件、837 passed / 1 个平台条件 skipped / 0 failed 及 171 files / 15 Markdown/HTML / 3 plugin files 的 pack 数字只描述 `cb9434b...` 之前的历史候选。`v0.1.0` tagged candidate 的 fresh 矩阵已通过：53 个测试文件、890 passed / 1 skipped / 0 failed，类型检查、构建、8/8 能力索引、release smoke 与生产依赖审计均通过；tagged artifact 的 pack dry-run 为 228 个文件。

全量测试还暴露并闭合了一个既有 Kimi ACP 时序竞态：client 可能早于 child close 返回，98/100 时序探针可观察。提交 `4af8b34` 加入 close 等待、1000ms 有界失败、stdio 销毁与两个确定性回归测试；独立复审 PASS、无 P0–P3，最终 49 文件矩阵已包含该修复。Pi resolver 在生产隔离环境中找到 `C:\Program Files\Git\bin\bash.exe`，`ProgramFiles` 两键存在、代理变量为 0；精确 Ark Agent Plan 写入探针 exit 0、28 bytes、SHA-256 `81fcf915...`。

注册表现在保持 8 passed / 0 pending，并由 [`docs/smoke/evidence/capabilities.json`](docs/smoke/evidence/capabilities.json) 与 `npm run verify:capabilities` 约束。维护者本机已通过官方命令安装 0.1.0 插件并移除同名开发期直连；旧 `codex_cc_tools` 保持启用，项目没有直接读取或写入 `~/.codex/config.toml`，也没有调用或修改 Claude Code。真实资格实验的 standing authorization 仍有效，但只有能力指纹失效、证据失效或新增能力时才需要针对性重跑；临时额度恢复本身不触发全量重认证。现行规则见[能力粒度资格设计](docs/superpowers/specs/2026-07-29-capability-scoped-qualification-design.md)，历史批次执行边界仍见[执行承载手册](docs/release/four-llm-qualification-execution-runbook.md)。

2026-07-27 的 105 秒演练只证明 `exec / wait` 可跨越旧的短时前台阈值；后续真实批次证明同一 cell 可承载到协调器正常终态，但不证明四小时存活。standing authorization 下的真实批次仍须使用 active long-term goal、至少 14,400,000 毫秒的内层 shell timeout、短周期 wait 与现有锁/终态协议。详见[承载演练报告](docs/release/qualification-carrier-rehearsal.md)与[执行承载手册](docs/release/four-llm-qualification-execution-runbook.md)。

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

仓库已包含本地 marketplace、官方插件 manifest、直接 server-map `.mcp.json` 和自包含 MCP bundle。44 files / 584 passed、46 files / 759 passed 与 48 files / 837 passed 都只描述各自历史候选；当前 stable fresh 全量为 53 files / 890 passed / 1 skipped / 0 failed。第 2 层隔离官方插件生命周期与既有 `--check-report` 均已通过；公共 npm 验收脚本还会在每个待晋级版本上重新执行临时 home 的官方生命周期。这些证据都不代表活动 Codex App 已安装或可用。

维护者本机已于 2026-07-30 取得逐动作许可，并通过官方 `codex plugin` 命令安装 `codex-external-agents`；项目代码没有直接读取或写入活动 `~/.codex/config.toml`。后续又用官方命令移除同名开发期直连，旧 `codex_cc_tools` 保持 enabled。完整重启后的新任务暴露 0.1.0 的相对 runtime 入口没有工作目录；`0.1.1-beta.0` 已补齐 `cwd: "."`，由 GitHub Actions OIDC 发布到 npm `next` 并通过公共 registry 隔离验收，活动插件也已按官方 remove/add 升级。CLI 现在把该字段解析到 0.1.1-beta.0 缓存根目录，但不重启 App 立即创建的新任务仍只发现旧工具。随后一次窗口/UI 级“重启”也没有终止早于 beta 安装启动的后台 `codex.exe app-server`，因此不能算修复后的完整复验。当前实测边界是 CLI/新进程立即生效，桌面 App 工具清单需要彻底退出后台宿主后重新打开；真实 App 宿主门禁保持 partial，不能称为已替代旧工具。

完整流程见 [运维说明](docs/operations.md)，与旧工具的共存边界见 [迁移说明](docs/migration-from-codex-cc-tools.md)，四层门禁状态见 [发布验收清单](docs/release/checklist.md)。

## 模型证据

- 当前 Kimi 只支持 K3；K2.7 记录仅作为历史证据保留，见 [Kimi 真实能力门禁](docs/smoke/kimi.md)。
- Gemini 已退役，不再是当前 provider；旧 Google / `proxy-10808` 路由、额度失败和 blocked 批次只作为历史证据保留，见 [Pi / Gemini 退役历史](docs/smoke/pi-gemini.md)。
- 三条 Ark 路线全部固定直连；Coding Plan 最新批次的 review/delegate 都通过，两个 Agent Plan profile 的 review/delegate 也各有已验证的通过证据。八项当前资格的唯一机器入口是 [能力资格索引](docs/smoke/evidence/capabilities.json)，叙述与历史见 [Ark / Pi 真实能力门禁](docs/smoke/ark.md)。

终端用户不需要手工维护 Pi 模型配置；Pi 使用由本项目在应用缓存下生成的版本化隔离配置，不读取或修改用户日常 `~/.pi/agent`。

## 开发验证

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run verify:capabilities
npm run smoke:release
npm run acceptance:plugin:isolated
```

公共 beta 或 stable 已发布后，可从官方 registry 对精确版本运行一次不调用
真实模型、也不接触活动 Codex home 的消费者视角验收：

```powershell
npm run acceptance:npm-package -- --version 0.1.0
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

当前稳定版本为 `0.1.0`，npm `latest` 仍指向该版本；`next` 已由 GitHub Actions OIDC 更新为 `0.1.1-beta.0`。beta 的本地确定性矩阵为 53 files / 891 passed / 1 skipped / 0 failed，Node 20/22/24 CI、release smoke、8/8 能力索引、生产依赖审计、隔离官方插件生命周期和公共 npm 精确版本验收全部通过。维护者本机活动插件已升级到该 beta，CLI 已解析正确缓存工作目录；升级后无重启的新任务仍未加载插件工具，随后窗口级重启也没有结束旧后台宿主。因此完整真实 Codex App 宿主门禁等待后台进程真正退出并重开后的真实调用，仍为 partial。公开发布不构成其它活动 Codex 的安装授权，也不能称为已替代旧工具。
