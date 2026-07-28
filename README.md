# codex-agent-tools

`codex-agent-tools` 为 Codex 提供两个外部 LLM 工具：只读审阅 `external_review` 和自主委派 `external_delegate`。MCP 服务名固定为 `codex_external_agents`。

当前代码公开四个固定逻辑 LLM，所有活动子进程均使用直连网络策略：

- `kimi-k3`：本机 Kimi Code ACP，直连；
- `ark-coding-plan`：隔离 Pi RPC / Ark Coding Plan / `ark-code-latest`，直连；
- `ark-agent-plan`：隔离 Pi RPC / Ark Agent Plan / `ark-code-latest`，直连；
- `ark-agent-deepseek-v4-flash`：隔离 Pi RPC / Ark Agent Plan / `deepseek-v4-flash`，直连。

当前八项 review/delegate 能力的过渡状态为 6 passed / 2 pending：`kimi-k3`、`ark-agent-plan` 与 `ark-agent-deepseek-v4-flash` 各两项 passed，只有 `ark-coding-plan` 的两项能力 pending。Gemini 已从活动注册表、运行时、凭据与网络策略、doctor、smoke 和资格入口退役；既有 Gemini 调用和 2026-07-26 五模型 blocked 批次只作为历史审计证据保留。pending 能力会明确拒绝，不会复用单项通过、旧模型证据或静默切换到其它 LLM。

最新真实批次绑定 frozen commit `07fd0d79e6885ee1e0af4a021e12170ef6c9f470`，批次 ID 为 `2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678`。标准入口只调用一次；同一 `functions.exec` cell 从 ordinal 1 完整执行八项，8 completed、7 passed，没有 resume、retry、fallback、补跑、第二入口或第二批。

ordinal 8 `ark-agent-deepseek-v4-flash/delegate` 的 provider、`deepseek-v4-flash` 模型、direct route、Agent Plan 凭据隔离、single-attempt、0 retry/fallback、命令数 6、精确 `git status --short` 观测与进程清理均正确，但结果文件完全缺失，因而以 `acceptance_failed` 结束。现有 evidence 只能证明最终制品缺失和已观察到的命令统计，不能证明精确写入命令是否形成、被执行、被改写或被跳过。manifest SHA-256 为 `eb3d2fd7827e4c14b35ffa97eb5d55bcfd2f0b8f6557eca04dab30241cb80556`，26 个批次文件由独立提交 `1d5d2c4` 保存。

用户批准的方案 B 已完成离线实现：超大 Pi 结束事件只安全保留 boolean `isError`；独立 Pi-only observer 产生 `source / match / outcome` 生命周期观察；qualification-only schema v3 producer 才可写入 `writeCommandObservations`；optional verifier 在该字段存在时严格校验。三个枚举只定位命令形成、工具结果与最终制品三层，不宣称已经识别四种具体根因。提示词、validator、公开 MCP、`commandsRun` / `commandCount`、provider/model/route/credential/retry/fallback、manifest/checkpoint/protocol 与历史 JSON 均未修改，新字段尚未由新真实批次实测。

实现与审阅提交链为 `8261736`、`652b13d` / `5e209e1` / `16cdad5`、`293e745`、`969e546` / `0852691` / `d9eb28a`、`4bd2439`。逐任务规格/质量审阅与整体规格/安全审阅均 PASS；本轮两次 Kimi 外部复核均无结论：设计级跨多实现面审阅约 604.5 秒 `timed_out`，只返回读取进度；实现后两个内嵌摘录的单一不变量审阅约 181.8 秒 `timed_out`，review 正文为空。二者不计 PASS、不阻断，也未重试同形任务。fresh 离线矩阵为 48 个测试文件、837 passed / 1 个平台条件 skipped / 0 failed；类型检查、构建、release smoke、隔离 check-report、两个 help 与 diff check 均通过。5/5 retained manifests 通过 immutable verifier，evidence 相对 `a8aa4d8` 无变更且 untracked 为 0；Kimi ACP / Pi RPC / real-smoke 为 0/0/0，资格锁 absent，持久 `.tgz` 为 0。`npm pack --dry-run --json` 的稳定文件面为 171 files / 15 Markdown/HTML / 3 plugin files；精确 byte size 不写入包内文档，避免打包元数据自引用。

注册表继续保持 6 passed / 2 pending，安装继续保持 `blocked / not ready`。当前未安装活动插件，未访问或修改 `~/.codex/config.toml`，未移除 `codex_cc_tools`，未调用或修改 Claude Code，也未发布、推送、合并或 fast-forward。本轮状态文档提交与 clean allow-empty freeze 完成后，最终 40 位 frozen SHA 将只由交接消息提供；第二个真实批次尚未授权。新的授权审阅页只作为仓库内人工审阅材料，由最终交接直接提供入口，页面本身不构成授权；既有[阻断结果审阅](docs/release/four-llm-qualification-result-review.html)及两份旧授权材料都只作历史审计。

2026-07-27 的 105 秒演练只证明 `exec / wait` 可跨越旧的短时前台阈值；后续真实批次证明同一 cell 可承载到协调器正常终态，但不证明四小时存活。未来另获授权的真实批次仍须使用 active long-term goal、至少 14,400,000 毫秒的内层 shell timeout、短周期 wait 与现有锁/终态协议。详见[承载演练报告](docs/release/qualification-carrier-rehearsal.md)与[执行承载手册](docs/release/four-llm-qualification-execution-runbook.md)。

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

仓库已包含本地 marketplace、官方插件 manifest、直接 server-map `.mcp.json` 和自包含 MCP bundle。较早的 44 files / 584 passed 与 46 files / 759 passed 矩阵只描述各自历史候选；当前 fresh 离线矩阵是 48 个测试文件、837 passed / 1 skipped / 0 failed，并通过类型检查、构建、release smoke、隔离 check-report、证据完整性、进程/锁与 clean-tree 检查。第 2 层隔离官方插件生命周期已经通过：Codex CLI 0.135.0 已在唯一临时 `CODEX_HOME` 中完成官方 marketplace/plugin 的 add、list、缓存副本启动与 remove 生命周期；这只证明隔离 CLI 生命周期，不代表活动 Codex App 已安装或可用。

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

当前版本为开发期 `0.1.0-alpha.1`，尚未执行 `npm publish`，也尚未获得真实官方安装许可。方案 B 离线实现、独立审阅与 48 files / 837 passed 的 fresh 验收已经完成；第 2 层隔离官方插件生命周期此前已经通过。四模型八项能力仍处于 6 passed / 2 pending；最新 `four-llm-v1` 批次完成八项但仅 7 passed，ordinal 8 因结果文件缺失而 `acceptance_failed`，未产生同批 8/8 资格。新诊断字段尚未经过新的真实批次实测，第二批尚未授权，真实 Codex App 宿主门禁也尚未执行。因此当前仍是 `blocked / not ready` 的官方插件候选，不能称为已安装、已替代旧工具或可公开发布。
