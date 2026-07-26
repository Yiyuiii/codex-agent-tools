# Gemini 退役与四模型资格认证设计

日期：2026-07-26

状态：设计已获用户批准；书面规格自检与独立复核通过，等待用户确认

## 1. 决策与目标

用户确认 Gemini 免费额度过低，实际不可用，因此将 `gemini-3.5-flash` 从 `codex-agent-tools` 当前产品面移除。移除范围覆盖活动注册表、运行时凭据与网络策略、doctor、smoke、资格认证、隔离插件验收和当前用户文档；已经提交的 Gemini evidence 与失败批次作为历史审计材料保留，不改写、不删除，也不能继续参与当前能力晋级。

当前产品面收缩为四个逻辑 LLM：

| 逻辑 LLM | 运行时 | provider / 模型 | 网络 |
| --- | --- | --- | --- |
| `kimi-k3` | Kimi Code ACP | `kimi-code/k3` | direct |
| `ark-coding-plan` | Pi RPC | `ark-coding-plan` / `ark-code-latest` | direct |
| `ark-agent-plan` | Pi RPC | `ark-agent-plan` / `ark-code-latest` | direct |
| `ark-agent-deepseek-v4-flash` | Pi RPC | `ark-agent-plan` / `deepseek-v4-flash` | direct |

公开 MCP 仍固定为 `codex_external_agents`，工具仍只有 `external_review` 与 `external_delegate`，每次调用仍必须显式填写 `llm`。本设计不重新引入 Claude Code、Anthropic Claude、OpenAI/Codex 模型家族、独立 DeepSeek API 或其它未批准来源。

四个活动 LLM 的子进程全部直连。项目不再为任何活动 LLM 注入 `10808`；这不改变 Codex 自身可能使用的本机 `10808` 网络设置，也不授权项目读取或修改活动 Codex 配置。

## 2. 方案比较

### 方案 A：完整收缩活动产品面并保留历史证据（采用）

删除所有 Gemini 活动入口与资格依赖，同时保留不可变历史 evidence、旧批次和历史说明。优点是产品契约、凭据面、网络面、doctor 与门禁完全一致，不留下看似可用的死能力；历史失败仍可复核。

### 方案 B：只从注册表隐藏 Gemini（不采用）

该方案改动较小，但会留下 Google 凭据白名单、`10808` preflight、quota 分类、Gemini smoke 和大量不可达测试。未来维护者容易误认为 Gemini 仍受支持，安全与运维边界也会继续扩大。

### 方案 C：保留隐藏的通用 Google/Pi 能力（不采用）

该方案便于未来恢复，但当前没有可用额度来源，也没有已批准的恢复路线。为假设性未来维护 provider、代理、重试和凭据逻辑不符合当前 YAGNI 边界；若未来重新引入 Google 模型，应以新的设计、凭据与真实门禁重新实施。

## 3. Ark Coding Plan 失败调查

2026-07-25 的 `ark-coding-plan delegate` evidence 只显示一个失败检查：

- `actualModelMatches=true`；
- provider 为 `ark-coding-plan`，endpoint host 为 `ark.cn-beijing.volces.com`，route 为 `direct`；
- 子进程只获得固定目标凭据 `CODEX_AGENT_ARK_CODING_KEY`，环境隔离通过；
- 任务正常完成，只观察到 `ark-coding-plan-smoke.txt` 一个预期文件变更；
- 命令调用已观察，Pi RPC 进程清理通过；
- 唯一失败值为 `resultFileValid=false`，稳定分类为 `acceptance_failed`。

Pi 配置中 Coding Plan 与 Agent Plan 都使用 `anthropic-messages` 和 `ark-code-latest`，区别是独立 endpoint（`/api/coding` 与 `/api/plan`）、凭据和额度池。Coding Plan 同一路线在 2026-07-20 的 delegate 曾通过，2026-07-25 的 review 也通过；Agent Plan 同模型的 delegate 亦通过。因此现有证据不支持“路由、协议或模型绑定错误”假设。

旧 schema v1 evidence 没有保存失败文件长度、哈希、规范化行数或正文，临时工作区也已经按安全流程删除，所以无法再区分额外说明文字、标点、编码差异或其它内容偏差。当前置信度最高的解释是一次上游指令遵循波动，但该解释不是通过证据。

处理原则：

