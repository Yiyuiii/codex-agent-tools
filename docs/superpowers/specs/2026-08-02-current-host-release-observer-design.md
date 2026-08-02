# 当前宿主发布 Observer 最小设计

日期：2026-08-02

状态：**已收敛设计，分批实现中；尚未形成发布PASS**

适用范围：维护者当前 Windows 10 x64、Node v24.14.1、.NET Framework 4.8 宿主上的公共 beta → 真实 Codex App 验收 → stable 发布链。本文不建立跨 Node、跨 Windows 或跨机器兼容承诺。

关联计划：[Windows 当前宿主 Owned Process 精简实施计划](../plans/2026-08-01-windows-current-host-owned-process.md)

## 1. 目标与非目标

stable 前必须取得一份机器可验证的当前宿主凭据，证明以下事实来自同一个公共 beta、同一个验收会话：

1. 外部 PowerShell 从精确 beta tag checkout 运行仓库固定验收脚本与 release-only observer；被测插件则必须来自公共 npm 的精确 beta，而不是工作树、本地 tarball 或临时重建产物；
2. 旧 Codex App 的 MCP 与 App 宿主完整退出，随后出现新的 App 宿主与新的 MCP；
3. 新宿主中的一个真实工具请求由 Codex 的 Stop 操作取消，终态精确为 `cancelled`；
4. 该请求的 handler 已取消、in-flight 记录已移除、owned process/Job 已归零，而且原任务的完成 marker 不存在；
5. 支持的发布流程只允许会话外 observer 的固定代码路径生成 PASS；stable verifier 会拒绝 observer、beta 身份或凭据漂移。

这条链只用于发布验收，不承担进程清理和产品控制。它不取代 native Job helper，不扩展公开 MCP 工具面，也不证明外部模型质量或跨宿主兼容性。

## 2. 用户要求与硬边界

- 只服务维护者当前宿主，不恢复 Node 20/22/24 矩阵或下载替代 Node。
- 不修改 Job helper、fd3 控制协议或插件 `.mcp.json`；observer 是独立的发布证据侧信道。
- 不使用 WMI、`ps`、Toolhelp 全机扫描、PID 轮询、`taskkill`、PID 退出后重开或任何“全机进程数为零”判据。
- 不读取或写入活动 `~/.codex/config.toml`，不把会话 descriptor 当配置项。
- 不给 Kimi、Pi 或其它外部 CLI 增加默认/全局 step、turn、tool、context、token、时间或资源上限。observer 只等待用户完成发布验收；显式调用级 timeout、资格 single-attempt 与测试 watchdog 的既有边界不变。
- 不建立第二套 Roslyn/net48 lock、restore、compiler flags 或 artifact 真值源。observer 可以维护自身必要的最小源码清单，但必须复用现有锁定工具链和编译合同，不得复制整套 native 构建实现。
- observer 是 release-only 可信测试工具，不进入公开 npm 包、不进入官方插件，也不增加公开 CLI/doctor 命令。stable 只接受被 beta marker 预先绑定、并可从 beta tag 精确重算的 observer；不得在 stable 候选或本机验收后替换 observer。

## 3. 组件与信任边界

### 3.1 beta tag checkout 中的固定验收脚本

外部 PowerShell 在精确 beta tag 的 clean checkout 中运行固定 repository script。该脚本是维护者发布流程的一部分，不是 npm 公开命令。它只负责：

- 严格验证 beta tag 内 release-only observer 可执行文件、协议和唯一 build manifest；不维护冗余的相邻 `.sha256` 文件；
- 生成高熵 nonce、随机 named-pipe 名称和一次性会话目录；
- 以普通前台子进程启动 tag 内 x64 observer；
- 在用户本地应用数据目录原子发布严格 descriptor，并在 observer 终态后清理 descriptor；
- 向维护者显示固定的操作顺序，但不替维护者操作活动插件或 App。

验收时不 restore、不编译、不下载工具链。observer 的源码和二进制在 beta 冻结前复用现有 `native/windows-job-helper/toolchain.lock.json`、`restore-toolchain.ps1` 与 x64/net48 compiler contract 产生。实现只用声明 observer 自身源码/artifact 的薄入口消费这些真值；不提取第二个共享 runner，不复制现有大型 build script、NuGet 身份或 compiler flags。observer 及脚本保持在 `package.json.files` 之外，既有精确 npm 包面不因测试工具扩大。

### 3.2 MCP 显式事件客户端

MCP 仅在工具请求边界检查严格 descriptor。descriptor 不存在时，普通运行不创建 timer、named-pipe client、常驻 worker、后台重试或文件 watcher；除一次无状态存在性检查外，行为与当前版本相同。

