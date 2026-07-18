# Codex External Agents

## 用户原始要求

- 本项目必须与 `D:\Codes\codex-cc-tools` 隔离，使用独立仓库和代码目录。
- MCP 服务名为 `codex_external_agents`，公开工具名为 `external_review` 与 `external_delegate`。
- 两个工具都要求调用者显式传入 `llm`；调用者不选择 backend、provider 或代理。
- 每个逻辑 LLM 固定绑定一个执行后端。Pi 与 Kimi 可以共存。
- 项目完全不调用、不修改、不卸载本机 Claude Code。
- 不提供 Anthropic Claude、OpenAI/Codex 或 DeepSeek 模型来源。
- 原 `codex-cc-tools` 中其余可用来源尽量迁移到 Pi；Kimi 使用本机 Kimi Code。
- 终端用户不手工维护插件或 Pi 配置，由 Codex 随项目版本维护。

## 当前事实状态

- 2026-07-18：产品设计已获用户批准；Kimi MVP、Pi/Gemini、Ark 与本机切换三份实施计划已完成。
- 2026-07-18：Kimi MVP 的注册表、严格输入契约、环境/脱敏、进程树、ACP 适配、证据编排、MCP、安装/卸载/doctor 和发布烟测均已实现。公开面只有 `external_review` 与 `external_delegate`，且 `llm` 始终必填。
- 2026-07-18：`kimi-k2.7`、`kimi-k2.7-highspeed`、`kimi-k3` 的 review/delegate 六个真实门禁全部通过并已启用；证据索引见 [Kimi 真实能力门禁](docs/smoke/kimi.md)。
- 本机 Pi 是 `@earendil-works/pi-coding-agent` 0.80.10，支持 RPC JSONL 模式。
- 本机 Kimi Code 是 0.27.0，位于 `C:\Users\Administrator\.kimi-code\bin\kimi.exe`；本项目通过官方 ACP SDK 调用 `kimi acp`。
- 本项目的隔离 Pi 配置已能列出 Google/Gemini 内置模型，以及两个 Ark provider 下的三个批准模型；该配置不含真实凭据，也不读取用户日常 Pi 配置。
- `codex-agent-tools` 在设计时没有同名 npm 包；发布前必须重新检查。
- 用户已明确当前迁移不需要额外审阅，继续自主推进。DeepSeek 不迁移。
- 2026-07-18：Pi/Gemini 阶段已完成；Pi 定位器和包版本化隔离配置已实现，默认位于应用自有缓存目录，不读取或修改 `~/.pi/agent`，配置内容不含凭据。
- 2026-07-18：Pi RPC 桥已实现严格 LF JSONL、命令 ID 关联、`agent_settled` 最终完成语义、工具事件、脱敏诊断、心跳、取消/硬超时和进程树清理；fake RPC 的分片、CRLF、未知事件、异常退出、stderr 洪泛及孙进程用例已通过。
- 2026-07-18：Pi adapter 已接入默认 MCP 服务的 runtime map；固定 provider/model/route、隔离配置和模型身份均在适配层校验。Pi 工具开始/结束事件会归一化为命令/结果证据，review 出现 bash/edit/write 事件会以 `review_policy_violation` 失败。
- 2026-07-18：`gemini-3.5-flash` 固定绑定 `pi-rpc` / `google` / `gemini-3.5-flash` / `proxy-10808`。凭据按 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_GENERATIVE_AI_API_KEY` 只复制第一个非空值；doctor 已覆盖 Pi 版本、隔离配置、凭据变量名和门禁状态。
- 2026-07-18：Gemini 的 direct review/delegate 曾通过，但复核发现本机 direct 访问 Google endpoint 超时，`10808`/`11808` 均可达；固定绑定改为 `proxy-10808` 后旧证据只作历史回归参考。新路由 review 正确命中 Google/真实模型且通过环境、工作区和进程检查，但被共享免费层额度拒绝；新路由 review/delegate 均保持 pending，证据见 [Pi / Gemini 真实能力门禁](docs/smoke/pi-gemini.md)。
- 当前阶段为发布前本地验收和可回滚切换复核；Gemini/Ark 外部门禁在额度或凭据条件恢复后复跑，未全绿前真实 cutover 必须拒绝写入。
- 2026-07-18：三个 Ark 逻辑 LLM 已以 pending 状态注册并固定绑定到 Pi/provider/model/direct；Coding Plan 与 Agent Plan 各自共享一个并发为 1 的配额池。doctor 会复核配置哈希、两个 endpoint、三个 Pi 模型和凭据来源变量名。尚未完成六项真实门禁，因此 Ark 能力仍禁用。
- 2026-07-18：Ark 六项真实门禁均已执行但未通过，证据见 [Ark / Pi 真实能力门禁](docs/smoke/ark.md)。Coding Plan 两项因本机无 `ARK_API_KEY` / `VOLCENGINE_API_KEY` 失败；Agent Plan 四项正确命中真实模型，但因上游周额度耗尽失败，脱敏诊断给出的重置时间为 2026-07-20 00:00（UTC+8）。所有 Ark 能力继续 pending。
- 2026-07-18：Pi RPC 桥已修复 assistant `errorMessage` 伴随空内容时被误标 completed 的问题；现在会脱敏记录诊断并返回 failed，fake RPC 有回归测试。
- 2026-07-18：可回滚 cutover 已实现于 CLI `install --replace-codex-cc-tools`。readiness 未全绿时零写入；通过时锁定配置、创建时间戳备份、只删除旧 MCP 表、原子安装新 owned 表并做 MCP initialize/listTools 自检；失败自动恢复。`restore --backup` 可显式回滚。当前真实 Gemini/Ark 门禁 pending，因此实际 cutover 会按设计拒绝。
- 2026-07-18：Codex stdio MCP 安装块会生成 `env_vars` 凭据白名单，使服务能从 Codex 父环境接收 Gemini/Ark 的候选变量；MCP 再按逻辑 LLM 只转发命中的最小凭据。Kimi 不依赖这些变量。
- 2026-07-18：Pi adapter 只对 Google 免费层明确返回 `generate_content_free_tier_requests` 且重试窗口不超过 60 秒的 review 失败做一次可取消等待；delegate 不重试。Pi RPC 最终 assistant 状态会覆盖同次运行中的瞬时错误状态，瞬时诊断仍保留。
- 2026-07-18：本机 stdio MCP 验收已通过工具契约、Kimi highspeed review、K3 delegate、取消和无残留进程检查；K3 delegate 最新独立证据见 `docs/smoke/evidence/2026-07-18T10-35-18.032Z-kimi-k3-delegate.json`。Gemini 调用由 pending 门禁即时拒绝，因此端到端全绿仍受外部门禁阻塞。
- 2026-07-18：新 MCP 已以并存模式安装到真实 `~/.codex/config.toml`；旧 `codex_cc_tools` 表保留，新 `codex_external_agents` 表由本包拥有并包含凭据 `env_vars` 白名单。安装后配置 SHA-256 为 `06cbc866006bbcb12c8de1b9dd361ddd5507dd8d68a9f95bcc7ffdf23b1d83c5`，第二次安装逐字节幂等。Codex App 需要重启才会加载新 MCP；正式 cutover 仍等待 Gemini/Ark 全绿。
- 2026-07-18 19:14（UTC+8）：Gemini `proxy-10808` review 再次真实复跑，模型/路由/环境/工作区/进程检查正确，但一次有界复试后仍被相同 Google 免费层额度阻塞；新证据为 `docs/smoke/evidence/2026-07-18T11-14-05.781Z-gemini-3.5-flash-review-pi.json`。smoke 分类器已新增 `google_free_tier_quota`，后续证据会把该外部状态与一般 adapter failure 分开。
- 2026-07-18：批准凭据变量在 Windows 环境范围的存在性已核对（不读取或记录值）。`GEMINI_API_KEY` 与 `OPENAI_API_KEY_DOUBAO` 存在于 Process/User；`ARK_API_KEY`、`VOLCENGINE_API_KEY` 在 Process/User/Machine 均不存在，因此 Ark Coding 不是仅靠重启可恢复的继承问题。

## 架构与计划索引

- [已批准的产品设计](docs/superpowers/specs/2026-07-18-codex-external-agents-design.md)
- [Kimi 可用 MVP 实施计划](docs/superpowers/plans/2026-07-18-kimi-mvp.md)
- [Pi/Gemini 适配实施计划](docs/superpowers/plans/2026-07-18-pi-gemini-adapter.md)
- [Ark 迁移与本机切换实施计划](docs/superpowers/plans/2026-07-18-ark-migration-and-cutover.md)
- [0.1.0-alpha.1 本机替换验收记录](docs/release/checklist.md)

当前执行顺序为 Kimi MVP → Pi/Gemini → Ark 与本机切换。三个阶段分别形成可测试软件；尚未通过真实 smoke 的“逻辑 LLM × task”能力必须保持禁用。

## 开发约定

- 行为代码使用 TDD。
- 不修改 `D:\Codes\codex-cc-tools` 或本机 Claude Code。
- 每个“逻辑 LLM × 任务类型”通过独立真实 smoke 后，才能在内置注册表中启用。
- 对重要设计和复杂改动优先调用本机 Kimi 做独立 review；审阅结论必须由 Codex 复核后采用。
- 结构、API、模型清单、网络策略或迁移状态发生变化时，同步更新本文件和相关设计/计划文档。
