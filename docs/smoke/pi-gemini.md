# Pi / Gemini 真实能力门禁

## 当前结论

2026-07-20，逻辑 LLM `gemini-3.5-flash` 在固定 `proxy-10808` 路由下分别通过 `review` 与 `delegate` 真实门禁，现已启用。它固定绑定 `pi-rpc`、Google provider 和真实模型 `gemini-3.5-flash`；不会回退到其它模型或路由。

本轮使用 Pi 0.80.10 和隔离配置 SHA-256 `ab12536cc03dd368115d71bab6eb65216506717fc63b33c4b8a077d82b3ebbf6`。凭据按 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_GENERATIVE_AI_API_KEY` 顺序只选第一个非空值。证据不记录凭据内容。

2026-07-25 的官方插件实施任务 7 将按当前五模型矩阵重新串行执行 Gemini review/delegate，并生成新的精确证据。当前路由保持 `proxy-10808` 不变；若复跑遭遇 Google 共享免费层额度或其它失败，必须保留真实失败，不得切换模型、provider 或网络策略。

<a id="gemini-review"></a>
## Gemini review

- 结果：passed；实际模型：`gemini-3.5-flash`；路由：`proxy-10808`；耗时：27.864 秒。
- 找到预置正确性缺陷；环境隔离、工作区零变更和 Pi 进程清理均通过。
- 证据：[JSON](evidence/2026-07-20T07-30-18.646Z-gemini-3.5-flash-review-pi.json)；SHA-256 `4c4656c0d5210555e641af05616e973508826b5aa549eaca9e3d9b24b8bc7e8d`。

<a id="gemini-delegate"></a>
## Gemini delegate

- 结果：passed；实际模型：`gemini-3.5-flash`；路由：`proxy-10808`；耗时：8.230 秒。
- 仅变更 `result.txt`，文件内容正确，且观测到验证命令；环境隔离和 Pi 进程清理均通过。
- 证据：[JSON](evidence/2026-07-20T07-33-34.354Z-gemini-3.5-flash-delegate-pi.json)；SHA-256 `9863ec964cfe4c070bf8d76369ae240431f4b3f373c34999a27d8fae6889c5dc`。

## 路由与历史证据

2026-07-18 较早的 direct review/delegate 曾通过，但随后复核发现本机 direct 访问 Google endpoint 超时，而 `10808` 可达。因为网络策略属于逻辑 LLM 身份，注册表改为 `proxy-10808` 后重新执行门禁，不能沿用 direct 证据。

同日两次 `proxy-10808` review 曾被 Google 共享免费层额度阻塞；分类器会把该状态记录为 `google_free_tier_quota`，与适配器故障区分。2026-07-20 额度恢复后的串行复测通过，故旧失败不再代表当前能力状态。

真实 Pi smoke 会比较全机 Pi RPC 进程快照，多项 smoke 必须串行运行，避免其它并发 smoke 被误认成残留进程。