每个 MCP 进程对一个 nonce 最多连接一次。连接成功后，它只发送严格、定长边界的生命周期事件；连接失败、descriptor 非法或 observer 拒绝握手时，该发布会话最终不能 PASS，但不得改变工具本身的成功/失败语义。旧 App 与新 App 各自的新 MCP 进程都可对同一个尚有效的 descriptor 建立一次连接。

descriptor 只包含 schema/协议版本、nonce、随机 pipe 名称、公共 beta 的 marker/plugin/observer/npm 身份，以及受限的目标 delegate 绑定：任务、逻辑 LLM、prompt/cwd/sessionId 摘要、显式调用级 `timeoutMs`、完整输入摘要和 completion-marker 身份。它不包含原始 prompt、cwd、sessionId、工作区内容、凭据、任意路径或发布结论。descriptor 使用当前用户私有目录、拒绝 reparse/越界，并由固定仓库脚本原子创建；MCP 只读。

这一层已由 `020c82d` 实现并通过聚焦测试、类型检查、库构建和 fresh 只读复审：descriptor 缺席时不计算 request 摘要、不安装 abort listener、不创建 timer/watcher/pipe；存在时只对实际 delegate 输入的规范化摘要建立一次性事件流。协议 JSON 是 TypeScript 客户端与后续 C# observer 的单一真值，同时纳入八项能力的共享 production fingerprint。当前宿主边界内，尚未完成连接的真实 `net.Socket` 只能被 `unref` 并在晚到时拒绝 HELLO，Node 没有可用于拒绝所有非重定向 reparse tag 的通用 API；固定私有路径的 lstat/realpath/文件身份校验和一次性 nonce 已覆盖受支持流程，这两点不扩张为跨宿主安全承诺。

### 3.3 Windows x64 observer

支持的发布流程中，observer 是唯一包含最终 receipt PASS 写入逻辑的进程。它用显式 current-user ACL 创建随机 named pipe，拒绝其它用户、远程客户端、错误 nonce、错误协议和重复角色。MCP 的自报 PID 只用于一致性比较；真实 peer PID 必须由 named-pipe 内核查询取得。同一 Windows 用户主动篡改仓库、二进制或 receipt 不在本地 ACL 能解决的威胁模型内；beta 预绑定和 stable 重算用于发现支持流程中的漂移，而不是宣称具备硬件级防伪。

observer 在连接建立时立即把内核 peer PID 转换为持久 MCP 进程 handle，并沿直接父子关系取得 app-server 与 ChatGPT 两层祖先 handle。祖先关系从已持有的子进程 handle 查询，并立刻打开、核对创建时间和保存父 handle；后续只等待这些 handle，不保存 PID 后在退出时重新打开，也不扫描系统。`MCP → app-server → ChatGPT` 是当前宿主需要由首次真实实现 fail closed 核对的实际链，而不是预先假定的进程名猜测；不满足即验收失败，不能降级为少等一层或全机搜索。

observer 记录的是非秘密身份摘要、创建/退出时序和内核 wait 结果，不记录可执行文件完整路径、命令行、环境或用户数据。

## 4. 会话状态机

observer 的 stdout 只发布四条固定动作门，不输出 `PASS`：`READY` 表示首个受保护 pipe 已可用，`OLD_HOST_BOUND` 表示旧 MCP 与两层宿主 handle 已持有、维护者可以完整退出旧 App，`OLD_HOST_EXITED` 表示旧三层 handle 已实际退出且第二个同名受保护 pipe 已创建、维护者可以重开 App，`REQUEST_STARTED` 表示新宿主的目标请求首帧已被 observer 接受、维护者此时才可点击 Stop。最终成功只由退出码 0 与严格 receipt 共同表示，启动脚本不得靠固定 sleep 猜测操作时机。

### 4.1 启动与旧宿主绑定

1. 先从公共 npm 精确安装beta并按官方命令升级插件。若当前App尚未实际加载该beta runtime，先完整退出/重开一次完成加载；这次准备动作不计入最终receipt。observer握手会核对beta identity，因此不能以旧runtime冒充。
2. 外部 PowerShell checkout 精确 beta tag，并由固定仓库脚本核对 clean tree、tag/commit、公共 npm 精确 beta identity、observer 和 marker。
3. 仓库脚本验证 observer 后启动它；observer 先创建 current-user ACL 随机 pipe，再由脚本原子发布 descriptor。
4. 维护者在已加载公共beta的旧App中发起一个普通、无副作用的工具调用。MCP 在请求边界发现 descriptor，完成一次握手。
5. observer 以 kernel peer PID 和直接父宿主 handle 绑定旧 MCP/旧 App 身份，并只在 handles 已持有后接受 `old_host_bound`。
6. 维护者通过系统托盘完整退出 App。只有旧 MCP、app-server 与 ChatGPT 三个已持有 handle 全部进入 signalled 状态，observer 才记录 `old_host_exited`。stdin EOF、pipe 断开、PID 消失或进程名变化均不能替代该证明。