- 保留现有 endpoint、provider、模型、凭据和直连策略；
- 不放宽精确结果文件验收；
- 不增加 retry、fallback 或提示词补偿；
- 用已经实现的 evidence v2 文件诊断和可观测 telemetry 重新认证；
- 新批次若再次失败，按新证据报告事实并立即停止。

## 4. 当前状态迁移

移除 Gemini 后，当前活动产品面从“五个逻辑 LLM、十项能力、6 passed / 4 pending”变为“四个逻辑 LLM、八项能力、6 passed / 2 pending”。

两个 pending 项均属于 `ark-coding-plan`。这里的 6/2 只是新产品面采用既有成对门禁后的过渡状态，不表示可以只重跑两项并拼接历史证据。为了形成同一代码、构建和运行条件下的完整资格证明，新协议仍要求四个 LLM 的八项 review/delegate 在同一批次全部产生新的 passed evidence。

只有同批 8/8 通过后，注册表才可一起晋级为 8 passed / 0 pending，并进入 `ready` 审阅包阶段。任一失败均保持 `blocked / not ready`，不晋级任何 pending 能力。

## 5. 历史证据与协议版本

### 5.1 历史材料

以下原始证据保持字节不变，历史索引保持事实与链接语义不变：

- `docs/smoke/evidence/` 下既有 Gemini 单项 evidence；
- `docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/` 的 blocked 批次；
- 这些文件在既有索引中记录的 SHA-256；
- `docs/smoke/pi-gemini.md` 已记录的历史事实与证据链接。

`docs/smoke/pi-gemini.md` 改为明确的退役历史页；允许修改说明文字和索引角色，但不得改写其引用的原始 evidence 或把历史通过/失败解释为当前能力。活动 README、doctor、发布清单和安装状态包不再把 Gemini 列为支持或 pending 模型。

### 5.2 版本化资格计划

不能直接把现有全局十项数组改成八项后继续用同一 manifest 语义，否则旧批次会被新 verifier 误判为损坏，或者新旧 evidence 被错误混用。

采用以下版本边界：

- 旧 manifest/checkpoint schema v1 固定绑定历史计划 `five-llm-v1` 和原十项顺序，只提供只读解析与验真，不允许启动新批次或晋级当前注册表；
- 新 manifest/checkpoint schema v2 显式记录 `qualificationPlanId: "four-llm-v1"`，固定绑定新八项顺序；
- 新批次 case evidence 使用 schema v3，并在 qualification 身份中记录同一个 `qualificationPlanId`；
- 旧 `FrozenPreflightRecord` schema v1 使用独立的 legacy codec：它冻结五个历史逻辑 LLM、Google/Ark 凭据名称、Gemini `proxy-10808`、历史构建产物（包括 `dist/pi-smoke.js`）和旧 failure reason 集合，不调用活动 `resolveLlm()` / `supportedLlmIds()`，也不要求这些已退役产物继续存在于当前构建；
- 新 `FrozenPreflightRecord` schema v2 显式绑定 `four-llm-v1`，只接受四个活动 LLM、direct 路由、Ark/Kimi 凭据与新的构建产物集合，不包含 `proxy10808` 或 `dist/pi-smoke.js`；
- manifest、checkpoint 和 verifier 必须先根据外层 schema 与计划身份选择固定 schedule 和 preflight codec，再解析任何模型、构建或网络字段，不能先用活动注册表解释历史记录；
- standalone smoke 仍可沿用与批次无关的既有 evidence 语义；只有新资格批次必须使用带计划身份的新 schema；
- 授权复用索引、锁恢复和批次扫描同时认识旧、新 schema，避免旧授权或旧批次被遗漏；
- 新协调器只允许创建 `four-llm-v1`，旧 `five-llm-v1` 不再有执行入口；
- verifier 根据磁盘记录的 schema 和计划身份选择固定 schedule，拒绝未知计划、case 数量漂移、ordinal 漂移、混用 schema 或跨计划 evidence。

历史 v1 verifier 只按冻结 codec 校验旧记录的结构、内部身份、互引哈希和既有 evidence，不要求当前工作树重新生成已经退役的 Gemini 构建产物，也不拿当前 registry 或 bundle 与旧 preflight 比较。旧协议兼容的目的只是证明历史文件没有发生非一致篡改，不是继续支持 Gemini，也不允许旧十项批次参与新四模型晋级。frozen-candidate verifier 只服务当前可执行的 `four-llm-v1` 候选。

## 6. 新八项原子资格批次

固定风险优先顺序：

