# stdio 生命周期与外部 CLI 原生执行预算设计

状态：维护者已于 2026-07-31 批准方案 A。本文定义 `codex-agent-tools`
在 MCP 宿主取消、stdio 连接断开和调用方显式截止时间之间的边界，并移除
Kimi/Pi profile 对单次模型执行施加的默认硬时限。

## 1. 用户目标

维护者明确要求：

- 不得再给 Kimi、Pi、Claude Code 或其它外部 CLI 持久化或全局注入步数、
  轮数、工具调用、上下文、token 或执行时长上限；
- 单次任务确有安全或验收需要时，可以由调用方显式传入只对该次调用生效的
  `timeoutMs`；
- 外层取消、宿主失联和 owned 进程回收仍必须可靠，不能以“保留清理能力”为由
  把 600/900 秒 profile timeout 继续当作模型能力上限；
- beta 必须先经过公共 npm 安装和本机真实宿主验收，取消链路通过后才可发布
  stable。

本设计不修改活动 `~/.codex/config.toml`、本机 Claude Code、旧
`codex_cc_tools` 或用户自己的 Kimi/Pi 全局配置。

## 2. 已确认的事实与根因

### 2.1 完整重启与 beta.1 真实宿主结果

完整退出并重开 Codex 桌面 App 后：

- 新任务同时发现插件提供的 `external_review` / `external_delegate` 和旧
  `cc_review` / `cc_delegate`；
- 因而当前桌面 App 不能无重启热更新插件 MCP，但完整宿主重启能够加载新版本；
- beta.1 的 Ark 凭据白名单已把本机凭据传入插件 MCP；真实 Coding Plan review
  成功解析为 `ark-code-latest` 并到达后端，随后因周额度 429 失败；
- Kimi K3 隔离 delegate 通过，只创建精确的预期文件，正常完成后目标进程归零。

### 2.2 取消门禁的可证事实

真实取消夹具让 Kimi 执行一个先写入 `STARTED\n`、再等待十分钟的 Node 命令。
App handoff 把调用线程标记为 `interrupted` 后：

- 睡眠 Node 命令被终止；
- `TASK.md` 未改，夹具只新增精确八字节的 `started.txt`；
- Kimi ACP 没有稳定归零，而是出现在新的插件 MCP 父进程下；
- 只有精确终止该调用所属的插件 MCP 三进程树后，ACP 才归零；
- 清理没有终止 Kimi 桌面、Codex App、其它插件 MCP 或旧工具。

handoff 同时迁移线程和工作区，因此不能单独证明普通 Stop 按钮一定会重放请求；
但它已经证明“宿主连接/线程终止后 owned 外部进程可靠归零”这一 stable 门禁尚未
满足。

### 2.3 代码与 SDK 数据流

当前代码已经完成以下传递：

```text
MCP tool extra.signal
  → ExternalAgentService TaskExecutionContext.signal
  → AdapterRunRequest.signal
  → Kimi ACP / Pi RPC caller cancellation
  → session abort + owned process-tree cleanup
```

缺口位于 stdio 会话生命周期：

- MCP SDK 为每个请求创建 `AbortController`；
- 收到 `notifications/cancelled` 或执行 `server.close()` 时，SDK 会 abort 在途
  handler；
- 当前 `StdioServerTransport` 只监听 stdin 的 `data` 与 `error`，没有把 stdin
  的 `end` / `close` 自动转为 transport/server close；
- `serveMcp()` 连接 transport 后立即返回，没有显式的会话关闭、在途任务 drain
  和宿主信号协调边界。

因此，宿主关闭 stdio 但没有成功发送 `notifications/cancelled` 时，任务层可能
永远收不到取消信号。

### 2.4 Pi 四条 429 的审计结论

Pi 的隔离生产配置没有覆盖其原生 auto retry。Pi 0.80.10 的默认值是
`retry.enabled=true`、`retry.maxRetries=3`，所以不可恢复的 429 会形成一次初始
请求加三次自动重试，对应本次看到的四条 assistant error。项目 adapter 仍只提交
一次 prompt；资格模式继续显式使用 `set_auto_retry=false`、provider
`maxRetries=0`。

本轮不关闭生产 Pi 的原生 retry，因为：

- 用户要求避免把一次验收的局部策略写成外部 CLI 长期默认；
- 它与 stdio 断开和默认执行时限是不同问题；
- 现有资格 evidence 已把资格模式的零 retry 单独验证。

若未来要改变生产 retry，必须另立设计，并区分只读 review、可写 delegate、
provider HTTP retry 和 agent turn retry。

## 3. 方案比较

### 方案 A：双通道生命周期（已批准）

默认不设置模型执行截止，只保留：

