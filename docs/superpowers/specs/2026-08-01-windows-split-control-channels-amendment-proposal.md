# Windows split control channels 补充规格草案（历史、未采用）

日期：2026-08-01

状态：**已被替代，未获批准，禁止实施**

> 2026-08-01维护者随后明确取消三个Node版本的发布证明，并要求一并删除其它冗余。重新审计发现，只要正常完成/取消使用显式frame且活着的Node在terminal前绝不half-close fd3，单一全双工fd3即可满足合同；本机Pi也可由当前Node直接运行包内`dist/cli.js`，无需`.cmd`执行。因此本文的fd3+fd4、三Node矩阵和相关证明链均未被采用。现行权威是[Windows当前宿主最小可靠owned process设计](2026-08-01-windows-current-host-minimal-design.md)。下文只保留为历史设计证据，不得作为实现要求或待批准事项。

关联基线：

- [已批准的 Windows Job Object owned process 设计](2026-07-31-windows-job-object-owned-process-design.md)
- [已批准的 stdio 生命周期与外部 CLI 原生执行预算设计](2026-07-31-stdio-lifecycle-and-native-execution-budget-design.md)
- [单 fd3 write-half-close 硬门禁证据](../../research/windows-fd3-half-close-preflight.md)
- [现行 Windows 实施计划](../plans/2026-07-31-windows-job-object-owned-process.md)

## 1. 批准语义

本文只是一份供维护者判断的补充规格草案。维护者明确批准前：

- 不修改现有批准规格的权威状态；
- 不实现 fd3 + fd4，不重跑 Task 2，不开始 Task 3；
- 不调用真实模型，不修改活动 Codex 配置、活动插件或外部 CLI 全局配置；
- 不发布、不打 tag、不本地 `npm publish`；
- 不把本文视为 named pipe、PID、direct spawn 或其它 fallback 的授权。

如果维护者批准本文，本文只覆盖第 12 节列出的单 fd3 条款；原两份批准规格的其它条款继续有效。若维护者修改或拒绝本文，应先修订书面设计，不得按当前草案实现。

## 2. 请求批准的结论

采用两个独立、已连接并继承给同一个 helper 的 Node extra stdio channel：

- **fd 3：command channel**，生产代码只允许 Node 写、helper 读；
- **fd 4：event channel**，生产代码只允许 helper 写、Node 读。

这两个 channel 在 Windows 上由 Node/libuv 建立。libuv 内部实现会使用带内部唯一名称、单实例和 first-instance 标志的 Windows pipe，再把已连接的 child endpoint 经 CRT reserved data 传给 helper。因此本文不再声称“内核层不存在 named pipe”，而采用精确边界：

- 项目不创建、不暴露、不重连、不接受名称参数，也不管理可寻址的 named-pipe transport；
- 禁止 application-managed/reopenable named pipe 及其 fallback；
- libuv 内部、不可由产品重新打开的 extra stdio 实现属于受审计运行时前提。

同一用户会话中的 hostile process 不在当前威胁模型内。若未来要求抵抗同用户恶意进程抢连或窥探，Node 公共 `child_process` API 不能配置内部 pipe DACL，必须重新设计并重新批准，不能在本文方案上静默加层。

## 3. 为什么必须改变载体

真实 Node 20.20.2 + C# probe 已证明同一 `_get_osfhandle(3)` 的普通 CONFIG/ACK/READY/PING/PONG 双向通信成立，但 Node 对 `child.stdio[3]` 调用 `.end()` 后，Windows libuv 的 50 ms EOF timer 会关闭该 pipe 两端。helper 虽从 fd3 观察到 EOF并走到 terminal write/flush 成功的唯一 exit-0 路径，Node 仍收不到 terminal。

因此，单 handle 无法同时满足：

1. helper 必须从 Node write EOF 得知 `session_shutdown`；
2. Node 在 write-half-close 后仍必须机器确认 helper terminal。

把命令和事件拆到不同 channel 后，fd3 EOF不再关闭 fd4，能够保留 terminal 证据，而不降低清理或成功判据。

## 4. 拓扑与数据边界

```text
Codex / MCP Node process
  ├─ target stdin/stdout/stderr ownership ───────────────┐
  ├─ fd3 command: LAUNCH_CONFIG / TERMINATE ──────────┐  │
  └─ fd4 event: READY / ERROR / EXIT ◀──────────────┐ │  │
                                                    │ │  │
                                     fixed net48 x64 helper
                                      ├─ command reader fd3
                                      ├─ terminal writer fd4
                                      ├─ only inner Job handle owner
                                      └─ CreateProcessW + STARTUPINFOEX
                                                    │
                                  target inherits only duplicated 0/1/2
```

