# 官方插件四层发布验收清单

建立日期：2026-07-25

最近复核：2026-07-28

分支：`codex/gemini-retirement`

包版本：`0.1.0-alpha.1`

当前结论：**最新真实 `four-llm-v1` 批次按首错停为 6 completed / 5 passed，ordinal 6 `ark-agent-plan/delegate` 因 `account_quota_exceeded` failed，ordinal 7–8 notRun；第 3 层仍为 6 passed / 2 pending。ordinal 1 与 6 的规定写入和规定状态命令均各一次 success，结果文件和变更范围精确通过，证明 Pi Windows bash resolver 与旧资格门禁假阳性已经由真实批次闭合。所有已执行项均为一次 client invocation、零 retry/fallback。当前已确认且需要人工处理的阻碍是 Ark Agent Plan 账户额度；ordinal 7–8 尚未运行，不能据此排除后续可能出现其它问题。第 4 层真实 Codex App 宿主门禁仍未执行。当前仍是 blocked / not ready，不是已安装、已替代旧工具或可公开发布状态。**

最新真实批次绑定 frozen commit `0113da97a6b1fef35cc4c45025caa9e36a002176`，批次 ID 为 `2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c`；标准入口和 execution cell 各只有一个，没有 resume、retry、fallback、补跑或第二批。最新 manifest SHA-256 为 `f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`，immutable-evidence verifier 通过，进程 0/0/0、锁 absent；20 个证据文件由提交 `6b4217d` 保存。执行边界见[承载手册](four-llm-qualification-execution-runbook.md)。standing authorization 继续有效，但无外部状态变化前不得重复消耗额度；维护者补充/恢复 `OPENAI_API_KEY_DOUBAO` 所属 Ark Agent Plan 计划额度或等待重置后，只需告知“已处理”。

每层都必须独立成立。上层通过不能替代下层证据；任一层失败或证据缺失时，按该层停止条件执行。

## 状态总览

| 层级 | 验收对象                                  | 当前状态                                                                    | 通过证据路径                                                                                                                                                                                                               |
| ---- | ----------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 确定性单测、类型检查、构建、release smoke | passed                                                                      | 49 files / 853 passed / 1 skipped / 0 failed；typecheck、build、release smoke、隔离 `--check-report`、retained manifests 7/7、证据不变、进程/锁与 211-file pack dry-run 均通过                                             |
| 2    | 临时 `CODEX_HOME` 中的官方插件生命周期    | passed                                                                      | [plugin-isolated-state.md](plugin-isolated-state.md)、`scripts/plugin-isolated-acceptance.mjs`                                                                                                                             |
| 3    | 四个逻辑 LLM 的八项真实模型门禁           | blocked：6 passed / 2 pending；最新 `four-llm-v1` 为 6 completed / 5 passed | [Kimi](../smoke/kimi.md)、[Ark](../smoke/ark.md)、[最新 blocked manifest](../smoke/evidence/batches/2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c/manifest.json)、[Gemini 退役历史](../smoke/pi-gemini.md) |
| 4    | 活动 Codex 的真实 App 宿主门禁            | not run / blocked                                                           | [real-plugin-install-review.md](real-plugin-install-review.md) 当前已存在，但只是 `blocked / not ready` 草案；只有 `four-llm-v1` 同批 8/8 passed 后才能重新审阅并改为 `ready`，授权后才可生成 `real-host-acceptance.md`    |

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
- npm pack 必须包含固定产品文档清单：资格结果、历史授权审阅、真实插件状态、隔离插件状态、历史执行计划，以及资格承载演练和执行手册；
- 固定清单只定义“必须打包”的产品文件，不限制扫描范围；release smoke 必须从实际 pack 文件面选出全部 Markdown/HTML，逐份完成敏感信息扫描和包内本地链接闭包，缺失目标、未检查文档或越界链接立即失败；
- HTML 与其它打包文本一并接受秘密值和开发机绝对路径扫描；
- runtime bundle 不依赖安装目录外生产模块，不泄漏开发机绝对路径或环境凭据值；
- MCP initialize/listTools 只公开 `external_review` 与 `external_delegate`，且 `llm` 必填；
- Codex plugin help 只在临时 `CODEX_HOME` 中运行；
- 不执行真实 add/remove、`npm publish`，也不保留 `.tgz`。

