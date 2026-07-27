# 官方插件四层发布验收清单

建立日期：2026-07-25

最近复核：2026-07-27

分支：`codex/gemini-retirement`

包版本：`0.1.0-alpha.1`

当前结论：**Ark Coding Plan 提示词分隔歧义已在离线候选中修复，独立双审阅、第 1 层确定性验证与第 2 层隔离官方插件生命周期均已通过；第 3 层四模型八项能力仍处于 6 passed / 2 pending，最新 `four-llm-v1` 批次因执行宿主超时后的协调器进程中断形成 interrupted 终态，0 个 case 完成，未取得 8/8 资格；第 4 层真实 Codex App 宿主门禁尚未执行。当前仍是 blocked / not ready，不是已安装、已替代旧工具或可公开发布状态。**

每层都必须独立成立。上层通过不能替代下层证据；任一层失败或证据缺失时，按该层停止条件执行。

## 状态总览

| 层级 | 验收对象 | 当前状态 | 通过证据路径 |
| --- | --- | --- | --- |
| 1 | 确定性单测、类型检查、构建、release smoke | passed | 提示词离线修复 fresh verification：44 files，569 passed / 1 skipped / 0 failed；类型检查、构建、release smoke、隔离报告 check-only、资格入口 help、diff check 与生产进程 0/0/0 均通过 |
| 2 | 临时 `CODEX_HOME` 中的官方插件生命周期 | passed | [plugin-isolated-state.md](plugin-isolated-state.md)、`scripts/plugin-isolated-acceptance.mjs` |
| 3 | 四个逻辑 LLM 的八项真实模型门禁 | blocked：6 passed / 2 pending；最新 `four-llm-v1` 为 interrupted，0 completed / 7 notRun | [Kimi](../smoke/kimi.md)、[Ark](../smoke/ark.md)、[最新 interrupted manifest](../smoke/evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json)、[结果审阅](four-llm-qualification-result-review.html)、[Gemini 退役历史](../smoke/pi-gemini.md) |
| 4 | 活动 Codex 的真实 App 宿主门禁 | not run / blocked | [real-plugin-install-review.md](real-plugin-install-review.md) 当前已存在，但只是 `blocked / not ready` 草案；只有 `four-llm-v1` 同批 8/8 passed 后才能重新审阅并改为 `ready`，授权后才可生成 `real-host-acceptance.md` |

## 第 1 层：确定性单测与构建

