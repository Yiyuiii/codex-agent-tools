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
- 当前 Pi 只发现 Google/Gemini 模型；Ark 来源需要由本项目生成隔离的 Pi 模型配置。
- `codex-agent-tools` 在设计时没有同名 npm 包；发布前必须重新检查。
- 用户已明确当前迁移不需要额外审阅，继续自主推进；下一阶段为 Pi/Gemini 适配。DeepSeek 不迁移。
- 2026-07-18：Pi/Gemini 阶段已开始；Pi 定位器和包版本化隔离配置已实现，默认位于应用自有缓存目录，不读取或修改 `~/.pi/agent`，配置内容不含凭据。

## 架构与计划索引

- [已批准的产品设计](docs/superpowers/specs/2026-07-18-codex-external-agents-design.md)
- [Kimi 可用 MVP 实施计划](docs/superpowers/plans/2026-07-18-kimi-mvp.md)
- [Pi/Gemini 适配实施计划](docs/superpowers/plans/2026-07-18-pi-gemini-adapter.md)
- [Ark 迁移与本机切换实施计划](docs/superpowers/plans/2026-07-18-ark-migration-and-cutover.md)

当前执行顺序为 Kimi MVP → Pi/Gemini → Ark 与本机切换。三个阶段分别形成可测试软件；尚未通过真实 smoke 的“逻辑 LLM × task”能力必须保持禁用。

## 开发约定

- 行为代码使用 TDD。
- 不修改 `D:\Codes\codex-cc-tools` 或本机 Claude Code。
- 每个“逻辑 LLM × 任务类型”通过独立真实 smoke 后，才能在内置注册表中启用。
- 对重要设计和复杂改动优先调用本机 Kimi 做独立 review；审阅结论必须由 Codex 复核后采用。
- 结构、API、模型清单、网络策略或迁移状态发生变化时，同步更新本文件和相关设计/计划文档。
