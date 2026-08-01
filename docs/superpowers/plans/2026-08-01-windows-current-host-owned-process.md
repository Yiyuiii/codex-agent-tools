# Windows 当前宿主 Owned Process 精简实施计划

日期：2026-08-01

状态：**现行计划**

**目标：** 在维护者当前 Windows 10 x64、Node v24.14.1、.NET Framework 4.8 环境上，用固定 native helper为每次Kimi/Pi invocation建立原子Job ownership，并删除与本机目标无关的三Node矩阵、split channel、`.cmd`执行、跨OS证明链和高成本重复测试。

**现行规格：** [Windows 当前宿主最小可靠 owned process 设计](../specs/2026-08-01-windows-current-host-minimal-design.md)

**历史基线：** Task 1提交`88cf22b`与文档提交`b575dd9`有效保留；旧Task 2的单fd3 write-half-close失败由`0bb610e`保存。旧14项计划只作为历史，不再指导Task 2以后实现。

## 1. 执行边界

- 使用分支`codex/stdio-lifecycle-and-native-budget`与当前隔离worktree。
- Task 2–7均使用TDD：先新增能证明旧行为失败的测试，再做最小生产实现。
- 每项行为任务均按fresh implementer → fresh规格审阅 → fresh质量审阅 → 主代理复验 → 单独提交闭环；子智能体写入范围不得重叠。
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

### 4.1 RED

- strict frame/config/terminal状态测试先失败；
- 标准Windows argv的空参数、引号、尾反斜杠、Unicode、NUL和总长度边界先失败；
- `.cmd`/`.bat`/相对executable必须在create前拒绝；
- 生命周期全部状态×事件表先失败，显式包含create结果、terminate/EOF/protocol-error、root-complete、job-zero和terminal-seal。

### 4.2 GREEN

- 实现方向允许但同fd3的`ControlProtocol.cs`，复用canonical JSON生成constants。
- 实现只面向native PE的`WindowsCommandLine.cs`，固定绝对`lpApplicationName`；command line首token必须是同一绝对executable/target `argv[0]`，再拼接业务argv，不实现shell quoting。总长按UTF-16 code units并连同NUL限制为32767。
- 实现纯`LifecycleMachine.cs`：launcher唯一发布create结果，control reader只锁存首个disposition，唯一cleanup owner和唯一terminal。terminal seal后reader不能发布新状态。
- 设计同一fd3内部read/write ownership：reader不拥有最终进程存活权，terminal/自然退出绝不依赖reader EOF或无界join；采用的后台/可取消I/O机制必须由当前宿主管理测试证明。
- terminal、EOF、helper close与首错优先级精确映射为固定脱敏错误。
- 全部状态/事件组合确定性枚举；不使用2000轮随机循环。

### 4.3 验证与提交

```powershell
npm run native:test:managed
npx vitest run test/runtime/windows-job-protocol.test.ts test/runtime/windows-native-command-line.test.ts test/runtime/windows-lifecycle-machine.test.ts
npm run typecheck
git diff --check
```

提交：`feat: implement native helper protocol and lifecycle`

## 5. Task 4：Win32 Job、句柄隔离与真实kernel helper

### 5.1 RED

先建立当前宿主真内核fixtures和fault hooks，证明以下合同尚未满足：

- `CREATE_SUSPENDED + HANDLE_LIST + JOB_LIST`同次原子创建；
- marker在resume前不存在，target从第一条用户指令起已在Job；
- target只能访问复制的0/1/2，`cbReserved2=0/lpReserved2=NULL`；
- root先退而grandchild存活、取消、timeout、session shutdown、fd3 EOF、helper kill、Node parent death均最终Job归零；
- 自然root/Job归零而Node保持fd3开放时，helper仍能terminal→close→exit，阻塞reader不造成死锁或重复terminal；
- 当前宿主compatible nested Job可用；真实Codex App Stop留到beta官方插件阶段，不在禁止活动插件变更的Tasks 2–8伪测；
- Job create、set-limit、DuplicateHandle、attribute init、HANDLE_LIST update、JOB_LIST update、CreateProcess、Resume、TerminateJobObject、Query pre-zero、Query final-zero和terminal write各一个确定性fault并fail closed。

### 5.2 GREEN

- 实现最小Win32 ABI、SafeHandle/RAII、`JobSession`和production helper。
- Job只设置`KILL_ON_JOB_CLOSE`，无其它Job limit；helper是唯一Job owner。
- fd3和Job在target创建前清除继承；target只收到duplicated stdio。
- CREATING交错遵循Task 3状态机，不存在未归属running或suspended child。
- parent-death使用test-only C#外层observer：Node test parent仍活着且fixture已创建root/grandchild后，fixture经专用测试通道报告PID/nonce和可复核creation identity；observer立即只为这两个已知identity打开并保留`SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION`handles，用`GetProcessTimes`等handle-bound identity核对报告后再牺牲Node。牺牲后禁止PID lookup/reopen，只wait既有handles；teardown救援不计PASS。生产不含该通道或PID逻辑。
- C# helper的production source/API扫描拒绝target cleanup使用`AssignProcessToJobObject`、`TerminateProcess`、WMI、taskkill、breakaway、direct-spawn和production fault hook。Node仍可在调用已永久失败后，通过spawn时保留的`ChildProcess`/OS handle最后终止helper；不得PID reopen、不得直接终止target、不得把该兜底计入PASS。
- 每个确定性barrier少量重复检查资源泄漏；不构造人工incompatible UI-limit outer Job。