1. `ark-coding-plan` delegate
2. `ark-coding-plan` review
3. `kimi-k3` review
4. `kimi-k3` delegate
5. `ark-agent-plan` review
6. `ark-agent-plan` delegate
7. `ark-agent-deepseek-v4-flash` review
8. `ark-agent-deepseek-v4-flash` delegate

Coding Plan delegate 是唯一仍需复核的历史内容验收失败，放在首项可以在失败时避免继续消耗其它计划额度。

既有原子批次安全语义全部保留：

- 完整 deterministic preflight 在创建批次 tracked 文件前完成；
- 冻结 commit、clean tree、构建身份、隔离 Pi 配置与凭据命中来源都要固定；
- 新批次使用新的授权引用，只存其 SHA-256，不保存对话原文；
- 新 lock owner 使用 schema v2 并记录 `qualificationPlanId: "four-llm-v1"`；历史 schema v1 owner 只解释为 `five-llm-v1`，不补写或猜测计划身份；
- `batch_started` 在任何真实调用前耐崩溃地消费授权；
- 严格串行、每项一次 adapter client 调用、零 adapter retry、零运行时显式 retry、零 fallback；
- 每项前后目标进程分类必须为零；
- 任一失败、受控基础设施异常或崩溃立即停止，后续项记为 not run；
- 不允许 resume、跳项、拼接旧 evidence 或在同一授权下重开；
- 8/8 通过只产生 `promotionEligible=true` 终态，协调器不直接修改注册表。

Gemini 退出后，preflight 不再要求本机 `10808` listener，也不再检查 Google credential。它仍必须证明父环境中的继承代理不会进入四个 direct 子进程。

崩溃恢复不得引用活动全局 schedule 推断旧批次。恢复流程按以下顺序闭合计划身份：

1. schema v1 lock owner 固定映射到 `five-llm-v1`；schema v2 owner 必须显式携带 `four-llm-v1`；
2. 若已有 `batch_started` checkpoint 或终态 manifest，其 schema、计划身份、batchId 与 owner 必须一致；
3. 根据已经确认的计划身份选择固定八项或十项 schedule，再生成 not-run 列表和 interrupted 终态；
4. 即使崩溃发生在 `batch_started` 发布前，只要留下可归属的 stale owner，也沿用既有保守语义发布 `interrupted` 并消费该授权；
5. owner、checkpoint 或终态身份冲突、未知 schema 或未知计划时 fail closed，保留锁和磁盘事实供人工调查，不猜测 schedule、不释放非己方锁、不发布第二终态。

用户在批准本设计时给出的“没有问题，请你继续”授权覆盖本设计、实施、确定性验收以及冻结候选上的一次 `four-llm-v1` 八门禁批次；它不覆盖第二批、失败后的重试、活动 Codex 安装、插件发布、旧工具移除或任何配置编辑。

## 7. 活动代码移除范围

### 7.1 注册表与公共行为

- 从 `src/llms/registry.ts` 删除 `gemini-3.5-flash`；
- supported LLM 列表、未知 LLM 错误、CLI/MCP schema 与 doctor 只显示四个活动 LLM；
- 删除 Google credential 名称的活动收集与继承；
- pending 拒绝测试改为只覆盖 `ark-coding-plan`；
- `external_review` 与 `external_delegate` 的 schema、名称和 `llm` 必填语义不变。

### 7.2 Pi 与环境

- Pi 隔离配置只生成 `ark-coding-plan` 和 `ark-agent-plan` provider；
- 从活动 adapter/runtime 删除 Gemini 特定 outer retry、free-tier quota 分类和 Google endpoint 诊断；legacy ledger/preflight/evidence codec 仍接受历史 `google_free_tier_quota` 与 Google 身份，否则既有 blocked 批次无法只读验真；
- 删除活动子进程 `proxy-10808` 注入路径，只保留 direct 子进程清除父代理的安全行为；
- 删除只服务 Gemini 的 `smoke:pi` / `real-pi-smoke.mjs` 入口；Ark 继续通过 `smoke:ark`；
- fake Pi 可以保留实现通用错误、重试或身份漂移测试所必需的中立 fixture，但不得继续把 Gemini 当成默认活动模型。

### 7.3 插件、验收与发布

