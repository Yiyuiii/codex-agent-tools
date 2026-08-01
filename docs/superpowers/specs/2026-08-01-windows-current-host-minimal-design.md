# Windows 当前宿主最小可靠 owned process 设计

日期：2026-08-01

状态：**现行覆盖规格**

授权来源：维护者已明确要求不再为了良好发布版本测试三个 Node 版本，目标改为让维护者自己的当前环境鲁棒可用，并要求同步删除其它冗余设计。该要求是用户原始要求；本文中的具体技术取舍是 Codex 根据已保存证据和三路独立审计形成的可复核实现决策，不应反向表述成维护者逐条指定的技术方案。

关联基线：

- [已批准的 Windows Job Object owned process 设计](2026-07-31-windows-job-object-owned-process-design.md)
- [已批准的 stdio 生命周期与外部 CLI 原生执行预算设计](2026-07-31-stdio-lifecycle-and-native-execution-budget-design.md)
- [单 fd3 write-half-close 失败证据](../../research/windows-fd3-half-close-preflight.md)
- [被替代的 split-channel 提案](2026-08-01-windows-split-control-channels-amendment-proposal.md)
- [现行精简实施计划](../plans/2026-08-01-windows-current-host-owned-process.md)

本文只覆盖旧 Windows 设计与实施计划中的 Node 支持范围、控制通道正常关闭语义、Windows target invocation 分类、CI/证明范围和测试规模。未被本文覆盖的 Job 原子归属、唯一清理所有权、严格句柄继承、环境/凭据隔离、fail-closed 与无外部 CLI 执行预算等安全核心继续生效。

## 1. 当前目标与诚实支持声明

产品只承诺在维护者当前使用的 Windows 宿主上经过真实验证，不再声称建立 Node 20/22/24、多个 Windows 版本或跨机器组合的兼容性证明。

2026-08-01 的观测基线是：

| 维度 | 当前值 | 合同含义 |
| --- | --- | --- |
| OS | Windows 10 Pro 10.0.19045 x64 | 当前真实验收宿主，不扩张为 Windows 全版本承诺 |
| Node | v24.14.1，libuv 1.51.0 | 当前 preflight 与验收实际运行时，不写成精确版本白名单 |
| npm | 11.11.0 | 发布/安装证据的观测值 |
| CLR | .NET Framework 4.8，Release 528372 | helper 当前运行前提 |
| Kimi | `%USERPROFILE%\.kimi-code\bin\kimi.exe` | 当前PATH解析到的Windows原生PE入口；精确绝对路径只留在脱敏本机证据 |
| Pi | `@earendil-works/pi-coding-agent` 0.80.10，Node engine `>=22.19.0` | 由当前 `process.execPath` 直接启动包内 `dist/cli.js` |

以上路径、版本和摘要只进入本机证据，不成为生产硬编码。未来 Node、Pi、Kimi、OS 或 CLR 变化时，维护者在下一次 beta/stable 前重跑同一当前宿主门禁；生产代码不得因未列入历史版本字符串而自动退回 direct spawn。

`package.json#engines.node`可以继续保留本轮未改变的JavaScript/POSIX历史最低版本，但单Node CI不构成对该范围的主动兼容矩阵；公开文档必须如实说明。它也不得被解释为Windows原生路径已在所有满足版本上认证。Windows不增加20/22/24白名单，也不下载固定Node archive。

## 2. 保留的安全核心

每次 Windows Kimi/Pi invocation 仍必须满足：

