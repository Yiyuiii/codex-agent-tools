# Pi 写入命令生命周期脱敏诊断设计

> 历史状态说明：本文当时的“新真实批次须独立授权”已被 [standing authorization](2026-07-28-standing-experiment-authorization-design.md) 覆盖；诊断分层、脱敏和资格协议边界保持不变。

日期：2026-07-28

状态：方案 B 离线实现、双重审阅与 fresh 验证已完成；待最终状态文档提交、clean allow-empty freeze 与新真实批次授权

## 1. 授权与边界

维护者已明确批准：

- 只增加 Pi 写入命令生命周期的脱敏诊断；
- 不修改资格提示词；
- 不修改结果文件、文件范围或精确 `git status --short` validator；
- 不修改公开 MCP、模型、provider、route、credential 或 retry/fallback；
- 使用 TDD、独立规格审阅、代码质量审阅和全量离线验证；
- 完成后冻结新的 clean candidate。

本批准不授权：

- 第二个真实 `four-llm-v1` 资格批次或任何 standalone 真实模型 smoke；
- 活动插件安装、升级、移除或回滚；
- 读取、写入、比较、备份或恢复活动 `~/.codex/config.toml`；
- 调用、修改或卸载 Claude Code；
- 移除 `codex_cc_tools`；
- npm/marketplace 发布、推送、合并或正式工作树 fast-forward。

## 2. 背景与可证事实

冻结提交 `07fd0d79e6885ee1e0af4a021e12170ef6c9f470` 上唯一获授权的新批次是：

`2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678`

该批次由同一 execution cell、同一标准入口和单一四小时内层预算执行，8 项全部完成：

1. Ark Coding Plan delegate：passed
2. Ark Coding Plan review：passed
3. Kimi K3 review：passed
4. Kimi K3 delegate：passed
5. Ark Agent Plan review：passed
6. Ark Agent Plan delegate：passed
7. Ark Agent DeepSeek V4 Flash review：passed
8. Ark Agent DeepSeek V4 Flash delegate：failed

最后一项的确定事实是：

- 运行状态为 `completed`；
- 实际模型、provider、direct route 与凭据隔离正确；
- adapter client invocation / adapter retry / runtime retry / fallback 为 `1 / 0 / 0 / false / false`；
- 共观察到 6 个公开命令字符串；
- 精确 `git status --short` 被观察到；
- `diagnosticCount=0`；
- `filesChanged=[]`；
- 目标结果文件读取状态为 `missing`；
- 进程清理、资格锁释放与 immutable-evidence verifier 均通过。

这些证据不能证明写入命令被省略、改写、执行失败或执行后制品消失。相同提示词合同在同一批次的 Ark Coding Plan 与 Ark Agent Plan delegate 中通过，因此当前证据不支持猜测性修改提示词、模型、路由、凭据、重试或 validator。

## 3. 设计时观测缺口（已由离线实现闭合）

实施前，Pi RPC client 会保留 `tool_execution_start` / `tool_execution_end`，Pi adapter 再映射为内部 `tool_call` / `tool_result`。任务服务当时只从开始事件提取公开 `commandsRun`：

- 有字符串 `rawInput.command` 时使用该字符串；
- 否则在 compatibility policy 下回退到 title；
- 结束事件不参与命令观测；
- tool-level `isError` 不进入公开结果或资格 evidence。

另有一个当时确定存在的 fail-open 风险：

1. 超过 65,536 bytes 的 Pi 工具事件只保留 `type / toolCallId / toolName / truncated`；
2. 超大结束事件的 boolean `isError` 因此丢失；
3. adapter 当时用 `record.isError === true` 映射结果；
4. 缺失或非 boolean 值会被强制变成 `false`，表现为“没有错误”。

本设计必须把该路径改为三态语义：只有明确 boolean 才能形成 success/error；缺失、非 boolean 或协议冲突必须形成 `unknown`。

## 4. 决策摘要

采用独立的 Pi-only 生命周期观察通道：

```text
Pi RPC sanitized events
        │
        ├── existing command extractor ──> commandsRun（保持原样）
        │
        └── new Pi lifecycle folder
                 │
                 ├── internal source/command/origin/outcome
                 │
                 └── qualification-only sanitizer
                         └── writeCommandObservations
                              { source, match, outcome }
```

新通道只定位失败层，不作为第二条通过路径。它能可靠表达：

- `exact + error`：精确写入命令已观察，工具结束事件明确报错；
- `exact + success` 且最终文件 missing：工具报告成功后最终制品仍不一致；
- `trim_only / embedded`：开始事件中的命令与固定目标存在相应关系；
- `missing / unknown`：结束事件缺失或协议证据不足。