### 通过标准

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
git diff --check
```

`smoke:release` 还必须证明：

- npm pack 精确包含 marketplace、plugin manifest、`.mcp.json` 与单文件 runtime；
- npm pack 精确包含资格结果与授权审阅两个入口，以及真实插件状态、隔离插件状态和历史执行计划五份依赖文档；
- 上述五份审阅包文档的包内本地链接必须闭合；缺失目标或越界链接立即失败；
- HTML 与其它打包文本一并接受秘密值和开发机绝对路径扫描；
- runtime bundle 不依赖安装目录外生产模块，不泄漏开发机绝对路径或环境凭据值；
- MCP initialize/listTools 只公开 `external_review` 与 `external_delegate`，且 `llm` 必填；
- Codex plugin help 只在临时 `CODEX_HOME` 中运行；
- 不执行真实 add/remove、`npm publish`，也不保留 `.tgz`。

### 当前证据

任务 5 的旧五模型阶段曾由主线程复验 release assurance 24/24、全量 191/191、类型检查、构建与 release smoke；这些数字只描述当时提交，不能证明当前四模型候选。Task 12 曾对 Gemini 退役候选运行 44 个文件、560 passed / 1 skipped / 0 failed 的完整命令组。此后的 Ark Coding Plan 提示词离线修复候选已重新执行完整验证：类型检查通过；全量测试为 44 个文件、569 passed / 1 个平台条件 skipped、0 failed；完整构建、release smoke、隔离插件报告 `--check-report`、资格入口 `--help`、`git diff --check` 均通过；生产 `classifyAgentProcesses()` 返回 Kimi ACP、Pi RPC、real-smoke 计数 0/0/0。当时 blocked batch 的 immutable verifier、当时 5/5 文件、14/14 历史 Gemini SHA/blob 与历史 `five-llm-v1` blocked/non-promotable 证据也通过；独立规格和代码质量审阅均为 PASS。因此第 1 层为 passed。该结论不替代第 3 层真实模型资格或第 4 层真实 App 宿主门禁。最新 interrupted batch 的 immutable verifier 结果见本层后文。

### 失败停止条件

任一命令非零、包文件面超出白名单、bundle 解析失败或发现秘密/绝对路径时立即停止。不得进入隔离安装、真实模型或真实 App 门禁；先在行为改动处补失败测试并修复。

## 第 2 层：隔离官方插件生命周期

### 通过标准

```powershell
npm run acceptance:plugin:isolated
```

脚本必须在唯一临时 `CODEX_HOME` 中完成官方 marketplace add/list、plugin add/list、从官方缓存副本启动 MCP、plugin remove/list 与 marketplace remove/list。调用门禁先证明已退役的 `gemini-3.5-flash` 以 unknown logical LLM 被明确拒绝、错误精确列出四项活动 LLM 且没有启动 Pi，再用 qualified 的 `ark-agent-deepseek-v4-flash` 验证从官方缓存副本恰好调用 fake Pi 一次、direct 路由、父代理清除、只注入目标 Agent 凭据和进程清理。脚本还必须验证 MCP 契约和官方列表语义回滚。

### 当前证据

[官方插件隔离状态报告](plugin-isolated-state.md) 记录 Codex CLI 0.135.0 的通过结果、相对状态差异、官方缓存位置和脱敏边界。该报告明确只证明隔离 CLI 生命周期，**不证明真实 Codex App 已安装或通过**。

### 失败停止条件

临时 home 边界、官方 add/list/remove、缓存副本启动、固定路由、环境白名单、进程回收或列表语义回滚任一失败即停止。不得改用活动 Codex home 诊断，也不得直接读取或写入活动 `config.toml`。

## 第 3 层：四模型八项真实门禁

### 当前矩阵

| 逻辑 LLM | 固定路由 | review | delegate |
| --- | --- | --- | --- |
| `kimi-k3` | Kimi ACP / `kimi-code/k3` / direct | passed | passed |
| `ark-coding-plan` | Pi / `ark-coding-plan` / `ark-code-latest` / direct | pending | pending |
| `ark-agent-plan` | Pi / `ark-agent-plan` / `ark-code-latest` / direct | passed | passed |
| `ark-agent-deepseek-v4-flash` | Pi / `ark-agent-plan` / `deepseek-v4-flash` / direct | passed | passed |

### 通过标准

- 四个逻辑 LLM 的 review/delegate 共八次调用必须按 `four-llm-v1` 固定顺序串行执行；
- 八项必须来自同一冻结候选和同一批次，不能只补跑 Ark Coding Plan 或拼接历史 evidence；
- 每次实际模型、provider 与路由必须和注册表精确一致；
- review 必须找到预置缺陷且工作区零变化；
- delegate 必须只产生预期变化并观测到验证命令；
- 每次调用结束后不得有新增 Kimi/Pi 进程；
- 新证据必须脱敏并写入新的 batch 目录，Kimi/Ark smoke 索引同步更新；
- 只有同批 8/8 passed 且冻结 verifier 通过时才允许晋级。

### 当前证据

移除 Gemini 后，当前活动产品面为四个逻辑 LLM、八项能力，过渡注册表是 6 passed / 2 pending；只有 Ark Coding Plan 的 review/delegate pending。既有 Kimi K3 和两个 Agent Plan profile 的通过证据仍解释当前过渡状态，但不能与最新 interrupted 结果、旧 blocked 结果或其它历史 evidence 拼接成新资格。

### 最新四模型 interrupted 批次

2026-07-27 在冻结 commit `287b9a8bfa14805f84707adff6c7f2af19065475` 上只调用一次标准入口，启动 `four-llm-v1` 批次 `2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde`。preflight clean 且通过；build identity SHA-256 为 `71576ad637f1a9ee9914ebf7294b267abd43421a4df89621f45fd0adfdf034ee`，preflight SHA-256 为 `1fdd7273a57309d6f541049493a89ed342ed897c749c5cb3cf043e7e7ca30185`。执行宿主前台 shell 约 14 秒后返回 timeout 124；协调器子进程随后仍存活，发布 `batch_started` 与 ordinal 1 `ark-coding-plan/delegate` 的 `case_running` 后退出并留下 stale owner。确认原进程已死、目标进程 0/0/0 后，只对同一 batch 执行一次 `--recover-interrupted`；它没有调用模型、resume、retry 或 fallback，只发布终态并释放锁。

manifest schema v2，`status=interrupted`、`stopReason=process_interrupted`、`promotionEligible=false`，0 completed cases，ordinal 2–8 共 7 个 notRun，2 个 checkpoints；没有 cases 文件、case evidence 或 `uncommittedEvidence`。现有证据不能证明 ordinal 1 是否完成真实后端请求，因此没有可报告的 telemetry 或失败 evidence SHA，也不能把终态归因于模型、route、凭据或 acceptance。manifest SHA-256 为 `3e200dca507fe886d4e3a4bbf67cc811cca485120e6969e7632f933537ba902b`；immutable-evidence verifier、锁消失和目标进程 0/0/0 均已通过，证据由独立提交 `b76c75d` 保存（3 files / 276 insertions）。

本轮授权已经消费。任何未来真实批次都必须先修正长时命令承载方式、重新冻结并复核，再取得新的明确授权，从 ordinal 1 重新开始；不能复用当前授权或旧证据。最小人工判断材料见[中断结果审阅](four-llm-qualification-result-review.html)。

### 上一轮四模型 blocked 批次

2026-07-27 在冻结 commit `b57382ed4f2fddce4946613b5aa5739c6eed5c8f` 上只启动一次 `four-llm-v1` 批次 `2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d`。完整 preflight 通过；第 1 项 Ark Coding Plan delegate 的模型、provider、direct 路由、凭据隔离、文件范围、命令和进程清理均正确，telemetry 为 `1 / 0 / 0 / false / false`，但结果文件内容不含预期行，故以 `acceptance_failed` 停止。case evidence SHA-256 为 `166947716c19d435155e4ce0d041e4c88b7ef9b79f302787e0c27572eb39e6c9`；blocked manifest SHA-256 为 `f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c`，immutable-evidence verifier 通过，`promotionEligible=false`，后七项 not run。当前授权已经消费，批次后 Kimi ACP、Pi RPC、real-smoke 计数为 0/0/0；没有 retry、fallback、resume、跳项或第二批。

未来如需重新认证，必须取得新的明确授权并从第 1 项开始运行完整八项；不得复用本次授权或只补跑失败项。

### 离线消歧候选

blocked case 的 raw/normalized 双哈希已确定结果文件为 `ARK_SMOKE_OK:ark-coding-plan;\n`。实现提交 `76504d7d165366ad291e6ff08026b7236f862fc8` 仅将 delegate 资格提示词改成精确 Node + Base64 Bash 写入命令并把 payload 独立分隔；严格 validator、provider/model/direct route、凭据、single-attempt、无 retry/fallback、telemetry、schema/protocol 与既有 evidence 均未改变。Bash → Node 探针精确写入 29 bytes、LF 结尾，SHA-256 为 `7b82d87530083f53c07b5b34d5ab4cc8c6bc031c96c70b0be28920262c20fb59`。

离线消歧阶段没有新的真实模型调用，因此这一修复不能改变第 3 层的 blocked 状态，也不能把 Ark Coding Plan 改为 passed。随后的最新批次又因进程中断而没有形成 case evidence。新的完整 `four-llm-v1` 八项批次仍需在修正长时命令承载方式、重新冻结和复核后取得一份新的明确授权；[原授权材料](four-llm-qualification-authorization-review.html)已经消费，只作为历史记录。

### 历史五模型证据

2026-07-25 曾严格串行执行五模型十项门禁，原始结果为 8 passed / 2 failed，成对注册表为 6 passed / 4 pending。2026-07-26 又在冻结 commit `f7209cd5744bad12fd27fbb3f5b6cd6fc42c3521` 上只启动一次 `five-llm-v1` 历史批次 `2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f`：首项 Gemini delegate 因 `google_free_tier_quota` failed，后九项 not run；manifest SHA-256 为 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`，批次后目标进程均为 0。Gemini 现已退役，这些文件只用于历史审计，不能参与当前四模型晋级。