1. 调用方显式 `timeoutMs`；
2. MCP 请求显式取消；
3. stdio 断开或宿主终止触发的会话取消；
4. adapter 对 owned 子进程的回收。

优点是同时满足原生执行能力与失联清理要求，且每种停止原因都能机器区分。
代价是共享 runtime 发生实质变化，相关能力证据必须重新验证。

### 方案 B：只补 stdio 取消，保留 profile 硬时限（拒绝）

该方案能降低残留风险，但仍在调用方未选择时用 600/900 秒截断 Kimi/Pi，违反
已确认的用户要求。

### 方案 C：只删除 profile 硬时限（拒绝）

该方案保留模型原生执行，但 stdio 失联仍可能留下 ACP/RPC 和其工具子进程，不能
通过 stable 取消门禁。

## 4. 执行预算语义

### 4.1 profile 不再携带默认时限

`LlmProfile.timeoutMs` 从逻辑模型注册表和能力 profile 投影中删除。profile 只描述
模型、provider、路由、凭据、能力和并发池，不再决定单次任务能运行多久。

Kimi/Pi adapter 不再使用 `Math.min(request timeout, profile timeout)`。请求没有
`timeoutMs` 时，client 不创建 deadline timer；外部 CLI 可以按其原生逻辑持续
工作。

### 4.2 显式 timeout 只属于单次调用

`timeoutMs` 保持公开可选字段：

- 必须是大于等于 1000 的安全整数；
- 不再有 900,000 毫秒产品上限；
- 不写入 profile、插件 manifest、Pi/Kimi 全局配置或环境变量；
- 只传给当前 adapter request；
- 到期后结果为 `timed_out`，不能把部分输出标记为 completed。

Node 单个 `setTimeout` 的延迟存在 32 位限制。实现必须用可取消的分段 deadline
调度器承载更大的安全整数，而不是把大值截成约 24.8 天、溢出为 1 毫秒或重新引入
产品级最大时长。

### 4.3 取消不等于 timeout

- 调用方发送 MCP `notifications/cancelled`：结果语义为 `cancelled`；
- stdio `end` / `close`、宿主 SIGINT/SIGTERM：会话关闭，所有在途请求收到
  cancellation signal；
- 只有显式 `timeoutMs` 到期才是 `timed_out`；
- 上述任一终止都必须进入同一 adapter finally cleanup，等待 owned 进程树归零；
- 被截断的 assistant 文本、工具事件或文件不构成完整成功。

## 5. MCP stdio 会话架构

### 5.1 会话生命周期协调器

`serveMcp()` 建立一个可测试的 stdio session，并显式持有：

- `McpServer`；
- `StdioServerTransport`；
- stdin/stdout；
- 会话关闭状态；
- 当前工具 handler promise 集合。

生产入口使用 `process.stdin` / `process.stdout`；测试可以注入
`PassThrough`，不需要真实模型或活动插件。

### 5.2 关闭触发

以下事件第一次发生时启动幂等 shutdown：

- stdin `end`；
- stdin `close`；
- stdin `error`；
- SIGINT；
- SIGTERM；
- 显式调用 session close。

shutdown 顺序固定为：

1. 标记会话 closing，拒绝把后续事件重复当成第二次关闭；
2. 调用 `server.close()`，利用 SDK 已有逻辑 abort 全部在途 request handler；
3. 等待已登记的工具 handler settle，使 Kimi/Pi finally 可以完成进程树清理；
4. 移除会话自己安装的流和信号监听器；
5. 让 MCP 进程自然退出。

本层不设置新的“最大 drain 时长”。adapter 已负责收到取消后先发送协议级 abort，
再在局部 `terminationGraceMs` 后回收 owned 进程树；若 adapter 无法 settle，
测试应暴露缺陷，而不是用另一个全局 watchdog 掩盖它。

### 5.3 在途任务跟踪

工具注册层为每次 `review` / `delegate` 登记实际 handler promise，并在 finally
删除。跟踪器只用于会话 shutdown drain：

- 不持久化 prompt、结果、凭据或 request ID；
- 不重试、resume 或重放任务；
- 不跨 MCP 进程做去重锁，因为 MCP extra 当前没有可依赖的跨进程稳定调用身份，
  强行加锁会误伤合法并发调用；
- 如果宿主在新 MCP 进程发起新请求，那是宿主的新调用，不能由旧进程伪装成同一
  请求成功。

## 6. 错误处理与安全边界

- 流关闭和显式取消走结构化 cancellation，不把连接错误正文写入结果；
- stdin error 可以进入脱敏诊断，但不包含环境值、prompt 或进程命令行；
- progress notification 失败本身不作为取消依据，因为它可能是瞬时发送错误；
  transport/session 关闭才是权威连接状态；
