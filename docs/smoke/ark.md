# Ark / Pi 真实能力门禁

## 当前结论

2026-07-18 在本机 Pi 0.80.10 上完成三个逻辑 LLM × review/delegate 的六项独立真实调用。隔离配置哈希为 `ab12536cc03dd368115d71bab6eb65216506717fc63b33c4b8a077d82b3ebbf6`，固定 endpoint host 为 `ark.cn-beijing.volces.com`，网络策略为 direct。

本轮没有任何 Ark 能力通过，因此注册表保持六项 pending：

- `ark-coding-plan` 在启动模型进程前因 `ARK_API_KEY` 与 `VOLCENGINE_API_KEY` 均不存在而失败；进程、用户、机器环境及当前旧 MCP 启动包装均未发现可继承来源。
- `ark-agent-glm-5.2` 与 `ark-agent-doubao-seed-2.0-pro` 均正确命中 `ark-agent-plan`、实际模型和隔离凭据目标变量，但上游返回 `AccountQuotaExceeded`。脱敏诊断给出的周额度重置时间为 2026-07-20 00:00:00（UTC+8）。
- 所有 review 工作区均未改变；所有运行结束后均未发现新增 Pi RPC 进程。

## 最终证据矩阵

| 逻辑 LLM | 任务 | 实际模型 | 结果 | 稳定失败码 | 耗时 | 证据与 SHA-256 |
| --- | --- | --- | --- | --- | ---: | --- |
| `ark-coding-plan` | review | 未启动 | failed | `missing_credential` | 873 ms | [JSON](evidence/2026-07-18T09-12-16.874Z-ark-coding-plan-review-ark.json) · `4814fd01476c6a0b3026b4ff824936e12caab1e0a0bee7c752b8597794230144` |
| `ark-coding-plan` | delegate | 未启动 | failed | `missing_credential` | 671 ms | [JSON](evidence/2026-07-18T09-12-22.257Z-ark-coding-plan-delegate-ark.json) · `018a59356d5cbdd3618bb7744ff6c0a2fc45c3e50a1dbe6f7253ee9e535dbea7` |
| `ark-agent-glm-5.2` | review | `glm-5.2` | failed | `account_quota_exceeded` | 22060 ms | [JSON](evidence/2026-07-18T09-12-48.572Z-ark-agent-glm-5.2-review-ark.json) · `37b9bcda2e67b658c99d55cb56c1dca128c5afc8bf400e57afff8953ebc0fa9c` |
| `ark-agent-glm-5.2` | delegate | `glm-5.2` | failed | `account_quota_exceeded` | 22743 ms | [JSON](evidence/2026-07-18T09-13-15.368Z-ark-agent-glm-5.2-delegate-ark.json) · `17c92f7626dcc79b2da65c61a350309e80c850623f5189a25488681d5d3d9568` |
| `ark-agent-doubao-seed-2.0-pro` | review | `doubao-seed-2.0-pro` | failed | `account_quota_exceeded` | 20209 ms | [JSON](evidence/2026-07-18T09-13-39.722Z-ark-agent-doubao-seed-2.0-pro-review-ark.json) · `d12658f2d320f915d16c04075ee5d973b0bad9d8f8e1bd93dbf249f3e8d179f8` |
| `ark-agent-doubao-seed-2.0-pro` | delegate | `doubao-seed-2.0-pro` | failed | `account_quota_exceeded` | 21268 ms | [JSON](evidence/2026-07-18T09-14-05.089Z-ark-agent-doubao-seed-2.0-pro-delegate-ark.json) · `d0a40f269cb4a914b67bc3da352703fd87441e3d59951c6bbdf83a950a767c6e` |

证据文件不含密钥、认证头、完整环境、开发机绝对路径或原始上游错误正文。`credentialEnv` 只记录 Pi 子进程看到的项目私有变量名。

## 适配器诊断修复

首次 GLM review 暴露一个桥接缺陷：Pi 的 assistant 消息可携带 `errorMessage` 且内容数组为空，旧逻辑只提取文本，因此会把 API 错误误标为 completed。当前实现会脱敏记录 assistant API 错误，并把最终状态标为 failed；fake RPC 回归测试覆盖该行为。最终矩阵均由修复后的实现生成。

## 复跑条件

Agent Plan 额度重置后，可按以下命令逐项复跑；只有单项 `passed: true` 后才允许启用对应能力：

```powershell
npm run smoke:ark -- --llm ark-agent-glm-5.2 --task review
npm run smoke:ark -- --llm ark-agent-glm-5.2 --task delegate
npm run smoke:ark -- --llm ark-agent-doubao-seed-2.0-pro --task review
npm run smoke:ark -- --llm ark-agent-doubao-seed-2.0-pro --task delegate
```

Coding Plan 只有在进程可继承 `ARK_API_KEY` 或 `VOLCENGINE_API_KEY` 后才复跑。项目不会从历史会话、旧源码或其它 provider 凭据中恢复、复制或猜测密钥。
