# 真实插件安装审阅状态包 — blocked / not ready

日期：2026-07-27

分支：`codex/gemini-retirement`

候选包版本：`0.1.0-alpha.1`

## 状态摘要

本状态包为 **blocked / not ready**，不是当前有效的安装权限包。

- 当前 Ark Coding Plan 提示词离线修复候选的第 1 层确定性验证已经新鲜通过：44 个测试文件、569 passed / 1 个平台条件 skipped / 0 failed，类型检查、完整构建、release smoke、隔离报告 check-only、资格入口 help、diff check 与生产进程 0/0/0 基线均通过。
- 第 2 层隔离官方插件生命周期已经通过。
- 当前活动产品面是四个逻辑 LLM、八项 review/delegate 能力，全部固定使用 direct。
- 按同一逻辑 LLM 的 review/delegate 必须成对通过的规则，当前过渡注册表是 **6 passed / 2 pending**；只有 Ark Coding Plan 的两项能力 pending。
- 最新 `four-llm-v1` 批次已在首项 Ark Coding Plan delegate 的结果文件内容验收层失败，形成 `blocked` 终态；后七项未运行，未取得同批 8/8 资格。
- 第 4 层真实 Codex App 宿主门禁尚未执行。
- 当前没有执行活动 Codex 的 marketplace/plugin add 或 remove，也没有读取、写入、备份或恢复活动 `~/.codex/config.toml`。

本文件不提出安装授权问题，也不提供当前可立即执行的安装命令。另行准备的[四模型八项资格批次授权审阅](four-llm-qualification-authorization-review.html)只询问一次完整真实资格批次，不能解释为活动安装、回滚或其它外部状态变更的许可。过去对“采用官方插件机制”的原则性同意不能替代未来某次真实 add/remove 的逐动作许可。

## 为什么最终仍需要官方安装

