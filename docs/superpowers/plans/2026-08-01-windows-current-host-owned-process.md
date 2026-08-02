# Windows 当前宿主 Owned Process 精简实施计划

日期：2026-08-01

状态：**现行计划**

**目标：** 在维护者当前 Windows 10 x64、Node v24.14.1、.NET Framework 4.8 环境上，用固定 native helper为每次Kimi/Pi invocation建立原子Job ownership，并删除与本机目标无关的三Node矩阵、split channel、`.cmd`执行、跨OS证明链和高成本重复测试。

**现行规格：** [Windows 当前宿主最小可靠 owned process 设计](../specs/2026-08-01-windows-current-host-minimal-design.md)

**历史基线：** Task 1提交`88cf22b`与文档提交`b575dd9`有效保留；旧Task 2的单fd3 write-half-close失败由`0bb610e`保存。旧14项计划只作为历史，不再指导Task 2以后实现。

## 1. 执行边界

- 使用分支`codex/stdio-lifecycle-and-native-budget`与当前隔离worktree。
- Task 2–7均使用TDD：先新增能证明旧行为失败的测试，再做最小生产实现。
- 子智能体继续驱动实现，但按风险分层审阅：Task 3–5分别经过fresh规格审阅与fresh质量审阅；Task 6–7各由一位fresh综合审阅者同时核对规格和质量；Task 8只做一次fresh集成终审。每项仍由主代理复验并单独提交，子智能体写入范围不得重叠。
- Tasks 2–8不调用真实Kimi/Pi/Ark模型，不读写活动`~/.codex/config.toml`，不变更活动插件，不发布、不push、不打tag、不本地`npm publish`。
- 不给外部CLI设置默认或持久化step、turn、tool-call、context、token、duration、CPU、内存或进程数限制。局部测试止损只可终止测试自身，不能成为production drain deadline。
- Windows production禁止PID reopen、WMI、`taskkill`、进程扫描、direct-spawn和自动fallback。任一前置失败即fail closed。
- `capabilities.json`在Task 8 clean freeze之后的新真实资格前保持原样；普通verifier必须只因八项runtime fingerprint stale而非零。

## 2. Task 1：历史工具链与协议基线（已完成）

保留：

- exact Roslyn/net48 NuGet identity、restore完整性、独占临时root、reparse/路径/清理边界；
- x64/net48固定编译参数、source-set配置、canonical protocol JSON与TypeScript codec；
- 现有23项Task 1测试和提交`88cf22b`。

Task 2只删除其中与新目标冲突的Node archive矩阵和`invocationKind`协议字段，不重写Task 1历史结论。

## 3. Task 2：当前宿主单fd3与native-only合同

**状态（2026-08-01）：** 已由提交`7e03d26`完成。最终实现使用Node `overlapped` fd3和Win32 `OVERLAPPED ReadFile/WriteFile`；自主路径在`READY`后建立pending-read barrier，再写`EXIT`且不join。当前宿主连续10次preflight、聚焦25/25、类型检查和diff check均通过；两轮规格/质量复审最终PASS。

### 3.1 RED

先新增/修改测试证明：

- `toolchain.lock.json`仍含`nodeArchives`，restore/runner仍有下载/矩阵路径；
- package script仍有`native:preflight:current`或精确Node白名单；
- protocol仍含`invocationKind`和cmd长度字段；
- 当前宿主还没有真实C# `_get_osfhandle(3)` 的CONFIG→READY→TERMINATE→EXIT→clean close probe；
- 当前宿主还没有证明CONFIG→READY后Node保持fd3开放且不再写时，reader仍可能阻塞的probe可以自主EXIT→close而不死锁；
- Task 2 preflight harness保持fd3开放到terminal/helper close；故障夹具人为造成terminal前close时，harness必须判为永久失败。测试不再把某个libuv版本对half-close的具体动态结果作为门禁。正式wrapper的同类生产合同留到Task 5。

### 3.2 GREEN

- 从lock、restore、runner和测试删除三个Node archive及下载/解压/顺序矩阵；保留NuGet工具链完整性。
- `native:preflight`只使用当前`process.execPath`，在脱敏报告中记录当前Node/libuv；删除`native:preflight:current`。
- canonical protocol删除`invocationKind`和8191字符cmd shell限制，新增`maxNativeCommandLineUtf16UnitsIncludingNul=32767`；`LAUNCH_CONFIG`只承载绝对native executable、cwd与argv。
- 新C# probe只使用fd3全双工，不创建Job/target、不读取环境/凭据；Node正常路径保持fd3开放直到terminal与helper close。
- probe同时覆盖显式TERMINATE路径与自主terminal路径；自主路径必须在Node保持fd3开放且不再写时由helper主动EXIT/close，terminal/进程退出不得join或等待control reader EOF。
- 覆盖short reads、分片/合并frame、并发nonce、terminal前EOF/close/error和helper异常退出。
- 禁止新增fd4、application-managed named pipe或runtime carrier缓存。

### 3.3 验证与提交

```powershell
npx vitest run test/native/native-build-contract.test.ts test/native/fd3-control-preflight.test.ts test/runtime/windows-job-protocol.test.ts
npm run native:preflight
npm run typecheck
git diff --check
```

提交：`feat: validate native Windows control on current host`

## 4. Task 3：严格协议、native argv与生命周期状态机

**状态（2026-08-01）：** 已由提交`a6930d9`完成。严格C#/TypeScript协议边界、Windows native argv构造与纯生命周期状态机已经实现；`ResumeThread`未成功时允许无`READY`的`ERROR`，一旦resume成功则即时退出或失败也必须遵守`READY → EXIT/ERROR`屏障。最终原生托管测试3套/53例、跨层聚焦3文件/26例、当前宿主preflight 5例、类型检查、diff check与临时构建根归零均通过；fresh规格与质量复审最终均为PASS/Ready。

### 4.1 RED

