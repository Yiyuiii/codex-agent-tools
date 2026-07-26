# Ark / Pi 真实能力门禁

## 当前结论

当前 Ark 公开面共有三项固定 Pi/direct 路线：

- `ark-coding-plan` → provider `ark-coding-plan` / model `ark-code-latest`；2026-07-25 复跑的 review passed、delegate 因结果文件内容不符而 failed，注册表两项均为 pending。
- `ark-agent-plan` → provider `ark-agent-plan` / model `ark-code-latest`；2026-07-25 review/delegate 均为 passed，注册表两项已晋级。
- `ark-agent-deepseek-v4-flash` → provider `ark-agent-plan` / model `deepseek-v4-flash`；2026-07-25 review/delegate 均为 passed，注册表两项已晋级。

两个 Agent Plan 逻辑 LLM 共享并发上限为 1 的 `ark-agent-plan` 配额池。2026-07-20 对旧 `ark-agent-glm-5.2` 与 `ark-agent-doubao-seed-2.0-pro` 完成的四项 passed 证据现仅作为历史事实保留，不属于当前公开面，也不得用于晋级两个新 Agent Plan 路线。原始 evidence JSON 保持不变。

Gemini 退役后，活动产品面共有四个逻辑 LLM、八项能力，过渡注册表为 6 passed / 2 pending；两个 pending 项都属于 `ark-coding-plan`。新的资格来源必须是一个尚未执行的 `four-llm-v1` 同批 8/8 结果，不能只补跑 Coding Plan，也不能把下述既有通过证据与新结果拼接。

2026-07-26 的旧五模型原子重认证批次在第 1 项 Gemini delegate 失败后立即停止，六项 Ark case 均为 not run。该历史批次没有替换下述 2026-07-25 Ark 证据；blocked [manifest](evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json) 的 SHA-256 为 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`，批次后目标进程分类为 0，未重试或另开批次。它现在只作为 `five-llm-v1` 历史审计材料保留，不能参与当前四模型晋级。

2026-07-20 历史 passed evidence 使用的旧隔离配置 SHA-256 为 `ab12536cc03dd368115d71bab6eb65216506717fc63b33c4b8a077d82b3ebbf6`。2026-07-25 本轮三模型配置包含 Agent Plan 的 `ark-code-latest`、`deepseek-v4-flash` 与 Coding Plan 的 `ark-code-latest`；按生成器实际输出计算的 SHA-256 为 `61ffbd4c6ea41adc6a8313f957b732da2b98b8b28b082c52a95226b2a6fb2fe9`。两代配置的 endpoint host 均固定为 `ark.cn-beijing.volces.com`，网络策略均为 direct。

2026-07-25 的六项 Ark 门禁严格串行执行，未重试或 fallback。每次 evidence 都确认环境隔离与无新增 Pi RPC 进程；每次 evidence 验收后的独立系统快照也确认 Kimi 与 Pi RPC 进程数均为 0。Coding Plan 的 delegate 失败被如实保留，因此 review 即使单独 passed 也不启用；两个 Agent profile 各自两项全部通过后才使用下方稳定 anchor 晋级。

Ark Coding 的本机用户环境变量实际命名为 `API_KEY_DOUBAO_CODING`。注册表现按 `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING` 的顺序选择第一个非空值，并只向 Pi 子进程注入项目私有变量 `CODEX_AGENT_ARK_CODING_KEY`。Ark Agent 使用 `OPENAI_API_KEY_DOUBAO`，规范化为 `CODEX_AGENT_ARK_AGENT_KEY`。

本轮所有 review 都找到预置正确性缺陷且工作区无修改。两个通过的 Agent delegate 只生成指定文件并观测到验证命令；Coding Plan delegate 只变更预期文件且观测到命令，但文件内容检查失败。证据文件不含密钥、认证头、完整环境、开发机绝对路径或上游原始错误正文。

## 当前证据矩阵

<a id="ark-coding-plan-review"></a>
### ark-coding-plan review

- 本次任务结果：passed；注册表状态：pending（同 profile 的 delegate 未通过）。
- 实际/预期模型均为 `ark-code-latest`；provider 为 `ark-coding-plan`；route 为 `direct`；耗时 11.803 秒。
- 缺陷识别、环境隔离、工作区零变更、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T15-49-40.932Z-ark-coding-plan-review-ark.json)；SHA-256 `a4c2b6ba19e8226f8c641426c5ad9c81826fcd32adb77200ad7c90731dbb3dd4`。

<a id="ark-coding-plan-delegate"></a>
### ark-coding-plan delegate

- 本次任务结果：failed；注册表状态：pending；稳定失败类别为 `acceptance_failed`。
- 实际/预期模型均为 `ark-code-latest`；provider 为 `ark-coding-plan`；route 为 `direct`；耗时 75.889 秒。
- 只变更 `ark-coding-plan-smoke.txt` 并观测到命令，但 `resultFileValid` 为 false；其它环境隔离、变更范围与进程清理检查均通过，独立系统进程快照也为零残留。
- 证据：[JSON](evidence/2026-07-25T15-51-44.134Z-ark-coding-plan-delegate-ark.json)；SHA-256 `7d7af81493dd9e94a9669efb12eb90c83c1c7535959b81c385091aa3eef461eb`。

<a id="ark-agent-plan-review"></a>
### ark-agent-plan review

- 结果：passed；实际/预期模型均为 `ark-code-latest`；provider 为 `ark-agent-plan`；route 为 `direct`；耗时 9.098 秒。
- 缺陷识别、环境隔离、工作区零变更、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T15-52-57.715Z-ark-agent-plan-review-ark.json)；SHA-256 `c6ef0351080d9448c4bf65ad606349c219c3b51d1a2e3ff7a02127c0e6fb6871`。

<a id="ark-agent-plan-delegate"></a>
### ark-agent-plan delegate

- 结果：passed；实际/预期模型均为 `ark-code-latest`；provider 为 `ark-agent-plan`；route 为 `direct`；耗时 859.946 秒。
- 只变更 `ark-agent-plan-smoke.txt`，文件内容与命令证据正确；环境隔离、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T16-08-00.444Z-ark-agent-plan-delegate-ark.json)；SHA-256 `ef805b815ee95b58c2ce0e81ad8f2bff62efd9d49599571b7c8ff87f18b127df`。

<a id="ark-agent-deepseek-v4-flash-review"></a>
### ark-agent-deepseek-v4-flash review

- 结果：passed；实际/预期模型均为 `deepseek-v4-flash`；provider 为 `ark-agent-plan`；route 为 `direct`；耗时 16.000 秒。
- 缺陷识别、环境隔离、工作区零变更、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T16-09-09.705Z-ark-agent-deepseek-v4-flash-review-ark.json)；SHA-256 `24fb03e09071666f33d5194a50cac2ccca492021249bf0adf466c7d3fde97545`。

<a id="ark-agent-deepseek-v4-flash-delegate"></a>
### ark-agent-deepseek-v4-flash delegate

- 结果：passed；实际/预期模型均为 `deepseek-v4-flash`；provider 为 `ark-agent-plan`；route 为 `direct`；耗时 32.243 秒。
- 只变更 `ark-agent-deepseek-v4-flash-smoke.txt`，文件内容与命令证据正确；环境隔离、evidence 清理检查与独立系统进程快照均通过。
- 证据：[JSON](evidence/2026-07-25T16-10-32.796Z-ark-agent-deepseek-v4-flash-delegate-ark.json)；SHA-256 `38869fd3844a2e5ab933cc438bcdbb364eaf16182dbc3c650452d04c3c3bbe92`。

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