1. 每次调用创建独立匿名 Job Object，唯一长期 Job handle 由固定 helper 持有；
2. `CREATE_SUSPENDED`、`PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 与 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在同一次 `CreateProcessW` 中让 target 在第一条用户指令前原子归入 Job；
3. target 只继承为它复制的 stdin/stdout/stderr，`cbReserved2=0`、`lpReserved2=NULL`，不继承 fd3、Job 或 helper 私有 handle；
4. Job 唯一 limit 是 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不设置 CPU、内存、时间、进程数、step、turn、tool、context 或 token 预算；
5. `CREATING` 期间只有 launcher 发布 create success/failure，控制 reader 只锁存首个停止 disposition，清理所有权唯一；
6. 正常完成、显式取消、调用级显式 timeout 和 stdio session shutdown 都等待 Job `ActiveProcesses=0`、合法终态、helper clean close 和目标 stdio settle；
7. helper 或 Node 崩溃时，helper观察到的Node→helper EOF或最后Job handle关闭最终清除整个owned tree；Node只有在合法terminal之后因helper主动关闭fd3而观察到的EOF才能参与成功判定；
8. C# helper对target cleanup禁止PID reopen、WMI、`taskkill`、全机扫描、`AssignProcessToJobObject`事后归属、`TerminateProcess`和breakaway；任何前置失败禁止direct-spawn或自动fallback；
9. helper、协议、hash、路径、架构、CLR、环境或 transport 前置条件失败时 fail closed；cleanup 成功不能把业务/协议失败改写为成功；
10. POSIX process-group 路径与公开 MCP 语义不因本设计改变。

Job Object 仍是生命周期承载，不是权限沙箱。通过系统 broker、服务或其它 Job 外机制显式创建的进程不属于可证明的 owned tree；若真实验收发现逃逸，停止发布并保存脱敏证据，不用模糊清理伪造通过。

## 3. 单一全双工 fd3 合同

### 3.1 为什么不再增加 fd4

历史失败只证明一个精确事实：Windows libuv 在 Node 对 extra stdio 调用 `.end()` 后，不能保证同一 pipe 的可读方向继续交付 helper terminal。它没有否定普通全双工通信；真实 probe 已完成 CONFIG/ACK/READY/PING/PONG。

现行合同不再把 Node write-half-close 当作正常结束协议：

- 正常完成由 target/Job 状态驱动；
- 取消、显式 timeout 与 session shutdown 使用完整 `TERMINATE(reason)` frame；
- 活着的 Node 在收到并验证 helper terminal、fd3 clean EOF/close、helper code 0 和全部 stdio settle 之前，绝不对 fd3 调用 `.end()`、`.destroy()` 或主动 close；
- helper读到的Node→helper EOF只表示parent loss或控制通道故障，不是活着调用方请求正常结束的方式；Node在合法terminal之前观察到EOF同样是故障。合法terminal之后，由helper主动关闭fd3而让Node观察到的clean EOF/close则属于成功收尾证据。

因此单一 fd3 足够承载 Node→helper 的 `LAUNCH_CONFIG`/`TERMINATE` 与 helper→Node 的 `READY`/`ERROR`/`EXIT`。增加 fd4 只会增加继承面、错误组合与测试成本，却不改善现行正常路径。

### 3.2 正常路径

1. Node spawn 固定 helper，立即安装 fd3、目标 stdout/stderr、helper error/exit/close listener并持续 drain；
2. Node 写入唯一 `LAUNCH_CONFIG`，但保持 fd3 开放；
3. helper 完成验证、创建 Job、原子创建 suspended target并按状态机决定 resume；
4. helper 写入 `READY` 后，Node 才允许 client 发送 ACP/RPC 请求；
5. 自然退出时，或 Node 写入一次 `TERMINATE(reason)` 后，helper 由唯一 cleanup owner 终止/等待 Job 归零；
6. helper确认Job已经归零后，写入并flush唯一`EXIT`或pre-ready `ERROR`，然后关闭fd3、Job和自身handle并自然退出；
7. Node 只有在完整验证终态、clean EOF/close、helper exit code 和 stdio settle 后才完成调用。

terminal缺失、重复、乱序、坏frame、helper非零退出或fd3在合法terminal前结束都会永久失败。失败后Node可利用spawn时已持有的`ChildProcess`/OS process handle精确终止helper并收尾stream；这项最后兜底允许底层使用该既有handle对应的终止能力，但不得读取/reopen PID、不得直接终止target，也不得把补救清理计为正常drain或PASS。

单fd3的活性合同还要求：control reader绝不能成为terminal或helper退出的join前置。helper可以把同一fd3 OS endpoint复制为内部read/write handle（这不是第二个channel），但reader必须是后台/可取消且不拥有最终进程存活权；自然Job归零时，即使reader仍阻塞等待Node输入，terminal owner也必须能够写入并flush `EXIT`，随后由helper主动关闭自己的fd3 handles并自然退出。实现可以选择已在当前宿主实测的后台reader、cancellable async I/O或helper-owned handle cancellation，但不得等待Node先close、不得用无界join形成循环等待，也不得让reader在terminal seal后发布新的状态或第二个terminal。

Task 2在当前宿主把上述选择收敛为一个可复用事实：Node为fd3使用`overlapped` extra stdio；helper从`_get_osfhandle(3)`取得endpoint并用Win32 `OVERLAPPED ReadFile/WriteFile`操作同一全双工handle。自主退出路径在`READY`后先提交1字节read，并以`ERROR_IO_PENDING`加零时`WAIT_TIMEOUT`证明读取仍pending；随后写入/flush `EXIT`且不等待该read。普通同步pipe加阻塞reader会阻断同一endpoint的terminal write，两个独立托管`FileStream`包装也不能形成可靠合同；后续production wrapper必须复用本轮已验证的overlapped carrier。

### 3.3 按观察方区分EOF、parent loss与崩溃

- helper在fd3读到Node→helper EOF时锁存`session_shutdown`/control failure：pre-create阻止创建，`CREATING`只锁存并等待launcher发布，post-create由唯一cleanup owner清Job；
- 若 Node 已死亡，不存在仍需接收 terminal 的活调用方；helper 应尽力清理并退出，不能为了写不可达 terminal 阻止关闭最后 Job handle；
- 若Node仍活着却在合法terminal前观察到helper→Node EOF，该invocation永久失败；只有terminal已完整验证后由helper主动close造成的clean EOF/close才是成功证据；
- helper 被杀时，最后 Job handle 关闭触发 `KILL_ON_JOB_CLOSE`；Node 因 terminal 缺失或 helper 非零/异常退出而失败；
- 真内核测试直接牺牲production helper的Node parent：target/grandchild创建后、牺牲Node前，由test-only外层取得并核验handle-bound creation identity并保留`SYNCHRONIZE`handles；牺牲后只等待这些既有handles，不再查找/reopen PID。删除只证明carrier的三方observer、`OBSERVER_ARMED`、watchdog-success和parent-sacrifice probe。

## 4. Windows 只执行原生 PE

helper 的 `LAUNCH_CONFIG` 不再含 `invocationKind`。它只接受绝对、规范化、存在且通过既定路径检查的 `.exe`；用绝对 `lpApplicationName` 调用 `CreateProcessW`。相对路径、`.cmd`、`.bat`、shell、URL、NUL 和过长命令行在 target 创建前拒绝。

### 4.1 Kimi

Kimi locator 在 Windows 解析并验证绝对 `kimi.exe`，helper直接启动该 PE。现有模型参数和 ACP 协议不变。

### 4.2 Pi

本机`pi.cmd`只是npm shim。Windows locator可以用shim或全局包根做发现，但shim只作为规范路径锚点：不得执行、解析或信任其中的命令文本，package root与bin关系必须由文件系统和`package.json`独立验证。locator必须：

1. 找到真实 `@earendil-works/pi-coding-agent/package.json`；
2. 验证 package name、version、`bin.pi` 与已安装路径关系；Windows上的`PI_COMMAND`若保留，只能提供shim/package位置锚点，任意`.exe`、任意脚本或无法独立还原受验证包根的覆盖值都在启动前拒绝；POSIX原有locator语义不变；
3. 将 bin realpath解析为包根内存在的 `dist/cli.js`，拒绝逃逸、reparse或字段漂移；
4. 校验当前Node满足该包声明的engine；为避免引入宽松自制semver，本轮只接受并精确解析当前包使用的`>=MAJOR.MINOR.PATCH`语法，其它合法但未实现的range语法fail closed并要求显式扩展测试；
5. 返回结构化`PiInvocation`：`executable = process.execPath`、`argvPrefix = [绝对 dist/cli.js]`和脱敏identity。adapter、doctor、`src/smoke/pi.ts`版本探针、qualification preflight与隔离/公共验收消费者都必须在自己的参数前拼接同一`argvPrefix`，不得有调用点继续把locator结果当成可直接执行的字符串。

这样helper始终只启动`node.exe`或Kimi`.exe`，可以删除`cmd.exe /c`、可信shell选择、双层转义、metacharacter注入和8191字符shell边界。canonical protocol把旧cmd limit替换为`maxNativeCommandLineUtf16UnitsIncludingNul=32767`。native `CreateProcessW`必须同时传绝对`lpApplicationName`，并把同一绝对executable作为command line首token/target `argv[0]`，再拼接`argvPrefix`和调用参数；不得让`dist/cli.js`被误吃成`argv[0]`。标准Windows native argv quoting必须覆盖空参数、空格、双引号、结尾反斜杠、Unicode和NUL拒绝；总命令行按UTF-16 code units计数，连同结尾NUL不得超过32767。

## 5. 环境与凭据边界

最终child environment由三个明确来源组成：(1)`buildChildEnvironment`只从固定系统变量白名单复制当前进程值；(2)只注入当前逻辑LLM所需的一个凭据候选；(3)adapter只加入固定、runtime-owned的非秘密键，当前Pi唯一允许项是隔离配置生成的`PI_CODING_AGENT_DIR`。Windows key比较大小写无关，输出只保留一个canonical key；跨来源发生大小写无关冲突时在spawn前fail closed，不能靠object spread静默覆盖。代理变量、其它provider secret、父进程中的`PI_CODING_AGENT_DIR`和任意未声明父环境不得穿透；runtime-owned值只来自本次隔离配置。

为避免 libuv 对缺失 Windows 系统变量做隐式父环境补值，固定白名单应覆盖当前运行时需要且父进程存在的系统 key，包括现有 PATH/PATHEXT/SYSTEMROOT/WINDIR/TEMP/TMP/USERPROFILE/APPDATA/LOCALAPPDATA/ProgramFiles 系列，以及 HOMEDRIVE、HOMEPATH、LOGONSERVER、SYSTEMDRIVE、USERDOMAIN、USERNAME。不存在的系统 key 不伪造；也不把某个 libuv 源码版本的“恰好 11 项”写成运行时精确相等协议。

Node spawn helper时使用上述三类来源合成并验证后的环境；helper创建target时继续传递该精确环境，不重新merge Node/MCP父环境。单元测试和poison-parent集成测试必须证明代理、父环境伪造的runtime key与无关凭据不泄漏，选定凭据和本次`PI_CODING_AGENT_DIR`仍可用，大小写重复不会造成漂移。任何凭据诊断只报告变量名/类别，不报告值；runtime-owned路径沿既有doctor脱敏/路径报告合同处理。

## 6. 工具链、artifact 与 resolver

保留 Task 1 已完成且稳定的部分：

- 固定 Roslyn 4.14.0 与 net48 reference assemblies 1.0.3 的 URL/摘要和完整 restore 验证；
- x64/net48、固定 flags、独占临时根、reparse/路径边界和非递归白名单清理；
- canonical protocol JSON、TypeScript codec 与临时生成 C# constants；
- source→artifact 的本机 deterministic 双根 byte compare；
- 仓库和包内唯一 helper PE、旁置 SHA-256、canonical resolver 与只读 `--probe-v1`。

删除：

- `toolchain.lock.json` 中三个 Node archive、下载/解压/摘要与顺序矩阵；
- `native:preflight:current` 和任何精确/major Node白名单；
- 把源码、历史文档或整个 npm package文件集做跨 OS raw-byte composite digest；
- `core.autocrlf=true/false` 双 checkout EOL门禁；
- partial/composite attestation、self-digest和远端 artifact fetcher。

`native:preflight`只用调用它的`process.execPath`测试完整单fd3，并记录当前`process.version`/libuv用于证据。它必须分别证明：(a) CONFIG→READY→TERMINATE→EXIT→clean close；(b) CONFIG→READY后Node不再写且保持fd3开放，probe在reader仍可能阻塞时自主EXIT→close，Node能收到terminal且进程不死锁。`--probe-v1`只验证helper可加载、协议身份和当前CLR/架构，不启动target、不读取凭据；生产每次真实launch的READY/terminal合同本身负责fail closed，不再增加每个MCP进程的一次性carrier探针缓存。

Task 2已在提交`7e03d26`实现该开发期preflight：当前Node v24.14.1/libuv 1.51.0连续10次稳定性运行通过；聚焦测试25/25通过。该数字是本机证据，不是生产版本白名单。显式`TERMINATE(cancelled)`必须在`EXIT`中回显`cancelled`，自主退出才使用`noneOrRootExit`。

resolver在每次 Windows launch前验证规范路径、无逃逸/reparse、文件存在、实际 SHA与旁置 SHA一致、唯一 x64 PE和固定 probe合同。失败时不得 fallback。

## 7. 最小充分测试

### 7.1 纯函数与状态机

- strict frame/payload/UTF-8/长度/保留位/顺序；
- native argv round-trip 与拒绝边界；
- Pi 包解析、engine与realpath；
- 生命周期全部状态×事件确定性表，显式包含create success/failure、terminate/EOF/protocol error、root-complete、job-zero与terminal-seal；
- 首错、幂等 terminate、唯一 terminal/cleanup owner。

不再用固定 2000 轮随机竞态或敌对 JavaScript对象内部测试替代状态覆盖。少量重复只用于发现真实 handle/process泄漏，不作为形式化证明。

### 7.2 当前宿主真内核

必须覆盖：

- target第一条用户指令前已归 Job；
- target只能访问复制的 0/1/2，fd3/Job/helper handle不可达，CRT reserved data为空；
- 自然 root退出、root先退而grandchild存活、显式取消、显式 timeout、session shutdown、fd3 EOF、protocol error、helper kill、Node parent death；
- Job create、set-limit、DuplicateHandle、attribute init、HANDLE_LIST update、JOB_LIST update、CreateProcess、Resume、TerminateJobObject、Query pre-zero、Query final-zero和terminal write各一个确定性fault；不恢复完整笛卡尔积；
- 当前宿主compatible nested Job。删除人工制造的incompatible UI-limit outer Job组合；Tasks 2–8不修改活动插件，因此真实Codex App Stop只在beta官方插件阶段验证，届时若真实宿主不兼容则硬停；
- 每例后已知 process/handle/temp root归零；测试 teardown只能收尾，先锁存的失败不能恢复为 PASS。

### 7.3 Kimi/Pi/stdio fake全链

从真实 MCP stdio transport进入 service→adapter→client→fake executable，证明 READY前不发业务请求，取消先走 ACP/RPC原生信号再走 owned terminate，handler/session只在Job归零和stdio settle后完成。不得调用真实模型。

Windows上的Kimi/Pi所有调用都必须经过`OwnedAgentProcess`，包括doctor、smoke与qualification preflight中的`--version`/只读诊断；不得因“不调用模型”而保留direct `execa`旁路。POSIX既有版本探针行为保持不变。

## 8. Doctor、资格与发布边界

Windows strict doctor只复用resolver并报告当前OS/Node/libuv/CLR/helper实际摘要，随后运行无target、无凭据的`--probe-v1`；非Windows报告not-applicable。完整单fd3 carrier preflight只由开发/冻结命令运行并写入发布证据，不在普通doctor中重新构建或执行，也不通过持久缓存替代。doctor是本机可用性诊断，不是跨版本认证。

能力指纹必须覆盖影响运行语义的native source、canonical protocol、构建配置和helper实际摘要；不需要覆盖历史计划、审阅稿或跨系统package-set digest。native变化会使八项能力stale，普通`verify:capabilities`与`smoke:release`继续fail closed，直到后续真实8/8形成新证据。

GitHub CI改为单一Node 24 Ubuntu job，只证明TypeScript、package、插件与OIDC发布链，不宣称Windows native兼容。Windows权威证据来自维护者当前宿主的preflight、真内核、fake全链、隔离package/plugin和最终真实Stop。

删除远端composite不等于允许任意tag立即发布。release workflow保留轻量、版本化、本地证据绑定：

- beta tag必须存在同版本`.release-validation/v<version>.md`，精确声明`Current-Host-Prequalification: pass`、`Capability-Index: pass`、runtime frozen commit、helper实际SHA和`Current-Host-Runtime-Fingerprint: <sha256>`；该fingerprint由一个确定性实现覆盖Windows native production source、TypeScript wrapper、canonical protocol、build config和helper实际digest，workflow在tagged tree重算并精确比较，同时核对tag/package版本与仓库helper/SHA；
- stable marker除既有release门禁外，必须精确声明`Public-Beta-Exact-Install: pass`、`Codex-App-Full-Restart: pass`、`Real-App-Stop: pass`、`Owned-Descendants-Zero: pass`、同一helper SHA和同一current-host runtime fingerprint，并用`RC:`绑定已公开beta；
- marker是可审计发布授权记录，不恢复Windows三shard、remote fetcher、selfDigest或跨OS package digest。

Tasks 2–8完成前不调用真实模型、不修改活动配置/插件、不发布。clean freeze后，沿既有授权执行：

1. 只为stale/缺失能力运行新的真实8/8资格并更新同一能力索引，历史batch/manifest/evidence保持不可变；
2. 推送`next`并由GitHub Actions Trusted Publishing/OIDC发布beta；
3. 从公共npm本机隔离安装，官方升级插件，完整退出并重开Codex App；
4. 真实验证Kimi、Pi、delegate以及Stop/interrupt后owned descendants归零；
5. beta所有门禁通过后，stable仍只由`main`上的GitHub Actions OIDC发布。

禁止本地`npm publish`，禁止跳过失败门禁，禁止直接读写活动`~/.codex/config.toml`。官方插件变更只在既有逐次授权与回滚协议下进行。

## 9. 删除项总表

| 删除/降级事项 | 原因 | 替代证据 |
| --- | --- | --- |
| Node 20/22/24 archive与矩阵 | 与当前宿主目标无关且锁定24版本不等于本机版本 | 当前`process.execPath` preflight与本机验收记录 |
| fd3+fd4 split | 正常路径不再half-close | 单fd3显式frame、terminal后helper close |
| `.cmd/.bat`执行 | 本机Pi可直接由Node运行JS，Kimi是PE | Pi package/bin验证与native argv测试 |
| 11项libuv精确相等/漂移协议 | 绑死特定libuv源码实现 | 固定系统allowlist、case-fold与poison-parent测试 |
| 2000轮竞态、完整故障笛卡尔积 | 成本高且弱于确定性状态/事件覆盖 | 状态表+barrier+每公共失败分支代表 |
| 人工不兼容outer Job | 不代表真实本机宿主 | 离线current-host compatible nested Job；beta后真实App Stop |
| 三方parent-sacrifice carrier observer | 证明载体而非真实owned tree | production helper parent-death真内核测试 |
| Windows CI三shard/composite attestation | 用户不要求跨版本/跨机器声明 | 单Node JS CI+当前宿主权威证据 |
| 全package raw-byte/EOL双checkout证明 | 与运行鲁棒性关联弱 | helper实际hash、exact package inclusion与隔离安装 |
| 多层candidate/core/prequalification wrapper | 重复同一release core | 一个本机prequalification入口+普通release smoke |

## 10. 完成判定

只有同时满足以下条件，本规格的离线实现阶段才完成：

1. 当前宿主单fd3 preflight通过，旧half-close路径不进入生产；
2. Windows helper满足原子Job归属、唯一owner、句柄/环境隔离和无预算限制；
3. Kimi直接PE、Pi直接Node+已验证cli.js，不存在production cmd/direct-spawn/PID fallback；
4. 当前宿主真内核、parent/helper crash、fake Kimi/Pi/stdio与current-host compatible nested Job测试通过且无残留；真实App Stop只在beta后门禁执行；
5. helper artifact、SHA、resolver、doctor、package、能力指纹与单Node workflow闭合；
6. 全量离线/隔离验证通过，工作树clean并由独立规格、质量审阅收敛；
7. 能力索引仍因预期stale而fail closed，真实模型、活动插件和公开发布尚未发生。

随后发布阶段仍以真实8/8、beta、本机公共安装/官方插件/完整重启/真实Stop、stable的顺序完成，不因本次删减而弱化。