### 5.3 验证与提交

```powershell
npm run native:test:kernel
npx vitest run test/native/windows-job-helper-kernel.test.ts
npm run typecheck
git diff --check
```

逐例核对process、retained handle和temp root回到基线。

提交：`feat: own Windows targets with a job helper`

## 6. Task 5：artifact、resolver与OwnedAgentProcess

### 6.1 RED

- source双根build、仓库唯一exe/SHA、resolver path/hash/PE/CLR/probe测试先失败；
- Windows wrapper仍不能以单fd3传递target stdio和terminal；
- POSIX行为与新抽象的回归测试先失败；
- environment poison与case-fold测试先失败。

### 6.2 GREEN

- 用Task 1工具链生成唯一x64/net48 helper；保留一次本机source→artifact byte compare。
- resolver拒绝escape、reparse、hash mismatch、非x64、CLR/probe失败和重复artifact。
- 实现不暴露PID的`OwnedAgentProcess`：POSIX保留现有process-group，Windows只启动helper。
- Windows wrapper spawn `stdio: [target stdin, target stdout, target stderr, control]`；正常路径不half-close fd3。
- 正式wrapper合同测试必须证明terminal前不调用`.end()`、`.destroy()`或主动close fd3；terminal前EOF/close/error永久失败，合法terminal后的helper clean close才能完成。
- helper terminal + fd3 clean close + helper code 0 + stdio settle + Job-zero构成成功；任一异常永久失败。
- Windows environment fixed allowlist增加必要系统key并case-fold去重，只保留选定credential；poison parent不得泄漏proxy或其它secret。
- 不增加production one-time carrier probe缓存；真实launch READY与terminal本身fail closed。

### 6.3 验证与提交

```powershell
npm run native:verify
npx vitest run test/native/windows-job-helper-artifact.test.ts test/runtime/windows-job-helper.test.ts test/runtime/owned-agent-process.test.ts test/runtime/posix-owned-agent-process.test.ts test/runtime/windows-owned-agent-process.test.ts test/runtime/windows-owned-agent-process.integration.test.ts
npm run typecheck
git diff --check
```

提交：`feat: launch Windows agents through verified ownership`

## 7. Task 6：Kimi、Pi与stdio接线

### 7.1 RED

- Kimi/Pi Windows路径仍依赖direct spawn、PID terminator或`pi.cmd`执行的合同测试先失败；
- Pi locator尚不能从当前安装解析/验证package name/version/bin/realpath/engine并返回结构化`PiInvocation`；
- adapter、doctor、`src/smoke/pi.ts`版本读取、qualification preflight和隔离/公共验收消费者仍把Pi locator当作字符串，尚未统一拼接`argvPrefix`；
- stdio真实fake链尚不能证明handler/session只在owned tree归零后settle。

### 7.2 GREEN

- Kimi locator返回绝对`kimi.exe`并由`OwnedAgentProcess`启动。
- Pi locator可用shim做发现但绝不执行或解析shim命令文本；Windows `PI_COMMAND`只作可验证package位置锚点，拒绝任意可执行覆盖。返回结构化`PiInvocation { executable: process.execPath, argvPrefix: [cliJsRealpath], identity }`并验证name/version/bin/engine/realpath。
- adapter、doctor、`src/smoke/pi.ts`、qualification preflight及隔离/公共验收测试全部消费结构化invocation，在各自参数前拼接`argvPrefix`；Windows上的Kimi/Pi `--version`和其它只读诊断也必须走`OwnedAgentProcess`，不得保留direct `execa`旁路；POSIX行为不漂移。
- 删除production `.cmd/.bat`、`cmd.exe`、shell quoting和Windows PID tree cleanup。
- 两个client只在READY后发协议请求；取消先发送ACP/RPC原生cancel/abort，再走一次owned terminate。
- 省略`timeoutMs`不创建deadline；显式timeout只属于该次调用；finally等待owned close无总截止。
- child environment用case-insensitive builder合成固定系统键、唯一credential和固定runtime-owned键；Pi本次隔离配置生成的`PI_CODING_AGENT_DIR`必须保留，父环境同名/变体、proxy与其它secret不得穿透，跨来源冲突fail closed。
- stdio end/close/error与SIGINT/SIGTERM共享幂等shutdown，业务错误优先、cleanup错误作为secondary附加；即使业务原本成功，只要cleanup失败，整个调用仍必须失败。
- fake Kimi/Pi覆盖root先退/grandchild、late spawn尝试、helper/parent崩溃与进程重生负例；不调用真实模型。

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
- capability fingerprint尚不覆盖native运行输入与实际binary digest；
- workflow测试仍要求Node 20/22/24矩阵；
- 当前本机prequalification入口不存在或重复分层。

### 8.2 GREEN

