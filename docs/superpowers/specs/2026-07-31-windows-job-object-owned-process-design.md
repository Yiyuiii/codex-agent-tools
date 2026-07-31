# Windows Job Object owned process 设计

状态：维护者已于 2026-07-31 批准方案 A、明确允许新增受控的 Windows 原生辅助层，
并已确认本文书面补充规格。本文是
`docs/superpowers/specs/2026-07-31-stdio-lifecycle-and-native-execution-budget-design.md`
的 Windows 进程归属补充规格；两份规格现已共同生效。本文只闭合
Windows owned process 生命周期，不改变公开 MCP 工具、逻辑 LLM、provider、模型、
凭据、提示词、资格协议或外部 CLI 的原生执行预算。

## 1. 背景、目标与非目标

### 1.1 已确认的问题

当前 Kimi/Pi client 在 Windows 上先由 Node 启动目标进程，结束时再按 PID 调用
`taskkill /T /F`。这个模型存在两个无法由事后补丁彻底消除的窗口：

1. 目标 root 在清理前退出时，后代可能已成为无法再从 root PID 可靠枚举的 orphan；
2. root PID 在清理前被系统复用时，按 PID 终止可能命中不属于本次 invocation 的进程。

这是一项发布前 P1 风险，不代表已经由真实事故证明为既往取消失败的唯一根因。
但 Task 9 会重新调用真实外部模型，所以必须先把 ownership 建立在内核对象上，而不是
继续依赖 PID 猜测。

### 1.2 目标

Windows 上每次 Kimi/Pi invocation 都必须：

- 在目标第一条用户代码运行前，把目标进程放进本次 invocation 独有的匿名 Job Object；
- 让目标自然产生的后代留在同一 Job 中，且不允许 breakaway；
- 在正常 root 退出、显式取消、stdio/session shutdown、控制通道 EOF 时，终止并等待
  Job 的 `ActiveProcesses` 归零后才结束 helper；
- 不再按 PID、WMI 快照或 `taskkill` 终止 Windows 生产 invocation；
- 保持 stdin/stdout/stderr 字节流、ACP/RPC 协议、调用级显式 `timeoutMs` 和 POSIX
  行为不变；
- 在 helper、配置、Job、creation attributes、spawn、resume、`.cmd` 转义、架构或 CLR 任一前置
  条件不成立时 fail closed，绝不直接启动外部 CLI 作为降级路径。

### 1.3 非目标

Job Object 是生命周期承载，不是安全沙箱。本轮明确不提供：

- 文件系统、注册表、网络、token、用户权限或命令授权隔离；
- CPU、内存、进程数、运行时长、步骤数、轮数、工具调用次数、上下文或 token 限额；
- 对经由 broker、WMI、服务、计划任务、其它用户会话或显式系统代理启动的非 Job
  进程进行全机追踪；
- 全机模糊进程扫描、按命令行批量清理或“宁可误杀”的补偿逻辑；
- ARM64、ia32 或早于 Windows 10 的 Windows 支持；
- 对 Kimi/Pi/Claude Code 用户全局配置的任何写入。

如果目标通过 Job 外部的系统 broker 启动进程，该进程不属于本机制能够证明的 owned
tree。测试或真实验收若发现这种逃逸，应保存脱敏证据并停止发布，回到设计判断；不得用
全机模糊清理把门禁伪装成通过。

## 2. 支持范围与前置条件

首版只声明以下组合受支持：

| 维度       | 支持范围                          | 失败语义                                 |
| ---------- | --------------------------------- | ---------------------------------------- |
| OS         | Windows 10、Windows 11            | 其它 Windows 版本不宣称支持              |
| 架构       | x64 Node + x64 helper             | `arm64`、`ia32` 在启动目标前 fail closed |
| CLR        | .NET Framework 4.8                | CLR 缺失或 helper 无法加载时 fail closed |
| Node       | 20、22、24                        | 每个版本都必须跑 Windows 真内核聚焦测试  |
| 非 Windows | 现有 POSIX detached process group | 本设计不改变其行为                       |

helper 是预编译的 .NET Framework 4.8 x64 C# PE。它通过 P/Invoke 使用 Win32 Job
Object 和 `CreateProcessW`。它不使用 Node/V8/libuv ABI，因此 Node 20/22/24 不需要
三份二进制；但 Node wrapper 与 fd 3 行为仍必须在三版 Node 上分别验证。

Windows 创建路径硬依赖 `PROC_THREAD_ATTRIBUTE_JOB_LIST`。Microsoft 将该属性定义为创建时
分配给 child 的 Job handle 列表，并明确支持 Windows 10+/Windows Server 2016+；这与本规格
只支持 Windows 10/11 的边界一致。属性不可用、初始化/更新失败或实际内核语义不符合本规格时
必须在 target 执行前 fail closed，不得退回创建后再归属的路径。

ARM64/ia32 以后只能通过新规格、对应二进制、真机 CI 和发布门禁晋级。首版 wrapper
必须显式检查 `process.arch === "x64"`，不得依靠 Windows 模拟层碰运气执行 x64 helper。

## 3. 总体架构

### 3.1 组件

系统分为三个边界清晰的组件：

1. **Node owned-process wrapper**
   - 选择 POSIX 旧路径或 Windows helper 路径；
   - 在 Windows 上启动 helper，并建立 fd 3 双向控制 pipe；
   - 对 Kimi/Pi client 暴露 stdin/stdout/stderr、`ready`、`closed` 和 `terminate()`；
   - 不暴露“按 PID 终止”的生产接口。
2. **C# Windows helper**
   - 严格解析有限长二进制配置；
   - 创建匿名 Job，并同时构造受控 stdio handle list 与唯一 Job list；
   - 通过 `CreateProcessW` 原子创建已归 inner Job 的 suspended target，再 resume；
   - 处理 normal root、`TERMINATE` 与控制 EOF，并等待 Job 归零。
3. **既有 Kimi/Pi clients**
   - 继续直接读写目标 stdin/stdout/stderr；
   - 继续先走协议级 cancel/abort，再在既有取消宽限后调用 `terminate()`；
   - 省略调用级 `timeoutMs` 时仍不创建模型执行 deadline。

### 3.2 数据流

```text
Node MCP/client
  ├─ fd 0/1/2 pipes ───────────────┐
  └─ fd 3 versioned control pipe ─┐ │
                                  ▼ ▼
                         C# x64 helper
                                  │
                                  ├─ anonymous, non-inheritable Job handle
                                  ├─ STARTUPINFOEXW
                                  │    ├─ HANDLE_LIST = duplicated fd 0/1/2 only
                                  │    └─ JOB_LIST = inner anonymous Job only
                                  ├─ CreateProcessW(CREATE_SUSPENDED)
                                  │    └─ success means target is already in inner Job
                                  ├─ ResumeThread
                                  └─ target inherits only duplicated fd 0/1/2 handles
                                             │
                                             └─ natural descendants stay in Job
```

helper 不代理、不解码也不改写目标 stdin/stdout/stderr。Node 为 helper 建立的 0/1/2
pipe 通过显式 handle allowlist 直接交给 target，因此 ACP/RPC 仍是字节透明流。控制消息只
走 fd 3，绝不混入模型协议或诊断 stderr。

### 3.3 每次 invocation 独立 ownership

每次调用都调用 `CreateJobObjectW(NULL, NULL)` 创建无名称 Job：

- 不创建、打开或复用命名 Job；
- Job handle 必须不可继承；
- 不在 invocation 之间共享 Job；
- 唯一持有者是该 invocation 的 helper；
- helper 正常关闭前主动 drain，helper 被强杀时由最后 Job handle 关闭触发
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。

匿名 Job 避免名称冲突、抢占、错误 reopen 和跨 invocation 权限面。测试必须能证明两个
并行 invocation 的 Job 相互独立，终止其中一个不会影响另一个。

## 4. Node wrapper 合同

### 4.1 概念接口

实现可按项目命名习惯调整标识符，但行为接口必须等价于：

```ts
interface OwnedAgentProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly ready: Promise<void>;
  readonly closed: Promise<OwnedProcessExit>;
  terminate(
    reason: "cancelled" | "timed_out" | "session_shutdown",
  ): Promise<void>;
}

interface SpawnOwnedAgentProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  invocationKind: "native" | "cmd";
}
```

Windows `terminate()` 的正常路径只向 fd 3 写 `TERMINATE` 并等待 helper 的 terminal frame
与 process close；不接收 target PID，也不调用 `taskkill`、WMI 或 `OpenProcess(pid)`。