硬边界：

- helper command line仍只有已验证 helper path与固定 `--control-v1`；
- executable、cwd、kind、argv只在 fd3 `LAUNCH_CONFIG` frame中出现；
- prompt只走 target stdin，不进入 helper command line、fd3、fd4、环境或诊断；
- credential只在受控 child environment中存在，不进入 command line、frame、日志或证据；
- fd4只允许固定小型 `READY`、唯一 `ERROR` 或唯一 `EXIT`，不承载 progress、日志、模型正文或 raw system error，避免 backpressure成为清理依赖。

## 5. Canonical protocol 与方向

wire frame保持 v1：magic、header、message type数值、payload、strict UTF-8、长度上限、reason与stage全部不变。`protocol.v1.json` 增加机器冻结的 transport metadata，生成到 TypeScript和C# constants；canonical文件的精确key合同与生成摘要随实现更新，但 frame version不升级：

```json
{
  "transport": {
    "commandFd": 3,
    "eventFd": 4,
    "commandMessageTypes": ["launchConfig", "terminate"],
    "eventMessageTypes": ["ready", "error", "exit"]
  }
}
```

| Channel | 允许消息 | 禁止行为 |
| --- | --- | --- |
| fd3 Node → helper | 恰好一次 `LAUNCH_CONFIG`；其后零或多次输入中至多一个有效终止 disposition，协议层只允许 `TERMINATE` | helper生产逻辑不得写；Node不得读取；不得传 event frame |
| fd4 helper → Node | 恰好一次 `READY` 后唯一 terminal，或 pre-ready唯一 `ERROR` | Node生产逻辑不得写；helper不得读取；不得传 command frame |

Windows libuv endpoint本身可能仍具有 duplex OS权限；“单向”是必须由源码、IL、调用图和真实数据路径共同证明的产品合同，不能伪称反向系统调用必然被内核拒绝。错信道、未知类型、坏frame、重复terminal或terminal后尾随字节全部永久失败。

## 6. 生命周期与线性化

原规格的首个 gate winner、launcher唯一发布 create result、唯一 cleanup owner、READY publication barrier、禁止 `TERMINATING → RUNNING` 全部保留。

### 6.1 正常启动

1. Node在 spawn返回后立即安装 fd4 data/end/close/error与 helper close listener并持续drain；
2. Node通过 fd3写唯一完整 `LAUNCH_CONFIG`；
3. helper完成全部纯验证与 Job创建，进入 `CREATING`；
4. launcher用同一 `STARTUPINFOEX` 的 HANDLE_LIST与JOB_LIST原子创建 suspended target；
5. 若没有已锁存停止，launcher resume；
6. helper在 fd4完整写出并flush `READY`；Node只有完整解码后才完成 `ready`；
7. Job归零后，helper经 fd4写唯一 terminal并flush，关闭fd4、fd3、Job与其它handles，自然exit 0。

terminal只是一项候选成功证据；Node必须继续验证 fd4 decoder clean EOF、fd4 close、helper code 0、全部stdio settle和 `jobActiveProcessesZero=1`。

### 6.2 正常取消

- 活着的Node调用 `terminate(reason)` 时，只在 fd3串行写一次完整 `TERMINATE`；不得先 `end()`、`destroy()` fd3或关闭fd4；
- helper锁存首个reason并执行唯一Job cleanup；
- `RUNNING` 后对应 `EXIT(reason)`；pre-ready对应唯一 `ERROR(cancelled_before_ready, reason)`；
- Node继续从fd4确认terminal与完整关闭，不设总drain deadline。

### 6.3 fd3 EOF / Node write-half-close

- helper把真实 fd3 read=0线性化为 `session_shutdown`，但不据此推断Node已经死亡；
- pre-create阻止create；`CREATING`只锁存并等待launcher发布；post-create清Job；
- helper在Job归零后仍必须通过独立fd4尝试terminal；只有实际write/flush失败才允许没有terminal；
- 活着的Node测试性 `.end(fd3)` 后仍应从fd4收到terminal；生产正常取消仍优先显式 `TERMINATE`。

### 6.4 fd4故障