### 当前证据

任务 5 的 release assurance 24/24、全量 191/191，Task 12 的 44 files / 560 passed、阻断收敛的 44 files / 584 passed、Kimi/package 阶段的 46 files / 759 passed，以及方案 B 阶段的 48 files / 837 passed / 1 skipped，都只描述各自历史候选。171 files / 15 Markdown/HTML / 3 plugin files 同样只是旧候选的 npm dry-run 历史数字。当前 fresh 结果为 49 files / 853 passed / 1 skipped / 0 failed；类型检查、构建、release smoke、隔离 `--check-report`、retained manifests immutable verifier 7/7、最新 evidence 不变、Pi resolver/精确写入探针、目标进程 0/0/0、资格锁 absent 与 211-file pack dry-run 均通过，且没有持久 `.tgz`。

首次全量曾暴露 Kimi ACP client 早于 child close 返回的既有竞态，98/100 时序探针可观察。提交 `4af8b34` 加入 close 等待、1000ms 有界失败、stdio 销毁和两个确定性回归测试；独立复审 PASS、无 P0–P3，最终 49-file 全量已经包含该修复。

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

| 逻辑 LLM                      | 固定路由                                             | review  | delegate |
| ----------------------------- | ---------------------------------------------------- | ------- | -------- |
| `kimi-k3`                     | Kimi ACP / `kimi-code/k3` / direct                   | passed  | passed   |
| `ark-coding-plan`             | Pi / `ark-coding-plan` / `ark-code-latest` / direct  | pending | pending  |
| `ark-agent-plan`              | Pi / `ark-agent-plan` / `ark-code-latest` / direct   | passed  | passed   |
| `ark-agent-deepseek-v4-flash` | Pi / `ark-agent-plan` / `deepseek-v4-flash` / direct | passed  | passed   |

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

移除 Gemini 后，当前活动产品面为四个逻辑 LLM、八项能力，过渡注册表是 6 passed / 2 pending；只有 Ark Coding Plan 的 review/delegate pending。既有 Kimi K3 和两个 Agent Plan profile 的通过证据仍解释当前过渡状态，但不能与最新 blocked 结果、旧 interrupted/blocked 结果或其它历史 evidence 拼接成新资格。

### 最新四模型 blocked 批次

2026-07-28 在冻结 commit `0113da97a6b1fef35cc4c45025caa9e36a002176` 上只调用一次标准入口，启动 `four-llm-v1` 批次 `2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c`。同一 execution cell 从 ordinal 1 执行到首个失败项，6 completed、5 passed，ordinal 7–8 notRun；没有 cell 丢失、recovery、resume、retry、fallback、跳项、补跑、第二入口或第二批。

ordinal 1–5 passed。ordinal 6 `ark-agent-plan/delegate` 的 provider `ark-agent-plan`、模型 `ark-code-latest`、direct route、Agent Plan 凭据隔离、single-attempt 与零 retry/fallback 均正确，结果文件精确通过，但以 `account_quota_exceeded` failed。ordinal 1 与 ordinal 6 的规定写入和规定 `git status --short` 均各观察到一次 success，变更范围只含预期结果文件；上批暴露的 shell 与旧门禁假阳性缺口已经得到真实闭环。所有六个已执行项均为一次 client invocation、零 adapter/runtime retry、零 adapter/orchestrator fallback。

最新 manifest SHA-256 为 `f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`；终态为 `blocked / case_failed`、`promotionEligible=false`，immutable-evidence verifier、锁 absent 与目标进程 0/0/0 均已通过，20 个证据文件由独立提交 `6b4217d` 保存。原子晋级未发生。

