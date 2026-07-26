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
- 本机 Kimi Code 0.27.0 通过官方 ACP SDK 接入；当前公开面只保留 `kimi-k3`，2026-07-25 串行复跑的 review/delegate 两项真实门禁均通过并生成新证据。`kimi-k2.7` 与 `kimi-k2.7-highspeed` 的四项 passed 证据只作为历史记录保留，不再属于当前公开面，详见 [Kimi 真实能力门禁](docs/smoke/kimi.md)。
- 本机 `@earendil-works/pi-coding-agent` 0.80.10 通过严格 RPC JSONL 接入。版本化隔离配置位于应用自有缓存，不读取或修改用户 `~/.pi/agent`，也不保存真实凭据。
- Pi 桥覆盖命令关联、最终完成语义、工具证据、脱敏、心跳、取消/超时和 Windows 进程树清理。review 一旦出现 bash/edit/write 事件即以 `review_policy_violation` 失败；委派不自动重试，避免重复写入。
- `gemini-3.5-flash` 固定绑定 Pi/Google/同名模型/`proxy-10808`。2026-07-25 串行复跑中 review passed、delegate 因 `google_free_tier_quota` failed；依据成对门禁策略，注册表两项当前均为 pending，证据见 [Pi / Gemini 真实能力门禁](docs/smoke/pi-gemini.md)。
- 当前 Ark 公开面为三项固定 Pi/direct 路线：`ark-coding-plan` 使用 provider `ark-coding-plan` 与模型 `ark-code-latest`，2026-07-25 复跑中 review passed、delegate 因结果文件内容不符 failed，因此注册表两项均为 pending；`ark-agent-plan` 与 `ark-agent-deepseek-v4-flash` 共享 provider `ark-agent-plan` 和并发上限 1，分别固定使用 `ark-code-latest` 与 `deepseek-v4-flash`，两者的 review/delegate 精确门禁均通过并晋级。旧 `ark-agent-glm-5.2` 与 `ark-agent-doubao-seed-2.0-pro` 证据只作为历史记录保留，不能用于新路线晋级，详见 [Ark / Pi 真实能力门禁](docs/smoke/ark.md)。
- Ark Coding 凭据候选依次为 `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING`；本机用户环境实际命中第三项。Agent Plan 使用 `OPENAI_API_KEY_DOUBAO`。MCP 只转发候选白名单，运行时再向 Pi 注入单个项目私有变量，doctor 只报告变量名而不报告值。
- 真实 Pi smoke 的残留进程检查使用全机快照，因此不同 smoke 必须串行执行。并行执行会把其它仍在运行的 smoke 进程误判为泄漏；2026-07-20 的最终门禁只采用串行证据。
- 历史实现曾包含 `install --replace-codex-cc-tools` 和 `restore --backup`，但这套应用内自检未能证明真实 Codex App 可正常启动。历史实现当前已禁用，不得用于活动配置；相关公开 CLI 与源代码已删除，不能再把显式测试副本当作当前运维路线。
- 2026-07-25 官方插件实施任务 1 已由提交 `db60c67` 完成：公开 CLI 只保留只读 `doctor`，不再接受 `--config`，历史 install/uninstall/restore/cutover 源码与测试已删除，doctor 不再读取 Codex 配置或报告 MCP registration。该提交经独立规格与代码质量审阅通过，当前基线为 147 项测试和类型检查全绿。
- 2026-07-20：157 项测试、类型检查、构建、release smoke 和真实 stdio MCP 验收全绿；验收摘要 SHA-256 为 `0e4aca2d35c4e124a5f3b6ca60e8df440bfad27253d3e710334ba0fe29169d04`。
- 2026-07-20 的自动 cutover 当时通过文件级、MCP initialize/listTools 和 strict doctor 检查，但重启后的真实 Codex App 运行异常。用户已于 2026-07-24 恢复原始 `~/.codex/config.toml`。因此“新 MCP 已在活动配置中完全替代旧 MCP”的结论已撤销；当前真实配置内容以用户恢复结果为准，未经许可不读取或修改。
- 当前代码公开五个固定逻辑 LLM：`ark-agent-deepseek-v4-flash`、`ark-agent-plan`、`ark-coding-plan`、`gemini-3.5-flash`、`kimi-k3`。2026-07-25 十项真实门禁的原始结果为 8 passed / 2 failed；执行成对门禁策略后，Kimi K3 与两个 Agent Plan profile 的 6 项注册表能力为 passed，Gemini 与 Ark Coding Plan 的 4 项注册表能力为 pending。pending 能力不会复用旧证据、单项通过结果或回退到其它 LLM。网络策略只保留 `direct` 与 `proxy-10808`，仅 Gemini 使用后者。
- `codex-agent-tools` 在设计时没有同名 npm 包；发布前必须重新检查。当前不执行 `npm publish`。
- 2026-07-25：官方插件集成目标设计已经 Kimi K3 与 Ark Coding Plan 外部审阅收敛并由用户书面复核通过，见 [官方插件集成设计](docs/superpowers/specs/2026-07-25-official-plugin-integration-design.md)；逐任务方案见 [官方插件集成实施计划](docs/superpowers/plans/2026-07-25-official-plugin-integration.md)。任务 1 的只读 CLI 基线保持不变；任务 2 由 `c1ed473` 完成五项模型面，并由 `9c14d4e` 加固独立、不可变且强制 evidence 的质量门禁；任务 3 由 `74d3bc7` 创建仓库内 marketplace、官方插件 manifest 与自包含 MCP bundle，`a47c993` 把无 `node_modules` 临时目录内的 MCP initialize/listTools 固化为回归测试，`f8090bb` 隔离了测试所用 tsup 配置。各任务的独立规格审阅与代码质量审阅最终均通过；任务 3 阶段基线为 159 项测试、类型检查和构建全绿。
- 2026-07-25：本机 `plugin-creator` 自带校验脚本仍只接受旧式顶层 `mcpServers` 包装，但当前 Codex 官方插件文档明确允许 `.mcp.json` 使用直接 server map 或 `mcp_servers` 包装。仓库按官方文档采用直接 server map；任务 3 证明 bundle 自包含和 MCP 契约，任务 4 又用临时 `CODEX_HOME` 下的真实 Codex `plugin` CLI 证明官方安装器实际接受该格式。旧校验器报错不代表官方宿主失败。
- 2026-07-25：官方插件实施任务 4 已在 Codex CLI 0.135.0 和唯一临时 `CODEX_HOME` 中完成真实 marketplace add/list、plugin add/list、缓存副本 MCP 启动、plugin remove/list 与 marketplace remove/list，官方安装器接受直接 server map。实测缓存末级是 manifest 版本目录 `plugins/cache/<marketplace>/<plugin>/<version>/`，不是设计时预估的 `local/`；卸载后可保留空缓存父目录和官方状态文件，验收以官方列表语义回滚与残留可解释为准。脱敏、可重复取证见 [官方插件隔离状态报告](docs/release/plugin-isolated-state.md)；该报告明确不代表活动 Codex App 验收。
- 2026-07-25：任务 4 的真实 fake Pi 门禁发现 `execa` 默认 `extendEnv: true` 会把 MCP 父进程的 `ALL_PROXY` 重新注入 Pi 子进程。提交 `e967947` 已在 Pi 启动处设置 `extendEnv: false`，使子进程只接收项目构造的白名单环境；回归同时验证显式 10808 HTTP(S) 代理与必要系统路径仍保留。隔离脚本还验证精确凭据哨兵、快照竞态失败传播和异常 MCP 进程树清理。最终任务 4 由 `eb81a51`、`e967947`、`0ad3d5e`、`f048b5c`、`91109c7` 完成，独立规格与质量复审均通过，主线程复验为 169 项测试、类型检查、构建和隔离生命周期全绿；活动 `~/.codex/config.toml` 未被读取或修改。
- 2026-07-25：官方插件实施任务 5 由 `874db97` 把四个精确插件文件纳入 npm pack 与 release smoke，`8e59c3c`、`d235803` 将 bundle 的生产依赖检查从脆弱正则收敛为 release-only TypeScript AST 遍历。当前门禁识别静态 import/re-export、动态 import、任意位置的直接 `require` / `__require`，注释与字符串不误报，非字面量和解析错误 fail closed；TypeScript 不进入插件 runtime bundle。`npm pack --dry-run --json` 的插件面严格为 marketplace、plugin manifest、`.mcp.json` 与单文件 runtime 四项，不生成持久 `.tgz`；Codex plugin help 只在临时 `CODEX_HOME` 中运行，release smoke 不执行安装、卸载或发布。任务 5 最终独立规格与质量复审通过，主线程复验为 release assurance 24/24、全量 191/191、release smoke、类型检查和构建全绿。
- 2026-07-25：官方插件实施任务 6 已把 README、运维、共存迁移、四层发布门禁和三份真实模型证据索引收敛到当前五模型面。当前运维只允许依次构建、隔离官方生命周期取证、准备权限包，并在逐动作明确许可后使用官方 add/remove；项目和维护者均不直接读写或手工恢复活动 `config.toml`。隔离 CLI 生命周期与真实 Codex App 宿主门禁被明确分层；当前第 1、2 层 passed，第 3 层为 6 passed / 4 pending，第 4 层尚未执行。旧 `codex_cc_tools` 本轮保持共存，移除旧工具属于后续独立变更与独立授权。
- 2026-07-25：任务 6 最终由 `1786b91`、`4c9d9d4`、`1aceaa6` 完成。规格复审先发现两份旧实施计划仍可能被误作当前配置写入指引，质量复审再发现 doctor 测试副本描述漂移和 PowerShell 原生命令失败后可能继续执行；修复后两类复审均通过。官方 add/remove 示例现在逐命令检查退出码，主线程重新运行文档漂移 `rg`、`git diff --check` 与 release smoke 全绿。
- 2026-07-25：任务 7 真实调用前的只读预飞审计曾发现证据链阻断：三个 `real-*-smoke.mjs` 只在核心 smoke 正常返回后落盘，基础设施异常可能没有 JSON；Kimi evidence 也缺少稳定失败类别。因此当时先暂停十项真实门禁，按实施计划 Step 0 用 TDD 加固失败 evidence 后才开始消耗真实额度。
- 2026-07-25：任务 7 Step 0 由 `2bc2ba6`、`93a115f`、`b3a2df3`、`cdc24cc` 完成。实现了三入口共享的脱敏失败 evidence、Kimi 稳定失败分类、生产脚本真实接线与默认 runner 身份测试、clean checkout 自足的 `pretest`、固定安全 progress 标签，以及同目录临时文件加 `fs.link` 的原子排他发布。规格复审先后发现只测 helper、默认 runner 未证明和 clean checkout 缺 `dist`；质量复审发现 progress 泄漏与部分正式 JSON 风险；全部修复后规格与质量复审通过。主线程 fresh verification 为 35 文件/220 测试、类型检查、构建、release smoke 与 diff-check 全绿；截至该基线仍未调用任何真实模型。
- 2026-07-25：任务 7 十项真实门禁随后严格串行执行，每条命令后都逐字段读取新 evidence，并用独立系统进程快照复核无新增 Kimi/Pi RPC 进程；十次均无残留、无 fallback。Kimi 两项通过；Gemini review 通过而 delegate 因 Google 免费层额度失败；Ark Coding review 通过而 delegate 因结果文件内容验收失败；Ark Agent Plan 主档与 DeepSeek V4 Flash 经济档各两项均通过。两个 Agent profile 已用稳定文档 anchor 晋级，Gemini 与 Ark Coding 按成对策略两项均保持 pending；三份 evidence 索引记录了十个实际文件、SHA-256、模型、provider、route、结果与清理证据。
- 2026-07-26：任务 7 注册表切换后的最终回归发现隔离插件验收仍固定调用已降为 pending 的 Gemini，MCP 正确拒绝后旧脚本误报缺少结构化结果。隔离验收现先证明 pending Gemini 被已安装 MCP 拒绝，再用已晋级的 `ark-agent-deepseek-v4-flash` 与 fake Pi 验证缓存副本调用、direct 父代理清理和 Agent 凭据规范化；Gemini 的固定 10808 替换继续由确定性环境测试与本轮真实 smoke evidence 覆盖。修复没有重新启用 Gemini，也没有使用活动 Codex home。
- 2026-07-26：任务 7 质量复审进一步收敛了发布状态叙述与后续授权边界：README 明确区分十项原始 8 passed / 2 failed 和成对注册表 6 passed / 4 pending；运维文档不再把隔离 fake Pi 验收误述为成功调用 Gemini。Task 8 当前只能生成 `blocked / not ready` 状态包并报告重入条件，不得索要真实安装授权；Task 9 必须同时满足十门禁全部 passed、状态包重新审阅为 ready 和当前会话精确授权。只读外部审阅只选执行时 qualified 的 profile，当前为 Kimi K3 与 Ark Agent Plan。fake Pi 的 `set_model` 元数据也按生产配置收敛：Google 使用 `google-generative-ai`，Ark Plan 使用 `anthropic-messages`。
- 2026-07-26：任务 8 的 [真实插件安装审阅状态包](docs/release/real-plugin-install-review.md) 已完成并保持 `blocked / not ready`，记录原始 8 passed / 2 failed、成对注册表 6 passed / 4 pending、两个失败 evidence、十门禁重入条件、隔离状态差异及未来官方回滚边界。qualified 的 Kimi K3 与 Ark Agent Plan 已依次完成只读外审，二者都没有改动文件；Kimi 只指出发布清单状态措辞，Ark Agent Plan 只指出 `docs/operations.md` 顶部硬编码的 as-of 日期，后者已通过删除该硬编码日期修复。独立规格复审通过；独立质量复审发现并修复了新插件工具范围可能被误解为全局唯一、发布清单未区分建立日期与最近复核日期、临时缓存路径可能被误作未来版本承诺、临时隔离配置主体误写为活动配置，以及审阅归因漂移。最终质量复核与主线程敏感词、授权指示、证据哈希、链接、release smoke、进程残留和工作树检查均通过。当前不提出或接受真实安装许可，任务 9 未执行；只有十项门禁全部通过并把状态包重新审阅为 `ready` 后，才可重新准备逐次授权。
- 2026-07-26：下一阶段采用 [十门禁原子重认证设计](docs/superpowers/specs/2026-07-26-gate-requalification-design.md)。Ark Coding Plan 的历史失败仅能证明正确文件名下的内容未通过严格契约，不能据此放宽验收、修改路由或增加重试；Gemini 当前额度也无法通过 doctor 预知。实施先补充脱敏结果文件哈希/长度/读取状态、精确命令证据、调用/重试/fallback 计数和原子批次 manifest，再按风险优先顺序只执行一次严格串行、无重试、无 fallback 的全量重认证。任一失败立即停止且保持 `blocked`；十项同批全部通过才允许准备新的 `ready` 审阅包，仍不构成真实安装授权。
- 2026-07-26：重认证设计已完成独立根因、资格策略、实现可行性与 Kimi K3 只读外审收敛。最终语义不宣称 provider 内部绝对单次请求，而要求 adapter client 调用/adapter 重试/Pi 明示自动重试/adapter 明示 fallback/协调器 fallback 为 `1 / 0 / 0 / false / false`；Pi 资格模式在 prompt 前显式关闭自动重试和自动压缩，并固定 provider retry 为 0。批次使用系统临时目录锁、不可变 `running`/终态 checkpoint、只发布一次的 manifest 和晋升前磁盘重验；“原子”只指同批证据与 all-or-none 晋升，不表示真实调用或额度可回滚。Kimi 外审成功且未改文件；Ark Agent Plan 审阅在无文件改动下因 Pi RPC `EPIPE` 未形成正文，不计通过。
- 2026-07-26：[十门禁原子重认证实施计划](docs/superpowers/plans/2026-07-26-gate-requalification.md) 已完成独立规格与可执行性复核。计划把冻结候选 verifier 与晋升后的 immutable-evidence verifier 分开，避免 registry/bundle 重建后错误要求匹配旧 build；preflight 在任何 batch tracked 文件出现前完成，隔离报告使用 check-only 模式；锁绑定授权哈希并覆盖四个崩溃窗口，`batch_started` 在真实调用前耐崩溃占用授权；结果文件通过 file handle/fstat identity 防路径替换；成功后旧 pending 隔离断言以真实 integration RED→GREEN 更新。Task 1–6 不运行十门禁真实批次，Task 7 只消费一次当前授权，失败不自动重开。
- 2026-07-26：原子重认证实施 Task 1 由 `f112a7d` 完成。Pi/Kimi delegate evidence 现在使用共享的 64 KiB 安全结果文件检查器，按 `lstat → open handle → fstat → 有界 handle.read → fstat` 校验普通文件、identity、长度和 fatal UTF-8，只持久化状态、长度、哈希、行数与包含关系；命令验收改为精确 `commandsRun.includes("git status --short")`，不保存命令清单。两轮质量复审先后发现并修复读取期间扩容导致的无界 `readFile` 风险，以及每字节短读可能保留约 512 MiB backing buffer 的内存放大；最终改为单次分配 `maximumBytes + 1` 的固定 Buffer。独立规格与质量复审均通过，主线程目标验证为 49/49、类型检查与 diff check 全绿；尚未运行任何新真实模型门禁。

