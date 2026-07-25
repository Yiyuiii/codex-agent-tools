# Codex External Agents

## 用户原始要求

- 本项目必须与 `D:\Codes\codex-cc-tools` 隔离，使用独立仓库和代码目录。
- MCP 服务名为 `codex_external_agents`，公开工具名为 `external_review` 与 `external_delegate`。
- 两个工具都要求调用者显式传入 `llm`；调用者不选择 backend、provider 或代理。
- 每个逻辑 LLM 固定绑定一个执行后端。Pi 与 Kimi 可以共存。
- 项目完全不调用、不修改、不卸载本机 Claude Code。
- 不提供 Anthropic Claude、OpenAI/Codex 或独立 DeepSeek 后端；`deepseek-v4-flash` 只作为 Ark Agent Plan 内的固定模型路线提供。
- 原 `codex-cc-tools` 中其余可用来源尽量迁移到 Pi；Kimi 使用本机 Kimi Code。
- 终端用户不手工维护插件或 Pi 配置，由 Codex 随项目版本维护。
- 当前迁移不需要额外外部审阅，由 Codex 自主推进；未经明确授权不公开发布 npm。
- 2026-07-24：用户反馈自动修改 `~/.codex/config.toml` 后 Codex 无法正常运行，并已恢复原始配置。后续默认不得写入、替换或恢复该文件；优先使用只读检查、独立测试配置和生成候选配置。若未来确实无法绕开，必须先说明必要性、精确差异、验证与回滚方案，并取得用户针对该次写入的明确许可。
- 2026-07-25：用户同意改用 Codex 官方插件机制管理插件状态，但项目代码仍不得直接读写活动 `~/.codex/config.toml`。官方文档明确说明插件开关状态存储在该文件中，因此真实官方安装或升级属于可能触碰活动配置的操作；执行前必须先在隔离 `CODEX_HOME` 取证，再展示预计精确差异、验证与回滚，并取得针对该次操作的明确许可。
- 2026-07-25：目标模型面调整为 `kimi-k3`、`gemini-3.5-flash`、两个固定使用 `ark-code-latest` 的 Ark Plan 路线，以及 Ark Agent Plan 内的 `deepseek-v4-flash` 快速经济档。

## 当前事实状态