提交 `2a815c7` 与 `e750052`、`b5a691f`、`3d85315`、`ceb8e9c` 的本地修复已经由上述真实命令成功证据验证；当前没有新的仓库内缺陷可修。当前已确认且需要人工处理的阻碍是 `OPENAI_API_KEY_DOUBAO` 所属 Ark Agent Plan 账户额度；ordinal 7–8 尚未运行，不能据此排除后续可能出现其它问题。维护者需补充/恢复该计划额度或等待其重置，无需提供密钥值；处理后 Codex 会按 standing authorization 完成新 clean freeze、生成 fresh 内部执行引用并从 ordinal 1 运行新的完整八项。

### 更早四模型 blocked 批次（结果文件缺失）

frozen commit `07fd0d79e6885ee1e0af4a021e12170ef6c9f470` 上的批次 `2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678` 完成八项并形成 7 passed，因 ordinal 8 `ark-agent-deepseek-v4-flash/delegate` 结果文件缺失而 `acceptance_failed`。manifest SHA-256 为 `eb3d2fd7827e4c14b35ffa97eb5d55bcfd2f0b8f6557eca04dab30241cb80556`，证据提交为 `1d5d2c4`。该轮现在只作历史审计，不能参与当前原子晋级。

### 更早四模型 blocked 批次（Kimi 命令观测）

2026-07-27 在冻结 commit `652e14ac637bfc04d90c448179ecc5838f2f8450` 上只调用一次标准入口，启动 `four-llm-v1` 批次 `2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa`。ordinal 1–3 passed，ordinal 4 Kimi delegate 因 `requiredCommandObserved=false` 而 `acceptance_failed`，ordinal 5–8 notRun。manifest 为 4 completed / 4 notRun，SHA-256 `d7be5e6ba3884075d80fe399dd3c2d72caaa1a3833f92e529928655e623b7b69`，证据提交 `4f816f0`。该批随后促成 Kimi 离线观测加固，但现只作历史审计。

### 更早四模型 interrupted 批次

2026-07-27 在冻结 commit `287b9a8bfa14805f84707adff6c7f2af19065475` 上只调用一次标准入口，启动 `four-llm-v1` 批次 `2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde`。preflight clean 且通过；build identity SHA-256 为 `71576ad637f1a9ee9914ebf7294b267abd43421a4df89621f45fd0adfdf034ee`，preflight SHA-256 为 `1fdd7273a57309d6f541049493a89ed342ed897c749c5cb3cf043e7e7ca30185`。执行宿主前台 shell 约 14 秒后返回 timeout 124；协调器子进程随后仍存活，发布 `batch_started` 与 ordinal 1 `ark-coding-plan/delegate` 的 `case_running` 后退出并留下 stale owner。确认原进程已死、目标进程 0/0/0 后，只对同一 batch 执行一次 `--recover-interrupted`；它没有调用模型、resume、retry 或 fallback，只发布终态并释放锁。

manifest schema v2，`status=interrupted`、`stopReason=process_interrupted`、`promotionEligible=false`，0 completed cases，ordinal 2–8 共 7 个 notRun，2 个 checkpoints；没有 cases 文件、case evidence 或 `uncommittedEvidence`。现有证据不能证明 ordinal 1 是否完成真实后端请求，因此没有可报告的 telemetry 或失败 evidence SHA，也不能把终态归因于模型、route、凭据或 acceptance。manifest SHA-256 为 `3e200dca507fe886d4e3a4bbf67cc811cca485120e6969e7632f933537ba902b`；immutable-evidence verifier、锁消失和目标进程 0/0/0 均已通过，证据由独立提交 `b76c75d` 保存（3 files / 276 insertions）。

该轮授权已经消费，且后续承载修复已经由最新真实批次证明可正常到达协调器终态。该 interrupted 记录仍只作历史审计，不能复用其授权或 evidence。

### 更早四模型 blocked 批次