- strict frame/config/terminal状态测试先失败；
- 标准Windows argv的空参数、引号、尾反斜杠、Unicode、NUL和总长度边界先失败；
- `.cmd`/`.bat`/相对executable必须在create前拒绝；
- 生命周期全部可达状态转移与关键非法事件先失败，显式包含create结果、CREATING期间的terminate/EOF/protocol-error、root-complete、job-zero、重复terminate和terminal-seal后事件；不建立不可达组合的笛卡尔积。

### 4.2 GREEN

- 实现方向允许但同fd3的`ControlProtocol.cs`，复用canonical JSON生成constants。
- 实现只面向native PE的`WindowsCommandLine.cs`，固定绝对`lpApplicationName`；command line首token必须是同一绝对executable/target `argv[0]`，再拼接业务argv，不实现shell quoting。总长按UTF-16 code units并连同NUL限制为32767。
- 实现纯`LifecycleMachine.cs`：launcher唯一发布create结果，control reader只锁存首个disposition，唯一cleanup owner和唯一terminal。terminal seal后reader不能发布新状态。
- 设计同一fd3内部read/write ownership：reader不拥有最终进程存活权，terminal/自然退出绝不依赖reader EOF或无界join；采用的后台/可取消I/O机制必须由当前宿主管理测试证明。
- terminal、EOF、helper close与首错优先级精确映射为固定脱敏错误。
- 全部可达状态转移确定性枚举，并单列关键非法事件；不枚举不可达笛卡尔积，不使用2000轮随机循环。

### 4.3 验证与提交

```powershell
npm run native:test:managed
npx vitest run test/native/native-build-contract.test.ts test/native/fd3-control-preflight.test.ts test/runtime/windows-job-protocol.test.ts
npm run native:preflight
npm run typecheck
git diff --check
```

Windows command line与生命周期纯状态机由`native:test:managed`中的C#测试覆盖；不再维护仅重复同一实现的独立TypeScript镜像测试文件。

提交：`feat: implement native helper protocol and lifecycle`

## 5. Task 4：Win32 Job、句柄隔离与真实kernel helper

**状态（2026-08-01，已完成）：** 第一批提交`b590e21`建立x64 Win32 ABI/SafeHandle、`CREATE_SUSPENDED + HANDLE_LIST + JOB_LIST`原子创建、仅复制0/1/2、`KILL_ON_JOB_CLOSE`、resume/READY门控与严格build入口；完成提交`6d8c585`增加单fd3 OVERLAPPED control loop、唯一cleanup/terminal、自然root+grandchild drain、完整故障代表和helper/Node parent两条真实崩溃回收。production carrier只保留natural、cancel、post-READY EOF与malformed四条独立因果路径；`timedOut`和`sessionShutdown`的真实producer分别留给Task 5/6，service/handler late-spawn/no-rebirth也由Task 6一个跨adapter共享代表负责。最终当前宿主preflight 5/5、managed 5套76例（测试替身竞态修复后额外连续5轮全绿）、kernel 2套24例（含crash 2例）、production carrier 4例、TypeScript聚焦14/14、全库61文件988 passed / 1 skipped、类型检查、格式/diff检查、临时根与仓库artifact归零均通过；fresh规格与质量复审最终PASS/Ready。未调用真实模型，未读写活动配置，未变更插件或发布，也未增加外部CLI默认/全局限制。

### 5.1 RED

先建立当前宿主真内核fixtures和fault hooks，证明以下合同尚未满足：

- `CREATE_SUSPENDED + HANDLE_LIST + JOB_LIST`同次原子创建；
- marker在resume前不存在，target从第一条用户指令起已在Job；
- target只能访问复制的0/1/2，`cbReserved2=0/lpReserved2=NULL`；
- production `Program` carrier用最小独立路径证明：natural root+grandchild、一个合法cancel代表、post-READY fd3 EOF、post-READY malformed frame；后两者分别证明真实transport failure与protocol failure接到真实Job drain。EOF允许terminal不可达但绝不能判成功；malformed必须得到唯一`ERROR`后clean close；
- managed protocol/lifecycle/coordinator参数覆盖`cancelled`、`timedOut`、`sessionShutdown`全部reason；真内核只用一个合法stop代表验证同一Terminate/Query/zero路径，不复制同构reason case。helper kill与Node parent death仍分别证明崩溃回收；
- 自然root/Job归零而Node保持fd3开放时，helper仍能terminal→close→exit，阻塞reader不造成死锁或重复terminal；
- helper-kill与Node-parent-death两案共用一个test-only outer Job，并在outer handle仍开放时以case-owned双锁释放、Node witness signal和outer `ActiveProcesses=0`证明inner tree归零；这同时构成当前宿主compatible nested Job代表，不再新增第三案。真实Codex App Stop留到beta官方插件阶段，不在禁止活动插件变更的Tasks 2–8伪测；
- Job create、set-limit、DuplicateHandle、attribute init、HANDLE_LIST update、JOB_LIST update、CreateProcess、Resume、TerminateJobObject、Query pre-zero、Query final-zero和terminal write各一个确定性fault并fail closed。

### 5.2 GREEN

