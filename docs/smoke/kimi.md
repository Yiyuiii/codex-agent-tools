# Kimi 真实能力门禁

## 当前结论

当前公开面只支持 `kimi-k3`，固定使用 Kimi ACP、实际模型 `kimi-code/k3` 与 direct 网络策略。2026-07-25 串行复跑的 review/delegate 两项门禁均为 passed，过渡注册表继续启用两项能力；最新四模型批次中的 Kimi 两项也通过，但不能替代同批八项原子晋级。

最新 `four-llm-v1` 批次 `2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678` 绑定 frozen commit `07fd0d79e6885ee1e0af4a021e12170ef6c9f470`。ordinal 3 Kimi review 使用 `kimi-code/k3` / direct，在 1 次 client 调用、0 retry/fallback 下识别预置缺陷且工作区不变；ordinal 4 Kimi delegate 同样使用固定模型与 direct，只变更 `result.txt`，得到 14-byte 单行结果并精确观察到 `git status --short`。delegate evidence 的唯一命令观察为 `late_update / exact`，执行 telemetry 为 `1 / 0 / 0 / false / false`，两项均 passed。

该批次继续完成 ordinal 5–8，最终在 ordinal 8 `ark-agent-deepseek-v4-flash/delegate` 因结果文件缺失而以 `blocked / case_failed` 结束，形成 8 completed / 7 passed，仍未取得同批 8/8。Kimi 两项不能与其它批次拼接完成原子资格；过渡注册表继续为 6 passed / 2 pending，安装继续为 `blocked / not ready`。未来完整八项批次必须重新冻结、复核并取得绑定新 frozen SHA 的明确授权，从 ordinal 1 开始。

最新批次没有回退到其它 Kimi 模型。两份 Kimi evidence 内的 `noNewKimiProcesses` 均为 true，批次终态后的独立系统快照也确认 Kimi ACP、Pi RPC 与 real-smoke 为 0/0/0；没有 resume、retry、fallback、补跑、第二入口或第二批。

2026-07-26 旧五模型 blocked 批次的终态见 [manifest](evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json)，SHA-256 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`。它只记录 Kimi 两项未运行，是 `five-llm-v1` 历史材料，不构成新的 Kimi 质量结论或当前资格来源。

最新四模型 blocked [manifest](evidence/batches/2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678/manifest.json) 的 SHA-256 为 `eb3d2fd7827e4c14b35ffa97eb5d55bcfd2f0b8f6557eca04dab30241cb80556`；immutable-evidence verifier 已通过，26 个批次文件由提交 `1d5d2c4` 保存。Kimi review [evidence](evidence/batches/2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678/cases/2026-07-28T01-56-48.309Z-kimi-k3-review.json) SHA-256 为 `6a843809513af866c20f0392e9f122479692fab376d8cea480e6d2ebd2e8787f`；Kimi delegate [evidence](evidence/batches/2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678/cases/2026-07-28T01-57-12.855Z-kimi-k3-delegate.json) SHA-256 为 `356284c02d16ad291e36b7fe588fbb4d6bcf4ef822d0a71c4dcc6c1cd1fa1790`。

上一轮 Kimi 命令观测阻断历史：[manifest](evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/manifest.json) 的 SHA-256 为 `d7be5e6ba3884075d80fe399dd3c2d72caaa1a3833f92e529928655e623b7b69`，4 completed / 4 notRun。ordinal 4 Kimi delegate 当时因 `requiredCommandObserved=false` 而停止；该批促成后续 Kimi 命令观测加固，现只作历史审计，不能参与当前原子晋级。

更早四模型 interrupted [manifest](evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json) 的 SHA-256 为 `3e200dca507fe886d4e3a4bbf67cc811cca485120e6969e7632f933537ba902b`。它只证明该历史批次被中断、Kimi 两项未运行，不支持任何新的 Kimi 资格或模型质量判断。

上一轮历史四模型 blocked [manifest](evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json) 的 SHA-256 为 `f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c`。它记录 Kimi review/delegate 分别为 ordinal 3/4、均 not run；批次后 Kimi ACP、Pi RPC、real-smoke 进程计数均为 0，没有 retry、fallback、resume 或第二批。

## 命令观测加固与真实验证状态

用户已经批准并完成 Kimi 资格命令观测的离线实现。delegate 资格提示词现在要求先用一个工具调用写入 `result.txt`，再用另一个独立 execute/shell 工具调用只执行 `git status --short`；管道、重定向、连接符、包装命令和模型正文声明都不能满足该要求。通过判定保持原样，仍只使用：

```ts
result.commandsRun.includes("git status --short")
```

Kimi ACP client 现在保留协议允许晚到的 `kind/title/rawInput`，任务层只在同一次 adapter 结果内按 tool-call ID 归并初始 call 和 update，再形成一个最终命令观测。新产生的 Kimi delegate evidence 将把内部观测映射为 `raw_input / title_fallback / late_update / unextractable` 来源枚举与 `exact / trim_only / embedded / other` 匹配枚举，不保存命令、title、raw input、tool-call ID、路径、输出或模型正文。optional verifier 只在字段存在时严格检查形状、适用范围和 exact 一致性；历史 evidence 可以没有该字段。

Kimi 命令观测加固的离线实现阶段本身没有调用真实模型，也没有修改任何既有 evidence JSON、`four-llm-v1` manifest/checkpoint schema 或公开任务/MCP 结果。随后 2026-07-28 的最新真实批次已经产生新的 schema v3 Kimi delegate evidence：`commandCount=1`、`commandObservations=[{source:"late_update",match:"exact"}]`、`requiredCommandObserved=true`，并通过该 case。该结果只验证 Kimi 命令观测路径，不改变“同批八项必须全部 passed”的原子门禁，也不验证随后新增但尚未进入真实批次的 Pi `writeCommandObservations`。最新批次仍为 `blocked / case_failed`，注册表仍为 6 passed / 2 pending，安装仍为 `blocked / not ready`；新的完整八项批次尚未授权。当前方案 B 候选的 fresh 离线矩阵为 48 个测试文件、837 passed / 1 个平台条件 skipped / 0 failed，类型检查、构建、release smoke、隔离 check-report、不可变证据、进程/锁和 clean-tree 检查均通过。

## 方法与通过标准

review 仓库包含一个可复现缺陷：`average([])` 因除以数组长度 0 而返回 `NaN`，与测试要求的 0 不符。通过要求为：ACP 报告的实际模型与注册表一致、结果状态为 `completed`、指出该缺陷，并且调用前后文件证据和 Git 状态均无变化。

delegate 要求只创建内容为 `KIMI_SMOKE_OK` 的 `result.txt`，随后执行 `git status --short`。通过要求为：实际模型一致、结果状态为 `completed`、文件内容正确、桥接层只观测到 `result.txt` 变更，并在命令观察数组中存在与 `git status --short` 完全相等的独立数组项；仅有任意命令事件、包含该文本的复合命令或模型文字声明都不满足门禁。两类任务都在调用前后枚举 Kimi PID，要求结束后不存在基线之外的新 Kimi 进程。

证据 JSON 不保存完整提示词、模型回复、OAuth 数据、环境变量或临时绝对路径，只保存非秘密模型身份、耗时、状态、哈希和结构化检查结果。当前 schema v3 Kimi delegate evidence 会保存上述 enum-only 命令观测分类，最新批次已验证 `late_update / exact`；分类只用于诊断，不能替代 exact validator。

## 当前注册表 K3 基线证据（2026-07-25）

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
