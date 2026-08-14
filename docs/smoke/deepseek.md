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
- Direct DeepSeek review：pending
- Direct DeepSeek delegate：pending
- 真实 Direct DeepSeek 调用：0
- 现行旧证据：八份历史 evidence 仍有效；资格协议属于共享指纹输入，因此六项 Pi 与两项 Kimi 能力当前全部 stale
- 发布资格：blocked；`npm run verify:capabilities` 与 release smoke 必须 fail closed
- 当前任务插件发现：实时工具注册表没有 `external_review` / `external_delegate`，当前任务未加载本项目插件
- 活动安装状态：未读取活动配置，不能把此前 `0.1.1` 宿主验收外推为当前 installed/enabled 状态；本候选没有执行 add/remove/upgrade，也没有访问活动 `~/.codex/config.toml`

`npm run smoke:deepseek -- --llm deepseek-v4-flash --task review|delegate` 是独立真实 smoke 入口。缺少凭据时不得运行；standalone smoke 也不能自行把 pending 改成 passed。标准资格入口使用仅含两项能力的 `direct-deepseek-v1` 计划；原八项继续使用 `four-llm-v1`。两个计划分别绑定 DeepSeek-only 与 Ark-only Pi 配置哈希，不能混合、拼接或互换 evidence。晋级仍需冻结候选、内部执行引用哈希、single-attempt、首错停、零 retry/fallback、不可变 evidence 与能力索引更新。

## 已完成的离线验证

- 注册表固定绑定、pending fail-closed 与凭据白名单测试
- Pi 官方配置精确 fixture 与 provider/model 集合测试
- 本机 Pi 0.80.10 的离线配置解析探针
- Direct DeepSeek adapter 的 provider/model/私有凭据隔离测试
- DeepSeek review smoke 的 endpoint/model/credential/evidence 测试
- doctor 的 endpoint/protocol/model/credential 检查
- 官方插件 manifest 的环境变量名闭包测试
- 隔离插件验收中，pending Direct DeepSeek 必须在启动 Pi 前被拒绝
- `direct-deepseek-v1` 的协议、锁、preflight、ledger、coordinator、verifier、能力索引与 smoke 上下文 TDD

## 下一步

1. 完成 clean frozen candidate 与两个当前资格计划的离线闭包。
2. 先运行两项 `direct-deepseek-v1`，提交其不可变 evidence；再在新 clean commit 上运行八项 `four-llm-v1`。
3. 十项能力通过后更新 `capabilities.json`，重新运行完整离线、隔离插件与 package/release 门禁。
4. 如需升级活动官方插件，先展示隔离取证、精确版本与回滚方案，再取得该次官方 add/remove 的明确许可。

资格拆分依据见 [Direct DeepSeek 双计划资格设计](../superpowers/specs/2026-08-14-direct-deepseek-qualification-design.md)。