它不能单独证明：

- `other` 或无 exact 时究竟是“完全跳过”还是“完全改写”；
- `success + missing` 一定发生了删除动作；
- Pi runtime、shell 或工具绝不会错误报告成功。

因此面向维护者的结论必须写成“定位失败层并指导下一步”，不能写成“证明四个具体根因”。

## 5. Pi 事件清洗与 adapter 映射

### 5.1 超大事件

`src/adapters/pi/client.ts` 的超大事件安全摘要继续保留：

- `type`
- `toolCallId`
- `toolName`
- `truncated: true`

当且仅当原始 `event.isError` 是 boolean 时，额外保留：

```ts
{
  isError: event.isError;
}
```

不得保留 `args`、`result`、命令、路径、模型正文或工具输出。不得把字符串、数字、对象或 accessor 形式的 `isError` 转成 boolean。

### 5.2 tool result

`src/adapters/pi/adapter.ts` 映射结束事件时：

- boolean `isError` 原样保留；
- 缺失或非 boolean 时，映射后的 `tool_result` 不含 `isError`；
- 不再用 `record.isError === true` 生成无依据的 `false`；
- 其它内部字段和公开行为保持不变。

## 6. 独立 Pi 生命周期观察

新建 `src/tasks/pi-command-lifecycle.ts`，不得修改既有：

- `CommandObservation`
- `extractCommandObservations`
- `commandsFromObservations`
- `CommandObservationPolicy`
- Kimi ACP folding

### 6.1 内部类型

```ts
export type PiCommandLifecycleSource =
  "raw_input" | "title_fallback" | "unextractable";

export type PiCommandLifecycleOrigin = "raw_input" | "title" | null;

export type PiCommandLifecycleOutcome =
  "success" | "error" | "missing" | "unknown";

export interface PiCommandLifecycleObservation {
  readonly source: PiCommandLifecycleSource;
  readonly command: string | null;
  readonly origin: PiCommandLifecycleOrigin;
  readonly outcome: PiCommandLifecycleOutcome;
}
```

`command` 和 `origin` 只存在于当前进程的内部观察值，不进入公开任务结果或 evidence JSON。

### 6.2 接受的事件

folder 只接受满足以下条件的普通 data record：

- `runtime === "pi-rpc"`；
- `type === "tool_call"` 或 `type === "tool_result"`；
- `toolCallId` 是非空字符串；
- 开始事件的首次 `kind === "execute"`。

Proxy、accessor、symbol、继承属性、非普通对象和读取异常全部 fail closed，不调用 getter、`toString`、iterator 或用户代码。

### 6.3 开始事件与命令来源

每个 `toolCallId` 只由首次开始事件决定是否形成观察项，顺序按首次开始事件：

1. 首次开始是 execute：形成一项；
2. 首次开始不是 execute：该 ID 永不形成命令生命周期项；
3. 同 ID 重复开始：仍只保留首次开始的数据，但 outcome 为 `unknown`。

命令来源：

1. `rawInput` 是非 Proxy 普通对象，且自有 data descriptor `command` 是字符串：`raw_input`；
2. 否则 title 是非空字符串：`title_fallback`；
3. 否则：`unextractable`，`command=null`。

该规则与当前 Pi compatibility `commandsRun` 计数保持一致：`raw_input` 和 `title_fallback` 各对应一个公开字符串，`unextractable` 不对应公开字符串。

### 6.4 结束状态机

对每个首次 execute start：

| 事件条件                                                                                                     | outcome   |
| ------------------------------------------------------------------------------------------------------------ | --------- |
| 开始之后恰有一个同 ID、同工具 title、boolean `isError=false` 的结果                                          | `success` |
| 开始之后恰有一个同 ID、同工具 title、boolean `isError=true` 的结果                                           | `error`   |
| 没有结果事件，且没有其它协议异常                                                                             | `missing` |
| 结果先于开始、重复开始、重复结果、冲突结果、工具 title 缺失/不一致、`isError` 缺失/非 boolean 或其它关联异常 | `unknown` |

孤立 result 没有首次 execute start 时不产生观察项。不同 ID、不同任务或不同 adapter run 不得关联。

## 7. TaskExecutionContext 与公开非干扰

`TaskExecutionContext` 增加内部回调：

```ts
onPiCommandLifecycleObservations?: (
  observations: readonly PiCommandLifecycleObservation[],
) => void;
```

服务行为：

