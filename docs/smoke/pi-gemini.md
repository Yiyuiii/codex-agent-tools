# Pi / Gemini 真实能力门禁

当前结论（2026-07-18）：逻辑 LLM `gemini-3.5-flash` 固定绑定为 `pi-rpc`、Google provider、真实模型 `gemini-3.5-flash`、`proxy-10808`。当前 review/delegate 均为 **pending**，不会被 MCP 调用，也不会回退到其它模型。

## 为什么重新打开门禁

同日较早时，Gemini 的 direct 路由 review/delegate 曾分别通过真实烟测；这些证据证明 Pi 协议、模型身份、工具限制和工作区证据链可用，但只授权当时的 direct 绑定。

随后复核发现本机 direct 访问 `generativelanguage.googleapis.com` 超时，而通过 `10808` 和 `11808` 均能立即到达 Google endpoint 并得到预期的未认证响应。为了满足“每个逻辑 LLM 固定网络策略”并使用本机 Codex 的既有网络线路，注册表把 Gemini 固定为 `proxy-10808`。网络绑定是能力身份的一部分，因此历史 direct 证据不能沿用，review/delegate 都必须重新通过。

## 当前路由的最新结果

`proxy-10808` review 已真实执行：实际 provider/model、固定代理、唯一 Gemini 凭据、隔离 Pi 配置、工作区零变更和无残留 Pi 进程均验证通过；Google 接口返回共享免费层 `generate_content_free_tier_requests` 配额错误。适配器按上游明确给出的窗口等待一次后复试，仍被同一外部额度限制拒绝，因此门禁正确失败。

- 状态：失败，能力保持 pending。
- 实际模型：`gemini-3.5-flash`。
- 路由：`proxy-10808`。
- 配置 SHA-256：`ab12536cc03dd368115d71bab6eb65216506717fc63b33c4b8a077d82b3ebbf6`。
- 耗时：131.536 秒（含一次 60 秒有界等待）。
- 安全检查：环境隔离通过、工作区零变更、无新增 Pi RPC 进程。
- 证据：[2026-07-18T10-24-35.508Z-gemini-3.5-flash-review-pi.json](evidence/2026-07-18T10-24-35.508Z-gemini-3.5-flash-review-pi.json)
- 证据文件 SHA-256：`7105920a222337ee456f59a4ca37888c04ec90e673fb56a832147c0545aab160`。

为了避免在已确认的共享额度阻塞下继续消耗请求，当前路由的 delegate 尚未执行。review 和 delegate 都保持 pending；额度恢复后必须分别复跑，不能以 review 结果推断 delegate。

## 历史 direct 证据（仅作回归参考）

历史 review：

- 状态：通过；耗时 13.436 秒。
- 证据：[2026-07-18T08-33-35.891Z-gemini-3.5-flash-review-pi.json](evidence/2026-07-18T08-33-35.891Z-gemini-3.5-flash-review-pi.json)
- SHA-256：`3e30fd8879f26cbd51359c0383ca71ed288364d899a96dde3f8b32f3d5fa49a1`。

历史 delegate：

- 最终状态：通过；耗时 9.499 秒；仅变更 `result.txt`，内容正确并观测到命令事件。
- 通过证据：[2026-07-18T08-35-31.179Z-gemini-3.5-flash-delegate-pi.json](evidence/2026-07-18T08-35-31.179Z-gemini-3.5-flash-delegate-pi.json)
- SHA-256：`ba5aea6c9cb0a158b079e3ca6a2dbaa7f682924d193fb53bb62ff9529290f7ea`。

delegate 的首次 direct 尝试只写文件而没有执行验证命令，门禁正确失败；失败证据为 [2026-07-18T08-33-56.352Z-gemini-3.5-flash-delegate-pi.json](evidence/2026-07-18T08-33-56.352Z-gemini-3.5-flash-delegate-pi.json)，SHA-256 `85b0302d6e5d1e81a33e62697c12d62fe1d56654d915c3c77cdcbe2a81660ca1`。

## 复跑条件

1. `10808` 本机代理可达 Google endpoint。
2. `GEMINI_API_KEY`、`GOOGLE_API_KEY` 或 `GOOGLE_GENERATIVE_AI_API_KEY` 至少一个在 Codex 父环境可用。
3. Google 免费层/项目配额已恢复。
4. 依次运行 `proxy-10808` review 与 delegate 真烟测；两项分别通过后才更新内置门禁。
