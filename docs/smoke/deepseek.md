# Direct DeepSeek / Pi 接入状态

## 用户范围

2026-08-13，维护者要求恢复 Direct DeepSeek API，由 Pi RPC 承载，并在该 provider 内只启用 `deepseek-v4-flash`。既有 Kimi 与 Ark 路线继续保留；Ark Agent Plan 内的 `ark-agent-deepseek-v4-flash` 是另一条独立路线，证据不可互换。

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
- 现行旧证据：八份历史 evidence 仍有效；资格协议属于共享指纹输入，因此六项 Pi 与两项 Kimi 能力当前全部 stale
- 旧八项刷新批次：`2026-08-14T03-03-14.120Z-3312323b-63e0-4b47-b88c-8fb98bb06e4e` 在首项 `ark-coding-plan/delegate` 因 `account_quota_exceeded` blocked，其余七项 notRun
- 发布资格：blocked；十项索引为 Direct 2 current + 原路线 8 stale，`npm run verify:capabilities` 与 release smoke 必须 fail closed
- 当前任务插件发现：实时工具注册表没有 `external_review` / `external_delegate`，当前任务未加载本项目插件
- 活动安装状态：未读取活动配置，不能把此前 `0.1.1` 宿主验收外推为当前 installed/enabled 状态；本候选没有执行 add/remove/upgrade，也没有访问活动 `~/.codex/config.toml`

`npm run smoke:deepseek -- --llm deepseek-v4-flash --task review|delegate` 是独立真实 smoke 入口。缺少凭据时不得运行；standalone smoke 不能自行改写能力索引。标准资格入口使用仅含两项能力的 `direct-deepseek-v1` 计划；原八项继续使用 `four-llm-v1`。两个计划分别绑定 DeepSeek-only 与 Ark-only Pi 配置哈希，不能混合、拼接或互换 evidence。已通过的 Direct case 按能力粒度政策独立晋级；整个候选仍须等旧八项 current 后才能通过发布 verifier。

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
- 当前候选完整 build、类型检查、70 个测试文件的单 worker 回归（1276 passed / 5 平台条件 skipped / 0 failed）
- 官方临时插件生命周期与 committed report 一致性通过；npm pack dry-run 为 26 files，精确包含 Direct manifest 与两项 case evidence，未生成持久 `.tgz`
- release smoke 在能力索引阶段按预期失败关闭；机器分析只报告 Direct 2 current 与原路线 8 stale

## 下一步

1. 维护者先恢复 Ark Coding Plan 账户额度；外部状态没有变化前不重复真实批次。
2. 在新的 clean frozen commit 上按 standing authorization 只运行一次 `four-llm-v1`；继续遵守首错停、无 resume/retry/fallback。
3. 八项刷新通过后更新其指纹并运行完整类型检查、确定性全库、隔离插件与 package/release 门禁。
4. 如需升级活动官方插件，先展示隔离取证、精确版本与回滚方案，再取得该次官方 add/remove 的明确许可。

资格拆分依据见 [Direct DeepSeek 双计划资格设计](../superpowers/specs/2026-08-14-direct-deepseek-qualification-design.md)。
