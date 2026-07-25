# Pi / Gemini 真实能力门禁

## 当前结论

逻辑 LLM `gemini-3.5-flash` 固定绑定 `pi-rpc`、Google provider、真实模型 `gemini-3.5-flash` 与 `proxy-10808` 路由，不会回退到其它模型或路由。2026-07-25 串行复跑中 review passed，delegate 因 Google 免费层额度失败；按照同一逻辑 LLM 两项必须共同通过的门禁策略，注册表中的 review/delegate 当前均为 pending。

本轮使用 Pi 0.80.10 和隔离配置 SHA-256 `61ffbd4c6ea41adc6a8313f957b732da2b98b8b28b082c52a95226b2a6fb2fe9`。凭据按 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_GENERATIVE_AI_API_KEY` 顺序只选第一个非空值。证据只记录命中的变量名，不记录凭据内容。

两次 evidence 的 `environmentIsolated` 与 `noNewPiRpcProcesses` 均为 true；每次 evidence 验收后的独立系统快照也确认 Kimi 与 Pi RPC 进程数均为 0。delegate 的失败保留为 `google_free_tier_quota`，没有重试或 fallback。

<a id="gemini-review"></a>
## Gemini review

- 本次任务结果：passed；注册表状态：pending（同 profile 的 delegate 未通过）。
- 实际/预期模型均为 `gemini-3.5-flash`；provider 为 `google`；route 为 `proxy-10808`；耗时 10.620 秒。
- 找到预置正确性缺陷；环境隔离、工作区零变更、evidence 清理检查和独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T15-47-08.146Z-gemini-3.5-flash-review-pi.json)；SHA-256 `09f78efdaea50a3f05ef8e8365fda4aab0127152c9ac65600ec76a83d28d663b`。

<a id="gemini-delegate"></a>
## Gemini delegate

- 本次任务结果：failed；注册表状态：pending；稳定失败类别为 `google_free_tier_quota`。
- 实际/预期模型均为 `gemini-3.5-flash`；provider 为 `google`；route 为 `proxy-10808`；耗时 31.716 秒。
- 本地结构化验收检查均为 true，包括环境隔离、目标文件/命令证据和无新增 Pi RPC 进程；模型任务状态仍因额度诊断为 failed。独立系统进程快照同样为零残留。
- 证据：[JSON](evidence/2026-07-25T15-48-28.600Z-gemini-3.5-flash-delegate-pi.json)；SHA-256 `890e546ff993e17f4f9303b88bb10dcb82fbd45a8bf0252f629c458db5a7d5c0`。

## 路由与历史证据

2026-07-18 较早的 direct review/delegate 曾通过，但随后复核发现本机 direct 访问 Google endpoint 超时，而 `10808` 可达。因为网络策略属于逻辑 LLM 身份，注册表改为 `proxy-10808` 后重新执行门禁，不能沿用 direct 证据。

同日两次 `proxy-10808` review 曾被 Google 共享免费层额度阻塞；分类器会把该状态记录为 `google_free_tier_quota`，与适配器故障区分。2026-07-20 额度恢复后的串行复测通过，故旧失败不再代表当前能力状态。

真实 Pi smoke 会比较全机 Pi RPC 进程快照，多项 smoke 必须串行运行，避免其它并发 smoke 被误认成残留进程。
