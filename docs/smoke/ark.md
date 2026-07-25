# Ark / Pi 真实能力门禁

## 当前结论

当前 Ark 公开面共有三项固定 Pi/direct 路线：

- `ark-coding-plan` → provider `ark-coding-plan` / model `ark-code-latest`；2026-07-20 的 review/delegate 证据继续有效，两项均为 passed。
- `ark-agent-plan` → provider `ark-agent-plan` / model `ark-code-latest`；当前 review/delegate 均为 pending。
- `ark-agent-deepseek-v4-flash` → provider `ark-agent-plan` / model `deepseek-v4-flash`；当前 review/delegate 均为 pending。

两个 Agent Plan 逻辑 LLM 共享并发上限为 1 的 `ark-agent-plan` 配额池。2026-07-20 对旧 `ark-agent-glm-5.2` 与 `ark-agent-doubao-seed-2.0-pro` 完成的四项 passed 证据现仅作为历史事实保留，不属于当前公开面，也不得用于晋级两个新 Agent Plan 路线。原始 evidence JSON 保持不变。

2026-07-20 历史 passed evidence 使用的旧隔离配置 SHA-256 为 `ab12536cc03dd368115d71bab6eb65216506717fc63b33c4b8a077d82b3ebbf6`。当前三模型 pending 配置包含 Agent Plan 的 `ark-code-latest`、`deepseek-v4-flash` 与 Coding Plan 的 `ark-code-latest`；按生成器实际输出重新计算的 SHA-256 为 `61ffbd4c6ea41adc6a8313f957b732da2b98b8b28b082c52a95226b2a6fb2fe9`。两代配置的 endpoint host 均固定为 `ark.cn-beijing.volces.com`，网络策略均为 direct。

2026-07-25 的官方插件实施任务 7 将按当前三个逻辑 ID 串行执行六项精确门禁并生成新证据。Coding Plan 当前的 passed 状态在复跑前继续引用既有同模型、同 provider、同路由证据；两个 Agent Plan 路线保持 pending，只有各自 review/delegate 均通过后才可晋级。任何失败都不得用历史模型证据或其它 LLM fallback 掩盖。

Ark Coding 的本机用户环境变量实际命名为 `API_KEY_DOUBAO_CODING`。注册表现按 `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING` 的顺序选择第一个非空值，并只向 Pi 子进程注入项目私有变量 `CODEX_AGENT_ARK_CODING_KEY`。Ark Agent 使用 `OPENAI_API_KEY_DOUBAO`，规范化为 `CODEX_AGENT_ARK_AGENT_KEY`。

上述 2026-07-20 passed evidence 中，所有 review 均找到预置正确性缺陷且工作区无修改；所有 delegate 仅生成指定文件、执行验证命令并返回一致证据；每次结束后均无新增 Pi RPC 进程。证据文件不含密钥、认证头、完整环境、开发机绝对路径或上游原始错误正文。

## 当前证据矩阵

<a id="ark-coding-plan-review"></a>
### ark-coding-plan review

- 结果：passed；实际模型：`ark-code-latest`；耗时：30.418 秒。
- 证据：[JSON](evidence/2026-07-20T07-31-07.279Z-ark-coding-plan-review-ark.json)；SHA-256 `13cae8458142bfa917b2fc056db0ac28ead108ff054301d5445e9a4aac357ab5`。

<a id="ark-coding-plan-delegate"></a>
### ark-coding-plan delegate

- 结果：passed；实际模型：`ark-code-latest`；耗时：84.960 秒。
- 仅变更 `ark-coding-plan-smoke.txt`，并观测到验证命令。
- 证据：[JSON](evidence/2026-07-20T07-35-16.748Z-ark-coding-plan-delegate-ark.json)；SHA-256 `f3083722dab245e96cdcb90d29d99e6a05bc3b917c78e1c4e7ac9a340263bb0c`。

<a id="ark-agent-plan-review"></a>
### ark-agent-plan review

- 结果：pending；尚未执行该逻辑 ID 与 `ark-code-latest` 的精确真实门禁。
- 不复用旧 `glm-5.2` 或 `doubao-seed-2.0-pro` 证据。

<a id="ark-agent-plan-delegate"></a>
### ark-agent-plan delegate

- 结果：pending；尚未执行该逻辑 ID 与 `ark-code-latest` 的精确真实门禁。
- 不复用旧 `glm-5.2` 或 `doubao-seed-2.0-pro` 证据。