- 只在 resolved profile runtime 为 `pi-rpc` 的 delegate 中调用；
- 每次 delegate 恰好调用一次，包括 adapter 抛错或零事件；
- 传入冻结数组和冻结 plain objects；
- callback 抛错只加入固定、不含原始内容的内部 diagnostic；
- Kimi delegate 不调用该 observer；
- 既有 `onCommandObservations`、`commandsRun` 和 callback policy 保持原样。

禁止把内部观察加入：

- `ExternalDelegateResult`
- `externalDelegateResultSchema`
- MCP `structuredContent`
- CLI 一般输出
- model-facing prompt

## 8. 资格 producer 与脱敏 evidence

### 8.1 适用范围

`writeCommandObservations` 只由以下 producer 产生：

- 当前 `four-llm-v1`
- schema v3
- runtime `pi-rpc`
- task `delegate`
- `qualificationContext !== null`

以下 evidence 不出现该字段：

- standalone schema v2 Pi delegate；
- Pi review；
- Kimi review/delegate；
- 历史 evidence；
- infrastructure failure 在 observer 合同完成前形成的共享失败 evidence。

### 8.2 producer 合同

Pi qualification delegate 在调用 service 前安装 observer，并在 task execution 返回前要求：

- callback report count 恰为 1；
- observation 数组已定义。

不满足时抛出固定 `SmokeInfrastructureError`，不得生成看似完整的生命周期 evidence。

使用同一个 `buildPiDelegateSmokeContract(options.llm).writeCommand` 作为匹配目标。提示词和 write command 本身不修改。

### 8.3 evidence 类型

```ts
export type PiWriteCommandMatch = "exact" | "trim_only" | "embedded" | "other";

export interface SanitizedPiWriteCommandObservation {
  readonly source: PiCommandLifecycleSource;
  readonly match: PiWriteCommandMatch;
  readonly outcome: PiCommandLifecycleOutcome;
}
```

匹配顺序：

1. raw command 与 write command 完全相等：`exact`；
2. 仅 `trim()` 后相等：`trim_only`；
3. raw command 包含目标但不是前两类：`embedded`；
4. 其它：`other`。

`title_fallback` 和 `unextractable` 必须固定为 `match="other"`，避免 title spoof 被升级为命令证据。

字段禁止包含：

- `command`
- hash
- `rawInput` / `rawOutput`
- tool-call ID
- cwd、文件名或路径
- Base64 payload
- 模型正文
- 工具输出

`writeCommandObservations` 只用于诊断，不参与 `passed`、`failureReason` 或 `checks` 的计算。

## 9. immutable verifier

历史 schema v3 与新 schema v3 使用同一版本号，因此新字段必须 optional：

- 字段缺失：按既有历史规则继续验证；
- 字段存在：执行本节严格检查。

当字段存在时必须：

1. identity 为当前 `four-llm-v1` 的 Pi delegate；
2. 值是非 Proxy、无 symbol 的普通稠密数组；
3. 长度不超过 256；
4. 每项是非 Proxy、无 symbol、只有 `source / match / outcome` 三个 enumerable data property 的普通对象；
5. source、match、outcome 均属于闭合枚举；
6. `title_fallback` / `unextractable` 只能与 `match="other"` 配对；
7. `commandCount` 是非负 safe integer；
8. `count(source !== "unextractable") === commandCount`。

不得把 `match="exact"` 与 `checks.requiredCommandObserved` 关联：前者匹配写入命令，后者验证的是另一条 `git status --short` 命令。

不得要求历史 evidence 存在该字段，不得修改任何历史 JSON、manifest、checkpoint、plan ID 或 SHA。

## 10. 安全与隐私

- 原始 Pi event 继续只在当前 adapter result 内存在。
- 任何新固定 diagnostic 不得拼接 command、title、ID、路径、输出或 secret。
- 事件折叠不跨 adapter run、任务、模型调用或重试。
- 对 Proxy/accessor/symbol/继承属性只做拒绝，不求值。
- 超大结束事件只保留 boolean `isError`，不因诊断需求扩大输出保存面。
- 新 observer 失败不能让任务通过，也不能把未知状态降格为 success。
- 验收仍完全依赖结果文件、唯一文件范围、精确状态命令、模型身份、环境隔离、telemetry 与进程清理。

## 11. TDD 与审阅

实现必须遵循 RED → GREEN → REFACTOR：