1. Doctor/package：Windows strict doctor复用resolver并报告当前OS/Node/libuv/CLR/helper摘要，运行无target的`--probe-v1`但不重新构建/运行完整carrier preflight；POSIX not-applicable。npm与plugin各包含唯一helper/SHA，隔离copy后可probe和跑fake MCP。
2. Fingerprint：加入native production source、TypeScript wrapper、protocol/build config和实际helper摘要；导出一个确定性`current-host runtime fingerprint`供本机prequalification evidence与tagged workflow共同重算。不加入历史evidence、资格开关、计划/审阅稿或整个package-set raw-byte digest。
3. Smoke：只新增一个`smoke:prequalification`，要求八项唯一失败原因均为runtime fingerprint stale后运行完整共享release core；普通`smoke:release`继续要求8/8 green。删除candidate/core多层wrapper设想。
4. Workflow：CI改为单一Node 24 Ubuntu job；artifact名称固定，不再有Windows三shard、partial/composite/selfDigest/fetcher。release继续Node24、branch/tag与npm Trusted Publishing/OIDC；beta tag新增版本化current-host prequalification/helper SHA/capability/current-host runtime fingerprint marker，workflow在tagged tree重算fingerprint并精确比较；stable marker新增public-beta exact install、完整App restart、真实Stop、owned-zero、同helper SHA与同runtime fingerprint，机器核对后才发布。
5. 文档：公开说明“维护者当前Windows宿主已验证”，不声称Node/Windows广泛兼容。

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

### 8.4 子批次B：fingerprint / prequalification / workflow / docs

在子批次A独立提交后，再实现并由fresh reviewers审阅资格与workflow闭包：

```powershell
npx vitest run test/release/assurance.test.ts test/qualification/capability-index.test.ts test/qualification/preflight.test.ts test/release/workflows.test.ts
npm run build
npm run smoke:prequalification
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
npm test -- --maxWorkers=1
npm run build
npm run native:preflight
npm run native:verify
npm run smoke:prequalification
npm run acceptance:plugin:isolated -- --check-report
npm pack --dry-run --json
git diff --check
```

本机证据必须记录：

- 当前OS/Node/libuv/npm/CLR/Pi/Kimi身份，只作观测值；
- helper实际SHA、source→artifact一致性与覆盖native source/wrapper/protocol/build/helper digest的current-host runtime fingerprint；
- carrier、kernel、parent/helper crash、fake Kimi/Pi/stdio结果；
- 全部已知owned process/handle/temp root归零；
- 八项能力唯一因runtime fingerprint stale；
- 真实模型、活动配置/插件、发布和外部CLI全局限制均为0。

Task 8把这些事实写入仓库内脱敏的当前宿主prequalification证据，并固定runtime frozen commit、helper SHA和current-host runtime fingerprint。它不提前创建尚未确定版本号的beta marker；真实8/8和版本元数据完成后，由后续beta候选提交生成同版本`.release-validation/v<version>.md`并引用该证据。tag workflow必须在tagged tree重算fingerprint，不能只相信marker文本。

两位fresh reviewer分别做规格与质量终审。任何代码问题退回所属Task修复和复审，Task 8不把补救清理或文档解释当作PASS。最终提交：`docs: freeze current-host Windows prequalification`

## 10. Task 8后的资格与发布

本阶段沿既有用户授权恢复，不属于离线Tasks 2–8：

1. 在clean frozen SHA上按能力索引只运行stale/缺失的真实能力，目标8/8；单次失败遵守资格协议，不篡改历史manifest/evidence。
2. 更新同一`capabilities.json`后，`verify:capabilities`和普通`smoke:release`转绿；设置beta版本，并生成同版本release marker，绑定Task 8 prequalification、runtime frozen commit、helper SHA、current-host runtime fingerprint与8/8能力索引。
3. 推送`next`，等待单Node CI；只有workflow核对beta marker后才创建/处理prerelease tag并由GitHub Actions OIDC发布beta，禁止本地publish。
4. 从公共registry精确版本隔离安装；按官方命令升级活动插件，完整退出并重开App。
5. 在当前宿主真实验证Kimi review、Pi/Ark review、隔离delegate和Stop/interrupt；只有helper/Job证据证明descendants归零才PASS。
6. stable marker必须新增公共beta精确安装、完整App重启、真实Stop、owned descendants归零、helper SHA和同一current-host runtime fingerprint精确项；合入`main`后由stable tag触发GitHub Actions OIDC发布`latest`。

任一门禁失败即回到对应Task，不因“只支持本机”而放宽安全、资格或发布真实性。

## 11. 完成定义

- 当前宿主鲁棒性由真实kernel/全链/隔离与最终App Stop证明；
- 不存在三Node下载/矩阵、split fd4、production cmd执行、跨OS composite或固定2000轮竞态；
- Job原子归属、唯一owner、句柄/环境隔离、父/helper crash回收和无执行预算限制全部保留；
- Task 2–7逐项TDD、双审、主代理验证和独立提交；Task 8只做当前宿主冻结与独立终审；
- beta经公共本机验收后才发布stable，全部npm发布只走GitHub ActionsOIDC。
