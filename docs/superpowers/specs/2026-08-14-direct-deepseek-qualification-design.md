# Direct DeepSeek 双计划资格设计

## 用户原始要求

- 恢复 Direct DeepSeek API，由 Pi RPC 承载。
- Direct DeepSeek provider 只启用 `deepseek-v4-flash`。
- 使用本机已有的宿主变量 `OPENAI_API_KEY_DEEPSEEK`，不得保存或输出其值。
- 既有 Kimi 与 Ark 路线继续保留；当前工作不触碰活动 `config.toml`、活动插件或 Claude Code。

## 当前事实

- Direct 路线的逻辑 ID、provider 与 model 均固定为 `deepseek-v4-flash`；Pi 子进程只接收 `CODEX_AGENT_DEEPSEEK_KEY`。
- Ark 与 Direct DeepSeek 的 Pi 配置分别位于 `.../pi/<version>/ark` 与 `.../pi/<version>/deepseek`，两份 `models.json` 不包含对方的 provider 或凭据占位符。
- 当前任务的实时工具注册表没有 `external_review` / `external_delegate`，所以当前任务没有加载本项目插件。
- 现行 `capabilities.json` 的八份历史 evidence 仍可由 immutable verifier 验证，但资格协议与共享 evidence 代码已变化，因此八项旧能力的运行时指纹全部 stale；Direct DeepSeek 独立批次已经 2/2 passed，并以精确 case source 写入索引为 current。
- 后续 `four-llm-v1` 刷新批次在首项 `ark-coding-plan/delegate` 因账户额度失败而 blocked；其余七项 notRun，完整候选保持 fail closed。

## 设计结论

资格生产协议保留两个当前计划：

1. `four-llm-v1`：原有四个逻辑 LLM 的八项 review/delegate，继续使用 Ark-only Pi 资格配置并在需要时定位 Kimi。
2. `direct-deepseek-v1`：只含 `deepseek-v4-flash/review` 与 `deepseek-v4-flash/delegate`，只使用 DeepSeek-only Pi 资格配置，不定位 Kimi，也不要求 Ark 凭据。

不把十项能力合并为一个新计划。资格 preflight 只有一个 `piConfigSha256`；Ark-only 与 DeepSeek-only 配置字节不同。混合批次只能放弃 provider 配置隔离，或让单一哈希错误代表两份配置。两个独立计划可以让每个 manifest、checkpoint、case evidence 与配置哈希形成闭合的一对一证据链。

## 执行与晋级

- 两个计划分别生成 fresh 内部执行引用；仓库只保存其 SHA-256。
- 每批只调用一次标准入口，严格串行、single-attempt、首错停、零 retry/resume/fallback。
- 先运行 `direct-deepseek-v1` 两项；形成可信终态并提交不可变 evidence 后，再在新的 clean frozen commit 上运行 `four-llm-v1` 八项。
- 任一批失败、blocked、interrupted 或证据校验失败，都停止当前批次并保留终态；不得在同一处理链补跑或覆盖。
- 能力粒度政策允许 Direct DeepSeek 的两个 passed case 在其独立批次后晋级，不因另一计划的外部额度失败而撤销；十项索引可同时表达 Direct 两项 current 与原八项 stale。完整 verifier 仍要求所有已启用能力 current，因此整个候选在 `four-llm-v1` 刷新成功前不可发布或安装。
- 最终必须重新通过类型检查、确定性全库测试、immutable/frozen verifier、隔离官方插件生命周期、release smoke 与精确 npm 包闭包。

## 外部状态边界

上述资格实验受现有 standing authorization 覆盖。它不授权读取或写入活动 `~/.codex/config.toml`，也不授权升级活动插件、调用 Claude Code、发布 npm、push、merge 或 fast-forward。活动插件升级必须在隔离安装取证和完整发布门禁之后，另行展示精确动作、验证与回滚方案并取得该次明确许可。