- 实现最小Win32 ABI、SafeHandle/RAII、`JobSession`和production helper。
- Job只设置`KILL_ON_JOB_CLOSE`，无其它Job limit；helper是唯一Job owner。
- fd3和Job在target创建前清除继承；target只收到duplicated stdio。
- CREATING交错遵循Task 3状态机，不存在未归属running或suspended child。
- 现有kernel runner直接充当外层，不新增observer可执行文件：它用真实`JobSession`把牺牲用Node原子放入只含`KILL_ON_JOB_CLOSE`的test-only outer Job，并把唯一outer handle保留到PASS之后。Node suspended后同一个新outer必须严格只有1个成员；随机case-root中的fixture root/grandchild各以`CreateNew`、nonce内容和`FileShare.None`持有全生命周期双锁；真实helper `READY`/armed且双锁明确sharing violation后，Node/helper/root/grandchild四个语义角色仍存活，故动作前`ActiveProcesses >= 4`，当前宿主实测8只记录为观测值，不固定为门禁也不保留pre-CONFIG诊断握手。释放后双锁必须成功独占打开并核验nonce。helper-kill只由Node用spawn时保留的`ChildProcess`/libuv handle执行，并核验kill成功、helper close和Node固定成功退出码；parent-death只用CreateProcess时已保留的Node process witness以固定test code执行。动作后同时要求Node witness signal、双锁释放以及仍开放outer Job的`ActiveProcesses=0`；不报告/读取/reopen PID，不增加`OpenProcess`、creation-time身份通道、三方observer或独立nested Job case。失败先锁存，`finally`关闭outer只作救援，永不计PASS。
- C# helper的production source/API扫描拒绝target cleanup使用`AssignProcessToJobObject`、`TerminateProcess`、WMI、taskkill、breakaway、direct-spawn和production fault hook。Node仍可在调用已永久失败后，通过spawn时保留的`ChildProcess`/OS handle最后终止helper；不得PID reopen、不得直接终止target、不得把该兜底计入PASS。
- 每个确定性barrier少量重复检查资源泄漏；不构造人工incompatible UI-limit outer Job。

### 5.3 验证与提交

```powershell
npm run native:test:kernel
npm run native:test:managed
npx vitest run test/native/native-build-contract.test.ts test/native/fd3-control-preflight.test.ts --maxWorkers=1
npm run native:preflight
npm run typecheck
git diff --check
```

逐例核对process、retained handle和temp root回到基线。

提交：`feat: own Windows targets with a job helper`

## 6. Task 5：artifact、resolver与OwnedAgentProcess

**状态（2026-08-01，已完成）：** 提交`7ab9b0b`建立唯一x64/net48 helper artifact与严格SHA清单、单次重编译`native:verify`、只接受dist/plugin布局且逐级拒绝reparse/hash/PE漂移的resolver，以及不暴露PID和默认执行预算的Windows `OwnedAgentProcess`。wrapper以单fd3传CONFIG/TERMINATE并严格等待READY、合法terminal、clean control close、helper exit和三路stdio settle；terminal后故障由保留的ChildProcess handle精确救援，termination reason接受精确回显或已先发生的自然完成竞态。artifact更新在任何写入前拒绝partial/extra/reparse状态，第二步失败会逐字节恢复旧pair或首次安装空状态。Windows child env按大小写无关唯一键和固定identity白名单fail closed，POSIX则完整保留旧的exact-first/case-insensitive-fallback及覆盖语义。最终`native:verify`固定SHA `c9bc5cddf77e6385c6a9971b7bf4d4cf5bd697f498fa80c2f1c9ec7c706d8dfa`；审计修复前全库65文件1021 passed / 1 skipped，最终影响范围52/52及后续env 18/18、类型与diff检查通过；两位fresh终审修复后均PASS。没有真实模型、活动配置/插件、发布、三Node矩阵、新POSIX抽象或外部CLI默认/全局限制。

### 6.1 RED

- 单一独占临时根source→artifact compare、仓库唯一exe/SHA、resolver静态path/hash/PE测试先失败；Vitest只读artifact/resolver且不触发build或probe，唯一重编译入口是`native:verify`；
- Windows wrapper仍不能以单fd3传递target stdio和terminal；
- environment poison与case-fold测试先失败。

### 6.2 GREEN

- 用Task 1工具链在一个独占、已验证临时根生成唯一x64/net48 helper，并与仓库artifact做一次byte compare；不再为路径可复现性构造第二个build root。
- production resolver每次launch拒绝escape、reparse、hash mismatch、非x64和重复artifact，然后直接启动真实helper；它不另起`--probe-v1`。CLR/load/protocol失败由真实launch fail closed，`--probe-v1`只留doctor、冻结与公共包/插件安装验收。
- 定义不暴露PID的`OwnedAgentProcess` handle/type，但本Task的production实现只做Windows helper；POSIX既有direct spawn与process-group cleanup保持原样，不新建`posix-owned-agent-process`抽象、集成矩阵或认证。Task 6改动client时只跑既有POSIX回归确认没有漂移。
- Windows wrapper spawn `stdio: ["pipe", "pipe", "pipe", "overlapped"]`；fd3复用Task 2已验证的Win32 OVERLAPPED全双工carrier，正常路径不half-close fd3。
- 正式wrapper合同测试必须证明terminal前不调用`.end()`、`.destroy()`或主动close fd3；terminal前EOF/close/error永久失败，合法terminal后的helper clean close才能完成。
- Windows `OwnedAgentProcess`真实集成只保留两个代表：自然退出证明wrapper成功路径；显式调用级timer真实触发一次`TERMINATE(timedOut)`，证明Task 5唯一新增的reason producer及reason echo、helper terminal/close、stdio settle与case-owned Job-zero。reason echo允许原生层在late ordinary termination竞态中返回`noneOrRootExit`并优先判定自然完成，其它非预期termination reason仍fail closed。测试watchdog只作teardown，不充当production deadline；不重复Task 4的cancel/EOF/malformed/crash/fault矩阵。
- helper terminal + fd3 clean close + helper code 0 + stdio settle + Job-zero构成成功；任一异常永久失败。
- Windows environment fixed allowlist增加必要系统key并case-fold去重，只保留选定credential；poison parent不得泄漏proxy或其它secret。
- 不增加production one-time carrier probe缓存；真实launch READY与terminal本身fail closed。

### 6.3 验证与提交

```powershell
npm run native:verify
npx vitest run test/native/native-build-contract.test.ts test/native/windows-job-helper-artifact.test.ts test/runtime/windows-job-helper.test.ts test/runtime/windows-owned-agent-process.test.ts test/runtime/windows-owned-agent-process.integration.test.ts test/runtime/environment.test.ts --maxWorkers=1
npm run typecheck
git diff --check
```

