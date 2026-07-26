# Kimi 真实能力门禁

## 当前结论

当前公开面只支持 `kimi-k3`，固定使用 Kimi ACP、实际模型 `kimi-code/k3` 与 direct 网络策略。2026-07-25 串行复跑的 review/delegate 两项门禁均为 passed，过渡注册表继续启用两项能力。2026-07-27 的最新 `four-llm-v1` 批次在第 1 项 Ark Coding Plan delegate 失败后立即停止，Kimi 两项均为 not run，因此没有形成新的 Kimi 资格结论；未来仍须在取得新授权后的完整同批 8/8 中重新产生 Kimi 两项 passed evidence，不能拼接本页既有证据。

本轮没有回退到其它 Kimi 模型。两次 evidence 内的 `noNewKimiProcesses` 均为 true，且每次 evidence 验收后的独立系统快照也确认 Kimi 与 Pi RPC 进程数均为 0。

2026-07-26 旧五模型 blocked 批次的终态见 [manifest](evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json)，SHA-256 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`。它只记录 Kimi 两项未运行，是 `five-llm-v1` 历史材料，不构成新的 Kimi 质量结论或当前资格来源。

最新四模型 blocked [manifest](evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json) 的 SHA-256 为 `f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c`。它记录 Kimi review/delegate 分别为 ordinal 3/4、均 not run；批次后 Kimi ACP、Pi RPC、real-smoke 进程计数均为 0，没有 retry、fallback、resume 或第二批。

## 方法与通过标准

review 仓库包含一个可复现缺陷：`average([])` 因除以数组长度 0 而返回 `NaN`，与测试要求的 0 不符。通过要求为：ACP 报告的实际模型与注册表一致、结果状态为 `completed`、指出该缺陷，并且调用前后文件证据和 Git 状态均无变化。

delegate 要求只创建内容为 `KIMI_SMOKE_OK` 的 `result.txt`，随后执行 `git status --short`。通过要求为：实际模型一致、结果状态为 `completed`、文件内容正确、桥接层只观测到 `result.txt` 变更，并至少观测到一条真实命令工具事件。两类任务都在调用前后枚举 Kimi PID，要求结束后不存在基线之外的新 Kimi 进程。

证据 JSON 不保存完整提示词、模型回复、OAuth 数据、环境变量或临时绝对路径，只保存非秘密模型身份、耗时、状态、哈希和结构化检查结果。

## 当前 K3 证据

| 逻辑 LLM | 任务 | 实际模型 | 耗时 | 结果 | 证据文件 SHA-256 |
| --- | --- | --- | ---: | --- | --- |
| `kimi-k3` | review | `kimi-code/k3` | 28.145 s | 通过 | `1c9fcd3f5a005f4d1af0430a524906e72d58c9cf4e25da13c96871b8adb09408` |
| `kimi-k3` | delegate | `kimi-code/k3` | 17.598 s | 通过 | `c7169b47b229621dc926f430fe87c4e22c811786d223eb5f11e81b0afe677136` |

<a id="kimi-k3-review"></a>
## kimi-k3-review

- 状态：passed；实际/预期模型均为 `kimi-code/k3`；provider 不适用；route 为 `direct`。
- 零工作区变更，已识别已知缺陷，无诊断；evidence 与独立系统快照均确认无新增 Kimi/Pi RPC 进程。
- 证据：[2026-07-25T15-44-34.778Z-kimi-k3-review.json](evidence/2026-07-25T15-44-34.778Z-kimi-k3-review.json)；SHA-256 `1c9fcd3f5a005f4d1af0430a524906e72d58c9cf4e25da13c96871b8adb09408`。

<a id="kimi-k3-delegate"></a>
## kimi-k3-delegate

- 状态：passed；实际/预期模型均为 `kimi-code/k3`；provider 不适用；route 为 `direct`。
- 只变更 `result.txt`，文件内容正确并观测到命令事件；evidence 与独立系统快照均确认无新增 Kimi/Pi RPC 进程。
- 证据：[2026-07-25T15-46-04.482Z-kimi-k3-delegate.json](evidence/2026-07-25T15-46-04.482Z-kimi-k3-delegate.json)；SHA-256 `c7169b47b229621dc926f430fe87c4e22c811786d223eb5f11e81b0afe677136`。

## 历史 K2.7 证据（不属于当前公开面）

2026-07-18 曾为 `kimi-k2.7` 与 `kimi-k2.7-highspeed` 完成四项 passed 门禁。两者现已从注册表删除；这些记录仅保存历史事实，不证明当前能力，也不会被当前门禁复用。原始 evidence JSON 保持不变。

| 历史逻辑 LLM | 任务 | 历史实际模型 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `kimi-k2.7` | review | `kimi-code/kimi-for-coding` | 通过 | [JSON](evidence/2026-07-18T07-59-25.150Z-kimi-k2.7-review.json) |
| `kimi-k2.7` | delegate | `kimi-code/kimi-for-coding` | 通过 | [JSON](evidence/2026-07-18T07-59-37.579Z-kimi-k2.7-delegate.json) |
| `kimi-k2.7-highspeed` | review | `kimi-code/kimi-for-coding-highspeed` | 通过 | [JSON](evidence/2026-07-18T07-59-47.269Z-kimi-k2.7-highspeed-review.json) |
| `kimi-k2.7-highspeed` | delegate | `kimi-code/kimi-for-coding-highspeed` | 通过 | [JSON](evidence/2026-07-18T07-59-56.939Z-kimi-k2.7-highspeed-delegate.json) |

## 结论

当前内置注册表只启用 `kimi-k3` 的 review/delegate 两个精确能力组合。K2.7 的四项记录是已退出公开面的历史证据，不构成当前支持承诺。该结论只覆盖本页记录的 Kimi Code 版本、逻辑 ID、实际模型和 review/delegate 任务，不自动推广到未来 Kimi 版本、Pi 运行时或其它模型来源。