历史 blocked evidence 进入 npm 包面后，`npm pack --dry-run --json` 会把 batch UUID 展示为 `***`。release smoke 要求每条脱敏路径唯一匹配本地文件，并对所有保留的历史文本执行秘密和开发机绝对路径扫描；缺失或歧义均失败。该包装逻辑不修改历史 evidence 或 manifest。

### 失败停止条件

任一精确门禁因模型、路由、额度、工作区、工具证据或残留进程失败时立即停止，不晋级任何 pending 能力。不得复用旧模型或 Gemini 证据、自动 fallback、并行运行 Pi smoke、只补跑失败项或把确定性测试当成真实模型证据。`four-llm-v1` 未同批 8/8 passed 前，不准备真实 App 安装执行。

## 第 4 层：真实 Codex App 宿主门禁

### 前置权限

当前尚未执行真实官方安装。项目代码不得直接读取或写入活动 `~/.codex/config.toml`；官方插件命令可能由官方机制触碰该文件，因此必须先提交 `real-plugin-install-review.md` 权限包并取得针对本次 add 与失败 remove 的明确许可。

### 通过标准

获得许可后，才可使用 [官方插件运维流程](../operations.md) 中列出的官方命令，并从真实 Codex App 验证：

- 只新增 `external_review` 与 `external_delegate`，二者 `llm` 必填；
- 旧 `codex_cc_tools` 仍存在且未被修改；
- Kimi 与至少一条 Pi 路线完成代表性 review；
- delegate 只在隔离临时仓库执行；
- 可取消长任务在结束后不残留 Kimi/Pi 进程；
- 所有结果、诊断和宿主证据均脱敏。

通过证据必须写入授权后才创建的 `docs/release/real-host-acceptance.md`。隔离 CLI 报告不能填充这一层。

### 失败停止条件

官方命令输出、工具发现、代表性调用、取消或进程清理任一异常时立即停止，且只使用权限包内的官方 remove 命令回滚。不得手工恢复、编辑或修补活动 `config.toml`。若官方回滚也异常，停止并报告，不执行旧工具移除或发布。

## 替代与发布边界

- 第四层通过只表示新插件具备替代条件，不会自动移除旧 `codex_cc_tools`。
- 旧工具移除是后续独立变更，需要新的影响评估、验证、回滚方案与明确授权。
- 本轮不调用或修改 Claude Code，不执行 `npm publish`，不发布公共 marketplace。
