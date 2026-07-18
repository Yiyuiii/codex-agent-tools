# Pi / Gemini 真实能力门禁

2026-07-18 使用本机 Pi 0.80.10 对逻辑 LLM `gemini-3.5-flash` 完成独立 review/delegate 门禁。真实绑定固定为 `pi-rpc`、Google provider、`gemini-3.5-flash`、direct；Pi 使用本包生成的隔离配置目录，配置内容 SHA-256 为 `7c6003bb69fea9e1c43887372649c46af279a87381fd6ffdaddc2778fcfc51e8`。

## 方法与边界

review 使用与 Kimi 门禁相同的确定性缺陷：`average([])` 因除以长度 0 而返回 `NaN`，与测试要求的 0 不符。review 只向 Pi 开放 `read,grep,find,ls`，通过条件包括：实际模型一致、命中缺陷、工作区零变更、无 review policy violation。

delegate 要求只创建内容为 `PI_SMOKE_OK` 的 `result.txt`，并通过 bash 工具执行精确命令 `git status --short`。通过条件包括：实际模型一致、只有预期文件变化、文件内容正确、桥接层观测到真实 bash 命令事件。

两类任务都验证 Pi 子进程环境：仅复制优先级最高的 `GEMINI_API_KEY`，没有继承代理，也没有 Kimi、Ark、Anthropic、OpenAI 或 DeepSeek 凭据；调用前后枚举带专用会话名的 Pi RPC PID，要求结束后无新增残留进程。证据不保存凭据值、完整环境、完整提示词、完整模型输出或临时绝对路径。

## gemini-review

- 状态：通过。
- 实际模型：`gemini-3.5-flash`。
- 耗时：13.436 秒。
- 证据摘要：命中已知缺陷、工作区零变更、环境隔离通过、无新增 Pi RPC PID、无诊断。
- 证据：[2026-07-18T08-33-35.891Z-gemini-3.5-flash-review-pi.json](evidence/2026-07-18T08-33-35.891Z-gemini-3.5-flash-review-pi.json)
- 证据文件 SHA-256：`3e30fd8879f26cbd51359c0383ca71ed288364d899a96dde3f8b32f3d5fa49a1`。

## gemini-delegate

- 最终状态：通过。
- 实际模型：`gemini-3.5-flash`。
- 最终耗时：9.499 秒。
- 最终证据摘要：只变更 `result.txt`，内容正确，观测到 1 条 `git status --short` 命令事件，环境隔离通过，无新增 Pi RPC PID，无诊断。
- 通过证据：[2026-07-18T08-35-31.179Z-gemini-3.5-flash-delegate-pi.json](evidence/2026-07-18T08-35-31.179Z-gemini-3.5-flash-delegate-pi.json)
- 通过证据文件 SHA-256：`ba5aea6c9cb0a158b079e3ca6a2dbaa7f682924d193fb53bb62ff9529290f7ea`。

首次 delegate 尝试在 6.060 秒完成文件写入，但模型没有执行提示中的验证命令，因此 `commandObserved=false`，门禁正确失败。随后把“写文件”和“精确 bash 调用”明确为完成前必须执行、不得用文字声明替代的两个验收动作，第二次通过。失败证据予以保留：[2026-07-18T08-33-56.352Z-gemini-3.5-flash-delegate-pi.json](evidence/2026-07-18T08-33-56.352Z-gemini-3.5-flash-delegate-pi.json)，SHA-256 `85b0302d6e5d1e81a33e62697c12d62fe1d56654d915c3c77cdcbe2a81660ca1`。

## 结论

`gemini-3.5-flash` 的 review 与 delegate 已分别通过真实门禁，可在内置注册表中启用。此结论只覆盖本页记录的 Pi 版本、逻辑 ID、真实模型、direct 网络策略和两类任务；未来 Pi/Gemini 版本变更或其它 Pi provider 仍需独立门禁。