[OpenAI 官方插件文档](https://developers.openai.com/plugins/build/plugins)要求用 `codex plugin marketplace` 管理 marketplace，而不是手工编辑 `config.toml`；文档同时说明插件启停状态存储在 `~/.codex/config.toml`。只有未来通过官方机制把插件安装到活动 Codex，再从真实 Codex App 新会话验证工具发现、调用、取消和进程清理，才能完成第 4 层宿主验收。

当前的[隔离状态报告](plugin-isolated-state.md)只证明 Codex CLI 0.135.0 在唯一临时 `CODEX_HOME` 中可以添加 marketplace、安装缓存副本、启动 MCP、卸载插件并按官方列表语义回滚。它不证明活动 Codex App 已安装或可用，也不能代替真实宿主门禁。

## 当前四模型原子资格认证停止事实

- 冻结 commit：`b57382ed4f2fddce4946613b5aa5739c6eed5c8f`；批次：`2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d`；协议：`four-llm-v1`。
- 完整 preflight 通过；第 1 项 `ark-coding-plan delegate` 固定使用 Pi RPC / `ark-coding-plan` / `ark-code-latest` / direct。
- 实际模型、provider、路由、凭据隔离、只变更预期文件、命令证据和进程清理均正确；adapter 调用、adapter retry、runtime retry、adapter fallback、orchestrator fallback 为 `1 / 0 / 0 / false / false`。
- 安全读取到 30 字节单行结果文件，但其规范化哈希与预期不符且不含预期行，故 `resultFileValid=false`、`failureReason=acceptance_failed`。
- evidence：[JSON](../smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/cases/2026-07-26T17-23-31.295Z-ark-coding-plan-delegate-ark.json)，SHA-256 `166947716c19d435155e4ce0d041e4c88b7ef9b79f302787e0c27572eb39e6c9`。
- blocked manifest：[JSON](../smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json)，SHA-256 `f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c`；immutable-evidence verifier 已通过，`promotionEligible=false`，后七项 not run。
- 当前授权已经消费；批次后 Kimi ACP、Pi RPC、real-smoke 目标进程均为 0。没有 retry、fallback、resume、跳项或第二批。

该终态不允许只补跑失败项，也不允许复用当前授权。未来若重新认证，必须先取得新的明确授权，再从第 1 项开始运行新的完整八项批次。

## 离线修复与验证状态

blocked case 的 raw/normalized 双哈希已确定实际文件是 `ARK_SMOKE_OK:ark-coding-plan;\n`，即旧提示词中紧邻期望 payload 的自然语言分号进入了文件。实现提交 `76504d7d165366ad291e6ff08026b7236f862fc8` 已将三个 Ark delegate profile 的写入要求统一为精确 Node + Base64 Bash 命令，并把 payload 放在独立代码块中。

本次改动没有触及严格结果 validator、provider/model/direct route、凭据、single-attempt、无 retry/fallback、telemetry、资格 schema/protocol 或任何既有 evidence。独立规格和代码质量审阅均为 PASS；fresh typecheck、build、release smoke、临时 `CODEX_HOME` 隔离 check-report、44 个测试文件（569 passed / 1 skipped / 0 failed）、当前 blocked immutable verifier、当前 evidence 5/5、历史 Gemini 14/14、历史 `five-llm-v1` blocked/non-promotable 和目标进程 0/0/0 均通过。Node `spawnSync(bash, ["-c", command])` 探针精确写入 29 bytes、LF 结尾，SHA-256 为 `7b82d87530083f53c07b5b34d5ab4cc8c6bc031c96c70b0be28920262c20fb59`。

这些都是离线证据。本轮没有新的真实模型调用，Ark Coding Plan 仍未重新资格通过，注册表和本安装状态包仍分别保持 6 passed / 2 pending 与 **blocked / not ready**。

## 历史五模型原子重认证停止事实

- 批次：`2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f`；冻结 commit：`f7209cd5744bad12fd27fbb3f5b6cd6fc42c3521`。
- 第 1 项 `gemini-3.5-flash delegate` 因 `google_free_tier_quota` failed；模型、provider、`proxy-10808`、凭据隔离、文件/命令检查和 `1 / 0 / 0 / false / false` 可观测统计均符合契约。
- evidence：[JSON](../smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/cases/2026-07-26T09-01-07.689Z-gemini-3.5-flash-delegate-pi.json)，SHA-256 `ed2e5c79c4cfbf851c7901aeeee5be885055ef244aefcf4ee11dca6ccbccf484`。
- blocked manifest：[JSON](../smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json)，SHA-256 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`；`promotionEligible=false`，后九项 not run。
- 冻结候选 verifier 按预期拒绝晋升，批次后 Kimi ACP、Pi RPC、real-smoke 目标进程均为 0。没有 retry、fallback、resume、跳项或第二批。

该失败批次没有替换 2026-07-25 的完整十项证据，也没有撤销或增加当时的注册表能力。Gemini 现已退役，该批次及授权消费事实只用于历史审计；它不是当前 `four-llm-v1` 的资格来源，也不提供新批次的可复用授权。

## 当前四模型过渡状态

当前四个活动 LLM 全部直连。最新八项资格批次被首项失败阻断后，下表注册表保持不变；只有 Ark Coding Plan 的 review/delegate pending。

| 逻辑 LLM | 固定后端 / 模型 / 路由 | 注册表 review | 注册表 delegate |
| --- | --- | --- | --- |
| `kimi-k3` | Kimi ACP / `kimi-code/k3` / direct | passed | passed |
| `ark-coding-plan` | Pi / `ark-coding-plan` / `ark-code-latest` / direct | pending | pending |
| `ark-agent-plan` | Pi / `ark-agent-plan` / `ark-code-latest` / direct | passed | passed |
| `ark-agent-deepseek-v4-flash` | Pi / `ark-agent-plan` / `deepseek-v4-flash` / direct | passed | passed |

既有精确证据和 SHA-256 见 [Kimi](../smoke/kimi.md)、[Ark](../smoke/ark.md)与 [Gemini 退役历史](../smoke/pi-gemini.md)索引。最新 blocked 证据不能晋级任何 pending 能力；未来新资格仍必须由取得新授权后的完整 `four-llm-v1` 8/8 批次提供，不能把这些既有证据拼接为当前资格。

### 历史五模型阻断证据

1. Gemini delegate 因 Google 免费层额度失败：
   - evidence：[2026-07-25T15-48-28.600Z-gemini-3.5-flash-delegate-pi.json](../smoke/evidence/2026-07-25T15-48-28.600Z-gemini-3.5-flash-delegate-pi.json)
   - SHA-256：`890e546ff993e17f4f9303b88bb10dcb82fbd45a8bf0252f629c458db5a7d5c0`
   - `failureReason`：`google_free_tier_quota`
   - 环境隔离、目标文件/命令证据与无新增 Pi RPC 进程检查均为 true，但模型任务仍因额度诊断为 failed；没有重试或 fallback。
2. Ark Coding Plan delegate 的结果文件内容验收失败：
   - evidence：[2026-07-25T15-51-44.134Z-ark-coding-plan-delegate-ark.json](../smoke/evidence/2026-07-25T15-51-44.134Z-ark-coding-plan-delegate-ark.json)
   - SHA-256：`7d7af81493dd9e94a9669efb12eb90c83c1c7535959b81c385091aa3eef461eb`
   - `failureReason`：`acceptance_failed`
   - 实际模型、provider、direct 路由、环境隔离、变更范围、命令证据和进程清理均正确，但 `resultFileValid` 为 false；没有重试或 fallback。

两项失败都保留为历史事实；其中只有 Ark Coding Plan 仍对应当前 pending profile。Gemini 的失败不再阻断当前 provider，因为该 provider 已退役，但其 evidence、SHA 和失败类别仍不得改写或删除。不能用单项 review passed、旧 evidence 或其它 LLM 替代 Ark Coding Plan 的当前资格。

## 当前四模型资格与授权准备的必要条件

未来只有同时满足以下全部条件，才能把本文件重新收敛为 `ready` 并开始准备某一次真实安装许可：

1. 取得新的明确资格授权，并在一个全新的 `four-llm-v1` 批次中从第 1 项开始严格串行完成四个活动 LLM 的八个精确组合，全部生成新的、脱敏的 `passed` evidence；固定顺序从 Ark Coding Plan delegate/review 开始，再执行 Kimi K3、Ark Agent Plan 和 Ark Agent DeepSeek V4 Flash 的 review/delegate。
2. 每次实际 backend、模型、provider 和 route 与上表固定身份精确一致；不并行运行 Pi smoke，不重用旧证据，不自动 retry 或 fallback。
3. review 找到预置缺陷且工作区零变化；delegate 只产生预期变化并观测到验证命令；每次结束后都没有新增 Kimi/Pi RPC 进程。
4. Kimi/Ark smoke 索引、`docs/smoke/evidence/`、内置注册表、README、运维文档与四层发布清单重新收敛为八项全部 passed，不保留 pending 或自相矛盾的当前状态；Gemini 页面继续只作为退役历史。
5. Ark Coding Plan 提示词离线修复候选已完成 44 个测试文件（569 passed / 1 skipped / 0 failed）、类型检查、构建、`npm run smoke:release`、隔离报告 check-only、资格入口 help、diff check、不可变 evidence 和生产进程基线的 fresh verification，第 1 层已经更新为 passed。第 2 层隔离官方插件生命周期也已通过；若候选的任何 tracked 内容或生成产物随后发生变化，均须在当时版本重新确认。
6. 本状态包改写为 `ready`，以当时的构建产物、隔离状态差异和官方命令行为重新独立审阅。

在这些条件全部成立前，不生成真实安装授权问题，也不进入真实安装执行。

## 外部只读审阅证据

- Kimi K3 的 `adversarial_review` 未发现阻断项，只指出发布清单仍把本文件写成“计划中”的 Minor；该措辞已经修正。
- Ark Agent Plan 的 `review_doc` 未发现 Critical 或 Important，只指出 `docs/operations.md` 顶部硬编码的 as-of 日期会漂移这一项 Minor；该硬编码日期已经从运维文档删除，活动 Codex 尚未安装且本轮被阻断的事实保留。
- 随后的独立质量复审另行发现发布清单顶部没有区分建立日期与最近复核日期；`docs/release/checklist.md` 现已分别标注建立日期 2026-07-25 与最近复核日期 2026-07-27。该修复不归因于 Ark Agent Plan 外审。
- 两次完成审阅的 `filesChanged` 都是 `[]`。本状态包不保存原始长输出、会话 ID 或秘密值，只保留上述可复核结论。
- 当前会话暴露的旧 MCP 状态拒绝 Ark Agent Plan 后，按实施计划从已构建的最新 bundle 启动临时 stdio 客户端并成功完成审阅；这不是插件安装，也没有改变活动 Codex 配置。
- Kimi 首轮等待 300 秒后超时，未形成审阅结论、未改变文件且没有残留进程；随后用聚焦后的同一只读任务完成审阅。任务 7 真实模型门禁的“不重试”边界不适用于任务 8 的只读文档审阅。

## 隔离取证支持的预计状态变化

以下只描述未来 ready 后官方 add/remove 可能产生的相对状态；它不是当前执行指示。

下述版本化缓存路径、预计新增项和预计删除项只来自 **Codex CLI 0.135.0 + 当前候选包 `0.1.0-alpha.1`** 在唯一临时 `CODEX_HOME` 中的实际观察，不是未来真实 Codex App 的路径或版本承诺。未来重入 ready 流程时，必须用当时的 CLI、候选包和全新临时 `CODEX_HOME` 重新完成隔离取证，并以新证据替换这里的缓存路径、预计文件差异和配置语义差异；若当时官方宿主产生可解释的合法差异，不得仅因它不匹配本轮旧路径而判定失败。

### 官方 add 的预计相对变化

- marketplace add：本轮隔离观察中，临时 `CODEX_HOME` 内的 `config.toml` marketplace 语义发生变化。
- plugin add：本轮隔离观察中，临时 `CODEX_HOME` 内的 `config.toml` 插件启用语义发生变化，并在同一临时 `CODEX_HOME` 的 `plugins/cache/codex-external-agents-local/codex-external-agents/0.1.0-alpha.1/` 下新增：
  - `.codex-plugin/plugin.json`
  - `.mcp.json`
  - `runtime/codex-external-agents-mcp.mjs`
- 官方 list 操作不应产生额外语义变化。

隔离报告中 marketplace add 后配置状态为 `H1`，plugin add 后为 `H2`；两次 list 分别保持对应 hash。官方 marketplace 数据包含管理时间，因此这里只承诺语义，不承诺 TOML 字段顺序、时间戳文本或字节级 hash。

### 活动 `config.toml` 的预计 TOML 语义

下面是脱敏后的预计语义，不是项目要写入的文本。表名和值由官方插件身份与本地 marketplace 决定；路径拼写、字段顺序和管理时间由当时官方 CLI 序列化。

```toml
[marketplaces.codex-external-agents-local]
source_type = "local"
source = "<repository-root>"
last_updated = "<official-cli-managed-timestamp>"

[plugins."codex-external-agents@codex-external-agents-local"]
enabled = true
```

项目代码和维护者都不得直接读取或写入活动配置来验证或制造上述片段。未来 ready 状态只能通过官方 list 输出、真实 App 行为与经过审阅的非秘密状态证据验证语义。

### 官方 remove 的预计相对变化

- plugin remove：本轮隔离观察中，移除上述临时 `CODEX_HOME` 内的三个版本化缓存文件，并由官方机制撤销目标插件的启用状态；未来重入时以重新取证得到的实际缓存文件面为准。
- marketplace remove：由官方机制移除目标 marketplace 状态。
- 隔离报告中 plugin remove 后配置回到 `H1`，marketplace remove 后进入 `H3`；官方 CLI 可能合法保留空缓存父目录和其它状态文件，因此只要求官方列表语义回滚与残留可解释，不声称字节级完全回滚。

## 未来 ready 后的宿主验证与回滚边界

如果将来满足全部重入条件并另行取得当次许可，真实宿主验收才可以覆盖：

- 官方 marketplace/plugin 列表确认目标来源和插件已安装；
- 真实 Codex App 新会话确认新安装的 `codex_external_agents` 插件只新增并公开 `external_review` 与 `external_delegate`，且二者 `llm` 始终必填；这是该插件命名空间与插件归属下的发现范围，不表示 Codex 全局只有两个工具；
- 旧 `codex_cc_tools` 仍存在、未修改并与新插件共存；
- Kimi K3 与至少一条已通过的 Pi 路线完成代表性 review；
- delegate 只在隔离临时仓库执行；
- 取消与完成后均无新增 Kimi/Pi RPC 残留进程；
- 结果、诊断和宿主证据脱敏写入未来的 `real-host-acceptance.md`。

任一宿主门禁异常时必须立即停止。回滚只允许按未来 ready 权限包中逐项列出的官方 plugin remove、再 marketplace remove，并用官方 list 确认语义回滚；若官方回滚本身异常，停止并报告。不得手工打开、恢复、重写或修补活动 `config.toml`，也不得借回滚移除旧工具。

## 本轮明确不做

- 不执行真实 marketplace/plugin add 或 remove。
- 不读取、写入、备份或恢复活动 `~/.codex/config.toml`。
- 不移除或修改旧 `codex_cc_tools`。
- 不调用或修改 Claude Code。
- 不执行 `npm publish`，不发布公共 marketplace。
- 不把本状态包解释为未来安装、回滚、升级、旧工具移除或发布的许可。