1. client fake 先证明超大 end 的 boolean `isError` 当前丢失；
2. adapter test 先证明缺失/非 boolean 当前被误映射成 false；
3. 新 lifecycle module 先覆盖完整状态机和 hostile inputs；
4. service test 先证明 Pi-only observer、一次回调和公开结果不变；
5. smoke test 先证明 qualification-only producer、三字段脱敏和 standalone/review absence；
6. verifier test 先证明非法字段当前可穿透，再实现严格校验；
7. 历史 batches 必须继续通过 immutable verifier，历史 evidence 工作树 diff 必须为空。

每个实现任务完成后依次进行：

1. 独立规格符合性审阅；
2. 独立代码质量审阅；
3. Critical/Important 实质问题必须用新的 RED 测试复现后修复；
4. reviewer 必须重新确认问题关闭。

外部 LLM 只允许通过 `codex_external_agents.external_review` 明确选择非 Claude 逻辑 LLM做只读复核；超时或无结论不计 PASS，也不重试同形宽任务。

## 12. 完成条件与当前状态

同时满足以下条件才算离线实现完成：

- 超大 Pi end 安全保留 boolean `isError`；
- 缺失/非 boolean end 不再被映射成 success；
- 独立 Pi lifecycle folder 的状态机和 hostile-input 测试通过；
- 现有 `commandsRun` / `commandCount` 行为和公开 MCP schema 不变；
- 新资格 Pi delegate evidence 只包含三枚举字段；
- standalone、review、Kimi 和历史 evidence 不出现新字段；
- verifier 对存在的新字段严格 fail closed，对缺失字段保持历史兼容；
- prompt、validator、provider/model/route/credential/retry/fallback、manifest/checkpoint/protocol 和历史 JSON 均未改变；
- 全量测试、typecheck、build、release smoke、隔离 plugin check-report、package/evidence/锁/进程检查全部通过；
- 独立规格和代码质量审阅无未解决实质问题；
- 文档与 AGENTS 反映真实状态；
- 最终候选为 clean 40 位 SHA；
- 没有运行第二个真实批次或其它越界动作。

### 12.1 已完成的实现与审阅

- 实现与审阅提交链为 `8261736`、`652b13d` / `5e209e1` / `16cdad5`、`293e745`、`969e546` / `0852691` / `d9eb28a`、`4bd2439`。
- 超大结束事件 boolean `isError`、Pi-only 生命周期状态机、内部 observer、qualification-only schema v3 producer 与严格 optional verifier 均已按本设计实现。
- 逐任务规格/质量审阅与整体规格/安全审阅均 PASS。
- 本轮两次 Kimi 外部复核均无结论：设计级跨多实现面审阅约 604.5 秒 `timed_out`，只返回读取进度；实现后两个内嵌摘录的单一不变量审阅约 181.8 秒 `timed_out`，review 正文为空。二者不计 PASS、不阻断，也未重试同形任务。
- fresh 离线矩阵为 48 个测试文件、837 passed / 1 个平台条件 skipped / 0 failed；typecheck、build、release smoke、隔离 check-report、两个 help 与 diff check 均通过。
- 5/5 retained manifests 通过 immutable verifier；evidence 相对 `a8aa4d8` 无变更且 untracked 为 0。
- Kimi ACP / Pi RPC / real-smoke 进程为 0/0/0，资格锁 absent，持久 `.tgz` 为 0。
- `npm pack --dry-run --json` 为 171 files / 15 Markdown/HTML / 3 plugin files，size 536161、unpackedSize 2703085。

### 12.2 尚未完成的收口

- 本轮状态文档提交尚未完成。
- clean allow-empty freeze 尚未完成，本文不得提前记录最终 40 位 frozen SHA。
- `writeCommandObservations` 尚未由新的真实批次实测。
- 第二个真实 `four-llm-v1` 批次尚未授权。
- 注册表仍为 6 passed / 2 pending，安装仍为 `blocked / not ready`。
- 未安装活动插件，未访问或修改 `~/.codex/config.toml`，未移除 `codex_cc_tools`，未调用或修改 Claude Code，也未发布、推送、合并或 fast-forward。

## 13. 后续人工门槛

完成状态文档提交与 clean allow-empty freeze 后，只能准备新的真实资格批次授权材料。下一次批次必须绑定交接消息届时提供的精确 40 位 frozen SHA，并遵守“一次全新完整 `four-llm-v1` 八项，从 ordinal 1，single entry/cell，按首错停，绝不 resume/retry/fallback/补跑/第二批”。本设计批准不能复用为真实调用授权，旧 SHA、旧授权与[授权审阅页面](../../release/four-llm-qualification-next-authorization-review.html)本身也都不能触发真实调用。