wrapper 必须保留 Node 创建 helper 时得到的 `ChildProcess`/OS process handle。只有 fd 3
已经不可恢复地断裂、helper 启动本身失败或宿主正在强制销毁 helper，才允许通过这个**既有
handle** 强杀 helper，使最后一个 Job handle 关闭并触发 `KILL_ON_JOB_CLOSE`。这条兜底不得
按 helper PID 重新查找进程，不得被报告为正常 drain 成功，也不得掩盖 terminal frame 缺失；
相关调用仍返回固定脱敏失败。候选的正常取消与 Stop 证据必须来自 `TERMINATE →
ActiveProcesses=0 → EXIT`，不能只靠强杀兜底取得通过。

POSIX 继续使用现有 detached process group 和负 PGID 终止逻辑。抽象可以共享，但不得
借重构改变 POSIX 信号、grace 或测试合同。

### 4.2 helper 启动

Windows wrapper 必须：

1. 在创建任何外部 CLI 前验证平台、x64 架构、helper 文件、固定 SHA-256 和路径归属；
2. 用 `stdio: ["pipe", "pipe", "pipe", "pipe"]` 启动 helper；helper command line
   只能包含固定的 protocol/mode 标识，不能包含 target executable、cwd、args、prompt 或凭据；
3. 把本次 adapter 已构造的精确隔离环境传给 helper；
4. 通过 fd 3 发送唯一 `LAUNCH_CONFIG`；
5. 等待 `READY` 后才向上报告“process started”并开始 ACP/RPC 对话；
6. 把 helper 的 0/1/2 stream 原样提供给 client；
7. 要求恰好一个 terminal `EXIT` 或 `ERROR`，缺失、重复、乱序或尾随帧均视为失败。

控制配置不传环境字典。helper 自身继承 adapter 已构造的隔离环境，target 再继承 helper
环境，从而不复制或记录凭据值。prompt 只走 target stdin，也不进入控制帧或进程命令行。

正常 `terminate()` 在写完完整 `TERMINATE` frame 后**不得**对 fd 3 调用 `end()`、
`destroy()` 或只保留单向读取的替代操作。Node 必须维持完整 duplex，直到收到 terminal frame
并观察 helper close。只有 fd 3 已经不可恢复地不能写入/读取时，才进入 retained helper
handle 强杀兜底；该调用仍失败。

如果 Node 在解析 helper frame 时发现坏 magic/version/type/length、乱序、重复 terminal 或
其它协议异常，只要 fd 3 仍可写，就必须先发送幂等 `TERMINATE(protocol_error)`，等待 helper
执行 Job cleanup；解析异常本身已经使 invocation 永久失败，后续即使读到合法 `EXIT` 也不能
改判成功。只有 fd 3 已损坏到无法发出 `TERMINATE` 或无法再确认 terminal/close 时，Node 才
使用启动 helper 时保留的现有 process handle 强杀；不得按 PID reopen，也不得静默返回。

### 4.3 fd 3 的裁决

本设计采用 Node 额外 stdio fd 3，而不是命名 pipe。现有真实临时探针只证明：Node 创建的
第四个 pipe 可由编译后的 C# helper 通过 `_get_osfhandle(3)` **读取 Node 写入的数据**。
它尚未证明同一 HANDLE 上 C# → Node 的回写、Node 20/22/24 一致性、half-close 或 EOF
行为；不得把这项单向证据描述成“双向已验证”。