- 合法terminal前的 fd4 end、close-without-end、error、坏frame或错方向消息使调用永久失败；
- 若fd3仍可写，Node至多一次发送 `TERMINATE(protocol_error)`，只用于让helper清Job；后续合法terminal不能恢复业务成功；
- fd3也不可用或fd4已经使cleanup无法确认时，才可用spawn时保留的现有helper process handle强杀；禁止读取 `.pid` 后reopen；
- helper端任何fd4 write/flush失败都锁存 `control_channel_failed`，但finally仍必须关闭Job与fd3/fd4，不能让证据通道故障阻止 `KILL_ON_JOB_CLOSE`。

### 6.5 Node或helper崩溃

- Node崩溃会让两个父endpoint关闭，但helper存在两个合法竞态结果：先观察fd3 EOF并执行 `session_shutdown`，或先被Node/libuv父Job直接回收。两者都不得查父PID；前者清Job后仍尝试fd4，后者依靠helper最后inner Job handle关闭触发 `KILL_ON_JOB_CLOSE`；
- helper崩溃或被强杀时，最后一个inner Job handle关闭并触发 `KILL_ON_JOB_CLOSE`；Node因terminal缺失、fd4合同不完整或helper非零退出而失败；
- 不得依赖Node/libuv可能创建的全局Job作为inner target清理证据；真内核测试必须覆盖helper被父Job处理与先观察fd3 EOF两种竞态。

跨fd3、fd4、helper process的事件只规定必要偏序，不规定脆弱全序：完整terminal必须先于fd4 end/close；Node `ChildProcess` close发生在被监视stdio关闭后；fd3 close与fd4 terminal的相对观察顺序不作为合同。

## 7. CREATING竞态

`CREATING` 内的 `TERMINATE`、fd3 EOF、fd3协议错误或fd4故障只锁存首个disposition：

- control reader不得关Job、写terminal、resume、关闭process/thread handle或成为第二个create publisher；
- launcher仍是唯一的 create success/failure与handle ownership发布者；
- create failure：没有child，按已锁存disposition经fd4尽力发送pre-ready `ERROR`；
- create success：target已经原子在inner Job，若已锁存停止则绝不resume，交给唯一cleanup owner清Job；
- helper在 `CREATING` 中被强杀时，create failure没有child；create success的child已在Job，helper最后Job handle关闭使其归零，不存在未归属suspended target。

## 8. Handle与CRT继承合同

Node → helper阶段允许libuv通过CRT reserved data建立fd3/fd4。helper取得两个实际handle后必须：

1. `_get_osfhandle(3)` 与 `_get_osfhandle(4)` 都有效且代表不同对象；
2. 分别只包装为command read stream与event write stream；
3. 对两个精确handle清除 `HANDLE_FLAG_INHERIT`，不得做全局模糊清除；
4. 生命周期内只关闭自己拥有的handle一次。

helper → target阶段必须同时满足：

- `STARTUPINFOEX.StartupInfo.cbReserved2 = 0`；
- `STARTUPINFOEX.StartupInfo.lpReserved2 = NULL`，禁止传播helper CRT fd表；
- `STARTF_USESTDHANDLES`，`bInheritHandles=TRUE`；
- `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 恰好是为target复制且设为可继承的0/1/2；
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` 恰好是inner Job；
- fd3、fd4、Job、helper process/thread和其它handle均不可继承；
- challenge按对象身份而不是数值handle证明target只能访问0/1/2。

并发测试至少启动两个不同nonce的helper，证明不同invocation的fd3/fd4不串线。

## 9. Windows child environment闭包

安全审计确认：Node 20.20.2所带libuv会在调用者提供的env缺少时，从真实Node父环境自动补入以下11个required variable：

```text
HOMEDRIVE HOMEPATH LOGONSERVER PATH SYSTEMDRIVE SYSTEMROOT TEMP
USERDOMAIN USERNAME USERPROFILE WINDIR
```