- `server.close()`、重复 end/close 和信号事件必须幂等；
- 进程回收只针对 adapter 已记录的 child PID 树，不按可执行文件名全机清理；
- 项目代码继续不读取或写入活动 `~/.codex/config.toml`，不修改用户 Kimi/Pi
  配置；
- App 插件更新仍采用官方 remove/add；当前桌面 App 需要完整重启才能加载新的
  MCP 版本。

## 7. 测试设计

实现使用 TDD，至少覆盖：

### 7.1 schema 与 deadline

- `timeoutMs` 缺失时通过；
- 大于 900,000 的安全整数通过；
- 小于 1000、非整数、非有限值和非安全整数拒绝；
- 分段 deadline 不提前触发，显式取消后不再触发；
- 没有显式 timeout 时 Kimi/Pi client 不创建 deadline；
- 显式 timeout 到期仍分别返回 `timed_out` 并清理 owned 进程。

### 7.2 adapter

- Kimi/Pi adapter 在 request 未提供 timeout 时，不向 client 注入默认值；
- 显式 timeout 原值透传，不再按 profile 裁剪；
- caller abort 仍分别返回 `cancelled`；
- 既有模型、provider、路由、凭据、权限和并发合同不漂移。

### 7.3 真实 stdio 生命周期

使用注入的 `PassThrough` 驱动真正的 `StdioServerTransport` 和 MCP 协议：

1. 建立会话并开始一个会等待 signal 的 fake service；
2. 关闭 stdin；
3. 断言 service 收到 aborted signal；
4. 让 fake service 完成 cancellation cleanup；
5. 断言 `serveMcp()` 只在 handler settle 后完成；
6. 重复 end/close 不触发第二次取消或未处理拒绝。

另用 fake Kimi/Pi 子进程验证 stdio 关闭最终使完整 owned 进程树归零。测试不得调用
真实模型，不得依赖活动 Codex 配置。

### 7.4 回归与发布门禁

- 聚焦测试；
- 类型检查；
- 单 worker 全量测试；
- build；
- `verify:capabilities`；
- release smoke；
- 隔离官方插件 lifecycle；
- 公共 npm 精确版本安装验收；
- 安装后的真实 App 工具发现、代表性 Kimi/Pi、隔离 delegate 和真正的取消门禁。

handoff 会迁移线程并可能重建 MCP，不再作为唯一取消成功证据。真实 App 门禁必须
使用普通 Stop/明确的 interrupt 原语；若当前 App 没有可自动调用的专用 interrupt，
这一项作为最小人工操作保留，不用 handoff 冒充。

## 8. 能力资格与发布影响

本设计改变：

- Kimi 和 Pi 的默认执行预算；
- Kimi/Pi client deadline 路径；
- MCP 请求取消与宿主断开语义；
- 所有公开 review/delegate 共用的任务承载边界。

因此八个 `logical LLM × task` 能力都受到实质影响，既有能力索引应按当前资格协议
变为 stale。不能通过排除这些源码、保留旧指纹或只切换 gate 开关来绕过重认证。

发布顺序固定为：

1. 完成设计、计划、TDD 和确定性验证；
2. 冻结 clean candidate，按 standing authorization 只运行受影响的八项能力；
3. 任一能力失败即按既有首错停协议收敛，不 retry、resume、fallback 或拼接旧
   evidence；
4. 八项重新具备当前指纹的 passed evidence 后，发布 `0.1.1-beta.2` 到 npm
   `next`；
5. 从公共 npm 隔离安装 beta.2，完成官方插件缓存和真实 App 宿主门禁；
6. 真正取消门禁、代表性 Kimi/Pi 与其它 release gate 全部通过后，才允许把
   `0.1.1` 发布到 npm `latest`。

Ark Coding Plan 当前周额度提示 2026-08-03 00:00 +0800 重置。额度属于运行
可用性，不撤销旧资格；但本次源码变化会使相关能力指纹 stale，所以新候选仍需在
额度可用后形成新 evidence。不得因为等待额度而发布带 stale 能力索引的 beta 或
stable。

## 9. 非目标

本设计不：

- 给外部 CLI 添加步数、轮数、token、上下文或工具调用上限；
- 修改 Pi 生产 auto retry、auto compaction 或 provider retry；
- 修改模型、provider、endpoint、凭据来源、网络路由或权限策略；
- 读取或修改活动 Codex 配置、用户 Pi/Kimi 配置或 Claude Code；
- 移除旧 `codex_cc_tools`；
- 为 handoff 重放增加跨进程去重协议；
- 重写或删除任何历史 evidence、manifest 或已发布 npm 版本。