<a id="ark-agent-deepseek-v4-flash-review"></a>
### ark-agent-deepseek-v4-flash review

- 结果：pending；尚未执行该逻辑 ID 与 `deepseek-v4-flash` 的精确真实门禁。
- 不复用旧 `glm-5.2` 或 `doubao-seed-2.0-pro` 证据。

<a id="ark-agent-deepseek-v4-flash-delegate"></a>
### ark-agent-deepseek-v4-flash delegate

- 结果：pending；尚未执行该逻辑 ID 与 `deepseek-v4-flash` 的精确真实门禁。
- 不复用旧 `glm-5.2` 或 `doubao-seed-2.0-pro` 证据。

## 历史证据（不属于当前公开面）

<a id="ark-agent-glm-5.2-review"></a>
### ark-agent-glm-5.2 review

- 结果：passed；实际模型：`glm-5.2`；耗时：34.765 秒。
- 证据：[JSON](evidence/2026-07-20T07-32-04.030Z-ark-agent-glm-5.2-review-ark.json)；SHA-256 `df9a02977e6501c96744f48b825377152287b3a82f18f428a8367e5121beef22`。

<a id="ark-agent-glm-5.2-delegate"></a>
### ark-agent-glm-5.2 delegate

- 结果：passed；实际模型：`glm-5.2`；耗时：41.426 秒。
- 仅变更 `ark-agent-glm-5.2-smoke.txt`，并观测到验证命令。
- 证据：[JSON](evidence/2026-07-20T07-36-31.292Z-ark-agent-glm-5.2-delegate-ark.json)；SHA-256 `4024d8eccc0cf88812958de0a64bb273f374a37139d3d9c67c9598eb3fcc34bb`。

<a id="ark-agent-doubao-seed-2.0-pro-review"></a>
### ark-agent-doubao-seed-2.0-pro review

- 结果：passed；实际模型：`doubao-seed-2.0-pro`；耗时：47.535 秒。
- 证据：[JSON](evidence/2026-07-20T07-33-08.018Z-ark-agent-doubao-seed-2.0-pro-review-ark.json)；SHA-256 `8d287e0fb5af52fca30acb8cb9ecb6c37e010d9a114d560f4542abec8fa4e36b`。

<a id="ark-agent-doubao-seed-2.0-pro-delegate"></a>
### ark-agent-doubao-seed-2.0-pro delegate

- 结果：passed；实际模型：`doubao-seed-2.0-pro`；耗时：16.338 秒。
- 仅变更 `ark-agent-doubao-seed-2.0-pro-smoke.txt`，并观测到验证命令。
- 证据：[JSON](evidence/2026-07-20T07-37-04.272Z-ark-agent-doubao-seed-2.0-pro-delegate-ark.json)；SHA-256 `726d34d59d7f3c9b9fd0f9973bb0047ffa7b9f82555bf3fd0ffbb328155d0a8c`。

## 历史失败与复核说明

2026-07-18 的 Coding Plan 失败源于当时未识别本机的 `API_KEY_DOUBAO_CODING` 命名；Agent Plan 失败源于上游周额度耗尽。这些失败证据保留作诊断回归，不再代表当前能力状态。

真实 Pi smoke 的“无新增 Pi RPC 进程”检查比较全机进程快照，因此多个 smoke 不应并行运行。2026-07-20 曾并行启动三个 review：先结束的两项因看见其它 smoke 的仍在运行进程而产生验收假阴性，最后结束的一项通过；串行复测证明模型、路由和清理逻辑均正常。最终门禁只采用上面的串行证据。

Pi RPC 桥还覆盖 assistant `errorMessage` 与空内容同时出现的失败语义：此类 API 错误会脱敏记录并返回 failed，不会误标 completed。

## 复跑命令

每项须串行运行：

```powershell
npm run smoke:ark -- --llm ark-coding-plan --task review
npm run smoke:ark -- --llm ark-coding-plan --task delegate
npm run smoke:ark -- --llm ark-agent-plan --task review
npm run smoke:ark -- --llm ark-agent-plan --task delegate
npm run smoke:ark -- --llm ark-agent-deepseek-v4-flash --task review
npm run smoke:ark -- --llm ark-agent-deepseek-v4-flash --task delegate
```