提交：`feat: launch Windows agents through verified ownership`

## 7. Task 6：Kimi、Pi与stdio接线

**实施裁决（2026-08-01）：** 现有两个client在业务完成后都会无条件PID-tree kill，Pi fake还用`setInterval`阻止自然退出；机械替换成`await owned.closed`会永久等待，而把成功收尾伪装成`cancelled`又会污染terminal语义。现行最小合同固定为：成功路径先结束target stdin/协议输入，让CLI自然退出并只接受`root_exit`；取消、显式调用级timeout与stdio shutdown才先发送ACP cancel/Pi abort，再分别请求对应owned termination。离线fake必须锁定stdin EOF自然退出；公共beta阶段必须验证真实Kimi/Pi相同行为。若真实CLI不响应EOF，发布门禁应失败并回到设计，不得增加默认timeout、PID/taskkill fallback或把completed映射成cancelled。

实现按最小依赖顺序拆为：定位器与Pi runtime env → Windows client owned接线 → stdio关闭准入/session reason/no-rebirth → 只读doctor/smoke/preflight消费者 → qualification新schema与全机scanner删除 → acceptance/PID/taskkill遗留收口。各子批只跑影响范围；Task 6结束后才运行一次全量回归。

**第一子批状态（2026-08-01，已完成）：** 提交`3ab1743`建立严格Windows Kimi executable与Pi package invocation验证，并通过既有child-env白名单注入唯一Pi runtime目录。独立审查后删除不可达containment假覆盖、父环境整表复制与可写类型漂移；Windows真实文件系统用例只在当前Windows宿主运行，POSIX回归继续供单Node Ubuntu workflow执行。最终聚焦57/57、类型与diff通过。consumer仍暂留旧接口，下一子批必须完成client/adapter迁移后再删除Windows legacy string路径。

**第二子批状态（2026-08-01，已完成）：** 提交`564bbcb`在工具handler构造前执行factory式准入；首次stdio/signal/显式close同步关闭准入并以固定`session_shutdown` abort独立signal，然后才关闭server、drain既有任务和清理listener。SDK request abort仍为独立signal，service已把两者原样传给adapter；关闭后不得晚启handler/service。未使用`output`已机械删除，无client行为或timeout变化。主线程73/73、fresh复审79/79、类型与diff通过。下一子批由Kimi/Pi client消费该shutdown signal并把reason精确映射到owned termination。

**第三子批状态（2026-08-02，clients已完成）：** 提交`a81e3fa`与`d2030b4`让Kimi/Pi的Windows client只通过`OwnedAgentProcess`运行；成功路径结束协议stdin并只接受自然`root_exit`且code 0，caller取消、显式调用级deadline与stdio shutdown分别锁存reason并请求一次Job终止，内部协议/decoder/business失败则立即以内部cleanup reason drain但公开保持`failed`。两条client都在spawner pending窗口、pre-READY、应用层cancel/abort写入永不settle、自然退出竞态、helper/closed/drain失败和spawn失败上fail closed；只有应用层取消写入是best effort，私有Job控制通道从不等待它。Windows测试不读取PID，POSIX旧direct spawn/process-group路径保留。三轮交叉审阅依次修复了预中止晚启、READY/pipe write挂死、协议失败误走成功EOF、Pi incomplete JSONL漏报、abort response伪诊断、POSIX pending未拒绝和nonzero root误判成功；最终Kimi 19/19、Pi 46 passed / 1 POSIX-only skipped，主线程类型与diff通过。

**第四子批状态（2026-08-02，adapter、telemetry与doctor已完成）：** 提交`10da9dc`让adapter传递独立shutdown signal，Windows Pi只接受经校验的`process.execPath + 单一绝对CLI入口`，凭据脱敏值从最终child environment提取；提交`e422ce5`增加`ownedProcessDrained?: true`，它只在本次Windows Job的`closed`成功证明`ownershipDrained === true`后出现，业务失败与排空事实保持正交，POSIX/no-spawn/closed失败不误报；提交`52be40e`把doctor改为targetless当前宿主静态诊断，仅对严格helper执行一次无凭据`--probe-v1`，并让MCP注册、doctor和npm acceptance共用唯一静态工具定义。独立复审修复了Windows验收接受伪Linux `not applicable`、工具硬编码伪绿、Ark负例只命中hash drift及helper路径泄漏；最终adapter/stdio聚焦25/25、telemetry 66 passed / 1 POSIX-only skipped、doctor/MCP/acceptance 30/30与类型/diff通过。smoke/preflight、qualification新schema、scanner删除及public acceptance遗留仍待后续子批。

**第五子批状态（2026-08-02，smoke owned evidence已完成）：** 提交`3daff2b`把当前Kimi/Pi smoke producer统一升级为evidence schema v4，删除直接目标`--version`探针、`tasklist`/WMI/`pgrep`全机快照、PID计数与`process_residual`结论。四种runtime/task组合只接受精确完整的业务检查集合，并要求一次adapter调用、零retry/auto-retry、无fallback及本次调用`ownedProcessDrained:true`；业务失败仍可独立记录排空事实。历史v2/v3只读类型保留，current资格consumer尚未升级前必须继续fail closed。最终5个聚焦文件141/141、类型与diff通过，fresh只读复审PASS。下一子批按artifact protocol v3/evidence v4迁移preflight、checkpoint、manifest、verifier、capability index与coordinator，再删除全机scanner。

