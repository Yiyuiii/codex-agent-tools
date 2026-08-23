# Direct DeepSeek / Pi 接入状态

## 用户范围

2026-08-13，维护者要求恢复 Direct DeepSeek API，由 Pi RPC 承载，并在该 provider 内只启用 `deepseek-v4-flash`。既有 Kimi 与 Ark 路线继续保留；Ark Agent Plan 内的 `ark-agent-deepseek-v4-flash` 是另一条独立路线，证据不可互换。2026-08-14 的阶段验收只验证 Direct DeepSeek。2026-08-20，维护者要求后续客户端统一可用 Kimi、Ark 与 Direct DeepSeek，因此当前目标改为五模型 beta，并继续跳过额外审阅调用。

## 当前实现

- 逻辑 ID：`deepseek-v4-flash`
- runtime：`pi-rpc`
- provider：`deepseek`
- model：`deepseek-v4-flash`
- endpoint：`https://api.deepseek.com`
- Pi API 协议：`openai-completions`
- 宿主凭据：`OPENAI_API_KEY_DEEPSEEK`
- Pi 子进程凭据：`CODEX_AGENT_DEEPSEEK_KEY`
- 网络：`direct`，清除父进程 HTTP(S)/ALL proxy
- 并发池：`deepseek`，上限 1