- 2026-07-18：产品设计和 Kimi、Pi/Gemini、Ark/cutover 三阶段实现已完成。公开面只有 `external_review` 与 `external_delegate`，`llm` 始终必填。
- 本机 Kimi Code 0.27.0 通过官方 ACP SDK 接入；当前公开面只保留 `kimi-k3`，其 review/delegate 两项真实门禁已通过并继续复用原证据。`kimi-k2.7` 与 `kimi-k2.7-highspeed` 的四项 passed 证据只作为历史记录保留，不再属于当前公开面，详见 [Kimi 真实能力门禁](docs/smoke/kimi.md)。
- 本机 `@earendil-works/pi-coding-agent` 0.80.10 通过严格 RPC JSONL 接入。版本化隔离配置位于应用自有缓存，不读取或修改用户 `~/.pi/agent`，也不保存真实凭据。
- Pi 桥覆盖命令关联、最终完成语义、工具证据、脱敏、心跳、取消/超时和 Windows 进程树清理。review 一旦出现 bash/edit/write 事件即以 `review_policy_violation` 失败；委派不自动重试，避免重复写入。
- `gemini-3.5-flash` 固定绑定 Pi/Google/同名模型/`proxy-10808`。2026-07-20 review/delegate 两项真实门禁均通过并启用，证据见 [Pi / Gemini 真实能力门禁](docs/smoke/pi-gemini.md)。
- 当前 Ark 公开面为三项固定 Pi/direct 路线：`ark-coding-plan` 使用 provider `ark-coding-plan` 与模型 `ark-code-latest`，其两项历史真实门禁继续有效；`ark-agent-plan` 与 `ark-agent-deepseek-v4-flash` 共享 provider `ark-agent-plan` 和并发上限 1，分别固定使用 `ark-code-latest` 与 `deepseek-v4-flash`，两者的 review/delegate 精确门禁当前均为 pending。旧 `ark-agent-glm-5.2` 与 `ark-agent-doubao-seed-2.0-pro` 证据只作为历史记录保留，不能用于晋级新路线，详见 [Ark / Pi 真实能力门禁](docs/smoke/ark.md)。
- Ark Coding 凭据候选依次为 `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING`；本机用户环境实际命中第三项。Agent Plan 使用 `OPENAI_API_KEY_DOUBAO`。MCP 只转发候选白名单，运行时再向 Pi 注入单个项目私有变量，doctor 只报告变量名而不报告值。
- 真实 Pi smoke 的残留进程检查使用全机快照，因此不同 smoke 必须串行执行。并行执行会把其它仍在运行的 smoke 进程误判为泄漏；2026-07-20 的最终门禁只采用串行证据。
- 历史实现包含 `install --replace-codex-cc-tools` 和 `restore --backup`，但这套应用内自检未能证明真实 Codex App 可正常启动。根据 2026-07-24 用户反馈，不得再对活动的 `~/.codex/config.toml` 执行这些命令；只能在显式测试副本上验证。
- 2026-07-25 官方插件实施任务 1 已由提交 `db60c67` 完成：公开 CLI 只保留只读 `doctor`，不再接受 `--config`，历史 install/uninstall/restore/cutover 源码与测试已删除，doctor 不再读取 Codex 配置或报告 MCP registration。该提交经独立规格与代码质量审阅通过，当前基线为 147 项测试和类型检查全绿。
- 2026-07-20：157 项测试、类型检查、构建、release smoke 和真实 stdio MCP 验收全绿；验收摘要 SHA-256 为 `0e4aca2d35c4e124a5f3b6ca60e8df440bfad27253d3e710334ba0fe29169d04`。
- 2026-07-20 的自动 cutover 当时通过文件级、MCP initialize/listTools 和 strict doctor 检查，但重启后的真实 Codex App 运行异常。用户已于 2026-07-24 恢复原始 `~/.codex/config.toml`。因此“新 MCP 已在活动配置中完全替代旧 MCP”的结论已撤销；当前真实配置内容以用户恢复结果为准，未经许可不读取或修改。
- 当前代码公开五个固定逻辑 LLM：`ark-agent-deepseek-v4-flash`、`ark-agent-plan`、`ark-coding-plan`、`gemini-3.5-flash`、`kimi-k3`。共 10 个任务组合，其中 Kimi K3、Gemini 与 Ark Coding Plan 的 6 项保留 passed，两个新 Agent Plan 路线的 4 项为 pending；pending 能力不会复用旧证据或回退到其它 LLM。网络策略只保留 `direct` 与 `proxy-10808`，仅 Gemini 使用后者。
- `codex-agent-tools` 在设计时没有同名 npm 包；发布前必须重新检查。当前不执行 `npm publish`。
- 2026-07-25：官方插件集成目标设计已经 Kimi K3 与 Ark Coding Plan 外部审阅收敛并由用户书面复核通过，见 [官方插件集成设计](docs/superpowers/specs/2026-07-25-official-plugin-integration-design.md)；逐任务方案见 [官方插件集成实施计划](docs/superpowers/plans/2026-07-25-official-plugin-integration.md)。任务 1 的只读 CLI 基线保持不变；任务 2 由 `c1ed473` 完成五项模型面，并由 `9c14d4e` 加固独立、不可变且强制 evidence 的质量门禁；任务 3 由 `74d3bc7` 创建仓库内 marketplace、官方插件 manifest 与自包含 MCP bundle，`a47c993` 把无 `node_modules` 临时目录内的 MCP initialize/listTools 固化为回归测试，`f8090bb` 隔离了测试所用 tsup 配置。各任务的独立规格审阅与代码质量审阅最终均通过；任务 3 阶段基线为 159 项测试、类型检查和构建全绿。
- 2026-07-25：本机 `plugin-creator` 自带校验脚本仍只接受旧式顶层 `mcpServers` 包装，但当前 Codex 官方插件文档明确允许 `.mcp.json` 使用直接 server map 或 `mcp_servers` 包装。仓库按官方文档采用直接 server map；任务 3 证明 bundle 自包含和 MCP 契约，任务 4 又用临时 `CODEX_HOME` 下的真实 Codex `plugin` CLI 证明官方安装器实际接受该格式。旧校验器报错不代表官方宿主失败。
- 2026-07-25：官方插件实施任务 4 已在 Codex CLI 0.135.0 和唯一临时 `CODEX_HOME` 中完成真实 marketplace add/list、plugin add/list、缓存副本 MCP 启动、plugin remove/list 与 marketplace remove/list，官方安装器接受直接 server map。实测缓存末级是 manifest 版本目录 `plugins/cache/<marketplace>/<plugin>/<version>/`，不是设计时预估的 `local/`；卸载后可保留空缓存父目录和官方状态文件，验收以官方列表语义回滚与残留可解释为准。脱敏、可重复取证见 [官方插件隔离状态报告](docs/release/plugin-isolated-state.md)；该报告明确不代表活动 Codex App 验收。
- 2026-07-25：任务 4 的真实 fake Pi 门禁发现 `execa` 默认 `extendEnv: true` 会把 MCP 父进程的 `ALL_PROXY` 重新注入 Pi 子进程。提交 `e967947` 已在 Pi 启动处设置 `extendEnv: false`，使子进程只接收项目构造的白名单环境；回归同时验证显式 10808 HTTP(S) 代理与必要系统路径仍保留。隔离脚本还验证精确凭据哨兵、快照竞态失败传播和异常 MCP 进程树清理。最终任务 4 由 `eb81a51`、`e967947`、`0ad3d5e`、`f048b5c`、`91109c7` 完成，独立规格与质量复审均通过，主线程复验为 169 项测试、类型检查、构建和隔离生命周期全绿；活动 `~/.codex/config.toml` 未被读取或修改。
- 2026-07-25：官方插件实施任务 5 由 `874db97` 把四个精确插件文件纳入 npm pack 与 release smoke，`8e59c3c`、`d235803` 将 bundle 的生产依赖检查从脆弱正则收敛为 release-only TypeScript AST 遍历。当前门禁识别静态 import/re-export、动态 import、任意位置的直接 `require` / `__require`，注释与字符串不误报，非字面量和解析错误 fail closed；TypeScript 不进入插件 runtime bundle。`npm pack --dry-run --json` 的插件面严格为 marketplace、plugin manifest、`.mcp.json` 与单文件 runtime 四项，不生成持久 `.tgz`；Codex plugin help 只在临时 `CODEX_HOME` 中运行，release smoke 不执行安装、卸载或发布。任务 5 最终独立规格与质量复审通过，主线程复验为 release assurance 24/24、全量 191/191、release smoke、类型检查和构建全绿。

## 架构与计划索引

- [产品设计历史基线](docs/superpowers/specs/2026-07-18-codex-external-agents-design.md)
- [当前官方插件集成设计](docs/superpowers/specs/2026-07-25-official-plugin-integration-design.md)
- [官方插件集成实施计划](docs/superpowers/plans/2026-07-25-official-plugin-integration.md)
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