**第六子批状态（2026-08-02，资格协议与scanner接线已完成）：** 提交`754a796`建立current preflight/checkpoint/manifest schema v3与evidence v4，历史schema v1/evidence v2及schema v2/evidence v3继续严格验证；共享current evidence contract在ledger写checkpoint前、immutable verifier和capability index三处统一校验四种runtime/task精确checks、owned drain、结果文件与命令诊断，runner不能用伪`passed:true`生成promotionEligible terminal。preflight只记录Node/Codex版本，Windows静态Pi检查与adapter同为`process.execPath + 单一绝对CLI`，不启动目标；coordinator/gate删除全部全机扫描，lock recovery只用owner PID+start identity并可按磁盘协议把历史未终结schema2批次关闭为interrupted。review producer同时删去冗余`commandCount:0`，真实四LLM×两任务八种生产形状直接通过共享contract。终审三轮修复伪passed、历史恢复、scanner类型残留及review形状漂移后PASS；主线程最终12文件416 passed / 1 POSIX-only skipped、类型/diff通过。公共npm acceptance的最后两次全机扫描与runtime scanner文件本身仍待下一子批删除。

**第七子批状态（2026-08-02，公共验收scanner已删除）：** 提交`7823d47`删除公共npm acceptance开始/结束的全机Kimi/Pi/real-smoke枚举，并移除`src/runtime/agent-processes.ts`及其专用测试。公共包验收现在只核对它实际拥有的MCP transport显式关闭、资格锁缺席、隔离临时目录最终删除，并要求已安装包存在native helper与SHA边车；已安装`doctor`继续严格校验hash、x64 managed PE并执行无target的`--probe-v1`。报告不再伪称用户整机idle，明确不扫描或约束其它Kimi/Pi进程；qualification lock owner PID+start identity与Job-owned drain保持不变。聚焦31/31、类型、library build与diff通过，fresh只读复审PASS。

**第八子批状态（2026-08-02，旧本地验收与跨环境checkout已退役）：** 提交`33b70a2`删除`acceptance:local`的package script、真实模型脚本、source/build entry与专用测试；该旧入口包含600秒SDK等待、模型重试和整机进程扫描，已被能力资格及beta后的真实App验收覆盖。公共npm acceptance内联保留installed MCP精确工具集合、`llm`必填和安全注解合同。`native-build-contract`同时删除`core.autocrlf=true/false`两套合成Git checkout；精确`.gitattributes`、真实helper目录闭包、字节SHA、MZ/PE/x64/managed身份、resolver与pack校验不变。聚焦28/28、类型、library build与diff通过；fresh差异复审在项目记忆同步后PASS。

### 7.1 RED

- Kimi/Pi Windows路径仍依赖direct spawn、PID terminator或`pi.cmd`执行的合同测试先失败；
- Pi locator尚不能从当前安装解析/验证package name/version/bin/realpath/engine并返回结构化`PiInvocation`；
- stdio真实fake链尚不能证明handler/session只在owned tree归零后settle；

### 7.2 GREEN

- Kimi locator返回绝对`kimi.exe`并由`OwnedAgentProcess`启动。
- Pi locator可用shim做发现但绝不执行或解析shim命令文本；Windows `PI_COMMAND`只作可验证package位置锚点，拒绝任意可执行覆盖。返回结构化`PiInvocation { executable: process.execPath, argvPrefix: [cliJsRealpath], identity }`并验证name/version/bin/engine/realpath。
- adapter和需要真实启动目标的consumer消费结构化invocation并拼接`argvPrefix`；doctor与smoke的冗余Kimi/Pi `--version`/诊断探针直接删除，doctor只做严格locator、配置与native helper静态诊断。任何仍必要的Windows目标启动都必须走`OwnedAgentProcess`，不得保留direct `execa`旁路；POSIX最小回归不漂移。
- 删除production `.cmd/.bat`、`cmd.exe`、shell quoting和Windows PID tree cleanup。
- 两个client只在READY后发协议请求；取消先发送ACP/RPC原生cancel/abort，再走一次owned terminate。
- 省略`timeoutMs`不创建deadline；显式timeout只属于该次调用；finally等待owned close无总截止。
- child environment用case-insensitive builder合成固定系统键、唯一credential和固定runtime-owned键；Pi本次隔离配置生成的`PI_CODING_AGENT_DIR`必须保留，父环境同名/变体、proxy与其它secret不得穿透，跨来源冲突fail closed。
- stdio end/close/error与SIGINT/SIGTERM共享幂等shutdown，业务错误优先、cleanup错误作为secondary附加；即使业务原本成功，只要cleanup失败，整个调用仍必须失败。
- 从真实MCP stdio end/close（或固定代表事件）触发幂等session shutdown，验证wrapper只发送一次`TERMINATE(sessionShutdown)`、terminal echo、handler等待owned drain与stdio settle；不得用Task 4 `Program`直接写`reason=3`冒充stdio source路径。
- 每个fake adapter只新增正常完成、一次取消或stdio shutdown，以及一个代表性descendant归零的真实stdio全链；helper/parent崩溃、单次invocation的owned tree回收与故障矩阵由Task 4真内核测试唯一负责，不按Kimi/Pi重复。Task 6另保留一个跨adapter共享的service/handler late-spawn/no-rebirth代表，证明shutdown或abort后不能晚启新helper或重生新invocation。不调用真实模型。
- 每个qualification case把本次`OwnedAgentProcess`的合法terminal、Job `ActiveProcesses=0`与stdio/helper settle形成case-owned drain证据；协调器只能在验证该证据后发布case终态。preflight、case前后检查、公共npm验收和lock recovery删除全机WMI/`ps` zero前置，不因无关Kimi/Pi/旧插件进程失败。
- lock recovery先验证qualification lock owner identity与不可变ledger状态；owner死亡后的target回收依赖已经证明的`KILL_ON_JOB_CLOSE`合同，不读取/reopen PID，也不以全机命令行匹配代替owned证明。删除现行runtime全机scanner及只验证它的测试，但保留历史记录codec。
- 新current preflight使用新schema并不再生成`targetProcesses`；历史v1/v2 preflight、manifest与case evidence中的`targetProcesses`只按旧schema严格读取，绝不改写。verifier继续验证历史不可变性，新producer、coordinator与recovery不得重新消费旧全机计数作为当前证明。
- 现有provider `KeyedLimiter`与`maxConcurrency`合同保留；它只调度本MCP进程内共享provider池，不设置或持久化外部CLI的step、turn、tool、context、token或执行时长上限。

