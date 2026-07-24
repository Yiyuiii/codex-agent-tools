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
- 当前迁移不需要额外外部审阅，由 Codex 自主推进；未经明确授权不公开发布 npm。
- 2026-07-24：用户反馈自动修改 `~/.codex/config.toml` 后 Codex 无法正常运行，并已恢复原始配置。后续默认不得写入、替换或恢复该文件；优先使用只读检查、独立测试配置和生成候选配置。若未来确实无法绕开，必须先说明必要性、精确差异、验证与回滚方案，并取得用户针对该次写入的明确许可。

## 当前事实状态

- 2026-07-18：产品设计和 Kimi、Pi/Gemini、Ark/cutover 三阶段实现已完成。公开面只有 `external_review` 与 `external_delegate`，`llm` 始终必填。
- 本机 Kimi Code 0.27.0 通过官方 ACP SDK 接入；`kimi-k2.7`、`kimi-k2.7-highspeed`、`kimi-k3` 的 review/delegate 六项真实门禁全部通过，证据见 [Kimi 真实能力门禁](docs/smoke/kimi.md)。
- 本机 `@earendil-works/pi-coding-agent` 0.80.10 通过严格 RPC JSONL 接入。版本化隔离配置位于应用自有缓存，不读取或修改用户 `~/.pi/agent`，也不保存真实凭据。
- Pi 桥覆盖命令关联、最终完成语义、工具证据、脱敏、心跳、取消/超时和 Windows 进程树清理。review 一旦出现 bash/edit/write 事件即以 `review_policy_violation` 失败；委派不自动重试，避免重复写入。
- `gemini-3.5-flash` 固定绑定 Pi/Google/同名模型/`proxy-10808`。2026-07-20 review/delegate 两项真实门禁均通过并启用，证据见 [Pi / Gemini 真实能力门禁](docs/smoke/pi-gemini.md)。
- `ark-coding-plan`、`ark-agent-glm-5.2`、`ark-agent-doubao-seed-2.0-pro` 固定绑定 Pi 中对应 provider/model/direct；Coding Plan 和 Agent Plan 各共享并发为 1 的 provider 配额池。2026-07-20 六项真实门禁全部通过并启用，证据见 [Ark / Pi 真实能力门禁](docs/smoke/ark.md)。
- Ark Coding 凭据候选依次为 `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING`；本机用户环境实际命中第三项。Agent Plan 使用 `OPENAI_API_KEY_DOUBAO`。MCP 只转发候选白名单，运行时再向 Pi 注入单个项目私有变量，doctor 只报告变量名而不报告值。
- 真实 Pi smoke 的残留进程检查使用全机快照，因此不同 smoke 必须串行执行。并行执行会把其它仍在运行的 smoke 进程误判为泄漏；2026-07-20 的最终门禁只采用串行证据。
- 历史实现包含 `install --replace-codex-cc-tools` 和 `restore --backup`，但这套应用内自检未能证明真实 Codex App 可正常启动。根据 2026-07-24 用户反馈，不得再对活动的 `~/.codex/config.toml` 执行这些命令；只能在显式测试副本上验证。
- 2026-07-20：157 项测试、类型检查、构建、release smoke 和真实 stdio MCP 验收全绿；验收摘要 SHA-256 为 `0e4aca2d35c4e124a5f3b6ca60e8df440bfad27253d3e710334ba0fe29169d04`。
- 2026-07-20 的自动 cutover 当时通过文件级、MCP initialize/listTools 和 strict doctor 检查，但重启后的真实 Codex App 运行异常。用户已于 2026-07-24 恢复原始 `~/.codex/config.toml`。因此“新 MCP 已在活动配置中完全替代旧 MCP”的结论已撤销；当前真实配置内容以用户恢复结果为准，未经许可不读取或修改。
- Kimi、Gemini、Ark 共七个逻辑 LLM、14 个任务组合现均有独立 passed 证据。禁用或未来 pending 能力不会回退到其它 LLM。
- `codex-agent-tools` 在设计时没有同名 npm 包；发布前必须重新检查。当前不执行 `npm publish`。

## 架构与计划索引

- [已批准的产品设计](docs/superpowers/specs/2026-07-18-codex-external-agents-design.md)
- [Kimi 可用 MVP 实施计划](docs/superpowers/plans/2026-07-18-kimi-mvp.md)
- [Pi/Gemini 适配实施计划](docs/superpowers/plans/2026-07-18-pi-gemini-adapter.md)
- [Ark 迁移与本机切换实施计划](docs/superpowers/plans/2026-07-18-ark-migration-and-cutover.md)
- [0.1.0-alpha.1 本机替换验收记录](docs/release/checklist.md)

## 开发约定

- 行为代码使用 TDD。
- 不修改 `D:\Codes\codex-cc-tools` 或本机 Claude Code。
- 每个“逻辑 LLM × 任务类型”通过独立真实 smoke 后，才能在内置注册表中启用。
- 真实 Kimi/Pi 能力门禁串行执行，并把脱敏证据持久化到 `docs/smoke/evidence/`。
- 结构、API、模型清单、网络策略或迁移状态发生变化时，同步更新本文件和相关设计/计划文档。