- 隔离官方插件生命周期不再先调用 pending Gemini；改为验证不存在/未知 Gemini，并用活动 Ark/Kimi profile 验证工具调用；
- local acceptance、plugin isolated report、发布清单和安装状态包统一使用四模型八能力术语；
- 插件 manifest 和 MCP bundle 仍只公开两个工具，不新增字段或工具；
- 当前活动 Codex 尚未安装该插件，本阶段不执行 cachebuster 重装，不调用活动 `codex plugin add/remove`；
- 隔离临时 `CODEX_HOME` 中的官方生命周期验收仍必须 fresh 运行。

## 8. 文档边界

必须同步更新：

- `AGENTS.md` 项目记忆与索引；
- `README.md` 当前产品面和发布状态；
- `docs/operations.md`；
- `docs/migration-from-codex-cc-tools.md`；
- `docs/release/checklist.md`；
- `docs/release/real-plugin-install-review.md`；
- `docs/smoke/ark.md`；
- `docs/smoke/pi-gemini.md` 退役历史说明；
- 资格设计、实施计划和完成记录。

既有旧计划和旧设计属于历史决策记录，不应批量重写为仿佛当时从未支持 Gemini；在文档顶部或当前索引中标明被本设计取代即可。当前事实与历史事实必须明确分层。

## 9. 晋级、审阅与安装停止线

### 八项全部通过

1. frozen-candidate verifier 从磁盘重验新 schema v2 manifest、八份 schema v3 evidence、checkpoint、commit、build、模型/provider/route/credential 和 telemetry。
2. 成对晋级 `ark-coding-plan`，使当前四模型八能力全部 passed。
3. 更新 registry、bundle、smoke 索引、README、运维、发布清单和安装状态包。
4. 运行 immutable-evidence verifier，确保源码晋级没有改写原批次。
5. fresh 运行类型检查、全量测试、build、release smoke 和隔离官方插件生命周期。
6. 使用当时 qualified 的外部 LLM 做只读规格与质量复核，由 Codex 综合裁决。
7. 把安装状态包收敛为 `ready`，向用户提供最小充分审阅材料。

即使 8/8 全部通过，本阶段仍停在活动 Codex 安装之前。不得读取、写入、备份或恢复活动 `~/.codex/config.toml`，不得调用或修改 Claude Code / `codex_cc_tools`，不得执行 npm publish，也不得移除旧工具。

### 任一失败

- 发布并提交新的 blocked/interrupted manifest 与脱敏 evidence；
- 当前注册表保持 6 passed / 2 pending；
- 安装状态包保持 `blocked / not ready`；
- 当前授权视为已经消费；
- 不自动重试或重开；
- 向用户报告精确失败层、证据哈希和下一步需要的新决策。

## 10. 测试与验收

行为代码全部采用 RED → GREEN → REFACTOR：

- registry：Gemini 不再可解析，四个 ID 固定，Ark Coding 保持 pending；
- environment：Google credential 不再继承，四个 direct profile 均清除父代理；
- Pi adapter：Ark 两个 provider 与模型身份不漂移，Gemini 特定 retry/quota 分支不存在；
- doctor：只报告 Kimi 与三条 Ark 逻辑 LLM，不要求 Google key 或 10808；
- qualification：旧 v1/`five-llm-v1` 只读兼容，新 v2/`four-llm-v1` 八项严格执行；
- verifier：未知 plan、八/十项混用、schema 混用、ordinal 漂移和历史文件篡改全部 fail closed；
- coordinator：八项严格串行、首项失败时七项 not run、8/8 才 promotion eligible；
- plugin acceptance：Gemini 不在工具支持列表，两个工具与 `llm` 必填不变；
- packaging：历史 Gemini evidence 仍进入包面并通过敏感信息扫描；
- docs：活动四模型状态与历史 Gemini 记录不相互矛盾。

冻结候选前必须 fresh 通过：

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated
npm run qualify:gates -- --help
git diff --check
```

真实八门禁不是普通回归测试，只能在冻结候选、目标进程基线为零且当前一次授权仍有效时通过固定协调器启动。

## 11. 非目标

- 不恢复或替换 Gemini 的付费 API；
- 不保留隐藏的 Google provider 作为当前产品能力；
- 不改变 Ark endpoint、模型、凭据优先级或额度池；
- 不通过放宽文件内容、命令或工作区验收来让 Ark Coding Plan 通过；
- 不改变 `external_review` / `external_delegate` 公共工具合同；
- 不安装、升级、卸载或发布活动插件；
- 不修改活动 Codex、Pi 日常配置、Claude Code 或 `codex_cc_tools`；
- 不把旧五模型批次重新解释为新四模型的通过证据。
