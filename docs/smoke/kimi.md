# Kimi 真实能力门禁

## 当前结论

自 2026-07-25 起，当前公开面只支持 `kimi-k3`，固定使用 Kimi ACP、实际模型 `kimi-code/k3` 与 direct 网络策略。其 review/delegate 两项门禁当前为 passed。

实施任务 7 将按当前五模型矩阵重新串行执行 K3 review/delegate，并生成新的精确证据。在新证据产生前，注册表继续引用下方 2026-07-18 的 K3 passed 证据；任务 7 若失败，不得回退到其它 Kimi 模型或保留不符合实际的晋级结论。

## 方法与通过标准

review 仓库包含一个可复现缺陷：`average([])` 因除以数组长度 0 而返回 `NaN`，与测试要求的 0 不符。通过要求为：ACP 报告的实际模型与注册表一致、结果状态为 `completed`、指出该缺陷，并且调用前后文件证据和 Git 状态均无变化。

delegate 要求只创建内容为 `KIMI_SMOKE_OK` 的 `result.txt`，随后执行 `git status --short`。通过要求为：实际模型一致、结果状态为 `completed`、文件内容正确、桥接层只观测到 `result.txt` 变更，并至少观测到一条真实命令工具事件。两类任务都在调用前后枚举 Kimi PID，要求结束后不存在基线之外的新 Kimi 进程。

证据 JSON 不保存完整提示词、模型回复、OAuth 数据、环境变量或临时绝对路径，只保存非秘密模型身份、耗时、状态、哈希和结构化检查结果。

## 当前 K3 证据

| 逻辑 LLM | 任务 | 实际模型 | 耗时 | 结果 | 证据文件 SHA-256 |
| --- | --- | --- | ---: | --- | --- |
| `kimi-k3` | review | `kimi-code/k3` | 63.864 s | 通过 | `e2c6ca97c082b06ee0cc552a2f8460af590f97e723817ab5e314ce1e3cc2d5c7` |
| `kimi-k3` | delegate | `kimi-code/k3` | 74.447 s | 通过 | `b0cd61c86a1925e860e78b9477a7d928ec913e3025ec7db3bb1d103b35edee14` |

<a id="kimi-k3-review"></a>
## kimi-k3-review

- 状态：通过，零工作区变更，已识别已知缺陷；15、30、45、60 秒心跳正常，无新增 Kimi PID，无诊断。
- 证据：[2026-07-18T08-01-03.988Z-kimi-k3-review.json](evidence/2026-07-18T08-01-03.988Z-kimi-k3-review.json)

<a id="kimi-k3-delegate"></a>
## kimi-k3-delegate

- 状态：通过，只变更 `result.txt`，文件内容正确，观测到 1 条命令事件；15、30、45、60 秒心跳正常，无新增 Kimi PID，无诊断。
- 证据：[2026-07-18T08-02-21.349Z-kimi-k3-delegate.json](evidence/2026-07-18T08-02-21.349Z-kimi-k3-delegate.json)

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
