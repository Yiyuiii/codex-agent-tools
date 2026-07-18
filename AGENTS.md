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

- 2026-07-18：产品设计已获用户批准，尚未开始实现。
- 本机 Pi 是 `@earendil-works/pi-coding-agent` 0.80.10，支持 RPC JSONL 模式。
- 本机 Kimi Code 是 0.27.0，位于 `C:\Users\Administrator\.kimi-code\bin\kimi.exe`；K3 非交互 JSONL smoke 已成功。
- 当前 Pi 只发现 Google/Gemini 模型；Ark 来源需要由本项目生成隔离的 Pi 模型配置。
- `codex-agent-tools` 在设计时没有同名 npm 包；发布前必须重新检查。

## 架构与计划索引

- [已批准的产品设计](docs/superpowers/specs/2026-07-18-codex-external-agents-design.md)
- 实施计划将在 `docs/superpowers/plans/` 下维护。

## 开发约定

- 行为代码使用 TDD。
- 不修改 `D:\Codes\codex-cc-tools` 或本机 Claude Code。
- 每个“逻辑 LLM × 任务类型”通过独立真实 smoke 后，才能在内置注册表中启用。
- 对重要设计和复杂改动优先调用本机 Kimi 做独立 review；审阅结论必须由 Codex 复核后采用。
- 结构、API、模型清单、网络策略或迁移状态发生变化时，同步更新本文件和相关设计/计划文档。