Pi 的版本化隔离 `models.json` 在 DeepSeek provider 下只有 `deepseek-v4-flash`。它采用官方资料中的 1,000,000 context window、384,000 max output、`max_tokens` 字段和 DeepSeek thinking compatibility；项目不读取或修改用户的 `~/.pi/agent`。静态 `cost` 被有意省略，因为 DeepSeek 已公告自 2026-08-16 起改用分时价格，而 Pi 0.80.10 的单组静态费率无法准确表达峰谷价格。官方参考：[DeepSeek 的 Pi 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/pi_mono/)、[模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)、[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion)、[Pi 自定义模型](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。上述动态资料最后复核于 2026-08-14。

Ark 与 Direct DeepSeek 使用按 provider 分离的缓存目录：`.../pi/<version>/ark` 与 `.../pi/<version>/deepseek`。Ark 配置不含 DeepSeek provider 或凭据占位符；Direct DeepSeek 配置也不含任何 Ark provider 或凭据占位符。2026-08-14 使用本机 Pi `0.80.10` 在 `--offline --list-models deepseek-v4-flash` 下重新完成无模型请求的解析探针，输出精确列出 provider `deepseek`、model `deepseek-v4-flash`、context `1M`、max output `384K`、thinking `yes`，exit code 0。

官方插件 `.mcp.json` 只新增凭据变量名 `OPENAI_API_KEY_DEEPSEEK`，不保存值。MCP 进程收到宿主白名单后，Pi 子进程只接收当前 profile 对应的私有凭据；Direct DeepSeek 不接收 Ark 凭据，Ark 路线也不接收 DeepSeek 凭据。

## 当前门禁

- 当前 Codex 进程环境：`OPENAI_API_KEY_DEEPSEEK` present（只核验布尔值）
- 当前 Windows user 环境：`OPENAI_API_KEY_DEEPSEEK` present（只核验布尔值）
- Direct DeepSeek review：passed；evidence valid / fingerprint current
- Direct DeepSeek delegate：passed；evidence valid / fingerprint current
- 真实 Direct DeepSeek 调用：2；每项单次 client invocation、零 retry/fallback、owned process drained
- 真实 Direct 批次：`2026-08-14T02-55-25.557Z-f96e5e84-7ab0-4c0f-b071-ea2dd5b94f69`，2/2 passed，manifest SHA-256 `f0d564aef9d1d62cfe9348b74e54a99f53912e810dd662830704b9860d17279d`
- 现行能力证据：Direct 两项与 Ark Coding delegate 保留各自 current passed case；其余五项 Ark 与两项 Kimi 使用 2026-08-23 定向刷新 passed cases
- 最新刷新批次：`2026-08-23T11-11-13.828Z-f5c1cb1c-9b94-4dee-8c2f-b3f5d6098e60` 在 frozen commit `388f0fdc37db02b5c6104988aa68baa793eda791` 上 7/7 passed，manifest SHA-256 `968c00d5ecf9a612fd8e9b5bff34ef84c31126ac6598078d9f9c74ee4f48e550`
- 发布资格：十项索引为 10 current / 0 stale / 0 legacy，`npm run verify:capabilities` 与 release smoke 通过
- 当前任务插件发现：活动注册表已暴露 `external_review` / `external_delegate`；Kimi、Ark Coding 与 Direct DeepSeek 三条代表性 review 均真实 completed、零诊断、零文件变化
- 活动安装状态：官方列表显示本地 staging `0.1.2-beta.1+codex.20260822121123` installed/enabled；公共 `0.1.2-beta.1` 已发布并通过隔离验收，但活动插件尚未升级到公共包
- 本次收敛验收：Direct batch immutable verifier 再次通过；真实 delegate evidence SHA-256 为 `7bbb2b11cc45e193a8b77e5ce1215b93f02ca80268b1914325d4f0c6490ea342`，实际 `provider=deepseek`、`model=deepseek-v4-flash`、`endpointHost=api.deepseek.com`、单次 client invocation、零 retry/fallback、owned process drained，全部 checks 为 true
- 五模型候选复核：十项 evidence 均 valid/current；2026-08-23 三次活动宿主 review 仍只作为可用性证据，不是资格 case

`npm run smoke:deepseek -- --llm deepseek-v4-flash --task review|delegate` 是独立真实 smoke 入口。缺少凭据时不得运行；standalone smoke 不能自行改写能力索引。标准资格入口使用仅含两项能力的 `direct-deepseek-v1` 计划；原八项广覆盖回归使用 `four-llm-v1`，定向刷新使用 `capability-refresh-v1`。计划分别绑定 DeepSeek-only 或 Ark-only Pi 配置哈希，不能混合、拼接或互换 evidence。已通过的 case 按能力粒度政策独立晋级；当前十项已经全部通过发布 verifier。

## 已完成的离线验证

- 注册表固定绑定、能力索引 anchor 与凭据白名单测试
- Pi 官方配置精确 fixture 与 provider/model 集合测试
- 本机 Pi 0.80.10 的离线配置解析探针
- Direct DeepSeek adapter 的 provider/model/私有凭据隔离测试
- DeepSeek review smoke 的 endpoint/model/credential/evidence 测试
- doctor 的 endpoint/protocol/model/credential 检查
- 官方插件 manifest 的环境变量名闭包测试
- 临时 `CODEX_HOME` 官方插件验收中，Direct 与 Ark Agent DeepSeek 分别恰好调用一次 fake Pi，并验证逐路线目标凭据隔离
- `direct-deepseek-v1` 的协议、锁、preflight、ledger、coordinator、verifier、能力索引与 smoke 上下文 TDD
- `direct-deepseek-v1` 真实 2/2 passed、immutable/frozen verifier、证据提交与 current 索引
- 2026-08-23 定向入口修复后完成 build、类型检查、聚焦 10 files / 413 passed / 1 skipped 与完整单 worker 回归（70 files passed / 1 file skipped，1285 passed / 6 skipped / 0 failed）
- 官方临时插件生命周期与 committed report 一致性通过；npm pack dry-run 为 27 files，精确包含两个 current manifest 与十项 case evidence，未生成持久 `.tgz`
- 2026-08-23 定向真实批次 7/7 passed；immutable-evidence 与 detached frozen-candidate verifier 通过，能力索引更新后 release smoke 通过

## 当前结论与后续边界

1. Direct DeepSeek review/delegate 已由不可变真实证据支持，当前运行时指纹保持 current，无需重复调用。
2. Kimi/Ark 七项定向刷新已通过；五模型 beta 的十项能力均 current，标准入口仍保持 single-attempt、首错停、无 resume/retry/fallback。
3. 当前进入最终 release marker、完整离线门禁与公共 beta 发布验收。活动插件升级仍是发布后的独立授权动作。

资格拆分依据见 [Direct DeepSeek 双计划资格设计](../superpowers/specs/2026-08-14-direct-deepseek-qualification-design.md)。
