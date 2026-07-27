# Kimi 真实能力门禁

## 当前结论

当前公开面只支持 `kimi-k3`，固定使用 Kimi ACP、实际模型 `kimi-code/k3` 与 direct 网络策略。2026-07-25 串行复跑的 review/delegate 两项门禁均为 passed，过渡注册表继续启用两项能力。

最新 `four-llm-v1` 批次 `2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa` 中，ordinal 3 Kimi review 通过；ordinal 4 Kimi delegate 的实际模型、direct 路由、只变更 `result.txt`、14-byte 单行结果、进程清理与 `1 / 0 / 0 / false / false` telemetry 均正确，但 `requiredCommandObserved=false`，因此以 `acceptance_failed` 停止。证据只保存 `commandCount=1`，不保存原始命令正文，所以不能证明 `git status --short` 是完全省略还是被合并进其它命令，也不得放宽 validator。

该批次以 `blocked / case_failed` 结束，后四项未运行，未形成完整同批 8/8。旧 Kimi 两项 passed 证据仍解释当前注册表中的 Kimi 能力，但不能与本轮或其它批次拼接完成原子资格；过渡注册表继续为 6 passed / 2 pending，安装继续为 `blocked / not ready`。未来完整八项批次必须重新冻结、复核并取得新授权，从 ordinal 1 开始。

本轮没有回退到其它 Kimi 模型。两份新 Kimi evidence 内的 `noNewKimiProcesses` 均为 true，批次终态后的独立系统快照也确认 Kimi ACP、Pi RPC 与 real-smoke 为 0/0/0；没有 retry、fallback、resume、补跑或第二批。

2026-07-26 旧五模型 blocked 批次的终态见 [manifest](evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json)，SHA-256 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`。它只记录 Kimi 两项未运行，是 `five-llm-v1` 历史材料，不构成新的 Kimi 质量结论或当前资格来源。

最新四模型 blocked [manifest](evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/manifest.json) 的 SHA-256 为 `d7be5e6ba3884075d80fe399dd3c2d72caaa1a3833f92e529928655e623b7b69`。它是 schema v2、4 completed / 4 notRun、9 checkpoints、`uncommittedEvidence=null`、`promotionEligible=false`；immutable-evidence verifier 已通过，证据提交为 `4f816f0`。Kimi review [evidence](evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/cases/2026-07-27T10-24-21.919Z-kimi-k3-review.json) SHA-256 为 `3082a3c5e3c6abee8b81bb6c5aec2505ace5af28cfb704d03c933b89bbf2324c`；Kimi delegate [evidence](evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/cases/2026-07-27T10-24-46.832Z-kimi-k3-delegate.json) SHA-256 为 `50ad43971505e90c3b853ac20f446b31e2061d1471948afe6f5a0231a0747ec5`。

上一轮四模型 interrupted [manifest](evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json) 的 SHA-256 为 `3e200dca507fe886d4e3a4bbf67cc811cca485120e6969e7632f933537ba902b`。它只证明该历史批次被中断、Kimi 两项未运行，不支持任何新的 Kimi 资格或模型质量判断。

上一轮历史四模型 blocked [manifest](evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json) 的 SHA-256 为 `f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c`。它记录 Kimi review/delegate 分别为 ordinal 3/4、均 not run；批次后 Kimi ACP、Pi RPC、real-smoke 进程计数均为 0，没有 retry、fallback、resume 或第二批。

## 离线命令观测加固状态

用户已经批准并完成 Kimi 资格命令观测的离线实现。delegate 资格提示词现在要求先用一个工具调用写入 `result.txt`，再用另一个独立 execute/shell 工具调用只执行 `git status --short`；管道、重定向、连接符、包装命令和模型正文声明都不能满足该要求。通过判定保持原样，仍只使用：

```ts
result.commandsRun.includes("git status --short")
```

Kimi ACP client 现在保留协议允许晚到的 `kind/title/rawInput`，任务层只在同一次 adapter 结果内按 tool-call ID 归并初始 call 和 update，再形成一个最终命令观测。新产生的 Kimi delegate evidence 将把内部观测映射为 `raw_input / title_fallback / late_update / unextractable` 来源枚举与 `exact / trim_only / embedded / other` 匹配枚举，不保存命令、title、raw input、tool-call ID、路径、输出或模型正文。optional verifier 只在字段存在时严格检查形状、适用范围和 exact 一致性；历史 evidence 可以没有该字段。

这轮实现没有调用真实模型，没有修改任何既有 evidence JSON、`four-llm-v1` manifest/checkpoint schema 或公开任务/MCP 结果。因此最新真实 Kimi delegate evidence 仍只记录原有 `commandCount=1` 与失败检查，不能用新代码反推历史命令内容。最新批次仍为 `blocked / case_failed`，注册表仍为 6 passed / 2 pending，安装仍为 `blocked / not ready`；旧授权已经消费，新的完整八项批次尚未授权。最终离线冻结矩阵为 46 个测试文件、759 passed / 1 个平台条件 skipped / 0 failed；类型检查、构建、release smoke、隔离 check-report、不可变证据、进程/锁和 clean-tree 检查通过，代码层独立规格与质量复审均已通过。

## 方法与通过标准

review 仓库包含一个可复现缺陷：`average([])` 因除以数组长度 0 而返回 `NaN`，与测试要求的 0 不符。通过要求为：ACP 报告的实际模型与注册表一致、结果状态为 `completed`、指出该缺陷，并且调用前后文件证据和 Git 状态均无变化。

delegate 要求只创建内容为 `KIMI_SMOKE_OK` 的 `result.txt`，随后执行 `git status --short`。通过要求为：实际模型一致、结果状态为 `completed`、文件内容正确、桥接层只观测到 `result.txt` 变更，并在命令观察数组中存在与 `git status --short` 完全相等的独立数组项；仅有任意命令事件、包含该文本的复合命令或模型文字声明都不满足门禁。两类任务都在调用前后枚举 Kimi PID，要求结束后不存在基线之外的新 Kimi 进程。

证据 JSON 不保存完整提示词、模型回复、OAuth 数据、环境变量或临时绝对路径，只保存非秘密模型身份、耗时、状态、哈希和结构化检查结果。未来新生成的 Kimi delegate evidence 还会保存上述 enum-only 命令观测分类；分类只用于诊断，不能替代 exact validator。

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