### 7.3 验证与提交

```powershell
npx vitest run test/adapters/kimi/client.test.ts test/adapters/kimi/client-cleanup.test.ts test/adapters/pi/locator.test.ts test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts test/cli/doctor.test.ts test/qualification/preflight.test.ts test/smoke/pi.test.ts test/smoke/kimi.test.ts test/mcp/stdio-process-cleanup.test.ts test/mcp/stdio-session.test.ts test/mcp/in-flight.test.ts
npm run typecheck
git diff --check
```

提交：`refactor: run Windows agent clients through owned processes`

## 8. Task 7：最小发布闭包

### 8.1 RED

- doctor、npm/plugin exact inclusion和public-package fixture尚不认识helper/SHA；
- capability fingerprint尚未复用唯一canonical runtime-input manifest/digest；
- release workflow尚未实现beta当前宿主marker和stable公共beta/完整重启/真实Stop/owned-zero marker；
- 当前宿主冻结、能力验证与tag workflow尚未复用同一runtime-input digest，且计划中仍存在重复的prequalification wrapper；
- EOL双checkout与旧`acceptance:local`已删除，但插件文档测试仍锁定当前beta、branch、date、测试数量与长段措辞；
- `engines >=24`、tsup `node24`与单Node 24 workflow已经收敛；剩余npm文档清单仍把历史计划/审阅页当产品必需文件；
- CI/release已无artifact往返；native sourceSets与npm文档清单仍有重复真值源；
- npm仍把整个`dist`作为公开运行面：未消费的`qualification` entry、仓库内部acceptance/smoke/release入口、无公共类型入口的声明/映射和仅release assurance使用的`commonmark`生产依赖尚未收敛；
- CI/release在同一job内通过`pretest`与`smoke:release`重复build，release smoke已检查pack后workflow又重复pack并上传无人消费的完整dist/runtime；
- 多项测试仍扫描脚本/tsup/计划Markdown的精确源码文本或锁定当前beta、branch、date与Windows条件测试数量；README与operations仍重复维护易变的活动安装、历史批次和执行合同。
- `src/tasks/schemas.ts`仍有历史固定prompt/context字符上限，workspace evidence还在200,000字符静默截断Git上下文，Pi隔离模型定义仍固定`contextWindow`/`maxTokens`；必须先根据当前Pi schema与当前Ark路线区分“必需的真实容量元数据”和“会削弱外部CLI原生能力的保守限制”，只删除后者，不能把未经证实的数值继续当全局默认。

### 8.2 GREEN

**提前完成的冗余闭包（2026-08-01）：** 提交`548cc01`已删除公开MCP schema中无依据的prompt/context/acceptance-criteria字符与数量魔数，并用阈值+1、尾部sentinel、service逐字透传和MCP schema测试锁定，聚焦60/60；提交`06f5d4e`又删除Git status/diff的200,000字符静默裁剪，真实超阈值尾部sentinel聚焦4/4完整保留。Pi容量字段经本机0.80.10随包源码确认会真实影响API `max_tokens`、输出预算和compaction，不能机械删除；现有值只作为历史真实调用已接受的配置保留，不宣称最大容量已证明。

**单宿主发布冗余复核（2026-08-02，只读）：** Node工作已收敛为`engines >=24`、tsup `node24`和单一Node 24 workflow，不恢复三版本矩阵。后续实现按风险拆分：先退役旧`acceptance:local`真实模型入口和双`core.autocrlf` checkout；再移除离线release smoke中的`npm view`、未消费CI/release artifacts与重复build/pack；随后以`package.json.files`为唯一包面声明，停止打包历史审阅稿/计划与整棵evidence树，只保留当前能力索引精确引用及native helper/SHA；最后用可执行marker verifier同时约束beta的当前宿主冻结证据和stable的公共beta精确安装、完整App重启、真实Stop与owned-zero。现行prerelease workflow会跳过validation marker，且npm files尚未包含native helper，这两项是必须补的非冗余发布阻断，不得随清理一起删除。

**离线门禁子批状态（2026-08-02，已完成）：** 提交`a060f3f`把CI与release收敛为单一Node 24、单一`gate:offline`和每job一次build；删除重复build/pack、未消费artifact及release smoke中的npm registry名称探测。Codex CLI精确版本只保留在`package.json.config.codexCliVersion`一个真值源，workflow运行时读取并验证；发布前版本查询只有明确E404可进入publish，其它认证、网络、TLS、5xx或异常输出全部固定脱敏失败。`prepublishOnly`复用完整离线门禁，helper/SHA现在精确进入npm包并由strict resolver验证hash、x64 managed PE与目录闭包。聚焦187/187、类型、library build、strict helper、`npm pack --dry-run --json`与diff均通过。该提交只关闭门禁执行冗余；beta/stable可执行marker、exact package closure与已安装helper验收仍是发布阻断，不能据此发布。

**精确npm包面子批状态（2026-08-02，已完成实现）：** `package.json.files`已经成为唯一包面声明，精确列出23个仓库文件；真实`npm pack`只有这些文件与npm隐式`package.json`共24项。公开dist只保留CLI/MCP；能力资格只打包当前索引与其直接引用的manifest/evidence；不再发布内部entry、声明/source map、历史计划或审阅稿，`commonmark`移为开发依赖。已安装包验收逐字比较仓库与安装后能力索引，并复核source hash与batch case身份。fresh审阅发现并修复祖先Windows junction缺口：全部声明文件现逐级拒绝symlink/reparse，且realpath必须仍为仓库内的同一目标。主线聚焦181/181、类型、build、exact pack与diff通过；全库Vitest一次运行在既定240秒test watchdog内未取得终态、无失败输出且无残留进程，因此不记为PASS且不提高或重跑；release smoke按预期在八项现有stale资格处fail closed。下一子批只实现canonical runtime-input digest与严格release marker，不改能力索引、不调用真实模型。

