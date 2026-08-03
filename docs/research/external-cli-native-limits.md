# 外部 CLI 原生能力上限审计

## 用户原始要求

2026-07-30 起，维护者明确要求本项目不得为 Kimi、Pi 或其它外部 CLI 持久化、全局注入或默认降低 step、turn、tool、context、token、执行时长等上限。显式单次调用 timeout、qualification-only single-attempt 和 test teardown watchdog 仍可保留，但任务结束后不得留下全局配置变化。

## 2026-08-01 事实状态

- 源码未发现 `maxSteps`、`maxTurns` 或历史 Kimi 100-step 限制。
- 省略公开 `timeoutMs` 时不会创建 deadline；provider `KeyedLimiter`只调度本 MCP 进程内共享provider并发，不限制外部CLI的原生执行预算。
- `src/tasks/schemas.ts` 的 `prompt.max(200_000)`、`context.max(100_000)`、单条 acceptance criterion 10,000 字符和最多 100 条均来自初始实现，没有协议上限、聚合内存预算或边界测试依据。它们会在 adapter 启动前拒绝请求，属于待删除的历史保守限制。
- `src/evidence/workspace.ts` 曾把 Git status/diff 在 200,000 字符静默截断；fingerprint使用完整内容，但模型收到的review evidence不完整。提交 `06f5d4e` 已按TDD删除该静默裁剪，保留10MiB显式Git进程buffer故障边界。

## Pi 模型容量字段不能机械删除

本机只读检查 `@earendil-works/pi-coding-agent` 0.80.10 的随包源码和类型确认：

- `models.json` 的 `contextWindow` / `maxTokens` 输入字段可省略，但 provider composer 会分别回退到 128,000 / 16,384；
- 最终 Pi `Model` 类型要求两项均为 number；
- `maxTokens` 会成为 Anthropic request 的 `max_tokens` 默认值；
- `contextWindow` 会参与输出预算夹取与自动压缩阈值。

因此删除字段不会恢复“无限原生能力”，反而会静默降低到 Pi 默认值。当前仓库的 200,000 / 32,000 已经通过历史真实能力调用，但历史计划与 fixture 没有记录它们是当前 Ark 路线的权威最大容量；不能把“调用成功”误写成“已经证明最大容量”。

火山方舟官方 API 文档说明 `max_tokens` 的取值范围随模型而异；Coding Plan 的 `ark-code-latest` 又可由控制台切换实际模型。当前可访问的官方接入文档没有给出本项目三条精确 provider/model 路线的稳定 context/output capacity 合同：

- [Coding Plan Claude Code 接入](https://www.volcengine.com/docs/82379/1928262?lang=zh)
- [方舟 API `max_tokens` 说明](https://api.volcengine.com/api-docs/view?action=ChatCompletions&serviceCode=ark&version=2024-01-01)

现阶段裁决：保留字段与既有值，明确其为历史真实调用已接受、但最大容量仍未证明的运行配置；不得擅自降低、删除或猜更大值。若官方以后暴露按 endpoint/provider/model 查询的容量元数据，再按路线建立唯一容量表并由 doctor/qualification 验证。当前发布至少必须由 stale-only 真实能力门禁证明该配置在当前宿主仍可工作。

## 后续验证

1. 已由提交 `548cc01` 按 TDD 删除公开 schema 的无依据字符/数量魔数，同时保留空白拒绝、strict object、cwd 和显式单次 timeout 合同；阈值+1、尾部sentinel、service逐字透传与MCP schema回归共60/60。
2. 已由提交 `06f5d4e` 删除 Git evidence 的静默 200,000 字符截断；真实超阈值diff尾部sentinel聚焦4/4完整保留。若未来需要 DoS 防护，应按完整 UTF-8 请求总字节建立可解释、显式报错的单一预算，而不是分字段魔数或静默裁剪。
3. Pi 容量字段只在获得精确当前路线证据后更新；不得用其它 provider 中同名模型的容量类推。
4. 冻结候选后只运行 stale/missing 能力，确认当前配置真实可用；该 smoke 不声称证明最大上下文或最大输出容量。
