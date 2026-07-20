# Ark / Pi 真实能力门禁

## 当前结论

2026-07-20 在本机 Pi 0.80.10 上串行完成三个逻辑 LLM × `review` / `delegate` 的六项真实调用，六项全部通过并已启用。隔离配置 SHA-256 为 `ab12536cc03dd368115d71bab6eb65216506717fc63b33c4b8a077d82b3ebbf6`，endpoint host 固定为 `ark.cn-beijing.volces.com`，网络策略固定为 direct。

Ark Coding 的本机用户环境变量实际命名为 `API_KEY_DOUBAO_CODING`。注册表现按 `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING` 的顺序选择第一个非空值，并只向 Pi 子进程注入项目私有变量 `CODEX_AGENT_ARK_CODING_KEY`。Ark Agent 使用 `OPENAI_API_KEY_DOUBAO`，规范化为 `CODEX_AGENT_ARK_AGENT_KEY`。

所有 review 均找到预置正确性缺陷且工作区无修改；所有 delegate 仅生成指定文件、执行验证命令并返回一致证据；每次结束后均无新增 Pi RPC 进程。证据文件不含密钥、认证头、完整环境、开发机绝对路径或上游原始错误正文。

## 最终证据矩阵

<a id="ark-coding-plan-review"></a>
### ark-coding-plan review

- 结果：passed；实际模型：`ark-code-latest`；耗时：30.418 秒。
- 证据：[JSON](evidence/2026-07-20T07-31-07.279Z-ark-coding-plan-review-ark.json)；SHA-256 `13cae8458142bfa917b2fc056db0ac28ead108ff054301d5445e9a4aac357ab5`。

<a id="ark-coding-plan-delegate"></a>
### ark-coding-plan delegate

- 结果：passed；实际模型：`ark-code-latest`；耗时：84.960 秒。
- 仅变更 `ark-coding-plan-smoke.txt`，并观测到验证命令。
- 证据：[JSON](evidence/2026-07-20T07-35-16.748Z-ark-coding-plan-delegate-ark.json)；SHA-256 `f3083722dab245e96cdcb90d29d99e6a05bc3b917c78e1c4e7ac9a340263bb0c`。

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
npm run smoke:ark -- --llm ark-agent-glm-5.2 --task review
npm run smoke:ark -- --llm ark-agent-glm-5.2 --task delegate
npm run smoke:ark -- --llm ark-agent-doubao-seed-2.0-pro --task review
npm run smoke:ark -- --llm ark-agent-doubao-seed-2.0-pro --task delegate
```