权威源码见[required_vars定义](https://github.com/nodejs/node/blob/v20.20.2/deps/uv/src/win/process.c#L39-L58)与[缺失值补入路径](https://github.com/nodejs/node/blob/v20.20.2/deps/uv/src/win/process.c#L628-L776)。因此原规格“helper只收到request精确environment”必须增加闭包：

- `buildChildEnvironment` 在Windows对上述key做大小写无关、唯一canonical copy；
- 只要真实Node父环境存在某key，受控request environment就必须显式携带同一值；若缺失、大小写重复或漂移，在spawn helper前fail closed；
- 父环境本身不存在的key不伪造；
- helper继承的最终environment必须逐项等于已冻结request environment，禁止libuv隐式补入未声明值；
- poison parent + request sentinel测试必须覆盖11项，证明没有父值穿透；
- 这只是把Windows运行必需系统值显式化，不授权读取用户配置、扩大credential集合或把环境写入frame/diagnostics。

helper随后用直接 `CreateProcessW` 让target继承该精确环境；不得重新merge Node/MCP父环境。

## 10. Node支持边界

package的POSIX路径继续遵守现行Node合同。Windows native route只对Node major 20、22、24开放；其它major在helper spawn前以固定脱敏unsupported fail closed，doctor与公开文档必须说明。`package.json engines` 无法表达平台条件，可以保留 `>=20`，但不能把它描述成所有Node major都已取得Windows native证据。

发布阻断证据继续锁定精确 Node 20.20.2、22.23.2、24.18.1。exact preflight版本只约束native gate和CI证据，不是对Kimi、Pi或其它外部CLI施加执行预算，也不改变其step/turn/tool/context/token/duration/CPU/memory/process限制政策。

## 11. Replacement Task 2 preflight

批准后，先用TDD新增 replacement preflight，不得直接开始Task 3。

### 11.1 固定工具链

- `native:preflight`按20→22→24顺序使用Task 1锁定的三个官方Node zip与SHA；
- 一个锁定Roslyn/net48编译出的唯一 x64 C# probe字节供三版Node共同使用；
- probe source set只有一个语义源码，可加canonical protocol临时生成constants；
- 编译继续复用Task 1 exact compiler、references、flags、pathmap、独占GUID root和非递归清理；
- Node runner不得复制第二套编译实现；
- `native:preflight:current`无参数，在restore/compile/spawn前精确拒绝非三个锁定version，并通过公开入口运行同一单版本case集合。

### 11.2 必须由parent harness观察的动态事实

- C#实际调用 `_get_osfhandle(3/4)`，两个值有效且不同；除parent-sacrifice单例的测试专用observer write外，源码/IL只允许fd3 read、fd4 write，observer不得进入production carrier或其它case；
- 带随机nonce的CONFIG只经fd3，ACK/READY/terminal只经fd4；parent逐字节验证动态payload，不能信probe布尔自报；
- short reads、1-byte与不规则分片、merged frames、多轮序号/摘要；
- Node `.end(fd3)` 后，C#从真实read=0得EOF，Node仍从fd4解码动态terminal，再观察fd4 end/close与child close；不得用helper exit0推断terminal；
- helper写完动态terminal并关闭fd4后仍继续读取fd3 challenge，以动态exit code证明fd4关闭不破坏fd3；
- retained `ChildProcess` handle强杀helper后，两个pipe与child settle且无terminal，此形态只能计预期失败证据；
- parent-sacrifice使用三方测试握手，不能在只见READY后盲目牺牲：牺牲Node把测试专用observer输出handle继承给probe并关闭自己的副本，外层Node从启动前持续drain observer；probe成功绑定该handle后必须先无缓冲写入并flush nonce绑定的 `OBSERVER_ARMED`，再经fd4向牺牲Node报告carrier ready；牺牲Node把nonce绑定的carrier-ready报告转给外层后等待，只有外层完整验证两项证据才发送一次性 `SACRIFICE_NOW`，随后牺牲Node立即exit且不end/destroy fd3/fd4；
- observer写端必须由probe从 `OBSERVER_ARMED` 持有到进程终止，probe不得显式close/dispose或在退出前转交该handle；源码/IL必须验证该lifetime。armed后允许两种机器可区分的成功结果：probe先收到fd3 EOF时写出随机nonce派生cleanup proof后自然exit，由进程终止关闭observer，或probe先被Node/libuv父Job回收而observer在外层的parent-reclaim判定窗口内直接EOF、没有cleanup proof。外层从牺牲Node退出的monotonic时间起计算该仅测试probe的窗口；窗口到期而未出现合法cleanup-proof+EOF或无-cleanup-proof+EOF时必须先锁存primary failure；
- probe watchdog的最早触发点必须通过冻结常量严格晚于parent-reclaim窗口；它在 `_exit` 前以无缓冲写入并flush不可与 `OBSERVER_ARMED` / cleanup proof混淆、绑定随机nonce的 `WATCHDOG_FAILURE`。缺少或错误armed、在外层确认armed前牺牲、任何watchdog标记、窗口到期后才到达的EOF或窗口失败后的其它证据都无条件FAIL，cleanup不能恢复成功。因此成功EOF证明已经动态armed的carrier/probe不再持有写端，而不能由继承失败、提前close或watchdog清理伪造。observer只证明carrier/probe无孤儿，不以PID查找或清理；
- 两个并发helper以不同nonce证明无cross-talk；
- source/IL member/import allowlist与runtime poison证明probe不创建Job/target、不读环境/凭据、不产生后代或临时副作用，并验证observer bind → `OBSERVER_ARMED` flush → carrier ready → 持有至进程终止的结构顺序；唯一测试性例外是parent-sacrifice probe的局部watchdog可在完整写出 `WATCHDOG_FAILURE` 后调用固定CRT `_exit` 自行终止。它不得接收PID、不得终止其它进程，observer handle仍只由该进程终止关闭；parent harness必须把该标记与相关EOF保留为失败证据。

carrier probe不创建Job或target，因此不能证明真实descendant ownership。后续Windows kernel/integration测试必须另用启动前保留的测试process/pipe/file handles与随机nonce证明：牺牲Node退出后，无论helper先处理fd3 EOF还是先被父Job回收，inner target与descendants最终归零；这些handle只用于观察和精确测试teardown，不得按PID reopen或把补救清理计为PASS。

probe自报 `handlesDistinct=true`、`jobCreated=false`、`environmentRead=false`，固定ACK文本，source scan，helper exit0，当前系统Node版本字符串或cleanup成功都不能单独计PASS。

### 11.3 失败、清理与首错停

- 每个case可有仅测试probe的局部watchdog，绝不进入production或外部CLI配置；parent-sacrifice case必须先完成外层验证的 `OBSERVER_ARMED` + carrier-ready握手，再允许 `SACRIFICE_NOW`，并冻结、机器验证 `parent-reclaim判定窗口 < probe watchdog最早触发时间`，外层到期时先锁存primary failure。probe watchdog必须先无缓冲写入并flush nonce绑定的 `WATCHDOG_FAILURE`，再通过已审计的固定CRT `_exit` 终止自身，使observer随进程退出关闭；缺少armed、任何watchdog标记或到期后EOF均只能完成失败清理，不能冒充收敛或PASS；
- 失败后只用已保留process/stream handles清理该case，不按PID reopen或按名扫描；
- primary failure先锁存，cleanup failure只能作为secondary，不能再次掩盖原始错误；
- 只删除白名单已知文件与目录；未知项、reparse或ancestor漂移保留证据并fail；
- 每例后临时root、probe/Node handle和进程回到基线；
- 任一版本首个case失败后不运行其余case或后续版本，stdout为空，stderr仅一行固定enum脱敏报告；
- 三版全部通过后才一次性输出success；任一失败仍硬停，不进入Task 3、不自动更换载体。

## 12. 对原规格与计划的覆盖范围

批准后必须精确改写以下单fd3假设，不能只追加Task 2：

- Windows设计 §2、§3.1、§3.2、§4.1–4.3、§5.2、§6.2–6.4、§8.1、§8.4、§10.3、§11.1、§11.3、§11.4、§13.5、§15；
- Windows实施计划 architecture、Task 2，以及Task 5/8/12/13/14中所有fd3、stdio数组、handle隔离、package、CI与attestation条款；
- protocol canonical key合同、C# constants摘要、能力指纹、doctor与公开Windows支持文档。

原失败Task 2保持历史事实，不改写为passed。replacement preflight取得三版全绿后，才在计划中新增独立完成证据并恢复Task 3。

## 13. 保持不变的批准合同

- `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在target第一条用户代码前原子归属；
- target创建使用suspended +同一STARTUPINFOEX，禁止post-create assignment与breakaway；
- inner Job唯一limit仍只有 `KILL_ON_JOB_CLOSE`，不设置任何CPU、内存、时间、进程数或其它执行预算；
- helper是唯一Job handle owner；无PID reopen、WMI、taskkill、全机扫描或direct-spawn fallback；
- CREATING linearization、唯一launcher/cleanup owner、READY barrier、terminal/Job归零成功判据；
- frame格式、payload、strict UTF-8、命令行转义、凭据/诊断脱敏；
- POSIX process-group路径与stdio session shutdown；
- 不给Kimi、Pi或任何外部CLI设置默认或持久化step/turn/tool-call/context/token/duration/CPU/memory/process限制；
- Task 9前capability index/evidence保持stale fail closed；Tasks 1–14无真实模型、活动配置/插件修改或发布；
- 完成Task 14、Windows composite attestation和prequalification后，才恢复8/8、GitHub Actions OIDC beta、公共验收与stable。

## 14. 历史结论

本文曾请求维护者批准fd3 command + fd4 event、三Node矩阵与相关继承/环境证明，但该批准未发生。后续维护者的新要求和重新审计已选择更小的单fd3/native-only当前宿主方案。任何后续实现都必须使用现行覆盖规格，不得继续执行本节历史提案。