### 4.2 新宿主、真实 Stop 与 drain

1. 维护者重新打开 App，在新任务中发起固定验收 prompt/cwd 的真实 delegate 请求。completion marker 位于由会话 nonce 派生的私有 session root 中，文件名也由受限 marker id 派生；observer 不接受 MCP 或人工传入的任意路径。descriptor 在请求前绑定 prompt、cwd 与 marker identity 的摘要。
2. 新 MCP 对同一 descriptor 建立自己的唯一连接。observer 再次用 kernel peer PID 与直接父宿主 handle 绑定新 MCP/新 App，并要求新旧进程创建身份不同且 `old exited < new created`。
3. MCP 用 SDK `extra.requestId` 关联请求，用 `extra.signal` 的真实 abort 事件记录 Stop；不新增公开参数或验收专用 MCP 工具。
4. runtime/adapter 发送内部事件，证明同一 request：handler 收到取消；`OwnedProcessExit.completion === "cancelled"` 且 `ownershipDrained === true`；后者的既有 helper 合同已经包含 Job 查询归零，不再另造第二个 `jobActiveProcessesZero` 自报字段；`InFlightTasks` 已删除该 request；handler 不会随后返回 completed。
5. observer 在 owned drain、handler cancelled 和 in-flight removed 全部到齐后，根据 nonce、受限 marker id 和私有 session root 自行解析并核对 completion marker 不存在。MCP 只核对同一 identity 并发送请求事件，不能选择任意路径，也不能代写“不存在”结论。

`timed_out`、`session_shutdown`、普通失败、App 退出造成的取消、只关闭工具窗口、用户在请求开始前点击 Stop、completion marker 已存在，或任一事件属于另一个 requestId/nonce，全部不能满足真实 Stop 门禁。

## 5. 事件协议与最小生产改动

事件协议独立版本化，严格拒绝 unknown/missing/duplicate 字段、非法 UTF-8、超长 frame、乱序、重复终态和 nonce/requestId 不一致。最小事件集合为：

- `HELLO`：协议、nonce、beta 身份和 MCP 声明身份；
- `REQUEST_STARTED`：SDK requestId、任务类型与 completion-marker 相对标识；
- `REQUEST_ABORTED`：来自 `extra.signal` 的 abort；
- `HANDLER_CANCELLED`：handler 的精确取消终态；
- `OWNED_EXIT`：`completion: "cancelled"` 与 `ownershipDrained: true`；该单一权威终态同时承载既有 Job-zero 合同，不再重复发送 Job 计数字段；
- `INFLIGHT_REMOVED`：同一 request 已从 `InFlightTasks` 移除；

MCP/session shutdown 不发送协议事件；observer 只以已经持有的进程 handles 证明旧宿主退出，transport 关闭不能替代该事实，也不再保留冗余时序自报。

第一批实现应先在 runtime 内形成不可伪造的结构化证据，再接 named-pipe client。MCP 注册层不得自行推断 Job zero；adapter 不得自行推断 in-flight 已移除；observer 只综合各自职责内的事件与内核事实。

Job helper、fd3 frame、任务输入 schema、公开结果 schema、provider 路由、凭据继承和 `.mcp.json` 均不改变。该侧信道也不能成为 task cancel/control 的第二通道；所有真实取消仍由现有 MCP `extra.signal` → service/adapter → `OwnedAgentProcess.terminate("cancelled")` 路线完成。

## 6. Receipt 唯一写入与发布绑定

observer 在所有条件成立后，使用同目录临时文件、flush、原子 rename 和 no-replace 语义写一份严格 JSON receipt。支持的仓库脚本、MCP、App 与测试驱动都不实现 PASS writer；observer 失败只可留下失败终态/退出码，不能留下可被误认的部分 PASS。同用户恶意手工伪造文件不在该流程威胁模型内。

receipt 至少绑定：

- schema/protocol、nonce 及 descriptor SHA；
- 公共 beta 精确版本、npm integrity/shasum、beta tag/commit；
- beta plugin 安装树的固定路径集合与树摘要；
- observer 在 beta tag 内的固定 release-only 路径、原始字节 SHA、协议摘要与构建输入摘要；
- beta marker、current-host freeze、canonical runtime-input、helper 和 capability index 身份；
- 旧/新 MCP、app-server 与 ChatGPT 的非秘密创建身份摘要、handle wait 时序；
- 同一 requestId 的 Stop、`cancelled`、`ownershipDrained:true`（含 Job zero）、handler cancelled、in-flight removed 与派生 completion marker absent；
- `result: "passed"`，且不存在人工 override、scanner、PID reopen、taskkill、config access 或默认 timeout。

