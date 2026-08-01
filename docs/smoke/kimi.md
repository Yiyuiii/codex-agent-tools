# Kimi 真实能力门禁

## 当前结论

当前公开面只支持 `kimi-k3`，固定使用 Kimi ACP、实际模型 `kimi-code/k3` 与 direct 网络策略。最新历史四模型批次中的 Kimi review/delegate 都通过，旧能力索引按精确 case 哈希与当时运行时指纹记录了两项 passed。

现行调用省略 `timeoutMs` 时不会向 Kimi Code 设置 deadline，而是保留 Kimi Code 原生执行预算。宿主取消、stdio 断开或进程信号会传播 SDK abort，并等待完整 owned ACP 进程树归零；只有调用方显式设置的单次 `timeoutMs` 到期才报告 timed out。本轮运行时变更已使旧 Kimi 能力指纹 stale；冻结当前宿主离线候选后，只重跑 stale、缺失、新增或证据失效的能力，Kimi 两项由对应新证据重新资格化。

最新历史 `four-llm-v1` 批次 `2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c` 绑定 frozen commit `0113da97a6b1fef35cc4c45025caa9e36a002176`。ordinal 3 Kimi review 与 ordinal 4 Kimi delegate 均固定使用 `kimi-code/k3` / direct，零 retry/fallback，并均 passed；这两项只支持旧实现资格，不能越过本轮 stale 指纹。

该批次继续到 ordinal 6 `ark-agent-plan/delegate`，因 `account_quota_exceeded` 按首错停止，形成 6 completed / 5 passed、ordinal 7–8 notRun、`blocked / case_failed`、`promotionEligible=false`。该批聚合终态保持不变，但不再撤销其中通过的 Kimi case；其它路线的临时额度不会触发 Kimi 重跑。

最新批次没有回退到其它 Kimi 模型；标准入口和 `functions.exec` cell 各只有一个，没有 resume、retry、fallback、补跑、第二入口或第二批。最新 manifest SHA-256 为 `f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`，证据提交为 `6b4217d`。

