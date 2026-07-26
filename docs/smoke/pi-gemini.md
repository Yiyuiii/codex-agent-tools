# Pi / Gemini 退役历史证据

## 退役结论

`gemini-3.5-flash` 已从当前活动注册表、Pi 配置、Google 凭据继承、网络策略、doctor、standalone smoke 和资格执行入口完整退役，不再是当前 provider，也没有 pending 能力。当前四个活动逻辑 LLM 全部 direct；本页只保留 Gemini 曾经使用 Pi RPC / Google / 同名模型 / `proxy-10808` 的历史调用、失败和不可变 evidence 索引。

2026-07-25 的历史复跑使用 Pi 0.80.10 和隔离配置 SHA-256 `61ffbd4c6ea41adc6a8313f957b732da2b98b8b28b082c52a95226b2a6fb2fe9`。当时凭据按 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_GENERATIVE_AI_API_KEY` 顺序只选第一个非空值；证据只记录命中的变量名，不记录凭据内容。上述变量和路由现在只存在于历史 codec、旧文档和泄漏拒绝检查中，不构成活动运行时支持。

两次历史 evidence 的 `environmentIsolated` 与 `noNewPiRpcProcesses` 均为 true；每次 evidence 验收后的独立系统快照也确认 Kimi 与 Pi RPC 进程数均为 0。delegate 的失败保留为 `google_free_tier_quota`，没有重试或 fallback。该类别只用于解释历史 evidence，不再是活动 smoke 的失败原因。

## 2026-07-26 五模型原子重认证停止证据

- 批次：`2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f`；冻结 commit：`f7209cd5744bad12fd27fbb3f5b6cd6fc42c3521`。
- 固定顺序的第 1 项 `gemini-3.5-flash delegate` 状态为 failed，`failureReason=google_free_tier_quota`；第 2 项 Gemini review 与后续八项均为 not run。
- 实际/预期模型、Google provider、`proxy-10808`、凭据名称、结果文件、命令与隔离检查均符合契约；可观测统计为 `1 / 0 / 0 / false / false`。批次后独立系统快照确认 Kimi ACP、Pi RPC、real-smoke 均为 0。
- evidence：[JSON](evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/cases/2026-07-26T09-01-07.689Z-gemini-3.5-flash-delegate-pi.json)；SHA-256 `ed2e5c79c4cfbf851c7901aeeee5be885055ef244aefcf4ee11dca6ccbccf484`。
- blocked manifest：[JSON](evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json)；SHA-256 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`；`promotionEligible=false`。冻结候选 verifier 按预期拒绝晋升。
- 当时授权已由 `batch_started` 消费；没有 retry、fallback、resume、跳项或第二批。该授权不能用于当前 `four-llm-v1`，旧批次也不能参与四模型晋级。

<a id="gemini-review"></a>
## Gemini review

- 历史任务结果：passed；当时注册表状态：pending（同 profile 的 delegate 未通过）。
- 实际/预期模型均为 `gemini-3.5-flash`；provider 为 `google`；route 为 `proxy-10808`；耗时 10.620 秒。
- 找到预置正确性缺陷；环境隔离、工作区零变更、evidence 清理检查和独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T15-47-08.146Z-gemini-3.5-flash-review-pi.json)；SHA-256 `09f78efdaea50a3f05ef8e8365fda4aab0127152c9ac65600ec76a83d28d663b`。

<a id="gemini-delegate"></a>
## Gemini delegate

- 历史任务结果：failed；当时注册表状态：pending；稳定失败类别为 `google_free_tier_quota`。
- 实际/预期模型均为 `gemini-3.5-flash`；provider 为 `google`；route 为 `proxy-10808`；耗时 31.716 秒。
- 本地结构化验收检查均为 true，包括环境隔离、目标文件/命令证据和无新增 Pi RPC 进程；模型任务状态仍因额度诊断为 failed。独立系统进程快照同样为零残留。
- 证据：[JSON](evidence/2026-07-25T15-48-28.600Z-gemini-3.5-flash-delegate-pi.json)；SHA-256 `890e546ff993e17f4f9303b88bb10dcb82fbd45a8bf0252f629c458db5a7d5c0`。

## 更早的路由与失败记录

2026-07-18 较早的 direct review/delegate 曾通过，但随后复核发现本机 direct 访问 Google endpoint 超时，而 `10808` 可达。因为网络策略属于逻辑 LLM 身份，注册表改为 `proxy-10808` 后重新执行门禁，不能沿用 direct 证据。

同日两次 `proxy-10808` review 曾被 Google 共享免费层额度阻塞；当时的分类器会把该状态记录为 `google_free_tier_quota`，与适配器故障区分。2026-07-20 额度恢复后的串行复测通过。这些结果现在都只描述已退役路线的历史表现。

当时的真实 Pi smoke 会比较全机 Pi RPC 进程快照，多项 smoke 必须串行运行，避免其它并发 smoke 被误认成残留进程。当前没有 Gemini standalone smoke 入口。