## 架构与计划索引

- [产品设计历史基线](docs/superpowers/specs/2026-07-18-codex-external-agents-design.md)
- [当前官方插件集成设计](docs/superpowers/specs/2026-07-25-official-plugin-integration-design.md)
- [十门禁原子重认证设计](docs/superpowers/specs/2026-07-26-gate-requalification-design.md)
- [十门禁原子重认证实施计划](docs/superpowers/plans/2026-07-26-gate-requalification.md)
- [官方插件集成实施计划](docs/superpowers/plans/2026-07-25-official-plugin-integration.md)
- [Kimi 可用 MVP 实施计划](docs/superpowers/plans/2026-07-18-kimi-mvp.md)
- [Pi/Gemini 适配实施计划](docs/superpowers/plans/2026-07-18-pi-gemini-adapter.md)
- [Ark 迁移与本机切换实施计划](docs/superpowers/plans/2026-07-18-ark-migration-and-cutover.md)
- [官方插件四层发布验收清单](docs/release/checklist.md)

## 开发约定

- 行为代码使用 TDD。
- 不修改 `D:\Codes\codex-cc-tools` 或本机 Claude Code。
- 每个“逻辑 LLM × 任务类型”通过独立真实 smoke 后，才能在内置注册表中启用。
- 真实 Kimi/Pi 能力门禁串行执行，并把脱敏证据持久化到 `docs/smoke/evidence/`。
- 结构、API、模型清单、网络策略或迁移状态发生变化时，同步更新本文件和相关设计/计划文档。