beta 严格 JSON marker 必须在发布前绑定 release-only observer artifact、observer 协议/构建输入摘要和固定 beta plugin tree digest。stable verifier 从 beta tag 读取并重算 observer 与 plugin tree，不信任 stable 工作树副本；同时要求公共 registry beta 身份、beta marker、receipt 和 stable marker 四方一致。stable 候选只能引用 receipt 的 SHA，不能复制或人工编辑其中事实。公开 beta package只携带被测 plugin runtime 中的descriptor事件客户端，不携带observer、仓库脚本或receipt writer。

历史 `.release-validation/v0.1.0.md` 只作历史记录。当前 beta/stable 门禁使用 `.release-validation/v<version>.json`，由可执行 verifier 严格解析、重算与 fail closed。

## 7. TDD 与提交边界

全部四个子批必须在当前宿主 freeze 和新真实 8/8 资格之前完成。前两批会修改 runtime/MCP/adapter 输入并使能力指纹发生变化；后两批负责把固定 observer 和发布证据边界在同一个候选中闭合。每批先 RED、再最小 GREEN、主代理复验、fresh 审阅、独立提交；不把后续批次测试提前塞入前一提交。

1. **runtime 内部证据（已完成）**：`ca9cf9e`让adapter只从同一次成功owned终态转发精确completion与drain；`f96e1ac`让MCP各职责点产生SDK abort、可信owned exit、handler cancelled与实际删除后的in-flight removed。两提交不接pipe、不改helper，聚焦验证与fresh只读复审均PASS。
2. **显式事件客户端（已完成）**：`020c82d`实现 descriptor 严格读取、每 MCP/nonce 一次连接、复用已提交的`extra.requestId`/`extra.signal`事件sink和正常运行零 timer/watcher/常驻；协议作为共享 production fingerprint 输入。fake transport、关闭竞态、故障隔离、89项聚焦测试、类型检查、库构建和fresh只读复审均PASS。
3. **原生 observer（行为实现已完成）**：`4ccc715`、`0feef26`与`1c82fec`依次完成纯托管严格核心、当前Windows x64 kernel peer/两层祖先 held handles与严格会话材料绑定；`228c6a3`把 `Program` 接到完整双 pipe 会话，使用 held handle 的真实 exit FILETIME、严格EOF、五帧事件、派生marker absence及唯一no-replace receipt writer。MCP客户端同时锁存自然终态并排空`HELLO + 5`，真实socket只以`close`为关闭完成；全局shutdown不能吞掉已锁存终态。固定stdout仅含`READY / OLD_HOST_BOUND / OLD_HOST_EXITED / REQUEST_STARTED`四个动作门，无`PASS`。主代理最终复验managed 34/34、真实kernel 7/7、客户端26/26、全库67文件1204 passed / 3平台条件skipped、类型、构建与diff PASS；fresh综合审查无P1/P2，两个P3测试质量项也已闭合。局部10秒fixture watchdog不进入production，也不构成Kimi、Pi或其它外部CLI的全局限制。仍待artifact、build manifest、启动脚本、current-host freeze和发布。
4. **marker/release整合（已完成）**：`1a029f1`保持精确npm包面不变，把release-only observer完整provenance、freeze observer身份与plugin tree纳入beta marker；stable verifier从beta tag重算observer/build inputs/plugin tree并严格核对公共npm identity和receipt。

严格 release marker 已经完成TDD、主代理复验和fresh终审。终审发现的freeze observer身份漂移与build manifest源码漏列均已闭合：freeze逐项绑定完整observer identity，observer源码集合只从严格唯一production source set派生并必须精确覆盖。descriptor client与observer运行时行为均已完成；仍必须生成并验证checked-in artifact/build manifest、完成固定启动脚本并做一次集成复审，之后才能生成真实freeze。不得因离线全链测试通过或workflow已接线就发布。

## 8. 失败语义与完成定义

以下任一情况均 fail closed：descriptor 或 pipe ACL 不可信、MCP/app-server/ChatGPT 任一 handle 无法取得、旧三层进程未完整退出、新旧身份未分离、Stop 不是 SDK abort、owned completion 不是精确 `cancelled`、`ownershipDrained` 未证明既有 Job-zero 合同、handler 或 in-flight 未闭合、派生 completion marker 存在、observer/plugin/beta 身份漂移、receipt 已存在或无法原子写入。

本设计的完成定义不是“日志看起来合理”，而是：beta tag 内被marker固定的release-only observer作为唯一receipt writer，以named-pipe kernel peer和直接祖先handles证明完整重启，以公共beta插件中的显式descriptor客户端和现有真实取消/Job ownership路线证明Stop后归零，并由stable workflow从beta tag与公共npm身份重新核对。实现和验证完成前，本文只是一份设计，不构成发布批准或验收PASS。