2026-07-26 旧五模型 blocked 批次的终态见 [manifest](evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json)，SHA-256 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`。它只记录 Kimi 两项未运行，是 `five-llm-v1` 历史材料，不构成新的 Kimi 质量结论或当前资格来源。

最新四模型 blocked [manifest](evidence/batches/2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c/manifest.json) 的 SHA-256 为 `f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`；immutable-evidence verifier 已通过，20 个证据文件由提交 `6b4217d` 保存。Kimi review 与 delegate evidence 分别见该批次的 [review JSON](evidence/batches/2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c/cases/2026-07-28T14-38-02.020Z-kimi-k3-review.json) 与 [delegate JSON](evidence/batches/2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c/cases/2026-07-28T14-38-33.375Z-kimi-k3-delegate.json)。

更早四模型 blocked [manifest](evidence/batches/2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678/manifest.json) 的 SHA-256 为 `eb3d2fd7827e4c14b35ffa97eb5d55bcfd2f0b8f6557eca04dab30241cb80556`；它在 ordinal 8 因其它 Ark route 失败而结束，只作历史审计。

上一轮 Kimi 命令观测阻断历史：[manifest](evidence/batches/2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa/manifest.json) 的 SHA-256 为 `d7be5e6ba3884075d80fe399dd3c2d72caaa1a3833f92e529928655e623b7b69`，4 completed / 4 notRun。ordinal 4 Kimi delegate 当时因 `requiredCommandObserved=false` 而停止；该批促成后续 Kimi 命令观测加固，现只作历史审计，不是当前 Kimi 资格来源。

更早四模型 interrupted [manifest](evidence/batches/2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde/manifest.json) 的 SHA-256 为 `3e200dca507fe886d4e3a4bbf67cc811cca485120e6969e7632f933537ba902b`。它只证明该历史批次被中断、Kimi 两项未运行，不支持任何新的 Kimi 资格或模型质量判断。

上一轮历史四模型 blocked [manifest](evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json) 的 SHA-256 为 `f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c`。它记录 Kimi review/delegate 分别为 ordinal 3/4、均 not run；批次后 Kimi ACP、Pi RPC、real-smoke 进程计数均为 0，没有 retry、fallback、resume 或第二批。

## 命令观测加固与真实验证状态

用户已经批准并完成 Kimi 资格命令观测的离线实现。delegate 资格提示词现在要求先用一个工具调用写入 `result.txt`，再用另一个独立 execute/shell 工具调用只执行 `git status --short`；管道、重定向、连接符、包装命令和模型正文声明都不能满足该要求。通过判定保持原样，仍只使用：

```ts
result.commandsRun.includes("git status --short");
```

Kimi ACP client 现在保留协议允许晚到的 `kind/title/rawInput`，任务层只在同一次 adapter 结果内按 tool-call ID 归并初始 call 和 update，再形成一个最终命令观测。新产生的 Kimi delegate evidence 将把内部观测映射为 `raw_input / title_fallback / late_update / unextractable` 来源枚举与 `exact / trim_only / embedded / other` 匹配枚举，不保存命令、title、raw input、tool-call ID、路径、输出或模型正文。optional verifier 只在字段存在时严格检查形状、适用范围和 exact 一致性；历史 evidence 可以没有该字段。

冻结前全量还暴露了 Kimi ACP client 早于 child close 返回的既有竞态，98/100 时序探针可观察。提交 `4af8b34` 加入 close 等待、1000ms 有界失败、stdio 销毁与两个确定性回归测试；独立复审 PASS、无 P0–P3。该修复不修改公开任务/MCP 结果、模型/route/credential、资格计划、提示词或 retry/fallback。

Kimi 命令观测加固的离线实现阶段本身没有调用真实模型，也没有修改任何既有 evidence JSON、`four-llm-v1` manifest/checkpoint schema 或公开任务/MCP 结果。后续历史批次已通过 Kimi review/delegate；下一轮 stale 能力资格会用同一能力索引同时验证新 evidence 与 Kimi 运行时指纹。

## 方法与通过标准

review 仓库包含一个可复现缺陷：`average([])` 因除以数组长度 0 而返回 `NaN`，与测试要求的 0 不符。通过要求为：ACP 报告的实际模型与注册表一致、结果状态为 `completed`、指出该缺陷，并且调用前后文件证据和 Git 状态均无变化。

delegate 要求只创建内容为 `KIMI_SMOKE_OK` 的 `result.txt`，随后执行 `git status --short`。通过要求为：实际模型一致、结果状态为 `completed`、文件内容正确、桥接层只观测到 `result.txt` 变更，并在命令观察数组中存在与 `git status --short` 完全相等的独立数组项；仅有任意命令事件、包含该文本的复合命令或模型文字声明都不满足门禁。两类任务都在调用前后枚举 Kimi PID，要求结束后不存在基线之外的新 Kimi 进程。

证据 JSON 不保存完整提示词、模型回复、OAuth 数据、环境变量或临时绝对路径，只保存非秘密模型身份、耗时、状态、哈希和结构化检查结果。当前 schema v3 Kimi delegate evidence 会保存上述 enum-only 命令观测分类，最新批次已验证 `late_update / exact`；分类只用于诊断，不能替代 exact validator。

## 当前注册表 K3 基线证据（2026-07-25）

| 逻辑 LLM  | 任务     | 实际模型       |     耗时 | 结果 | 证据文件 SHA-256                                                   |
| --------- | -------- | -------------- | -------: | ---- | ------------------------------------------------------------------ |
| `kimi-k3` | review   | `kimi-code/k3` | 28.145 s | 通过 | `1c9fcd3f5a005f4d1af0430a524906e72d58c9cf4e25da13c96871b8adb09408` |
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

| 历史逻辑 LLM          | 任务     | 历史实际模型                          | 结果 | 证据                                                                        |
| --------------------- | -------- | ------------------------------------- | ---- | --------------------------------------------------------------------------- |
| `kimi-k2.7`           | review   | `kimi-code/kimi-for-coding`           | 通过 | [JSON](evidence/2026-07-18T07-59-25.150Z-kimi-k2.7-review.json)             |
| `kimi-k2.7`           | delegate | `kimi-code/kimi-for-coding`           | 通过 | [JSON](evidence/2026-07-18T07-59-37.579Z-kimi-k2.7-delegate.json)           |
| `kimi-k2.7-highspeed` | review   | `kimi-code/kimi-for-coding-highspeed` | 通过 | [JSON](evidence/2026-07-18T07-59-47.269Z-kimi-k2.7-highspeed-review.json)   |
| `kimi-k2.7-highspeed` | delegate | `kimi-code/kimi-for-coding-highspeed` | 通过 | [JSON](evidence/2026-07-18T07-59-56.939Z-kimi-k2.7-highspeed-delegate.json) |

## 结论

当前内置注册表只启用 `kimi-k3` 的 review/delegate 两个精确能力组合。K2.7 的四项记录是已退出公开面的历史证据，不构成当前支持承诺。该结论只覆盖本页记录的 Kimi Code 版本、逻辑 ID、实际模型和 review/delegate 任务，不自动推广到未来 Kimi 版本、Pi 运行时或其它模型来源。