**Canonical runtime-input子批状态（2026-08-02，已完成实现）：** 新增唯一内存manifest schema1，固定包含production build/generated protocol合同、protocol投影、只从`build.config.json#sourceSets.production`派生的9个C#源、4个Windows TypeScript wrapper和helper实际字节SHA；不建立第二份C#清单，也不纳入tests/fixtures/toolchain/generated文件/docs/evidence/marker/CI/POSIX/host值。纯helper inspector由production resolver与release/qualification共同复用。serializer/digest对unknown执行固定重投影，拒绝对象或数组proxy、getter、symbol、extra、missing、duplicate、sparse、路径/SHA不一致。能力指纹升为schema2并注入同一canonical digest；普通输入只排除已被摘要覆盖的4个wrapper，其余runtime仍收集。新分析入口只收集一次canonical identity、按runtime缓存并完整检查8项后返回状态；真实当前索引为8/8 evidence valid、8/8 stored schema1 fingerprint相对current schema2 stale，严格verifier仍generic fail closed。不得把该结果反向解释成八个历史摘要曾共享同一旧digest。fresh复审最终PASS；主线58/58、类型、library build与diff通过。索引、历史manifest/evidence与helper二进制均未改。

1. Doctor/package：Windows strict doctor复用resolver并报告当前OS/Node/libuv/CLR/helper摘要，运行无target的`--probe-v1`但不重新构建/运行完整carrier preflight；production invocation不先跑probe。POSIX not-applicable。npm与plugin各包含唯一helper/SHA，隔离copy后可probe和跑fake MCP。
2. Runtime inputs：建立唯一canonical manifest，精确列出native production source、TypeScript wrapper、protocol/build config和实际helper摘要，并由同一实现生成确定性digest。capability fingerprint把该digest作为运行输入；当前宿主冻结证据和tagged workflow复用同一manifest与算法，不再维护平行的`current-host runtime fingerprint`。不加入历史evidence、资格开关、计划/审阅稿或整个package-set raw-byte digest。
3. Freeze/release smoke：不新增`smoke:prequalification`。Task 8逐项运行既有原子命令各一次，并单独记录八项能力唯一因runtime-input digest stale而fail closed；取得新8/8后只运行普通`smoke:release`。不得用candidate/core/prequalification多层wrapper重复build、pack或release core。
4. Workflow：CI保持单一Node 24 Ubuntu job并删除不被release消费的dist/plugin artifact，不再有Windows三shard、partial/composite/selfDigest/fetcher；tag release job继续独立生成自己的package evidence。release继续Node24、branch/tag与npm Trusted Publishing/OIDC；beta tag新增版本化current-host prequalification/helper SHA/capability/canonical runtime-input digest marker，workflow在tagged tree以同一实现重算并精确比较；stable marker新增public-beta exact install、完整App restart、真实Stop、owned-zero、同helper SHA与同runtime-input digest，机器核对后才发布。
5. 文档：公开说明“维护者当前Windows宿主已验证”，不声称Node/Windows广泛兼容。
6. 单宿主冗余闭包：删除EOL双checkout与未消费的CI artifact；统一`engines >=24`、tsup `node24`和公开Node要求，并注明只实测当前v24.14.1而非跨版本认证；活动文档只使用阶段名，不再绑定历史Task 9–12或某个beta序号。历史发布/失败记录留在仓库但不重写。
7. 单一真值源：native `build.config.json`是sourceSets唯一清单，PowerShell严格验证schema、相对`.cs`路径、安全compiler flags、边界与reparse后消费，不再复制整份数组；npm只打包用户文档、helper/SHA和能力索引实际引用的证据，release smoke从同一清单核对并继续执行秘密扫描与链接闭包。
8. 旧入口退役：删除旧`acceptance:local`真实模型脚本/entry/专用测试；保留无模型公共包隔离验收和beta后的真实App代表性门禁。`prepublishOnly`只作误触本地publish的最后检查，不是发布授权，OIDC workflow仍是唯一发布路径。
9. npm运行面：把CLI、MCP、plugin runtime与能力索引实际引用载荷定义为公开包边界；仓库内部acceptance/smoke/release构建输出留在包外，不再因`files: ["dist"]`整体发布。删除没有消费者的`qualification` build entry；无公共TypeScript API的声明文件不进入包。`commonmark`等仅release assurance使用的依赖降为开发依赖。不得误删CLI/MCP共享chunk、helper/SHA、能力索引引用evidence或其它由真实pack闭包证明必需的文件。
10. Workflow单次执行：每个CI/release job只显式build一次，随后直接运行Vitest与已构建的release smoke；release smoke第一次`npm pack --dry-run --json`的已检查结果同时写成可上传manifest，不再第二次pack。CI不上传dist/runtime；release若保留调试artifact，只保留pack manifest或必要摘要，不把无人消费的完整dist/runtime当发布证明。
11. 行为测试替代文本耦合：把npm launch-path等validator提取为纯函数并测试输入输出；保留真实隔离bundle执行、package exact inclusion、链接闭包、秘密/绝对路径扫描和workflow发布语义。删除对tsup实现字段、release-smoke源代码列表、计划命令块、`windowsIt`数量、当前beta/branch/date及精确Codex CLI版本的重复文本断言；版本测试改为比较package、CLI、MCP、plugin与workflow共享pin的一致性，Codex CLI仍固定到一个仓库真值源而非浮动最新版。
12. 文档真值源：`docs/operations.md`唯一维护完整安装、验收、回滚和发布流程；README只保留稳定产品合同、当前支持声明与链接。活动插件版本、历史批次ID/SHA/测试计数和一次性分支日期进入未打包的freeze/release evidence，不在两个公开文档重复维护。历史evidence/manifest保持不可变。
13. 明确保留：Job原子归属、唯一owner、句柄/环境/凭据隔离、parent/helper crash、managed与kernel分层测试、source→artifact/SHA/PE/resolver、canonical runtime-input digest、资格与能力双verifier、pack秘密/链接检查、beta/stable marker、公共beta精确安装、完整App重启/真实Stop、OIDC发布、`prepublishOnly`、固定Codex CLI来源、最小POSIX release回归及provider `KeyedLimiter`均不因删冗余而弱化。
14. 外部CLI原生能力：删除没有协议或当前provider事实依据的prompt/context/token保守上限与Git evidence静默字符截断；若Pi模型定义字段是当前安装版本执行所需的容量元数据，则保留字段，但数值必须由当前路线权威合同证明并记录来源，不把它扩张为step/turn/tool/runtime限制。显式调用级`timeoutMs`、qualification-only single-attempt和test teardown watchdog不受影响。