helper 必须把 fd 3 包装成严格的双向二进制流；其 OS handle 不得出现在 target 的
`PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 中。helper 退出时负责关闭 fd 3。Node 控制端
write-half-close、父进程崩溃或任意 pipe EOF 都触发 `session_shutdown` cleanup；但 **EOF
本身不证明父进程已经死亡**。helper 在 Job 归零后仍应尝试写 terminal frame，只有该写入
实际失败时才允许省略。

在实现正式 helper/state machine 前，必须先建立一个最小 C# fd3 probe，并在 Windows x64
Node 20、22、24 上分别机器证明：

1. Node → C# 发送完整 `CONFIG`；
2. C# 在同一个 `_get_osfhandle(3)` 对象上回写 `ACK`/`READY`，Node 精确收到；
3. 正常 full-duplex、Node write-half-close、helper write-half-close 与整进程强杀的 EOF/close
   顺序符合规格；
4. probe 没有创建 Job、target 或真实 CLI，也没有读取环境/凭据。

这是 implementation preflight 硬门禁。任一 Node 版本失败都必须回到本规格重新选择控制
载体，不能一边实现主逻辑一边假设 fd 3 可用，也不能自动退回命名 pipe。

## 5. 控制协议

### 5.1 通用 frame

控制协议 v1 使用小端二进制 frame。每帧固定 12 字节 header：

| 偏移 | 长度 | 字段          | 约束                        |
| ---- | ---: | ------------- | --------------------------- |
| 0    |    4 | magic         | ASCII `CAJ1`                |
| 4    |    2 | version       | unsigned LE，v1 固定为 `1`  |
| 6    |    2 | messageType   | unsigned LE，必须是已知枚举 |
| 8    |    4 | payloadLength | unsigned LE，不得超过 1 MiB |

读取必须精确处理 short read；不能假设一次 read 得到完整 header 或 payload。协议错误按
ownership 阶段分流：

- **pre-create**：在尚未进入 `CREATING` 时发现坏 magic、版本、类型、长度、UTF-8、字段
  计数或首帧错误，不创建 target；关闭已创建的空 Job（如处于 `JOB_READY`），发送
  `ERROR(protocol_invalid)` 后退出；
- **during `CREATING`**：只在状态机 gate 内锁存 `protocol_invalid` disposition；不得关闭 Job、
  写 terminal 或与 launcher 竞争 handles。`CreateProcessW` 返回失败时关闭空 Job并发送唯一
  `ERROR(protocol_invalid)`；返回成功时 target 已在 inner Job，先统一 Job cleanup 再发送该
  `ERROR`；
- **post-`CREATED_ASSIGNED` 或 post-`READY`**：必须先进入统一 `TERMINATING`、
  `TerminateJobObject` 并验证 `ActiveProcesses=0`，然后发送唯一
  `ERROR(protocol_invalid)`；这一条路径禁止再发送 `EXIT`。

一旦发现协议错误，invocation 永久失败。不能因为 cleanup 成功或后来出现可解析帧而恢复为
成功。

### 5.2 消息类型与顺序

| 方向          | 消息                | 语义                                                           |
| ------------- | ------------------- | -------------------------------------------------------------- |
| Node → helper | `LAUNCH_CONFIG = 1` | 必须是第一帧且恰好一次                                         |
| helper → Node | `READY = 2`         | target 已由 `JOB_LIST` 创建进 inner Job 且 `ResumeThread` 成功 |
| Node → helper | `TERMINATE = 3`     | 幂等请求结束本 Job                                             |
| helper → Node | `ERROR = 4`         | 启动或生命周期阶段失败，随后 helper 退出                       |
| helper → Node | `EXIT = 5`          | Job 已 `ActiveProcesses=0`，随后 helper 退出                   |

`READY` 前唯一允许的 terminal frame 是 `ERROR`。一旦 `ResumeThread` 成功，helper 必须先
串行写出 `READY`；即使 target 在 resume 后立即退出，也必须保持 `READY → EXIT` 的顺序。
如果即时退出路径同时发现协议或内核错误，则顺序为 `READY → ERROR`，并禁止 `EXIT`。
`ERROR` 和 `EXIT` 都是互斥 terminal frame。
`TERMINATE` 可以在配置后任意时刻到达。重复 `TERMINATE` 必须幂等；terminal frame 后的输入
不得重新启动 target。

### 5.3 `LAUNCH_CONFIG` payload

payload 使用以下顺序，每个字符串都是 `uint32 byteLength + strict UTF-8 bytes`：

1. `uint8 invocationKind`：`1 = native`，`2 = cmd`；
2. `executable`；
3. `cwd`；
4. `uint32 argc`；
5. `argc` 个 argument 字符串。

附加约束：

- `argc <= 1024`；
- 单个字符串 UTF-8 不超过 64 KiB；
- payload 总长不超过 1 MiB；
- NUL、非法 UTF-8、空 executable、非绝对 executable/cwd、未知 kind 一律拒绝；
- 生成后的 Windows UTF-16 command line 必须满足 Win32 长度约束；
- payload 不得出现 prompt、credential、环境变量值、session 内容或模型输出。

`TERMINATE` payload 只有一个原因枚举：cancelled、timed_out、session_shutdown、
protocol_error。该枚举只解释已经发生的停止事件，不创建 deadline；`protocol_error` 永远
导致 terminal `ERROR`，不能导致成功 `EXIT`。

`ERROR` 只返回固定 stage code 和可选 Win32 数字错误码。公开诊断必须映射为固定脱敏文本，
不得包含 executable、cwd、args、环境或原始系统错误字符串。

`EXIT` 返回 target root exit code、结束原因和 `jobActiveProcesses = 0` 的已验证标志。
Node 不得仅凭 helper process exit code把缺失 `EXIT` 当作成功。

## 6. Win32 创建、归属与句柄边界

### 6.1 Job 设置

helper 按以下顺序创建和配置 Job：

1. `CreateJobObjectW(NULL, NULL)`；
2. 使用 `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` 调用
   `SetInformationJobObject(JobObjectExtendedLimitInformation)`；
3. `LimitFlags` **只**包含 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。

禁止设置：

- `JOB_OBJECT_LIMIT_JOB_TIME`、`PROCESS_TIME`、CPU rate；
- process/job memory；
- `ACTIVE_PROCESS`；
- priority、working set 或 affinity；
- `BREAKAWAY_OK`、`SILENT_BREAKAWAY_OK`；
- UI/security 限制或其它执行能力限制。

测试必须查询 Job extended limits，证明唯一设置的 limit bit 是
`KILL_ON_JOB_CLOSE`。

### 6.2 stdio handle allowlist

helper 对其 fd 0/1/2 对应 OS handles 分别执行受控 `DuplicateHandle`，得到明确可继承的
副本。随后构造 `STARTUPINFOEXW`：

- `STARTF_USESTDHANDLES` 指向三个副本；
- attribute list 容量固定为两项；
- `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 精确列出这三个可继承副本，`cbSize` 恰好为
  `3 * sizeof(HANDLE)`；
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` 精确列出唯一 inner anonymous Job handle，`cbSize` 恰好为
  `sizeof(HANDLE)`；
- `bInheritHandles = TRUE`；
- creation flags 包含 `EXTENDED_STARTUPINFO_PRESENT`；
- fd 3、Job handle、helper process/thread handle、控制状态和其它打开 handle 都不在
  `HANDLE_LIST`。

两个 attribute 的 value buffers 必须保持有效直到 `CreateProcessW` 返回并销毁 attribute
list。Job handle 本身继续保持不可继承；它出现在 `JOB_LIST` 只表示“创建时把 child 归入该
Job”，不表示把这个 handle 继承给 child。`InitializeProcThreadAttributeList`、任一次
`UpdateProcThreadAttribute`（包括 `HANDLE_LIST` 与 `JOB_LIST`）或 value size/count 检查失败
都必须在 target 创建前关闭临时 handles/Job 并 fail closed。

`CreateProcessW` 返回后 helper 立即关闭自己的三个临时 duplicated handles；target 持有其
继承副本。Job handle 从创建开始到统一 cleanup 完成始终只由 helper 持有。

禁止仅依赖“默认不可继承”或全局 `SetHandleInformation` 猜测。目标测试程序必须证明它可
用 0/1/2 完成双向大流量传输，同时无法访问 fd 3 或 helper Job handle；Job membership 与
Job handle inheritance 必须分别取证，不能把“target 在 Job 中”误当成“target 继承了 Job
handle”。

### 6.3 `JOB_LIST` create → resume

target 启动顺序是硬合同：

1. 构造已验证的 application path 和可写 UTF-16 command line buffer；
2. 完成匿名 Job、两项 `STARTUPINFOEXW` attributes 与全部 value buffer 验证；
3. launcher 在状态机 gate 内提交 `CREATING`，随后释放 gate并调用不可中断的
   `CreateProcessW`；creation flags 至少包含：
   - `CREATE_SUSPENDED`；
   - `CREATE_NO_WINDOW`；
   - `EXTENDED_STARTUPINFO_PRESENT`；
4. `CreateProcessW` 失败意味着没有 target；launcher 回到 gate 内原子发布失败，选择已锁定
   disposition 或 `create_failed`，关闭 attribute/stdio 临时 handles与空 Job，然后发送唯一
   `ERROR`；
5. `CreateProcessW` 成功意味着 suspended target 已经属于唯一 inner Job；launcher 回到
   gate 内一次性发布 process/thread handles 和 `CREATED_ASSIGNED`；
6. 若 gate 中已有 pending stop，launcher 在同一临界区提交 `TERMINATING` 并成为唯一
   cleanup owner，绝不 resume；否则它取得 resume publication 权；
7. 调用 `ResumeThread(primaryThread)`；成功后提交 `RUNNING` 并发送 `READY`，失败则统一
   Job cleanup 后发送精确 stage 的 `ERROR`。

`READY` 的写入必须与 target process handle 的完成观察串行化，保证 target 即时退出时仍
先发送 READY，再进入 normal-root cleanup 并发送 EXIT。控制 reader 必须在配置解析后并发
监视 `TERMINATE`/EOF/协议错误。它们在 `CONFIGURED`/`JOB_READY` 可以阻止 create；在
`CREATING` 只能由 gate 锁存 exact pending disposition，不能关闭 Job、写 terminal 或访问
尚未发布的 handles。`CreateProcessW` 返回后由 launcher 唯一发布结果并完成对应 success/
failure 分支，控制线程不得与其争夺 cleanup。

pending disposition 由第一个赢得 gate 的事件固定：`TERMINATE(cancelled|timed_out|
session_shutdown)` 或 EOF 对应 `cancelled_before_ready`（并保留精确 requested reason），
`TERMINATE(protocol_error)` 或 helper 自己检测到的协议错误对应 `protocol_invalid`。
若 create 同时失败，pending disposition 优先于 `create_failed`；没有 pending stop 时才报告
`create_failed`。这保证 success/failure × terminate/EOF/protocol_error 的交错都只有一个可
预测 terminal。

`lpApplicationName` 必须传验证后的绝对路径，不能留空让 Win32 从 command line 猜可执行
文件。生产 helper 禁止调用 `AssignProcessToJobObject` 或 `TerminateProcess`；不存在任何
creation 返回后再补 membership 的 cleanup 阶段、PID reopen 或事后补归属路径。

任一阶段失败：

- `CreateProcessW` 前失败：没有 target，关闭临时 handles/Job 后发送 `ERROR`；
- `CreateProcessW` 返回失败：按 Win32 合同没有 target，launcher 关闭临时 handles/空 Job 后
  发送唯一 `ERROR`；
- `CreateProcessW` 返回成功：target 已在 Job；任何取消、协议、resume 或后续内核失败都只走
  `TerminateJobObject`/Job handle close 路径；
- 绝不 resume 一个控制端已锁存停止的 target；
- 绝不回退到 direct spawn、`taskkill` 或 PID ledger。

外层 Codex App 可能已把 helper 放在宿主 Job 中。Windows 10/11 支持 nested jobs，但实际
宿主限制仍可能让 `JOB_LIST` process creation 失败。此时本调用 fail closed；不得加入
`CREATE_BREAKAWAY_FROM_JOB` 绕过宿主。公开 beta 的完整 App 重启/Stop 门禁必须验证真实
宿主下创建时 nested Job membership 成功。

### 6.4 create/resume/terminate 线性化状态机

control reader、launcher、target process waiter 和 terminal writer 不得靠多个松散 boolean
协作。它们共享一个 mutex 或具有等价证明的单一 CAS state word，至少包含：

```text
CONFIGURED → JOB_READY → CREATING → CREATED_ASSIGNED → RUNNING
CONFIGURED ───────────────→ TERMINATING → TERMINATED → TERMINAL
JOB_READY ────────────────→ TERMINATING
CREATING -- CreateProcessW failure --> TERMINAL(ERROR)
CREATING -- success + pending stop --> CREATED_ASSIGNED → TERMINATING
CREATED_ASSIGNED ─────────────────────────────────────→ TERMINATING
RUNNING ──────────────────────────────────────────────→ TERMINATING
```

硬性线性化规则：

- `TERMINATE`/EOF/协议错误在 `CONFIGURED` 或 `JOB_READY` 赢得 gate 时阻止 create；没有
  target，winner 成为 cleanup owner，关闭空 Job（如已创建）并写唯一 terminal；
- launcher 在 gate 内提交 `CREATING` 后释放 gate再调用 `CreateProcessW`。此调用期间到达的
  stop 只固定 pending disposition；任何线程都不得关闭 Job、写 terminal、假造 handles 或
  把状态移出 `CREATING`；
- `CreateProcessW` 返回后，只有 launcher 可以在 gate 内原子发布 failure，或同时发布
  process/thread handles 与 `CREATED_ASSIGNED`。成功分支在可见时 target 已属于 inner Job；
- create 失败时 launcher 是唯一 cleanup owner；有 pending disposition则发送该精确
  `ERROR`，否则发送 `ERROR(create_failed)`。create 成功且有 pending stop 时，launcher 在
  同一 gate 内把 `CREATED_ASSIGNED` 提交为 `TERMINATING` 并成为唯一 Job cleanup owner；
- `TERMINATE`/EOF/协议错误若先把 `CREATED_ASSIGNED` 提交为 `TERMINATING`，launcher 后续
  绝不调用 `ResumeThread`；
- launcher 若先在 gate 内取得 resume 权、`ResumeThread` 成功并把状态提交为 `RUNNING`，
  随后到达的 terminate 必须立即把 `RUNNING` CAS 为 `TERMINATING` 并调用
  `TerminateJobObject`；
- resume 失败直接进入错误 cleanup，不能短暂发布 `RUNNING`；
- cleanup ownership 是 state transition 的一部分：只有提交 `TERMINATING` 的线程，或在
  create failure 分支发布 terminal 的 launcher，能够清理 handles、Job 和写 terminal；重复
  terminate、root signal、EOF 或 protocol error只等待同一 completion；
- 不允许出现 `TERMINATING → RUNNING`、第二次 resume 或第二个 terminal frame。

`READY` publication 也是这台状态机的一部分。resume 成功者在提交 `RUNNING` 时同时建立
`readyPublication` barrier；terminal writer 无论收到即时 root exit、terminate 还是错误，
都必须先等待该 barrier：成功运行路径输出 `READY → EXIT`，运行后错误路径输出
`READY → ERROR`。terminate 可以在 READY 写出期间立即开始 Job cleanup，不必等 target
继续运行，但 terminal frame 不能越过 READY。

必须用可重复 barrier 测试分别把线程停在 `CONFIGURED`、`JOB_READY`、`CREATING`（真实
`CreateProcessW` 返回前）以及 `CREATED_ASSIGNED`/resume 前和 resume 后/READY 前。让
terminate、EOF、protocol error 与 create/resume 竞争数千次，机器证明：

1. 在 `CONFIGURED`/`JOB_READY` 赢：不创建 target；关闭空 Job（如已创建），target marker
   永不存在、无 `READY`、无 suspended 残留；terminate/EOF 的唯一逻辑终态为
   `ERROR(cancelled_before_ready)`，protocol error 的唯一逻辑终态为
   `ERROR(protocol_invalid)`，两者都禁止 `EXIT`；
2. 在 `CREATING` 锁存：在 create 返回前不关闭 Job、不写 terminal；create 失败分支没有
   child并关闭空 Job，create 成功分支的 suspended target 已在 Job且由
   `TerminateJobObject` 清零。两支都无 marker、无 `READY`、无残留，并按锁存事件只发一个
   `ERROR(cancelled_before_ready)` 或 `ERROR(protocol_invalid)`；
3. 在 `CREATED_ASSIGNED` 赢：绝不 resume；target marker 永不存在、无 `READY`，Job 归零后
   按事件只发一个 `ERROR(cancelled_before_ready)` 或 `ERROR(protocol_invalid)`；
4. resume 先赢且随后发生无故障正常 terminate：必须严格为恰好一次
   `READY → EXIT`；`EXIT` 必须精确携带请求的 reason，并断言
   `jobActiveProcesses = 0`。该竞态不得接受 `ERROR`；`ERROR` 只属于独立的协议错误或故障
   注入用例，且必须精确断言对应 stage。

矩阵必须完整交叉 `CreateProcessW` success/failure 与 terminate/EOF/protocol_error，并断言
每格的唯一 cleanup owner、terminal disposition 和句柄关闭顺序。概率性 sleep 测试不足以
证明这条线性化合同。

### 6.5 外层 Job 兼容性

Windows 真内核测试必须把 helper 自身放进人工构造的 outer Job：

- **compatible outer Job**：带唯一 inner Job 的 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 创建成功；
  suspended target 在 `CreateProcessW` 返回时已经同时属于 inner/outer nested Jobs，terminate
  后 inner `ActiveProcesses=0`，outer 中的 peer process 保持存活；
- **incompatible UI-limit outer Job**：构造会使创建时 nested membership 被 Win32 拒绝的
  UI-limit 条件；`CreateProcessW` 必须 fail closed且不产生 child/process handles，target
  marker 不出现，同一 outer Job 的 peer process 不受影响；
- 两种路径都静态和动态证明没有 `CREATE_BREAKAWAY_FROM_JOB`、`BREAKAWAY_OK` 或
  `SILENT_BREAKAWAY_OK`。

测试不能为了制造成功而把 helper 从 outer Job 中 break away，也不能在失败后终止整个 outer
Job，因为那会掩盖本 invocation 的 ownership 边界。如果受支持的真实 Windows 10/11 x64
内核没有表现出上述“兼容时创建成功并已入 Job、不兼容时 CreateProcessW 失败且无 child”
语义，native gate 必须失败并回到设计评审，不能增加 post-create 修补路径。

## 7. `.cmd` / `.bat` 兼容与注入边界

### 7.1 invocation 分类

Node 根据已解析绝对 executable 的扩展名生成 `invocationKind`：

- `.cmd`、`.bat`（不区分大小写）必须是 `cmd`；
- 其它受支持 PE executable 必须是 `native`。

helper 独立复核 kind 与扩展名。kind/扩展不一致、未知扩展或可执行路径不满足前置条件时，
在 `CreateProcessW` 前 fail closed。

### 7.2 可信 shell

`cmd` invocation 不信任继承的 `COMSPEC`。helper 使用 `GetSystemDirectoryW` 得到系统目录，
固定选择其中的 `cmd.exe`，并以该绝对路径作为 `lpApplicationName`。固定参数前缀为：

```text
/d /s /v:off /c
```

- `/d` 禁止 AutoRun；
- `/s` 固定 `/c` 引号处理；
- `/v:off` 禁止 delayed expansion；
- prompt 和 credential 永远不进入 command line。

### 7.3 经审计转义

`.cmd` command string 必须采用一份独立、可单测、来源记录清楚的 Windows argv + cmd
双层转义实现。不得用 `args.join(" ")`、只包双引号或临时正则拼接。

算法必须正确处理：

- 空参数、空格和尾随反斜杠；
- 双引号及其前导反斜杠；
- `& | < > ^ ( ) % !`；
- Unicode、路径中的空格和 cmd metacharacter；
- npm shim 的额外解析层；
- 类似 `node_modules/.bin/*.cmd` 的 double-escape 情况。

集成测试中的 `.cmd` 只能做固定、最小转发：它把参数转交给仓库构建的原生 x64
`argv-recorder.exe`。recorder 以二进制长度前缀格式输出每个 UTF-16 argument，测试以该输出
作为 `.cmd` 最终收到并转发的**用户 arguments** oracle；它不能观察、也不得被用于证明
`cmd.exe` 自己的 argv0。禁止使用 batch `echo`、`set` 或解析后的文本充当 argv oracle，
因为 cmd 自身会二次展开和改写它们。另加入会创建哨兵文件的注入字符串；只有 recorder
记录的用户 arguments 精确且哨兵不存在才算通过。任何无法无歧义表示的 argument 都必须
fail closed，不能删除字符或改变用户参数来“尽量运行”。

### 7.4 `cmd.exe` 独立长度门禁

Win32 native command line 上限与 `cmd.exe` 的 8191 字符上限是两条独立门禁。对于 `cmd`
invocation，helper 必须先构造**最终完整、可写的 UTF-16 command line buffer**，再按 UTF-16
code unit 计数。计数必须包括：

- 正确的、已加引号的 System32 `cmd.exe` argv0；
- `/d /s /v:off /c` 及全部分隔；
- `.cmd` path、所有转义/双重转义后的 arguments 和外层 `/s /c` quoting；
- 终止 NUL。

总数 `<= 8191` 才允许调用 `CreateProcessW`，`>= 8192` 必须在 target 创建前 fail closed。
原生 PE invocation 仍按其独立 Win32 上限检查，不能复用 8191 规则。

边界测试必须通过自动填充参数得到最终总长恰好 8190、8191、8192 三种 command line：前两者
允许创建，8192 在 target 创建前明确拒绝且 marker 不存在；`argv-recorder.exe` 只证明前两者
的 `.cmd` 最终收到并转发了精确用户 arguments。

`cmd.exe` application/argv0 另由两层证据证明，不能让 recorder 越权充当 oracle：

1. C# 纯函数/golden test 对最终可写 command-line buffer 做字节/UTF-16 code-unit 级断言：
   首 token 必须是加引号的可信 System32 `cmd.exe` 绝对路径，其后依次才是
   `/d /s /v:off /c`、`.cmd` command string；长度计算覆盖这个完整 buffer 和终止 NUL；
2. Windows 真内核测试在 target 仍 suspended 时用 `QueryFullProcessImageNameW` 查询实际
   image，必须与传给 `lpApplicationName`、也与 golden 首 token 所表示的同一规范化
   System32 `cmd.exe` 路径精确一致。

## 8. 终止、drain 与错误语义

### 8.1 三类正常停止/完成入口

以下事件进入同一幂等 lifecycle state machine：

1. target root process handle 正常 signaled；
2. fd 3 收到 `TERMINATE`；
3. fd 3 EOF、broken pipe 或 Node 父进程消失。

入口先按 6.4 的当前状态裁决：`CONFIGURED`/`JOB_READY` 没有 target，直接关闭空 Job并写
pre-ready `ERROR`；`CREATING` 只锁存并等待 launcher 发布 create 结果；create failure 由
launcher 关闭空 Job并写 `ERROR`。只有 `CreateProcessW` 成功、target 已由 `JOB_LIST` 归入
inner Job 后，唯一 cleanup owner 才执行以下 Job cleanup：

1. 由唯一赢得 `TERMINATING` 的调用者至多一次调用 `TerminateJobObject`，并检查其 BOOL
   返回值；
2. 每次调用 `QueryInformationJobObject(JobObjectBasicAccountingInformation)` 都检查返回
   值和返回结构长度，不读取失败后的 buffer；
3. 在成功查询之间使用 completion notification 或低频等待节流，再重新查询；禁止 tight
   loop/busy polling，也不设置总执行截止；
4. 只有成功观察到 `ActiveProcesses === 0`，才提交 `TERMINATED`；
5. 关闭 target process/thread handles；
6. 根据已锁定的 terminal disposition 发送唯一 `EXIT` 或 `ERROR`；
7. 关闭 Job 与 fd 3；
8. helper 自然退出。

root 正常退出也必须终止 Job 中仍活跃的后代，不能因为 root exit code 为 0 就提前返回。
`EXIT` 发送前 Job 必须已经归零。

`TerminateJobObject` 返回 FALSE，或任一次 `QueryInformationJobObject` 返回 FALSE/结构不
完整时，helper **禁止发送 EXIT**。它必须锁定失败 disposition，尽力发送固定脱敏 `ERROR`，
随后关闭最后一个 Job handle 触发 `KILL_ON_CLOSE` 并以失败退出；不能声称已验证
`ActiveProcesses=0`。即使 `ERROR` 写入失败，helper 也必须关闭 Job。Node 观察到缺失 terminal
时继续按失败处理并使用 retained helper handle确认 helper close；不得重试为成功。

fd 3 read EOF 只表示 Node → helper 写方向已经关闭，不证明 Node 进程死亡，也不证明
helper → Node 写方向不可用。helper 仍必须完成 Job drain并尝试发送 terminal frame；只有
实际写失败才省略。活着的 Node wrapper 发起正常取消时不得先 end/destroy fd 3，而应发送
TERMINATE 并保持完整 duplex 到 terminal/close。

故障注入测试必须让 `TerminateJobObject`、首次 Query、中途 Query 和归零确认 Query 分别
返回失败，逐项证明：无 EXIT、尽力 ERROR、最后 Job handle关闭、target/后代最终被
KILL_ON_CLOSE 清除、调用方固定失败且 unrelated peer不受影响。

### 8.2 helper 被强杀

如果 helper 因宿主强杀、崩溃或不可恢复 CLR 终止而不能运行上述 state machine，helper
持有的最后一个 Job handle 会被 OS 关闭，`KILL_ON_JOB_CLOSE` 负责终止 Job members。
这是内核兜底，不是常规 Node 终止 API。

生产 Node cleanup 不设置“等 N 秒后按 PID taskkill”的 fallback。测试必须单独强杀 helper，
证明 target root 已退出与仍存后代两种情况下 Job 都最终归零。

### 8.3 无默认执行预算

本设计不增加任何新的调用 deadline、watchdog、Job time limit 或默认 timeout：

- 调用方省略 `timeoutMs`：外部 CLI 可按原生预算运行；
- 调用方显式给出合法 `timeoutMs`：既有调用级 deadline 触发 `TERMINATE(timed_out)`；
- stdio/session shutdown：触发 `TERMINATE(session_shutdown)`；
- Kimi/Pi 协议 cancel 后的已有短暂 grace 只发生在停止已经被请求之后，不是模型预算；
- Job `ActiveProcesses=0` drain 不使用时间上限。

不得把测试夹具 timeout、CI job timeout 或清理探针上限写成产品默认值。

### 8.4 fail-closed 矩阵

以下任一情况都使当前调用失败，且不得直接执行 target：

- helper 缺失、hash 不符、无法启动或 CLR 失败；
- 非 x64 Windows、未知 invocation kind；
- fd 3 建立失败、协议/版本/长度/UTF-8/config 不合法；
- Job 创建或 `SetInformationJobObject` 失败；
- stdio handle duplicate、attribute list 初始化、`HANDLE_LIST` 更新或 `JOB_LIST` 更新失败；
- application/cwd/command line 验证失败；
- `.cmd` 分类或转义拒绝；
- `CreateProcessW` 或 resume 失败；
- `TerminateJobObject` 或任一次 `QueryInformationJobObject` 失败；
- helper 未发送 READY、terminal frame 缺失或 Job 未证明归零。

生产 source/IL metadata 必须有静态负向门禁：不得引用 `AssignProcessToJobObject`、
`TerminateProcess`、`taskkill`、WMI process termination 或按 PID `OpenProcess` 的 target cleanup
路径。该门禁与真内核无 child/无 marker 测试同时成立，防止以后重新引入 post-create 修补。

公开结果只返回固定脱敏类别。内部测试可以断言 stage code 和 Win32 数字错误码，但不得保存
路径、argument、环境值、prompt 或模型正文。

## 9. 打包、定位与供应链

### 9.1 单一运行时二进制

仓库中的 canonical 预编译产物放在插件内：

```text
plugins/codex-external-agents/native/win32-x64/
  codex-agent-job-helper.exe
  codex-agent-job-helper.exe.sha256
```

`package.json.files` 还必须显式包含 `native/windows-job-helper/`，使 npm 使用者和 release
smoke 能审计 helper source、固定构建配置与 toolchain manifest；这些 source 文件不属于
插件运行时精确六项，但属于 npm 包的必需供应链材料。

两条 MCP 启动面定位同一份文件：

- 插件 bundle 从自身 `runtime/` 目录向上解析到 `../native/win32-x64/...`；
- npm `dist/mcp.js` 从 package root 解析到
  `plugins/codex-external-agents/native/win32-x64/...`。

npm package 中不得复制第二份 helper。官方插件缓存复制整个 plugin 目录，因此缓存内仍只有
该插件自己的同一份 native artifact。路径解析必须以 `import.meta.url` 和受验证的 package/
plugin root 为基准，不依赖进程当前工作目录，也不接受环境变量覆盖 helper 路径。

### 9.2 入库来源

以下内容必须一同入库并接受审阅：

```text
native/windows-job-helper/
  JobHelper.cs
  deterministic-build configuration
  toolchain lock/manifest
plugins/codex-external-agents/native/win32-x64/
  codex-agent-job-helper.exe
  codex-agent-job-helper.exe.sha256
```

SHA 文件使用固定小写十六进制格式并精确指向 exe。二进制不可手工修改；任何 source、
build config、toolchain 或 exe 改动都必须一起更新并重跑完整门禁。

固定构建必须至少锁定：

- .NET Framework 4.8 reference assemblies；
- C# compiler/toolset 的精确版本和来源；
- x64、Release、optimization、deterministic、无 debug/PDB 注入的编译参数；
- 不含本机绝对路径、wall-clock timestamp 或 post-build mutation；
- 输入文件排序、locale 和换行规范。

### 9.3 deterministic rebuild 是硬门禁

Windows CI 必须从 clean checkout 的 source + fixed config 重新构建 helper，并对预编译 exe
做 byte-for-byte comparison；随后复核 SHA 文件。语义相似、PE metadata 相似或只比较源哈希
都不能替代 byte comparison。

如果固定工具链仍不能产生相同字节：

1. Task 9 不得开始；
2. beta.2 不得发布；
3. 不得忽略易变 PE 区域、放宽到“功能相同”或跳过 Windows gate；
4. 必须回到本规格重新决定工具链、产物模式或语言实现，并取得新的设计确认。

### 9.4 npm exact file set

release smoke 和 artifact 测试必须把插件精确文件集更新为：

```text
.agents/plugins/marketplace.json
plugins/codex-external-agents/.codex-plugin/plugin.json
plugins/codex-external-agents/.mcp.json
plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs
plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe
plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256
```

package gate 必须：

- 从实际 `npm pack --dry-run --json` 清单确认六项恰好存在；
- 证明 package 中只有一份 helper exe；
- 比较实际 exe SHA 与 `.sha256`；
- 不把二进制当 UTF-8 文本扫描；
- 继续对 source、build config、SHA、bundle、文档执行 secret、绝对开发路径和链接闭包检查；
- 更新隔离插件测试，使其复制整个 plugin artifact，而不是只复制 `.mjs`；
- 保持 capability verifier 在 pack 与联网 npm 名称检查之前执行。

规格与计划中的仓库路径一律使用 `<isolated-worktree>`；npm 包不得包含开发机绝对路径。

### 9.5 固定 `--probe-v1` 合同

checked-in production helper 必须提供只读启动探针：

```text
codex-agent-job-helper.exe --probe-v1
```

该模式是独立入口，不使用 fd 3，不创建 Job、target、控制 pipe、临时文件或 helper 自有的
工作线程，不枚举
进程，也不读取环境变量、用户目录、配置、credential 或任何 secret-like value。其全部可见
合同固定为：

- stdout 恰好一个 UTF-8/LF 行：`codex-agent-job-helper probe-v1 ok\n`；
- stderr 恰好为空；
- exit code 恰好为 `0`；
- 不因继承环境内容不同而改变输出。

strict doctor 必须先从 MCP 生产代码使用的同一 canonical resolver 定位 helper，读取实际 exe
字节并验证实际 SHA，再以 `--probe-v1` 启动该精确文件；不能调用 PATH 上同名程序、复制品或
测试 helper。strict doctor 对 stdout/stderr/exit 做字节级精确比较，任一偏差 fail closed，且
不得自动建议 direct spawn。

`--probe-v1`、实际 SHA、x64/CLR 检查和 canonical path 是 Task 9 前 clean candidate 的硬
门禁；普通 human-readable doctor 可以提供脱敏解释，但严格机器结果不得使用宽松 substring。

## 10. CI 与发布工作流

### 10.1 PR/分支 CI

现有 Ubuntu Node 20/22/24 全量矩阵继续保留。另增阻断性的 Windows x64 native matrix：

| Runner      | Node | 必须执行                                                          |
| ----------- | ---- | ----------------------------------------------------------------- |
| Windows x64 | 20   | deterministic rebuild、byte compare、真内核聚焦测试               |
| Windows x64 | 22   | deterministic rebuild、byte compare、真内核聚焦测试               |
| Windows x64 | 24   | deterministic rebuild、byte compare、真内核聚焦测试、package gate |

Windows runner 必须使用显式版本标签和固定工具链，不用浮动的“本机已有任意 csc”充当可复现
证据。CI artifact 保存 source SHA、toolchain identity、helper SHA、Node/OS 版本和测试摘要；不保存
环境凭据或模型输出。

所有 PR/push job 都必须以触发事件的不可变 commit SHA 为输入。需要跨 OS 比较时，Windows
与 Ubuntu 都显式 checkout 同一个 SHA，并在执行前断言 `git rev-parse HEAD` 精确相等；不能
让一侧 checkout branch tip、merge 后新 tip 或重新解析的 tag。

### 10.2 Release

tag release 增加阻断性的 `windows-native-gate` job。Ubuntu publish job 必须 `needs` 它，
然后才执行现有：

- checkout tag 与 ancestry/version 检查；
- `npm ci`、typecheck、单 worker 全量测试、release smoke；
- npm OIDC / Trusted Publishing；
- registry dist-tag 与 GitHub Release 验证。

发布仍由 Ubuntu GitHub Actions 通过 npm Trusted Publishing 完成。禁止本地 `npm publish`，
也不向开发机写入 npm token。Windows job只验证 tag 内已入库 artifact，不单独发布、不上传
另一个未被 package gate验证的二进制。

release 两侧必须显式 checkout 不可变 `${{ github.sha }}`，并断言 HEAD 精确匹配。允许为
ancestry 检查 fetch `main`/`next` remote ref，但不得重新解析 tag 得到另一个 commit、切换
HEAD 或使用“最新成功 workflow”的 artifact。

`windows-native-gate` 在同一 SHA 上 deterministic rebuild并 byte-compare checked-in helper、
跑真内核测试和实际 package exact-set 计算，然后生成版本化 attestation，至少包含：

- immutable commit SHA；
- checked-in helper 实际 SHA-256；
- source/build config/toolchain identity 与 toolchain package-set digest；
- 对实际待打包路径按规范化相对路径排序、以文件原始字节 hash形成的 package-set digest；
- Windows runner OS/build、Node 版本、测试与 byte-compare 结果；
- attestation schema/version 与自身 digest。

Ubuntu publish job 在取得 OIDC credential **之前**必须：

1. 验证 attestation 来自当前 workflow、当前 immutable SHA，schema 与 artifact digest 精确；
2. 从自己的 checkout 读取 checked-in helper，验证 SHA 与 attestation；
3. 构建 JS/package，但不得重新构建、下载替换或修改 helper exe/sha；
4. 对自己的实际 `npm pack --dry-run --json` 文件集重算相同 package-set digest并与 Windows
   attestation 比较；
5. 再跑 typecheck、单 worker全量、release smoke 和普通 capability verifier。

任一 digest 不同都在 OIDC/npm 阶段之前停止。Windows attestation 是对 checked-in artifact
与真内核行为的证明，不是让 Ubuntu 用另一个二进制替换 tagged helper 的搬运通道。

### 10.3 GitHub runner 与真实宿主的证据边界

GitHub Windows Server runner 只是可重复的 Win32 内核代理，用于竞态、Job、fd3、构建与包
门禁；它不是 Codex Desktop、活动插件缓存、Windows 10/11 用户会话或真实 App Stop 的替代
证据。

stable 前必须在实际 Windows 10 或 Windows 11 x64 维护者宿主上，从公开 beta.2 与官方插件
完整重启后记录：

- OS product name、完整 build/revision、x64 架构；
- Node、CLR 4.8 probe、插件版本与实际 helper SHA；
- helper 是否位于实际插件缓存的 canonical path；
- compatible nested Job、真实 Kimi/Pi invocation 与 Stop/interrupt 后
  helper/target/descendant 归零；
- unrelated peer、Codex App、旧工具和用户桌面进程未受影响。

记录必须脱敏，不包含用户名、凭据或完整命令行。没有这份真实 Windows 10/11 x64 OS build
宿主 gate，就不能以 GitHub Server 结果维持本文的桌面支持声明，也不得发布 stable。

## 11. TDD 与验证矩阵

每一项行为必须先出现目标失败测试，再做最小实现。至少覆盖以下层次。

### 11.1 TypeScript 单元测试

- Windows x64 选择 helper；Windows ARM64/ia32 在 target spawn 前拒绝；POSIX 保持旧路径；
- helper path 基于 package/plugin artifact，拒绝路径逃逸、symlink、缺失和 SHA 不符；
- frame short-read、合并帧、超长、坏 magic/version/type、坏 UTF-8、重复 config/terminal；
- config 明确不含 prompt、credential 或环境值；
- READY 前 client 不发送 ACP/RPC，不上报 process started；
- TERMINATE 幂等，正常 terminate不 end/destroy fd 3，并保持 duplex 到 terminal/close；
- helper frame 解析异常先尝试 TERMINATE，fd 3 真损坏才用 retained helper handle强杀，且
  两条路径都固定失败；
- fd 3 EOF 映射到 session shutdown但不推断父进程死亡；write-half-close 后仍接受 terminal；
- terminal frame 缺失、Job 未归零标志、helper 非零退出都 fail closed；
- 无 direct spawn/taskkill/PID fallback；
- 省略 `timeoutMs` 时没有 deadline、Job limit 或 watchdog。

### 11.2 C# 协议与构建测试

- binary codec 与 TypeScript golden vectors 双向一致；
- 所有 frame/string/argc/command-line 上限；
- cmd command-line 纯函数/golden vectors 精确断言首 token 是加引号的 System32
  `cmd.exe`，其后才是 `/d /s /v:off /c`，并覆盖含 NUL 的 8190/8191/8192 最终 buffer；
- Win32 stage error 映射固定且不泄漏输入；
- pre-create protocol error不创建 target；`CREATING` protocol error只锁存并等待 create 返回；
  `CREATED_ASSIGNED`/READY protocol error先清 Job、只发 ERROR、不发 EXIT；
- attribute list 固定同时包含 `HANDLE_LIST`（仅 0/1/2）与 `JOB_LIST`（唯一 inner Job）；分别
  注入 initialize、HANDLE_LIST update、JOB_LIST update失败，均不调用 `CreateProcessW`；
- `CONFIGURED`/`JOB_READY`/`CREATING`/`CREATED_ASSIGNED` 的 TERMINATE/EOF/protocol-error
  barrier race：marker 不存在、无 READY、无 suspended 残留、唯一 terminal；`CREATING` 在
  `CreateProcessW` 返回前只锁存且不关闭 Job；
- `CREATED_ASSIGNED`/RUNNING 与 TERMINATING 的 mutex/CAS barrier race；无故障 resume-first 正常取消
  只接受 `READY → EXIT`、精确 requested reason 与 `jobActiveProcesses = 0`；协议错误和各故障
  注入才接受 `ERROR`，并精确断言 stage；
- 完整交叉 `CreateProcessW` success/failure × terminate/EOF/protocol_error，断言唯一 cleanup
  owner、pending disposition 优先级、handles/Job关闭顺序和每格精确 terminal；
- `TerminateJobObject` 与每次 `QueryInformationJobObject` 的失败注入和返回值处理；
- `--probe-v1` 在无 fd3 下只输出固定一行、stderr空、exit 0，且毒化环境不改变结果、没有
  Job/target/临时文件；
- source + fixed toolchain deterministic rebuild 与 checked-in exe 字节相同；
- PE 是预期 x64 .NET Framework 4.8 artifact，SHA 精确；
- 查询 Job limits 只出现 `KILL_ON_JOB_CLOSE`，无 breakaway 或资源限制。

### 11.3 Windows 真内核测试

使用无网络、无模型的测试 executable / `.cmd` fixture，至少验证：

1. `CreateProcessW` 成功返回的 target 仍 suspended 且已经在唯一 inner Job；测试 marker 在
   READY 前不存在；
2. `CONFIGURED`/`JOB_READY` 的 TERMINATE/EOF 不创建 target；`CREATING` 的 stop 在 create
   返回前只锁存，按 success/failure 分支清空 Job 或确认无 child；`CREATED_ASSIGNED` 的 stop
   只走 Job cleanup。三类取消都无 marker、无 READY、无 suspended 残留且只有
   `ERROR(cancelled_before_ready)`；protocol error 使用相同交错但只发
   `ERROR(protocol_invalid)`；RUNNING/READY/即时 exit barrier 竞态只有规格允许的顺序；
   无故障 resume-first 正常 terminate 严格为 `READY → EXIT`，并精确断言 requested reason
   与 `jobActiveProcesses = 0`，不得接受 ERROR；
3. Job/create/attribute-list/HANDLE_LIST/JOB_LIST/resume 注入失败时 target 从未执行；其中
   `CreateProcessW` failure 和不兼容 outer Job 必须没有 child/process handles；
4. root 自行退出、grandchild 无限等待时，helper terminal 前 grandchild 已死；
5. `TERMINATE` 后 fd 3 保持 duplex，root/carrier/grandchild 全部归零；
6. fd 3 full-duplex、Node write-half-close、helper write-half-close、EOF 与 Node test parent
   强杀分别符合 terminal/close 合同；
7. 强杀 helper 后 `KILL_ON_CLOSE` 最终清除 Job members；
8. `TerminateJobObject`、首次/中途/最终 Query失败均无 EXIT、尽力 ERROR，并由最后 handle
   关闭清树；
9. unrelated sentinel 即使 PID/启动时序相邻也保持存活，证明没有按 PID 扫描；
10. 两个并行 Job 终止一个不影响另一个；
11. compatible outer Job 中 `JOB_LIST` 创建成功且 suspended target 已在 inner/outer Jobs；
    incompatible UI-limit outer Job 中 `CreateProcessW` 失败、没有 child，peer不受影响；两者均
    无 breakaway；若任一真实内核行为不符则阻断并回到设计；
12. target 只能使用继承的 0/1/2；它虽通过 `JOB_LIST` 属于 inner Job，却不能访问 fd 3、Job
    handle 或其它 helper handle；
13. 大量 stdin/stdout/stderr、分块 JSONL、backpressure 和 Unicode 字节精确；
14. native `.exe` 的 cwd、environment、argv 精确；
15. `.cmd` 只转发到原生 x64 length-prefixed argv recorder；recorder 只核验最终收到并转发的
    用户 arguments；空参数、空格、引号、尾反斜杠、Unicode、`&|<>^()%!` 与 npm shim
    double-escape 精确，注入哨兵文件不存在；
16. 完整 cmd command line含 argv0/flags/quoting/NUL 的 8190、8191 接受和 8192 拒绝；在
    suspended target 上以 `QueryFullProcessImageNameW` 证明实际 image 是与
    `lpApplicationName` 和 golden 首 token 相同的 System32 `cmd.exe`；
17. target 正常 0、非零退出与取消三种状态都在 Job 归零后才返回；
18. 没有持久临时文件、命名 Job、命名 pipe、helper、target 或资格锁残留。

handle 隔离测试不得把“target 中没有看到某个相同 HANDLE 数字”当作证明，因为 HANDLE 值在
不同进程中可复用且没有跨进程身份意义。测试必须构造带随机 nonce 的 event/pipe/object
identity handshake：只有 target 真持有被禁止对象才能完成挑战；期望结果是 0/1/2 对应挑战
成功，而 fd 3、Job 和额外 helper object 的 nonce challenge 均无法完成。另用 Job membership
查询独立证明 target 属于 inner Job，从而同时证明 `JOB_LIST` 生效且没有泄漏 Job handle。

故障注入可以通过同源、仅测试编译标志生成的 helper test build 实现，但 production helper
不得接受环境变量或公开参数来跳过 `JOB_LIST`、伪造 membership/READY、禁用 cleanup 或改变
Job limits。source/IL 静态门禁还必须证明生产 artifact 不包含
`AssignProcessToJobObject`、`TerminateProcess`、`taskkill` 或 PID reopen target cleanup。

### 11.4 既有矩阵与本地 Windows 验收

在 `<isolated-worktree>` 运行：

- 新 owned-process/helper/protocol/cmd quoting 聚焦测试；
- Node 20/22/24 → C# fd3 CONFIG、同 HANDLE ACK/READY、half-close/EOF implementation
  preflight；
- Kimi/Pi client、stdio session、stdio process cleanup 回归；
- typecheck、build、单 worker 全量测试；
- deterministic native rebuild/byte compare；
- isolated plugin lifecycle；
- release smoke，Task 9 前仍应只因 stale capability verifier fail closed；
- `git diff --check`、package exact set、helper SHA 与残留进程检查。

所有测试均使用 fake executable，不调用真实 Kimi、Pi、Ark 或网络后端，不读取活动
`~/.codex/config.toml`，也不修改活动插件或外部 CLI 全局配置。

Windows strict `doctor` 必须按 9.5 的字节级合同执行 canonical helper `--probe-v1`，并只读
报告：当前 Node 架构是否为 x64、helper 是否位于 MCP 实际受控 package/plugin 路径、实际
exe SHA 是否匹配清单、CLR 4.8 probe 的 stdout/stderr/exit 是否精确。任一失败都给出可操作
但脱敏的诊断；doctor 不得运行真实模型或把失败转换为 direct-spawn 建议。

### 11.5 prequalification expected-failure gate

Task 9 前普通命令必须保持真实失败：

- `npm run verify:capabilities` 非零；
- `npm run smoke:release` 非零；
- 两者不能用 mock、skip、`continue-on-error` 或改写 exit code取得伪绿。

另设一个专用 prequalification wrapper，用 verifier 的结构化 API（不是 stderr substring）机器
断言：所有 native wrapper、fd3、Job、doctor、build、test、package、attestation 子门禁均已
成功；唯一预期失败集合恰好是以下八个 capability 的 `runtime_fingerprint_stale`：

```text
kimi-k3/review
kimi-k3/delegate
ark-coding-plan/review
ark-coding-plan/delegate
ark-agent-plan/review
ark-agent-plan/delegate
ark-agent-deepseek-v4-flash/review
ark-agent-deepseek-v4-flash/delegate
```

wrapper 必须比较精确排序集合、精确 reason enum 和失败计数 8；不得使用宽松字符串、
`includes("stale")`、忽略未知失败或允许额外失败。wrapper 自身只有在“其它全绿 + 精确八项
stale”时退出 0，从而证明可以进入 Task 9，但不改变普通 verifier/release smoke 的非零事实。

Task 9 更新现行能力索引后，普通 `verify:capabilities` 与 `smoke:release` 必须各自真实 exit 0；
prequalification wrapper 的“期待八项 stale”模式此时必须拒绝运行或按已晋级模式断言 0 stale，
不能继续吞掉新的回归。

## 12. 能力资格与发布顺序

native ownership 会改变 Kimi/Pi 的共享执行路径，因此能力指纹必须纳入：

- C# helper source；
- deterministic build configuration 与 toolchain manifest；
- 从实际 helper exe 字节计算、并已与 `.sha256` 清单精确核对的规范化 SHA-256；
- TypeScript owned-process wrapper、协议 codec、cmd quoting 与相关依赖锁。

verifier 不能只信文本 hash 文件：它必须先读取 exe、计算实际摘要、与清单比较，再把这个
已验证摘要写入规范化 fingerprint 输入。修改 exe 而不改清单会 fail closed；同时修改 exe
与清单会改变 fingerprint，并要求新 evidence。

在 native TDD、两轮独立审阅、Windows CI 与 prequalification 确定性矩阵通过前（普通
verifier/release smoke 仍按 11.5 精确因八项 stale 非零）：

- 现行 `capabilities.json` 保持原样；
- `npm run verify:capabilities` 继续 stale fail closed；
- 不启动 Task 9，不发布 beta.2。

唯一晋级顺序为：

1. native 设计实现、TDD、规格审阅、质量/安全审阅收敛；
2. Windows Node 20/22/24 native gate、strict doctor 和 11.5 prequalification wrapper 在
   clean frozen candidate 上通过；普通 verifier/release smoke 此时只允许精确八项 stale；
3. Task 9 在 clean frozen candidate 上串行完成八项真实能力重资格，更新同一现行索引；
4. capability verifier 8/8 后，GitHub Actions Trusted Publishing 发布
   `0.1.1-beta.2` 到 npm `next`；
5. 从公共 npm 做精确版本隔离验收并官方升级插件；
6. 完整退出并重开 Codex App，在真实宿主下验证 nested Job、Kimi/Pi 调用与
   Stop/interrupt 后 helper/Job/target 全归零；
7. 只有公共 beta、完整重启和真实 Stop gate 全部通过，才由 GitHub Actions 发布
   stable `0.1.1` 到 npm `latest`。

任何一项失败都保存脱敏证据、停止后续发布并回到对应任务；不得跳过 verifier、复用 stale
证据、在本地发布，或用全机模糊清理把 Stop gate伪造成通过。

## 13. 替代方案及拒绝原因

### 13.1 PID + startTime ledger / WMI 枚举

拒绝。startTime 能降低 PID reuse 误杀概率，但不能让已经脱离 root 的后代重新获得可靠
ownership，也堵不住“枚举后又创建后代”的竞态。WMI 还是事后快照，不是内核归属。

### 13.2 N-API addon

拒绝。Node-API 可以提供跨 Node major 的 ABI 稳定性，但 Windows binary 仍有架构分发问题；
更重要的是，Node-API 没有稳定公开接口把任意 Win32 pipe handle直接变成标准
`ChildProcess` streams。若 addon 不能在同一次 `CreateProcessW` 中用 `JOB_LIST` 建立 ownership，
创建与归属间的竞态仍存在；若 addon 自己实现 spawn、stdio/backpressure/exit，则复杂度和
Node runtime 耦合远高于独立 helper。

### 13.3 运行时 PowerShell / `Add-Type`

拒绝。运行时编译受执行策略、CLR/compiler 可用性、临时文件、启动延迟和安全产品影响，无法
提供入库二进制、固定 SHA 与 deterministic byte comparison。PowerShell 文本流也不是 ACP/
JSONL 字节透明承载。

### 13.4 命名 Job

拒绝。命名 Job 增加名称碰撞、抢占、错误 reopen 和 ACL 面，而每 invocation 并不需要跨进程
重新发现 Job。匿名 Job + helper 唯一不可继承 handle 已足够。

### 13.5 命名控制 pipe

拒绝为当前首选。命名 pipe 需要名称随机性、namespace/ACL、连接抢占和清理设计。Node fd 3
已经由真实 C# 探针证明 Node → C# 单向读取可用；同 handle 双向 ACK、三版 Node 与 half-close/
EOF 仍必须先通过 4.3 的 implementation preflight。只有该硬门禁通过，首版才继续采用匿名
额外 stdio pipe；若失败，必须回到本规格重新选择控制载体，不能静默切换命名 pipe。

### 13.6 普通 direct spawn + 失败时 fallback

拒绝。只有带 `JOB_LIST` 的同一次 `CreateProcessW` 可以让“创建成功”同时意味着“已经归属”；
helper/CLR/arch/attribute/JOB_LIST/create 任一失败都必须阻止 target，而不是回退到旧
`taskkill` 路线或事后修补 membership。

## 14. 官方参考

- Microsoft：[Job Objects 及 nested/KILL_ON_CLOSE 语义](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- Microsoft：[`CreateJobObjectW`](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw)
- Microsoft：[`SetInformationJobObject`](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject)
- Microsoft：[`CreateProcessW`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- Microsoft：[Process Creation Flags / `CREATE_SUSPENDED`](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
- Microsoft：[`UpdateProcThreadAttribute` / `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` / `PROC_THREAD_ATTRIBUTE_JOB_LIST`（Windows 10+/Server 2016+）](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- Microsoft：[`ResumeThread`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread)
- Microsoft：[`TerminateJobObject`](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
- Microsoft：[`QueryInformationJobObject`](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)
- Microsoft：[`GetSystemDirectoryW`](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemdirectoryw)
- Node.js：[`child_process` stdio 数组与额外 pipe](https://nodejs.org/api/child_process.html#optionsstdio)
- Node.js：[Node-API ABI 保证及其不覆盖 libuv/V8 的边界](https://nodejs.org/api/n-api.html#implications-of-abi-stability)

## 15. 规格完成判定

本文对应的实现只有在以下事实同时成立时才算完成：

- Windows `CreateProcessW` 成功即得到已由 `JOB_LIST` 归入唯一 inner Job 的 suspended target，
  不存在 post-create ownership gap；
- attribute list 同时只有 `HANDLE_LIST`（0/1/2）和 `JOB_LIST`（inner Job）；target 只继承
  fd 0/1/2，fd 3 与 Job handle 不可达；
- normal root、TERMINATE、control EOF 和 helper 强杀都由真实内核测试证明无 owned 残留；
- 生产 Windows 路径不存在 PID/taskkill/direct-spawn fallback；
- `.cmd` argv 精确且注入测试通过；
- Job 只启用 KILL_ON_CLOSE，没有任何执行资源限制或 breakaway；
- fixed toolchain rebuild 与 checked-in helper byte-for-byte 相同；
- Windows Node 20/22/24、全量离线、package exact set 和 release gate通过；
- capability fingerprint 已覆盖 native inputs，Task 9 前 verifier 保持 stale fail closed；
- 真实资格、beta.2、公共 npm/官方插件完整重启/Stop、stable 顺序没有被绕过。

只满足“测试进程最后死了”或“没有观察到明显残留”不足以证明完成；必须由 Job ownership、
控制协议、可复现 artifact 与逐项门禁共同提供证据。
