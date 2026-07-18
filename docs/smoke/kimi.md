# Kimi 真实能力门禁

2026-07-18 在本机 Kimi Code 0.27.0 上完成了三个逻辑 Kimi LLM 的独立 review/delegate 门禁。六次调用均使用 `kimi acp`、固定真实模型和 `direct` 网络策略；每次均在新建的临时 Git 仓库中执行，结束后清理仓库与 Kimi 进程树。

## 方法与通过标准

review 仓库包含一个可复现缺陷：`average([])` 因除以数组长度 0 而返回 `NaN`，与测试要求的 0 不符。通过要求为：ACP 报告的实际模型与注册表一致、结果状态为 `completed`、指出该缺陷，并且调用前后文件证据和 Git 状态均无变化。

delegate 要求只创建内容为 `KIMI_SMOKE_OK` 的 `result.txt`，随后执行 `git status --short`。通过要求为：实际模型一致、结果状态为 `completed`、文件内容正确、桥接层只观测到 `result.txt` 变更，并至少观测到一条真实命令工具事件。两类任务都在调用前后枚举 Kimi PID，要求结束后不存在基线之外的新 Kimi 进程。

证据 JSON 不保存完整提示词、模型回复、OAuth 数据、环境变量或临时绝对路径，只保存非秘密模型身份、耗时、状态、哈希和结构化检查结果。

| 逻辑 LLM | 任务 | 实际模型 | 耗时 | 结果 | 证据文件 SHA-256 |
| --- | --- | --- | ---: | --- | --- |
| `kimi-k2.7` | review | `kimi-code/kimi-for-coding` | 9.672 s | 通过 | `5d7b3f2189cf6ea95fa1471856d189531ab2a24013138ce0084453dfcf6ca018` |
| `kimi-k2.7` | delegate | `kimi-code/kimi-for-coding` | 9.468 s | 通过 | `0efe86da72ccb67881669389ff70a1786160d2b0b7df943465a4ae976339b65c` |
| `kimi-k2.7-highspeed` | review | `kimi-code/kimi-for-coding-highspeed` | 6.495 s | 通过 | `07d5040aa5ce222e8528355c8b6927bed45081cf3bae6a28385317c85991f2dd` |
| `kimi-k2.7-highspeed` | delegate | `kimi-code/kimi-for-coding-highspeed` | 6.581 s | 通过 | `9175ad0442e246f57af8b5b55a35fd4a72fda706f2fc6bbcaa1af9937a5d9632` |
| `kimi-k3` | review | `kimi-code/k3` | 63.864 s | 通过 | `e2c6ca97c082b06ee0cc552a2f8460af590f97e723817ab5e314ce1e3cc2d5c7` |
| `kimi-k3` | delegate | `kimi-code/k3` | 74.447 s | 通过 | `b0cd61c86a1925e860e78b9477a7d928ec913e3025ec7db3bb1d103b35edee14` |

## kimi-k27-review

- 状态：通过，零工作区变更，已识别已知缺陷，无新增 Kimi PID，无诊断。
- 证据：[2026-07-18T07-59-25.150Z-kimi-k2.7-review.json](evidence/2026-07-18T07-59-25.150Z-kimi-k2.7-review.json)

## kimi-k27-delegate

- 状态：通过，只变更 `result.txt`，文件内容正确，观测到 1 条命令事件，无新增 Kimi PID，无诊断。
- 证据：[2026-07-18T07-59-37.579Z-kimi-k2.7-delegate.json](evidence/2026-07-18T07-59-37.579Z-kimi-k2.7-delegate.json)

## kimi-k27-highspeed-review

- 状态：通过，零工作区变更，已识别已知缺陷，无新增 Kimi PID，无诊断。
- 证据：[2026-07-18T07-59-47.269Z-kimi-k2.7-highspeed-review.json](evidence/2026-07-18T07-59-47.269Z-kimi-k2.7-highspeed-review.json)

## kimi-k27-highspeed-delegate

- 状态：通过，只变更 `result.txt`，文件内容正确，观测到 1 条命令事件，无新增 Kimi PID，无诊断。
- 证据：[2026-07-18T07-59-56.939Z-kimi-k2.7-highspeed-delegate.json](evidence/2026-07-18T07-59-56.939Z-kimi-k2.7-highspeed-delegate.json)

## kimi-k3-review

- 状态：通过，零工作区变更，已识别已知缺陷；15、30、45、60 秒心跳正常，无新增 Kimi PID，无诊断。
- 证据：[2026-07-18T08-01-03.988Z-kimi-k3-review.json](evidence/2026-07-18T08-01-03.988Z-kimi-k3-review.json)

## kimi-k3-delegate

- 状态：通过，只变更 `result.txt`，文件内容正确，观测到 1 条命令事件；15、30、45、60 秒心跳正常，无新增 Kimi PID，无诊断。
- 证据：[2026-07-18T08-02-21.349Z-kimi-k3-delegate.json](evidence/2026-07-18T08-02-21.349Z-kimi-k3-delegate.json)

## 结论

以上六个精确能力组合均已在内置注册表中启用。该结论只覆盖本页记录的 Kimi Code 版本、逻辑 ID、实际模型和 review/delegate 任务，不自动推广到未来 Kimi 版本、Pi 运行时或其它模型来源。