### 8.3 子批次A：artifact / resolver / doctor / package

先只实现并审阅doctor与package闭包：

```powershell
npx vitest run test/cli/doctor.test.ts test/plugin/artifact.test.ts test/acceptance/npm-package.test.ts
npm run build
npm pack --dry-run --json
npm run typecheck
git diff --check
```

提交：`feat: package and diagnose the Windows helper`

### 8.4 子批次B：runtime inputs / freeze evidence / workflow / docs

在子批次A独立提交后，再实现canonical runtime-input manifest/digest、资格复用与workflow闭包，并由一位fresh综合审阅者审阅：

```powershell
npx vitest run test/release/assurance.test.ts test/qualification/capability-index.test.ts test/qualification/preflight.test.ts test/release/workflows.test.ts
npm run build
npm pack --dry-run --json
npm run typecheck
git diff --check
```

提交：`feat: close current-host Windows release gates`

## 9. Task 8：当前宿主冻结与独立终审

在维护者当前宿主运行，不使用下载的替代Node：

```powershell
node --version
node -p "process.versions.uv"
npm run typecheck
npx vitest run --maxWorkers=1
npm run native:preflight
npm run native:verify
npm run acceptance:plugin:isolated -- --check-report
npm pack --dry-run --json
npm run verify:capabilities
git diff --check
```

这里的`verify:capabilities`在新真实8/8之前必须精确以exit 1失败。机器分析必须先完整证明8份历史证据仍有效，再证明8个已存schema1摘要均与current schema2 fingerprint不符；它不能从不可逆旧摘要反推八项历史上曾共享同一个旧digest。Task 8不得把该预期失败改写为PASS，也不重复运行必然失败的完整`smoke:release`。

本机证据必须记录：

- 当前OS/Node/libuv/npm/CLR/Pi/Kimi身份，只作观测值；
- helper实际SHA、单一独占临时根的source→artifact一致性与canonical runtime-input manifest/digest；
- carrier与Task 4 kernel/parent/helper crash结果，以及Task 6最小fake Kimi/Pi/stdio接线结果；
- 全部已知owned process/handle/temp root由各自case-owned Job drain归零，资格、恢复与公共npm验收没有调用WMI/`ps`全机zero gate；
- 新current preflight不再生成`targetProcesses`，历史v1/v2记录仍可严格只读验证且没有任何历史manifest/evidence被改写；
- 八项历史证据均有效，八个已存schema1摘要相对current schema2 fingerprint均为stale；
- 真实模型、活动配置/插件、发布和外部CLI全局限制均为0。

Task 8把这些事实写入仓库内脱敏的当前宿主prequalification证据，并固定runtime frozen commit、helper SHA和canonical runtime-input digest。它不提前创建尚未确定版本号的beta marker；真实8/8和版本元数据完成后，由后续beta候选提交生成同版本`.release-validation/v<version>.md`并引用该证据。tag workflow必须在tagged tree用同一manifest实现重算digest，不能只相信marker文本。

一位fresh reviewer做规格与质量集成终审。任何代码问题退回所属Task修复和复审，Task 8不把补救清理或文档解释当作PASS。最终提交：`docs: freeze current-host Windows prequalification`

## 10. Task 8后的资格与发布

本阶段沿既有用户授权恢复，不属于离线Tasks 2–8：

1. 在clean frozen SHA上按能力索引只运行stale/缺失的真实能力，目标8/8；单次失败遵守资格协议，不篡改历史manifest/evidence。
2. 更新同一`capabilities.json`后，`verify:capabilities`和普通`smoke:release`转绿；设置beta版本，并生成同版本release marker，绑定Task 8 prequalification、runtime frozen commit、helper SHA、canonical runtime-input digest与8/8能力索引。
3. 推送`next`，等待单Node CI；只有workflow核对beta marker后才创建/处理prerelease tag并由GitHub Actions OIDC发布beta，禁止本地publish。
4. 从公共registry精确版本隔离安装；按官方命令升级活动插件，完整退出并重开App。
5. 在当前宿主真实验证Kimi review、Pi/Ark review、隔离delegate和Stop/interrupt；只有helper/Job证据证明descendants归零才PASS。
6. stable marker必须新增公共beta精确安装、完整App重启、真实Stop、owned descendants归零、helper SHA和同一canonical runtime-input digest精确项；合入`main`后由stable tag触发GitHub Actions OIDC发布`latest`。

任一门禁失败即回到对应Task，不因“只支持本机”而放宽安全、资格或发布真实性。

## 11. 完成定义

- 当前宿主鲁棒性由真实kernel/全链/隔离与最终App Stop证明；
- 不存在三Node下载/矩阵、split fd4、production cmd执行、跨OS composite或固定2000轮竞态；
- Job原子归属、唯一owner、句柄/环境隔离、父/helper crash回收和无执行预算限制全部保留；
- Task 2–7逐项TDD、按风险分层审阅、主代理验证和独立提交；Task 8只做当前宿主冻结与一次独立集成终审；
- beta经公共本机验收后才发布stable，全部npm发布只走GitHub ActionsOIDC。