2026-07-27 在冻结 commit `b57382ed4f2fddce4946613b5aa5739c6eed5c8f` 上只启动一次 `four-llm-v1` 批次 `2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d`。完整 preflight 通过；第 1 项 Ark Coding Plan delegate 的模型、provider、direct 路由、凭据隔离、文件范围、命令和进程清理均正确，telemetry 为 `1 / 0 / 0 / false / false`，但结果文件内容不含预期行，故以 `acceptance_failed` 停止。case evidence SHA-256 为 `166947716c19d435155e4ce0d041e4c88b7ef9b79f302787e0c27572eb39e6c9`；blocked manifest SHA-256 为 `f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c`，immutable-evidence verifier 通过，`promotionEligible=false`，后七项 not run。当前授权已经消费，批次后 Kimi ACP、Pi RPC、real-smoke 计数为 0/0/0；没有 retry、fallback、resume、跳项或第二批。

未来如需重新认证，必须在新 clean frozen SHA 上生成 fresh 内部执行引用并从第 1 项开始运行完整八项；standing authorization 已允许该自主重入，但仍不得复用旧执行引用或只补跑失败项。

### 离线消歧候选

blocked case 的 raw/normalized 双哈希已确定结果文件为 `ARK_SMOKE_OK:ark-coding-plan;\n`。实现提交 `76504d7d165366ad291e6ff08026b7236f862fc8` 仅将 delegate 资格提示词改成精确 Node + Base64 Bash 写入命令并把 payload 独立分隔；严格 validator、provider/model/direct route、凭据、single-attempt、无 retry/fallback、telemetry、schema/protocol 与既有 evidence 均未改变。Bash → Node 探针精确写入 29 bytes、LF 结尾，SHA-256 为 `7b82d87530083f53c07b5b34d5ab4cc8c6bc031c96c70b0be28920262c20fb59`。

离线消歧阶段本身没有新的真实模型调用。后续多个批次均形成 Ark Coding Plan 两项 passed case evidence，但同一原子批次仍未 8/8，因此不能把 Ark Coding Plan 晋级为 passed。此段只作历史修复记录。

### 历史：Kimi 命令观测与 package 闭包离线候选

用户已批准并完成 Kimi 资格命令观测的离线实现。资格提示词现在要求写文件与执行精确状态检查使用两个有序、独立的工具调用；ACP late `kind/title/rawInput` 按 tool-call ID 归并。新产生的 Kimi delegate evidence 将只包含 `raw_input / title_fallback / late_update / unextractable` 来源枚举与 `exact / trim_only / embedded / other` 匹配枚举，optional verifier 仅在字段存在时严格校验。通过判定仍只使用 `commandsRun.includes("git status --short")`；trim-only、embedded、title 或模型正文都不能反向升级为 passed。公开 MCP 结果、`four-llm-v1` manifest/checkpoint schema 与全部既有 evidence JSON 均未修改，历史 evidence 可以没有该诊断字段。

资格承载演练和执行手册在该阶段纳入 npm package；当时 dry-run 为 145 files / 15 docs / 4 plugin files。该数字只描述历史候选，当前 pack 事实以第 1 层当前证据为准。

### 历史：Pi 写入命令生命周期脱敏诊断离线候选

实现与审阅提交链为 `8261736`、`652b13d` / `5e209e1` / `16cdad5`、`293e745`、`969e546` / `0852691` / `d9eb28a`、`4bd2439`。逐任务规格/质量审阅与整体规格/安全审阅均 PASS；本轮两次 Kimi 外部复核均无结论：设计级跨多实现面审阅约 604.5 秒 `timed_out`，只返回读取进度；实现后两个内嵌摘录的单一不变量审阅约 181.8 秒 `timed_out`，review 正文为空。二者不计 PASS、不阻断，也未重试同形任务。该阶段验证为 48 files / 837 passed / 1 skipped / 0 failed；这个数字只属于当时的历史候选。

当前未安装活动插件，未访问或修改 `~/.codex/config.toml`，未移除 `codex_cc_tools`，未调用或修改 Claude Code，也未发布、推送、合并或 fast-forward。注册表仍为 6 passed / 2 pending，安装仍为 `blocked / not ready`；当前候选的最终全量验证已经通过，状态文档提交和 clean freeze 尚待主线程完成。真实资格实验已由 standing authorization 默认许可，完成这些前置条件后由 Codex 自主启动新批。

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
