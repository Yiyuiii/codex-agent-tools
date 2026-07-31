# Windows Job Object Owned Process Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every behavior-bearing task uses superpowers:test-driven-development; every task receives a fresh specification-compliance review followed by a fresh code-quality review before its task commit is accepted.

**Goal:** 用一个可复现构建、可机器验真的 .NET Framework 4.8 x64 helper，把 Windows 上每次 Kimi/Pi invocation 在第一条用户代码执行前原子归入该 invocation 独有的匿名 Job Object，并让 Node、MCP stdio shutdown、能力资格和 GitHub Trusted Publishing 都以 Job 归零而非 PID 猜测作为完成依据。

**Architecture:** Node 只启动固定 helper，并通过 fd 3 二进制协议发送 executable/cwd/argv；helper 用同一 `STARTUPINFOEX` 的 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 与 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 创建 suspended target，成功返回即已在 inner Job，随后 resume、监视 root/控制通道并在唯一清理路径上等待 `ActiveProcesses=0`。Node 侧以不暴露 PID 的 `OwnedAgentProcess` 统一 POSIX process group 与 Windows Job；Kimi/Pi 只在 `READY` 后开始协议，在 `finally` 无总截止地等待 owned process 关闭。预编译 helper、源码、锁定工具链、SHA、doctor、能力指纹、Windows CI 和 release attestation 组成同一 fail-closed 供应链。

**Tech Stack:** TypeScript 5.9、Node.js 20.20.2 / 22.23.2 / 24.18.1 x64、Vitest 4、C# / .NET Framework 4.8、Roslyn `Microsoft.Net.Compilers.Toolset` 4.14.0、`Microsoft.NETFramework.ReferenceAssemblies.net48` 1.0.3、Win32 Job Objects / `STARTUPINFOEX`、PowerShell、tsup、GitHub Actions npm Trusted Publishing。

---

## 执行上下文与不可变边界

- 分支：`codex/stdio-lifecycle-and-native-budget`；隔离 worktree：`<isolated-worktree>`。
- 批准规格：
  - `docs/superpowers/specs/2026-07-31-stdio-lifecycle-and-native-execution-budget-design.md`
  - `docs/superpowers/specs/2026-07-31-windows-job-object-owned-process-design.md`
- 上游实施/发布计划：
  - `docs/superpowers/plans/2026-07-31-stdio-lifecycle-and-native-execution-budget.md`
  - `docs/superpowers/plans/2026-07-29-beta-to-stable-release.md`
- 本计划先闭合原 Task 9 前的 Windows P1。Task 14 形成新的 clean frozen candidate 后，才恢复上游 Task 9–12。
- 不读取或修改活动 `~/.codex/config.toml`，不替换活动插件，不修改相邻 `codex-cc-tools`、Claude Code、旧 `codex_cc_tools` 或 Kimi/Pi 全局配置。
- 不给任何外部 CLI 增加默认或持久化的 step、turn、tool-call、context、token、duration、CPU、内存或进程数限制。测试 fixture timeout 只可在停止已经请求后用于测试进程自身止损，不得成为生产 Job drain 总截止。
- Windows production target cleanup 静态禁止 `AssignProcessToJobObject`、`TerminateProcess`、`taskkill`、WMI、PID reopen 或按 PID 重新认领。`src/plugin/mcp-cleanup.ts` 的 acceptance-only MCP transport 清理属于另一边界，不得计入 target ownership 证据。
- 不在 Task 1–14 调用任何真实模型；不改写历史 batch/manifest/evidence；`capabilities.json` 保持原样。native 输入改变后，普通 `verify:capabilities` 与 `smoke:release` 在 Task 9 前必须只因八项 `runtime_fingerprint_stale` 非零。
- 不本地 `npm publish`。beta/stable 仍只由 GitHub Actions Trusted Publishing 发布。
- 任一硬前提失败即停止相关后续任务：不得自动改成命名 pipe、PID fallback、直接 spawn 或另一套 helper 技术。

## 协议 v1 的实现冻结

Node 与 C# 必须共享 `native/windows-job-helper/protocol.v1.json`，不得各自复制魔法数字。TypeScript 在构建时内联该合同，native build runner 只在系统临时编译目录生成对应的 C# constants source，仓库不保存可漂移的第二份 generated constants：

- helper production mode：`--control-v1`；只读探针：`--probe-v1`。
- 12 字节 LE header：`CAJ1`、`uint16 version=1`、`uint16 type`、`uint32 payloadLength<=1MiB`。
- type：`LAUNCH_CONFIG=1`、`READY=2`、`TERMINATE=3`、`ERROR=4`、`EXIT=5`。
- terminate reason：`cancelled=1`、`timed_out=2`、`session_shutdown=3`、`protocol_error=4`；`0` 只在没有请求原因的 `ERROR` 中表示 none。
- `READY` payload 长度精确为 0；`TERMINATE` payload 精确为一个 `uint8 reason`。
- `ERROR` payload 精确为 8 字节：`uint16 stage`、`uint8 reason`、`uint8 hasWin32Code`、`uint32 win32Code`。`hasWin32Code=0` 时 code 必须为 0。
- `EXIT` payload 精确为 8 字节：`uint32 rootExitCode`、`uint8 reason`、`uint8 jobActiveProcessesZero=1`、`uint16 reserved=0`。`reason=0` 表示自然 root exit，其余只允许 1–3；protocol error 永不产生 `EXIT`。
- stage：`protocol_invalid=1`、`cancelled_before_ready=2`、`job_create_failed=3`、`job_config_failed=4`、`stdio_duplicate_failed=5`、`attribute_list_init_failed=6`、`handle_list_attribute_failed=7`、`job_list_attribute_failed=8`、`command_line_invalid=9`、`create_failed=10`、`resume_failed=11`、`terminate_job_failed=12`、`query_job_failed=13`、`control_channel_failed=14`、`helper_internal=15`、`wait_failed=16`。
- `LAUNCH_CONFIG` 严格沿规格中的 kind/executable/cwd/argc/argv 编码；不承载 prompt、credential、环境值、session 内容或模型输出。target 环境只从 helper 的已继承环境自然继承。

canonical JSON的枚举/限制段必须精确为以下内容，generator只允许读取这些固定keys：

```json
{
  "schemaVersion": 1,
  "mode": { "control": "--control-v1", "probe": "--probe-v1" },
  "frame": { "magic": "CAJ1", "version": 1, "headerBytes": 12, "maxPayloadBytes": 1048576 },
  "limits": { "maxStringBytes": 65536, "maxArgCount": 1024, "maxCmdUtf16UnitsIncludingNul": 8191 },
  "messageType": { "launchConfig": 1, "ready": 2, "terminate": 3, "error": 4, "exit": 5 },
  "invocationKind": { "native": 1, "cmd": 2 },
  "reason": { "noneOrRootExit": 0, "cancelled": 1, "timedOut": 2, "sessionShutdown": 3, "protocolError": 4 },
  "stage": {
    "protocolInvalid": 1,
    "cancelledBeforeReady": 2,
    "jobCreateFailed": 3,
    "jobConfigFailed": 4,
    "stdioDuplicateFailed": 5,
    "attributeListInitFailed": 6,
    "handleListAttributeFailed": 7,
    "jobListAttributeFailed": 8,
    "commandLineInvalid": 9,
    "createFailed": 10,
    "resumeFailed": 11,
    "terminateJobFailed": 12,
    "queryJobFailed": 13,
    "controlChannelFailed": 14,
    "helperInternal": 15,
    "waitFailed": 16
  }
}
```

## 每项任务的子智能体闭环

每项任务严格串行执行：

1. 新 implementer 只接收该任务文件范围、失败测试、禁止事项和验证命令；先看到 RED，再写最小实现并自检。
2. 新 spec reviewer 对照两份批准规格和本计划检查遗漏/越界；有问题则原 implementer 修复，再复审到 PASS。
3. 新 quality reviewer 检查竞态、错误处理、测试真实性、脱敏、可维护性和无隐藏预算；有问题则原 implementer修复，再复审到 Ready。
4. 主线程复跑本任务命令、`npm run typecheck` 和 `git diff --check`，检查 diff 与工作树；只提交本任务范围。
5. 不并行启动会写同一工作树的 implementer。只读 reviewer 可在 implementer 完成后运行。

## Task 1：冻结确定性工具链、Node 矩阵与跨语言协议

**Files**

- Create: `native/windows-job-helper/toolchain.lock.json`
- Create: `native/windows-job-helper/build.config.json`
- Create: `native/windows-job-helper/protocol.v1.json`
- Create: `native/windows-job-helper/restore-toolchain.ps1`
- Create: `native/windows-job-helper/build.ps1`
- Create: `scripts/windows-native-helper.mjs`
- Create: `src/runtime/windows-job-protocol.ts`
- Create: `test/native/native-build-contract.test.ts`
- Create: `test/runtime/windows-job-protocol.test.ts`
- Modify: `package.json`
- Modify: `.gitattributes`

- [ ] **Step 1：先写工具链与协议 RED 测试**

测试必须断言：精确 NuGet package/version/official flat-container URL/长度/SHA-256/SHA-512；精确 Node archive URL 与以下官方 SHA-256；固定编译参数、x64、排序 source list、临时目录输出；协议 mode、枚举、payload、golden vectors、short read、合并帧、坏 magic/version/type/length/UTF-8/NUL/argc/string/frame 上限。

`.gitattributes` 固定为 `* text=auto eol=lf` 与 `*.exe binary`；测试断言文本在 Windows/Ubuntu checkout都为 LF，PE永不走文本转换。不得依赖本机 `core.autocrlf=true` 的偶然工作树字节。

```text
node-v20.20.2-win-x64.zip dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77
node-v22.23.2-win-x64.zip 1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97
node-v24.18.1-win-x64.zip ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765
```

```powershell
npx vitest run test/native/native-build-contract.test.ts test/runtime/windows-job-protocol.test.ts
```

预期：因锁文件、脚本、协议模块和 fixture 不存在而失败。

- [ ] **Step 2：锁定官方工具链并实现共享协议 codec**

规划阶段已从以下官方 NuGet flat-container HTTPS URL独立下载并冻结长度、SHA-256与SHA-512；正式 `restore-toolchain.ps1` 从第一次运行起只允许下载到经解析验证的系统临时目录并与这些精确值校验，绝不提供 bootstrap/refresh/update-lock模式，任何漂移 fail closed：

```text
https://api.nuget.org/v3-flatcontainer/microsoft.net.compilers.toolset/4.14.0/microsoft.net.compilers.toolset.4.14.0.nupkg
length 21771766
sha256 941a9cf3ea618d88d01a3dd6b1a45a06bcf07716a9f81ce4031caa3edd24a845
sha512 879184c42ddfc747e6d2a1f0f2b43acb9734ba4e9c0a202ca2b2e5f47abff55968b44becbffa16eb444da3c1ce600a6feba90da89ab8060fd391202c8100306d

https://api.nuget.org/v3-flatcontainer/microsoft.netframework.referenceassemblies.net48/1.0.3/microsoft.netframework.referenceassemblies.net48.1.0.3.nupkg
length 20997929
sha256 8a7e348538e7eb91351696911689f49e3d4f63f8bab517432bbe159b8b1104a2
sha512 5d62a0c9e35a74d71341a215bd007c06b74236b11aafa7e8fdd7b539d41167d1c5cb48dc05268cf08579abae196a6a6c4a70bc0254ec002686654ba8170e3544
```

固定 `/noconfig /nostdlib+ /target:exe /platform:x64 /optimize+ /debug- /deterministic+ /checked+ /unsafe- /langversion:latest /utf8output /filealign:512`，并由脚本把经 `GetFullPath` 验证的 `$resolvedNativeSource`组成 `/pathmap:$resolvedNativeSource=/_/native/windows-job-helper`；只引用锁定 reference package 的 `mscorlib.dll`、`System.dll`、`System.Core.dll`。`windows-job-protocol.ts` 从 canonical JSON 合同导出 codec 和固定脱敏映射，不接收 helper path/protocol override；native runner 从同一 JSON 只向临时编译目录生成 C# constants，并在每次 build前验证生成内容摘要。

最终固定 package scripts 为：`native:preflight`（三版全跑）、`native:preflight:current`（当前锁定版本）、`native:test:managed`、`native:test:kernel`、`native:verify`、`native:update-artifact`、`test:native`；全部只委托 `scripts/windows-native-helper.mjs` 的固定 subcommand，不接受工具链/helper/path override。

- [ ] **Step 3：验证并提交**

```powershell
npx vitest run test/native/native-build-contract.test.ts test/runtime/windows-job-protocol.test.ts
node scripts/windows-native-helper.mjs restore
npm run typecheck
git diff --check
git add .gitattributes package.json native/windows-job-helper/toolchain.lock.json native/windows-job-helper/build.config.json native/windows-job-helper/protocol.v1.json native/windows-job-helper/restore-toolchain.ps1 native/windows-job-helper/build.ps1 scripts/windows-native-helper.mjs src/runtime/windows-job-protocol.ts test/native/native-build-contract.test.ts test/runtime/windows-job-protocol.test.ts
git commit -m "feat: freeze Windows helper protocol and toolchain"
```

预期：全部通过，下载/解包/编译缓存只在系统临时目录，仓库没有生成物。

## Task 2：证明 Node 20/22/24 与 C# fd3 控制载体成立

**Files**

- Create: `native/windows-job-helper/preflight/Fd3Probe.cs`
- Create: `test/native/fd3-preflight.test.ts`
- Modify: `native/windows-job-helper/build.config.json`
- Modify: `scripts/windows-native-helper.mjs`
- Modify: `package.json`

- [ ] **Step 1：写出真实 fd3 RED 测试**

测试必须用 C# `_get_osfhandle(3)` 与 Node `stdio[3]` 证明：Node→C# CONFIG；同一 HANDLE 上 C#→Node ACK/READY；full-duplex；Node write-half-close 后仍能读 terminal；helper write-half-close 的 EOF/close 顺序；强杀 helper 后 Node 的 EOF/close；probe 不创建 Job/target，不读环境或凭据。TypeScript fake 不计证据。

```powershell
npx vitest run test/native/fd3-preflight.test.ts
```

预期：因 `Fd3Probe.cs` 和 preflight runner 不存在而失败。

- [ ] **Step 2：实现最小 probe 并逐版本运行**

`native:preflight` 下载并核对 Task 1 锁定的三个官方 Node zip到临时目录，逐一调用相同编译出的 probe；不得用未锁定的 `npx node`，不得只用当前系统 Node。
同时提供无参数的固定入口 `native:preflight:current`，只接受当前 `process.version` 精确等于三项锁定版本之一，用于 GitHub matrix 证明各 runner 当前 Node；它不接受任意版本/path 参数。

```powershell
npm run native:preflight
```

预期：Windows x64 上 Node 20.20.2、22.23.2、24.18.1 全部通过，临时目录被删除。任一版本不能提供规格要求的 duplex/half-close/EOF 语义时，立即停止本计划并回到书面规格；不得开始 Task 3，不得自动改成命名 pipe。

- [ ] **Step 3：复验并提交**

```powershell
npx vitest run test/native/native-build-contract.test.ts test/native/fd3-preflight.test.ts test/runtime/windows-job-protocol.test.ts
npm run native:preflight
npm run typecheck
git diff --check
git add native/windows-job-helper/preflight/Fd3Probe.cs native/windows-job-helper/build.config.json scripts/windows-native-helper.mjs test/native/fd3-preflight.test.ts package.json
git commit -m "test: prove Windows fd3 control transport"
```

## Task 3：实现 C# 协议、严格配置和 Windows 命令行纯函数

**Files**

- Create: `native/windows-job-helper/src/ControlProtocol.cs`
- Create: `native/windows-job-helper/src/WindowsCommandLine.cs`
- Create: `native/windows-job-helper/tests/TestRunner.cs`
- Create: `native/windows-job-helper/tests/ProtocolTests.cs`
- Create: `native/windows-job-helper/tests/CommandLineTests.cs`
- Create: `test/native/windows-job-helper-protocol.test.ts`
- Create: `src/runtime/windows-invocation-kind.ts`
- Create: `test/runtime/windows-invocation-kind.test.ts`
- Create: `native/windows-job-helper/fixtures/FixtureShim.cmd`
- Create: `native/windows-job-helper/fixtures/ArgvRecorder.cs`
- Modify: `native/windows-job-helper/build.config.json`
- Modify: `scripts/windows-native-helper.mjs`

- [ ] **Step 1：先写 C# 与跨语言 golden RED 测试**

覆盖：12-byte LE header、short reads/merged frames、所有 payload 精确长度与 reserved bits；1 MiB frame、64 KiB string、1024 args；坏 UTF-8/NUL/绝对路径/kind/重复 config/terminal；TypeScript→C# 与 C#→TypeScript golden vectors完全一致。

命令行覆盖 native argv0/空参数/尾反斜杠/引号/Unicode；`windows-invocation-kind.ts` 按 resolved absolute executable把 `.cmd/.bat`（大小写无关）分类为 `cmd`，其它受支持 PE为 `native`，helper独立复核 kind/扩展，mismatch/未知扩展 pre-create拒绝，adapter不得各自猜测。cmd builder接收 Task 5 由 `GetSystemDirectoryW` 得到的可信 `cmd.exe` path，不信任 `SystemRoot`/`COMSPEC`，固定 `/d /s /v:off /c`；覆盖 `&|<>^()%!` 双层转义；自动填充包含终止 NUL 的最终 command line 8190/8191 接受、8192 pre-create 拒绝；native Win32上限与 cmd 8191独立。

`.cmd` fixture只做最小转发到仓库构建的 x64 `argv-recorder.exe`；recorder以 length-prefixed UTF-16二进制输出用户 arguments。测试同时传入会创建哨兵文件的注入字符串，只有 binary oracle逐项精确且哨兵不存在才通过，禁止用 batch `echo/set` 作为 argv oracle。

```powershell
node scripts/windows-native-helper.mjs test-managed --filter Protocol
node scripts/windows-native-helper.mjs test-managed --filter CommandLine
npx vitest run test/native/windows-job-helper-protocol.test.ts test/runtime/windows-invocation-kind.test.ts
```

预期：因生产类不存在而失败。

- [ ] **Step 2：实现无 Win32 副作用的最小纯函数**

所有字符串 strict UTF-8、长度检查和错误 stage 都在 create 前完成；错误只携带固定 stage/reason/code，不包含 path/arg/env/raw system message。不得在命令行或控制 frame 中出现 prompt、credential、环境值或模型内容。

- [ ] **Step 3：验证并提交**

```powershell
node scripts/windows-native-helper.mjs test-managed --filter Protocol
node scripts/windows-native-helper.mjs test-managed --filter CommandLine
npx vitest run test/runtime/windows-job-protocol.test.ts test/native/windows-job-helper-protocol.test.ts test/runtime/windows-invocation-kind.test.ts
npm run typecheck
git diff --check
git add native/windows-job-helper/src/ControlProtocol.cs native/windows-job-helper/src/WindowsCommandLine.cs native/windows-job-helper/tests/TestRunner.cs native/windows-job-helper/tests/ProtocolTests.cs native/windows-job-helper/tests/CommandLineTests.cs native/windows-job-helper/fixtures/FixtureShim.cmd native/windows-job-helper/fixtures/ArgvRecorder.cs src/runtime/windows-invocation-kind.ts test/runtime/windows-invocation-kind.test.ts test/native/windows-job-helper-protocol.test.ts native/windows-job-helper/build.config.json scripts/windows-native-helper.mjs
git commit -m "feat: implement Windows helper protocol and quoting"
```

## Task 4：先用纯状态机闭合 CREATING 线性化

**Files**

- Create: `native/windows-job-helper/src/LifecycleMachine.cs`
- Create: `native/windows-job-helper/tests/LifecycleMachineTests.cs`
- Create: `native/windows-job-helper/tests/FaultKernel.cs`
- Modify: `native/windows-job-helper/build.config.json`
- Modify: `scripts/windows-native-helper.mjs`

- [ ] **Step 1：用可枚举事件表写 RED 测试**

至少交叉 `CreateProcessW success/failure × terminate/EOF/protocol_error × CONFIGURED/JOB_READY/CREATING/CREATED_ASSIGNED/RUNNING`。逐格断言：第一个 disposition 获胜；cleanup owner 恰好一个；`CREATING` 不提前关 Job；stop-before-resume 永不 resume；resume-first 严格 `READY→EXIT`；protocol/Win32 失败严格为 pre-ready `ERROR` 或 `READY→ERROR`；无第二 terminal/resume、无 `TERMINATING→RUNNING`；requested reason 精确保留。

```powershell
node scripts/windows-native-helper.mjs test-managed --filter LifecycleMachine
```

预期：状态机不存在而失败。

- [ ] **Step 2：实现单 gate、launcher 唯一发布者的最小状态机**

状态机不直接 P/Invoke；fault kernel 只在 test assembly，production source/artifact 不暴露故障开关。`CREATING` 中 reader 只锁存，只有 launcher 发布 create success/failure、handles 和 cleanup ownership。

- [ ] **Step 3：验证并提交**

```powershell
node scripts/windows-native-helper.mjs test-managed --filter LifecycleMachine
node scripts/windows-native-helper.mjs test-managed
git diff --check
git add native/windows-job-helper/src/LifecycleMachine.cs native/windows-job-helper/tests/LifecycleMachineTests.cs native/windows-job-helper/tests/FaultKernel.cs native/windows-job-helper/build.config.json scripts/windows-native-helper.mjs
git commit -m "feat: linearize Windows helper lifecycle"
```

## Task 5：实现 Win32 Job、句柄隔离与 production helper

**Files**

- Create: `native/windows-job-helper/src/NativeMethods.cs`
- Create: `native/windows-job-helper/src/NativeHandles.cs`
- Create: `native/windows-job-helper/src/JobSession.cs`
- Create: `native/windows-job-helper/src/JobHelper.cs`
- Create: `native/windows-job-helper/tests/WindowsKernelTests.cs`
- Create: `native/windows-job-helper/fixtures/FixtureTarget.cs`
- Create: `native/windows-job-helper/fixtures/OuterJobHarness.cs`
- Create: `test/native/windows-job-helper-kernel.test.ts`
- Modify: `native/windows-job-helper/build.config.json`
- Modify: `scripts/windows-native-helper.mjs`

- [ ] **Step 1（Task 5A）：写 native ABI/handle RED 测试**

在 `WindowsKernelTests.cs` 增加 `NativeContract` 组，精确断言 constants、struct sizes/offsets、`STARTUPINFOEX.cb`、`STARTF_USESTDHANDLES`、`bInheritHandles=TRUE`、`CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT`，并静态拒绝 breakaway flags。`NativeHandles` 组用真实 duplicated pipe handles证明 Job/fd3不可继承、仅0/1/2可继承且所有 SafeHandle只关闭一次。

```powershell
node scripts/windows-native-helper.mjs test-kernel --filter NativeContract
node scripts/windows-native-helper.mjs test-kernel --filter NativeHandles
```

预期：两条命令都 FAIL，分别证明 `NativeMethods` ABI 合同与 `NativeHandles` 继承/单次释放合同尚未实现。

- [ ] **Step 2（Task 5A）：实现最小 ABI/RAII 并转绿**

`NativeMethods.cs` 只声明规格列出的 Kernel32 API/struct/constants；`NativeHandles.cs` 用 sealed SafeHandle wrappers管理 Job、process、thread、duplicated stdio和attribute-list buffer，构造失败逆序释放。禁止声明 `AssignProcessToJobObject`、`TerminateProcess`、`OpenProcess`。

```powershell
node scripts/windows-native-helper.mjs test-kernel --filter NativeContract
node scripts/windows-native-helper.mjs test-kernel --filter NativeHandles
git add native/windows-job-helper/src/NativeMethods.cs native/windows-job-helper/src/NativeHandles.cs native/windows-job-helper/tests/WindowsKernelTests.cs native/windows-job-helper/build.config.json scripts/windows-native-helper.mjs
git commit -m "feat: wrap Windows job native handles"
```

- [ ] **Step 3（Task 5B）：写 atomic create/handle-list/JOB_LIST RED 测试**

`CreateOwnership` 组先构建 marker target、nonce handle challenge、compatible/incompatible outer Job和 suspended image oracle。精确要求：Job唯一 limit bit为KILL_ON_CLOSE；匿名Job；`HANDLE_LIST`只有duplicated0/1/2；`JOB_LIST`只有inner Job；Create成功时membership已成立且marker尚不存在，失败时无child/process/thread handles。compatible路径在Create返回时用独立membership查询证明suspended target同时属于inner与outer Job；terminate后inner `ActiveProcesses=0`且同一outer Job内peer仍存活。incompatible UI-limit路径必须Create失败、无child/process/thread handles、marker不存在且同一incompatible outer Job peer仍存活。两条都静态/动态无CREATE_BREAKAWAY/breakaway limits；任一真实内核语义不符立即停止并回到设计，不得post-create修补。`CommandImage`组用 `GetSystemDirectoryW`、`QueryFullProcessImageNameW`、x64 `ArgvRecorder.cs`和注入哨兵证明cmd image/argv/8190/8191/8192合同。

```powershell
node scripts/windows-native-helper.mjs test-kernel --filter CreateOwnership
node scripts/windows-native-helper.mjs test-kernel --filter CommandImage
```

预期：FAIL，`JobSession`/`JobHelper` 尚未创建 target。

- [ ] **Step 4（Task 5B）：实现 create→publish→resume 最小路径并转绿**

固定实现顺序：验证/复制 stdio → anonymous non-inheritable Job → only KILL_ON_CLOSE → stable HANDLE_LIST/JOB_LIST buffers → `LifecycleMachine.EnterCreating()` → approved flags `CreateProcessW` → launcher原子发布 process/primary-thread handles → 只立即关闭 helper侧 duplicated0/1/2 → pending stop绝不resume；否则对仍有效 primary-thread handle `ResumeThread`并串行发布 READY。`cmd` path只能来自 `GetSystemDirectoryW`。

```powershell
node scripts/windows-native-helper.mjs test-kernel --filter CreateOwnership
node scripts/windows-native-helper.mjs test-kernel --filter CommandImage
git add native/windows-job-helper/src/JobSession.cs native/windows-job-helper/src/JobHelper.cs native/windows-job-helper/fixtures/FixtureTarget.cs native/windows-job-helper/fixtures/OuterJobHarness.cs native/windows-job-helper/fixtures/ArgvRecorder.cs native/windows-job-helper/fixtures/FixtureShim.cmd native/windows-job-helper/tests/WindowsKernelTests.cs native/windows-job-helper/build.config.json scripts/windows-native-helper.mjs
git commit -m "feat: create targets atomically inside Windows jobs"
```

- [ ] **Step 5（Task 5C）：写 drain/exit/failure RED 测试**

`DrainLifecycle` 组覆盖 root exit 0/非零、三种 terminate、control EOF、root-first-grandchild、READY/ERROR/EXIT写失败。每次 Query验证 BOOL与结构长度；计数器证明成功 Query之间有 completion notification或低频等待且无 tight loop。Terminate/首次/中途/最终 Query/Wait失败都禁止 EXIT、尽力ERROR、最终关闭Job清树。helper强杀分“root活着”与“root已退但grandchild活着”。

```powershell
node scripts/windows-native-helper.mjs test-kernel --filter DrainLifecycle
```

预期：FAIL，production helper尚无统一 drain。

- [ ] **Step 6（Task 5C）：实现唯一 cleanup owner 并转绿**

root/control reader只竞争 `LifecycleMachine` gate；winner至多一次 `TerminateJobObject`，节流查询到真实 `ActiveProcesses=0`才构造EXIT。target process handle保留到root code取得；process/thread handles只在统一cleanup关闭。任一 kernel/control failure锁定ERROR并最终关闭Job，绝不把helper exit code当terminal。

```powershell
node scripts/windows-native-helper.mjs test-kernel --filter DrainLifecycle
git add native/windows-job-helper/src/JobSession.cs native/windows-job-helper/src/JobHelper.cs native/windows-job-helper/tests/WindowsKernelTests.cs
git commit -m "feat: drain Windows jobs before helper exit"
```

- [ ] **Step 7（Task 5D）：写真实 barrier/fault/outer-job RED 测试**

test-only build分别停在 `CONFIGURED`、`JOB_READY`、`CREATING`、`CREATED_ASSIGNED`/resume前、resume后/READY前；每个关键交错使用确定性barrier至少2000轮竞争TERMINATE/EOF/protocol error与create success/failure，禁止用概率性sleep充当barrier，逐轮断言marker、READY、suspended child、handles、唯一owner/terminal。另覆盖Initialize/两个Update/Create/Resume/Terminate/三处Query/Wait fault、并行Jobs、unrelated sentinel，以及上述同一outer Job peer的compatible/incompatible完整证据。

```powershell
node scripts/windows-native-helper.mjs test-kernel --filter RacesAndFaults
```

预期：FAIL，test build尚无注入接口。

- [ ] **Step 8（Task 5D）：仅在 test build接入 barrier/fault并转绿**

fault/barrier由 `build.config.json` 的 test-only source set静态编译进入测试 helper；production source/API/env/args均无开关。实现后扫描production source/IL，拒绝fault token以及 `AssignProcessToJobObject`、`TerminateProcess`、`taskkill`、WMI、PID reopen/direct-spawn fallback。

```powershell
node scripts/windows-native-helper.mjs test-kernel --filter RacesAndFaults
npm run native:test:kernel
npx vitest run test/native/windows-job-helper-protocol.test.ts test/native/windows-job-helper-kernel.test.ts
git diff --check
git add native/windows-job-helper/src native/windows-job-helper/tests native/windows-job-helper/fixtures test/native/windows-job-helper-kernel.test.ts native/windows-job-helper/build.config.json scripts/windows-native-helper.mjs
git commit -m "test: prove Windows job ownership races and faults"
```

预期：无目标残留、无临时文件、无命名内核对象泄漏；每个5A–5D子任务都执行独立规格/质量复审后才进入下一子任务。

## Task 6：生成可复现 helper artifact 并实现 canonical resolver

**Files**

- Create: `plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe`
- Create: `plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256`
- Create: `src/runtime/windows-job-helper.ts`
- Create: `test/native/windows-job-helper-artifact.test.ts`
- Create: `test/runtime/windows-job-helper.test.ts`
- Modify: `scripts/windows-native-helper.mjs`
- Modify: `package.json`

- [ ] **Step 1：写 reproducibility、artifact 与 resolver RED 测试**

测试必须断言：两个不同绝对临时根的 clean build byte-for-byte 相同；canonical SHA 清单为严格小写 64 hex + 两空格 + 固定文件名；实际 exe SHA 与清单一致；PE=x64、CLR=.NET Framework 4.8；`--probe-v1` 精确 stdout一行、stderr空、exit 0，毒化环境不影响输出，且不打开 fd3/control pipe、不创建 Job/target/temp file/worker thread、不枚举进程、不读取用户目录/config/secret；production artifact无 fault/barrier switch。

resolver 必须覆盖 `dist/*.js` 与 `plugins/codex-external-agents/runtime/*.mjs` 两种 `import.meta.url` 布局，只接受唯一插件内 canonical helper；Windows 非 x64、missing、symlink、junction/path escape、非法清单、hash mismatch 均 fail closed；不接受环境变量或公开参数覆盖 helper path。

```powershell
npx vitest run test/native/windows-job-helper-artifact.test.ts test/runtime/windows-job-helper.test.ts
```

预期：artifact、SHA 与 resolver 不存在而失败。

- [ ] **Step 2：先只在临时目录证明可复现，再更新入库 artifact**

```powershell
node scripts/windows-native-helper.mjs reproducibility-check
npm run native:update-artifact
npm run native:verify
```

`native:update-artifact` 是唯一可写 canonical exe/SHA 的命令；它必须先完成两根 byte comparison，再原子替换 artifact。签入后 `native:verify` 从 source重建到临时目录并逐字节比较，不得忽略 PE 区域或接受“语义等价”。

- [ ] **Step 3：验证并提交**

```powershell
npm run native:verify
npx vitest run test/native/windows-job-helper-artifact.test.ts test/runtime/windows-job-helper.test.ts
npm run typecheck
git diff --check
git add plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256 src/runtime/windows-job-helper.ts test/native/windows-job-helper-artifact.test.ts test/runtime/windows-job-helper.test.ts scripts/windows-native-helper.mjs package.json
git commit -m "build: add verified Windows job helper artifact"
```

## Task 7：建立不暴露 PID 的跨平台 OwnedAgentProcess

**Files**

- Create: `src/runtime/owned-agent-process.ts`
- Create: `src/runtime/posix-owned-agent-process.ts`
- Create: `test/runtime/owned-agent-process.test.ts`
- Create: `test/runtime/posix-owned-agent-process.test.ts`
- Modify: `src/runtime/process-tree.ts`
- Modify: `test/runtime/process-tree.test.ts`

- [ ] **Step 1：先写接口与 POSIX 回归 RED 测试**

接口固定暴露 `stdin/stdout/stderr`、`ready: Promise<void>`、`closed: Promise<OwnedProcessExit>`、`terminate(reason)`，不暴露 PID。`SpawnOwnedAgentProcessRequest` 精确包含 `executable`、`args`、`cwd`、adapter 已构造的 `environment: NodeJS.ProcessEnv` 与 `invocationKind: "native" | "cmd"`；不包含默认 timeout 或资源预算。client可调用的 termination reason 只有 `cancelled | timed_out | session_shutdown`；`protocol_error` 只属于 Windows wrapper 检测 helper 控制协议损坏后的私有清理路径，不能由 Kimi/Pi adapter调用。

类型合同冻结为：

```ts
type OwnedTerminationReason = "cancelled" | "timed_out" | "session_shutdown";
type OwnedCompletion = "root_exit" | OwnedTerminationReason;
type OwnedProcessExit =
  | Readonly<{
      platform: "win32";
      completion: OwnedCompletion;
      rootExitCode: number; // uint32
      signal: null;
      ownershipDrained: true;
    }>
  | Readonly<{
      platform: "posix";
      completion: OwnedCompletion;
      rootExitCode: number;
      signal: null;
      ownershipDrained: true;
    }>
  | Readonly<{
      platform: "posix";
      completion: OwnedCompletion;
      rootExitCode: null;
      signal: NodeJS.Signals;
      ownershipDrained: true;
    }>;
```

`closed` 只有在 production ownership已完整 drain时 resolve；helper ERROR、控制协议错误、terminal缺失/重复、Job未证明归零、spawn/stream fault均以固定脱敏 `OwnedProcessFailure` reject，绝不返回 `ownershipDrained:false` 的“半成功”。若业务/协议先失败且 cleanup也失败，首次业务失败保持权威类别，cleanup failure以固定脱敏 secondary diagnostics/cause保留；若业务原本成功但 cleanup失败，则整个调用按 cleanup failure失败。任意组合都不能让 cleanup失败转为成功或泄漏原始 path/env/system message。

POSIX 保持现有 detached process group、负 PGID、SIGTERM 后局部 grace 再 SIGKILL 的停止语义；grace 只在停止已经请求后生效，不是模型执行 deadline。`terminate()` 幂等；`closed` 只在完整 process group 清理后完成。

```powershell
npx vitest run test/runtime/process-tree.test.ts test/runtime/owned-agent-process.test.ts test/runtime/posix-owned-agent-process.test.ts
```

预期：owned abstraction 不存在而失败。

- [ ] **Step 2：实现 platform spawner 与 POSIX adapter**

Windows 分支暂时只抛固定 unsupported，Task 8 接线后转绿；不得为 Windows 保留 taskkill/direct spawn fallback。公共 classifier 由已解析 absolute executable 的扩展名生成 kind：`.cmd/.bat` 大小写无关为 `cmd`，其它受支持 PE 为 `native`，未知扩展 fail closed。保留的低层 PID 工具若只服务测试或 acceptance，必须从 production target call graph 隔离并由静态测试证明。

- [ ] **Step 3：验证并提交**

```powershell
npx vitest run test/runtime/process-tree.test.ts test/runtime/owned-agent-process.test.ts test/runtime/posix-owned-agent-process.test.ts
npm run typecheck
git diff --check
git add src/runtime/owned-agent-process.ts src/runtime/posix-owned-agent-process.ts src/runtime/process-tree.ts test/runtime/owned-agent-process.test.ts test/runtime/posix-owned-agent-process.test.ts test/runtime/process-tree.test.ts
git commit -m "refactor: model agent subprocesses by ownership"
```

## Task 8：实现 Node→Windows helper transport wrapper

**Files**

- Create: `src/runtime/windows-owned-agent-process.ts`
- Create: `test/runtime/windows-owned-agent-process.test.ts`
- Create: `test/fakes/fake-windows-job-helper.mjs`
- Create: `test/runtime/windows-owned-agent-process.integration.test.ts`
- Modify: `src/runtime/owned-agent-process.ts`
- Modify: `src/runtime/windows-job-protocol.ts`

- [ ] **Step 1：先用 fake helper 写 transport RED 测试**

覆盖：helper command line 只有已验证路径与 `--control-v1`，不含 target/cwd/argv/env/prompt；`stdio: ["pipe","pipe","pipe","pipe"]`；CONFIG 只经 fd3；READY 前 `ready` 不完成；short/merged/bad frames、READY 缺失、重复/尾随 terminal、helper 非零退出全部 fail closed。

`terminate()` 幂等，只写完整 `TERMINATE`，不得对 fd3 `end()`/`destroy()`；wrapper 自己检测到 helper-control protocol error时，在 fd3 可写的私有路径发送一次 `TERMINATE(protocol_error)` 并永久失败。仅 fd3 已损坏到无法正常 cleanup 时，可用 retained `ChildProcess` handle强杀 helper；仍返回失败且不得通过 `.pid` reopen/lookup。`closed` 无总截止。

helper 必须只收到 request 的精确 `environment`，不能把 Node/MCP 父进程环境重新 merge 回去。用毒化父环境 + 最小 request环境的测试证明 target只看到 request环境；环境值不得进入 helper command line、fd3 CONFIG、diagnostics或持久证据。

```powershell
npx vitest run test/runtime/windows-owned-agent-process.test.ts
```

预期：wrapper 不存在而失败。

- [ ] **Step 2：实现最小 wrapper，再接真实 helper**

真实 integration 覆盖 native/`.cmd` argv/cwd/env、READY marker、自然 root exit code 0/非零且精确保留、root-first grandchild、cancelled/timed_out/session_shutdown、helper强杀时 root仍存活与 root已退但 grandchild存活、两个并行 Job、unrelated sentinel、fd3/Job handle不可达和无 PID fallback。成功必须同时有合法 terminal、`jobActiveProcessesZero=1`、helper exit 0和 stream close；不能只凭任一单项。

- [ ] **Step 3：验证并提交**

```powershell
npx vitest run test/runtime/windows-job-protocol.test.ts test/runtime/windows-job-helper.test.ts test/runtime/windows-owned-agent-process.test.ts test/runtime/windows-owned-agent-process.integration.test.ts
npm run native:verify
npm run typecheck
git diff --check
git add src/runtime/windows-owned-agent-process.ts src/runtime/owned-agent-process.ts src/runtime/windows-job-protocol.ts test/runtime/windows-owned-agent-process.test.ts test/runtime/windows-owned-agent-process.integration.test.ts test/fakes/fake-windows-job-helper.mjs
git commit -m "feat: control Windows owned processes through job helper"
```

## Task 9：让 Kimi client 只通过 OwnedAgentProcess 运行

**Files**

- Modify: `src/adapters/kimi/client.ts`
- Modify: `test/adapters/kimi/client.test.ts`
- Modify: `test/adapters/kimi/client-cleanup.test.ts`

- [ ] **Step 1：把旧 PID/一秒放弃合同改成 RED 测试**

通过不进入公开 request 的 `KimiAcpClientDependencies.spawnOwnedAgentProcess` 注入 fake owned process。断言：立即连接 stdout/stderr 防 backpressure，但 `await ready` 前不启动 ACP、不上报 `kimi process started`；pre-ready cancel不发 ACP cancel，只 `terminate(cancelled)`；ready 后先 ACP session cancel、保留既有协议 grace，再 owned terminate；显式 deadline 映射 `timed_out`，session shutdown 映射相应 reason。

删除 `KIMI_CHILD_CLOSE_TIMEOUT_MS` 和“terminator 成功但 child 未关时 1 秒后放弃”的测试；新的 `finally` 必须无总截止等待 `terminate()` 与 `closed`。固定 helper错误只能进入脱敏 diagnostics；省略 `timeoutMs` 仍不创建 deadline。

共享错误优先级测试覆盖：业务成功+cleanup失败→cleanup失败；业务失败+cleanup成功→原业务失败；业务失败+cleanup失败→原业务类别不变且固定 secondary cleanup diagnostic存在；不得产生 unhandled rejection。

```powershell
npx vitest run test/adapters/kimi/client.test.ts test/adapters/kimi/client-cleanup.test.ts
```

预期：旧 client 仍 direct spawn/PID cleanup，测试失败。

- [ ] **Step 2：最小迁移，不改 ACP/资格语义**

不得改 prompt、provider/model、review policy、命令观测、retry/fallback或公开 MCP schema。Windows 与 POSIX 都走同一 platform owned spawner。

- [ ] **Step 3：验证并提交**

```powershell
npx vitest run test/adapters/kimi/client.test.ts test/adapters/kimi/client-cleanup.test.ts test/runtime/owned-agent-process.test.ts test/runtime/windows-owned-agent-process.test.ts
npm run typecheck
git diff --check
git add src/adapters/kimi/client.ts test/adapters/kimi/client.test.ts test/adapters/kimi/client-cleanup.test.ts
git commit -m "refactor: run Kimi through owned process transport"
```

## Task 10：让 Pi client 只通过 OwnedAgentProcess 运行

**Files**

- Modify: `src/adapters/pi/client.ts`
- Modify: `test/adapters/pi/client.test.ts`

- [ ] **Step 1：把 Execa/PID 合同改成 RED 测试**

通过不进入公开 request 的 `PiRpcClientDependencies.spawnOwnedAgentProcess` 注入。断言：READY 前不发 `set_model`、`set_thinking_level`、prompt，不上报 started；`closed` 在 `agent_settled` 前完成仍产生原有固定失败；Pi JSONL/RPC decoder error保留原调用失败并以普通 cleanup reason `cancelled` 终止 owned tree，不能冒充 helper-control `protocol_error`；取消仍先发恰好一次 RPC `abort`，既有 grace 后 owned terminate；finally 无总截止等待完整 Job/group 归零。

复用 Task 9 的四格错误优先级合同，额外断言 decoder/agent failure与 `closed` rejection组合不会被 cleanup覆盖或产生 unhandled rejection。

```powershell
npx vitest run test/adapters/pi/client.test.ts
```

预期：旧 client 仍依赖 Execa promise/PID terminator，测试失败。

- [ ] **Step 2：最小迁移并保持现有业务合同**

保持 runtime retry、identity、redaction、command correlation、资格 no-retry、provider/model/env routing 不变；不得把 Pi native retry混入本轮。

- [ ] **Step 3：验证并提交**

```powershell
npx vitest run test/adapters/pi/client.test.ts test/runtime/owned-agent-process.test.ts test/runtime/windows-owned-agent-process.test.ts
npm run typecheck
git diff --check
git add src/adapters/pi/client.ts test/adapters/pi/client.test.ts
git commit -m "refactor: run Pi through owned process transport"
```

## Task 11：让 stdio session 的完成证据来自 owned process 归零

**Files**

- Modify: `test/mcp/stdio-process-cleanup.test.ts`
- Modify: `test/fakes/fake-kimi-acp.mjs`
- Modify: `test/fakes/fake-pi-rpc.mjs`
- Modify only if a new RED test proves necessary: `src/mcp/stdio-session.ts`

- [ ] **Step 1：升级真实 transport 清理测试**

保留 `StdioServerTransport → MCP tool → service → adapter → client → fake executable` 全链，并断言 `client cleanup < service settle < stdio session settle`。通过 retained `OwnedAgentProcess` 观察 root/carrier/grandchild；PID 文件只作为存活观测，不能成为 production 正向终止接口。

teardown 若需要安全补救，必须把测试标为失败并保存固定脱敏证据，不能用补救把测试转绿。Windows 路径必须由真实 helper terminal/Job 归零证明；POSIX 保持 process-group 证据。现行 session 已有 `server.close() → inFlight.drain()`，没有 RED 前不改生产文件。

```powershell
npx vitest run test/mcp/stdio-process-cleanup.test.ts test/mcp/stdio-session.test.ts test/mcp/in-flight.test.ts
```

预期：旧 fake/PID 合同与新 owned evidence 不匹配而失败。

- [ ] **Step 2：最小修改 fixtures/注入并复验跨平台顺序**

不增加 timer/watchdog；stdin end/close/error、SIGINT/SIGTERM 与显式 close仍共享同一幂等 shutdown。普通测试的局部 fixture timeout只在 abort/terminate 已请求后防测试挂死。

- [ ] **Step 3：验证并提交**

```powershell
npx vitest run test/mcp/stdio-process-cleanup.test.ts test/mcp/stdio-session.test.ts test/mcp/in-flight.test.ts test/adapters/kimi/client-cleanup.test.ts test/adapters/pi/client.test.ts
npm run typecheck
git diff --check
git add src/mcp/stdio-session.ts test/mcp/stdio-process-cleanup.test.ts test/fakes/fake-kimi-acp.mjs test/fakes/fake-pi-rpc.mjs
git commit -m "test: prove stdio waits for owned process cleanup"
```

## Task 12：闭合 doctor、package、能力指纹与 Task 9 前双态门禁

本大项必须拆成12A–12D四个独立、可编译、可提交子任务；每个子任务使用fresh implementer并完成规格/质量双审，不得把31个文件压进一个GREEN步骤。

**Files**

- Create: `scripts/release-smoke-core.mjs`
- Create: `scripts/prequalification-core-smoke.mjs`
- Create: `scripts/prequalification-smoke.mjs`
- Create: `scripts/candidate-smoke.mjs`
- Create: `scripts/assert-expected-stale.mjs`
- Create: `test/release/prequalification-smoke.test.ts`
- Create: `src/release/package-set-digest.ts`
- Create: `test/release/package-set-digest.test.ts`
- Create: `scripts/package-eol-reproducibility.mjs`
- Create: `test/release/package-eol-reproducibility.test.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `test/cli/doctor.test.ts`
- Modify: `src/qualification/capability-index.ts`
- Modify: `test/qualification/capability-index.test.ts`
- Modify: `scripts/verify-capabilities.ts`
- Modify: `test/qualification/capability-verifier-cli.test.ts`
- Modify: `src/qualification/preflight.ts`
- Modify: `test/qualification/preflight.test.ts`
- Modify: `src/qualification/types.ts`
- Modify: `src/qualification/coordinator.ts`
- Modify: `test/qualification/coordinator.test.ts`
- Modify: `src/qualification/manifest.ts`
- Modify: `test/qualification/manifest.test.ts`
- Modify: `test/qualification/verifier.test.ts`
- Modify: `src/release/assurance.ts`
- Modify: `test/release/assurance.test.ts`
- Modify: `scripts/release-smoke.mjs`
- Modify: `scripts/plugin-isolated-acceptance.mjs`
- Modify: `scripts/npm-package-acceptance.mjs`
- Modify: `src/acceptance/npm-package.ts`
- Modify: `test/acceptance/npm-package.test.ts`
- Modify: `test/plugin/artifact.test.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/superpowers/plans/2026-07-31-stdio-lifecycle-and-native-execution-budget.md`
- Modify: `docs/superpowers/plans/2026-07-29-beta-to-stable-release.md`

- [ ] **Step 1：先写 strict doctor 与 package exact-set RED 测试**

Windows x64 strict doctor 必须复用 production resolver：canonical path、无 symlink/path escape、actual SHA、PE/CLR、`--probe-v1` 精确输出全过才 pass；Windows non-x64 fail closed；POSIX 报 not-applicable而不把 Windows helper 当错误。不得输出真实路径、用户名、原始 Win32 message或凭据。

插件 artifact 从原 4 项精确变为 6 项（原 4 项 + exe + SHA），隔离测试复制完整 plugin。npm package精确包含 native source/build config/toolchain lock、唯一 helper exe/SHA和批准 spec/plan；`.exe` 明确 binary，不做 UTF-8/secret text decode；`.cs/.ps1/.json/.sha256` 继续接受文本敏感信息、绝对路径和链接检查。同步修复 `src/release/assurance.ts` 被 stale verifier 短路遮蔽的 public-file allowlist，包括已经打包的两份 2026-07-31 lifecycle 文档。

`package-set-digest.ts` 是唯一 canonical算法：接收经过 package path安全验证的精确相对路径集合，按 UTF-8 bytewise路径排序，把每个 path length/path bytes/file length/raw file bytes送入版本化 SHA-256；拒绝重复、symlink、path escape、缺失/额外路径。后续 Windows partial/composite、Ubuntu publish与 installed-tree acceptance全部复用这一实现，不能各自重新发明摘要格式。

`package-eol-reproducibility.mjs` 验证**暂存区精确候选**而不是旧 `HEAD`：调用前要求本任务所有变化均已 staged且无 unstaged/untracked候选文件；脚本用 `git write-tree` + `git commit-tree` 生成不移动当前分支的临时 candidate commit，并在 `try/finally` 中建立/删除唯一临时 ref。两个经验证的系统临时 clone各自只 fetch该临时 ref，分别固定 `core.autocrlf=true/false` 后 checkout同一 candidate commit、断言 `HEAD`/tree identity、`npm ci`、build、dry-run pack，并按共享算法比较完整 path集合/raw-byte digest；两边必须相同，临时ref/clone最终全部清理。该真实 gate在 Task 12与Task 14运行，不能只靠 `.gitattributes` 文本断言，也不能把未提交候选误替换为旧 `HEAD`。

同步公开 README、operations与 release checklist：首版 Windows只支持 Windows 10/11 x64 + .NET Framework 4.8；non-x64/CLR/helper/hash/probe任一失败都 fail closed且无 direct-spawn fallback；Job只有生命周期归属，没有任何执行资源上限。公开故障排查只建议修复受控 artifact/runtime前提，不建议 taskkill/PID补救。

```powershell
npx vitest run test/cli/doctor.test.ts test/plugin/artifact.test.ts test/release/assurance.test.ts test/native/windows-job-helper-artifact.test.ts test/release/package-set-digest.test.ts test/release/package-eol-reproducibility.test.ts
```

预期：doctor、package/allowlist仍不知道 native artifact而失败；共享 digest runtime entry与暂存区精确 candidate双checkout EOL gate也尚不存在，两个新release测试必须分别失败。

- [ ] **Step 1B（Task 12A）：实现 doctor/package/EOL 最小闭包并提交**

复用production resolver实现strict doctor；更新plugin/package exact sets、binary/text scanners、public-file allowlist和完整plugin复制。实现唯一 `package-set-digest.ts`，并在 `tsup.config.ts` 增加独立 `package-set-digest` runtime entry；所有 Node `.mjs` 只导入build后的该entry，不复制算法或直接加载TypeScript。实现暂存区精确candidate双checkout EOL gate，公开README/operations/checklist只写已批准支持边界。

```powershell
npx vitest run test/cli/doctor.test.ts test/plugin/artifact.test.ts test/release/assurance.test.ts test/native/windows-job-helper-artifact.test.ts test/release/package-set-digest.test.ts test/release/package-eol-reproducibility.test.ts
npm run build
git diff --check
git add .gitattributes package.json tsup.config.ts README.md docs/operations.md docs/release/checklist.md src/cli/doctor.ts src/release/assurance.ts src/release/package-set-digest.ts scripts/package-eol-reproducibility.mjs scripts/plugin-isolated-acceptance.mjs test/cli/doctor.test.ts test/plugin/artifact.test.ts test/release/assurance.test.ts test/release/package-set-digest.test.ts test/release/package-eol-reproducibility.test.ts
git diff --cached --check
npm run verify:package-eol
git commit -m "feat: package and diagnose Windows native helper"
```

- [ ] **Step 2：先写能力 assessment 与 binary fingerprint RED 测试**

`capability-index.ts` 增加结构化 assessment，但普通公开 CLI 仍只输出固定脱敏成功/失败。assessment 必须完整验证 index、registry anchor、manifest/evidence、runtime inputs，不能遇到 fingerprint stale 就跳过其它错误。

runtime fingerprint 加入 helper C# source/build/toolchain文本，以及“读取 actual exe → 核对 SHA manifest → 写入规范化摘要”的二进制合成输入；实际 exe不匹配时 evidence invalid/fingerprint invalid，不能只信文本 SHA。改 exe+SHA会产生新 fingerprint并精确八项 stale。

资格 artifact 集用 schema明确判别两套不可混搭身份：历史 four-llm preflight schema v2只允许精确4项并继续只读验真；native producer/coordinator升级为 schema v3且只能生成 runtime bundle + helper exe + helper SHA的精确6项，当前 coordinator从依赖收到 v2即拒绝。v2+6、v3+4、重复、缺项或4/6混合全部拒绝，不得让历史 immutable manifests从“仅 stale”退化为 invalid。测试必须用仓库现有真实 v2 manifest证明兼容，并分别证明新 v3 producer/manifest通过、新生成四项拒绝、v2六项拒绝和混搭拒绝。

```powershell
npx vitest run test/qualification/capability-index.test.ts test/qualification/capability-verifier-cli.test.ts test/qualification/preflight.test.ts test/qualification/manifest.test.ts test/qualification/verifier.test.ts
```

预期：RED，现有 collector拒绝binary，v2 producer仍生成四项，且没有结构化 stale reason。

- [ ] **Step 2B（Task 12B）：实现 schema v3、binary fingerprint与完整 assessment并提交**

先让历史真实v2 fixtures保持通过，再让current producer只生成v3六项；assessment对每项累计全部reason，不因stale跳过evidence/anchor/input校验。actual exe SHA先与manifest比较，再把规范化digest作为synthetic runtime input。

```powershell
npx vitest run test/qualification/capability-index.test.ts test/qualification/capability-verifier-cli.test.ts test/qualification/preflight.test.ts test/qualification/manifest.test.ts test/qualification/verifier.test.ts test/qualification/coordinator.test.ts
npm run typecheck
git diff --check
git add src/qualification/capability-index.ts src/qualification/preflight.ts src/qualification/manifest.ts src/qualification/types.ts src/qualification/coordinator.ts scripts/verify-capabilities.ts test/qualification/capability-index.test.ts test/qualification/capability-verifier-cli.test.ts test/qualification/preflight.test.ts test/qualification/manifest.test.ts test/qualification/verifier.test.ts test/qualification/coordinator.test.ts
git commit -m "feat: fingerprint native qualification inputs"
```

- [ ] **Step 3A（Task 12C）：先写 preflight/release-smoke 双态 RED 合同**

把 release smoke共享阶段提取到 `release-smoke-core.mjs`，但固定事件顺序不变：build完成后先做 structured capability assessment，再运行 native/packaged-file/secret/npm-pack gates，联网名称检查永远最后。事件顺序测试必须证明普通 stale verifier在 pack/联网检查前 fail closed，同时 prequalification用精确 expected-stale assessment继续运行其余本地门禁：

- `smoke:release`：先要求普通 verifier 8/8，再运行后续 core；Task 9前在 pack/network前 exit 1。
- `smoke:prequalification:core`：先要求 assessment全部且仅有排序后的八项 `runtime_fingerprint_stale`，再运行全部本地 native/package core；任一其它错误、少/多于八项、已经8/8 qualified都拒绝。它只表示“本地 core 已通过”，不宣称远端 composite attestation已通过。
- `smoke:prequalification`：Task 13 才完成的最终入口；在 core之外还必须固定获取并验证当前 immutable HEAD、当前 CI workflow/run 的三版 Node composite attestation。Task 12 不伪造该结果。
- `smoke:candidate`：只接受上述精确 prequalification 状态或普通 8/8 qualified状态；两种状态都运行同一 core，不提供 skip/refresh/任意 index path/continue-on-error。

Task 12 先把 `src/qualification/preflight.ts` 的 `smoke:release` 改为临时的 `smoke:prequalification:core`，并把 `npm test` 固定为 `npm test -- --maxWorkers=1`，让本任务提交可独立全绿；Task 13 在 composite attestation实现后再把它升级为最终 `smoke:prequalification`。普通发布门禁始终不变。

`assert-expected-stale.mjs` 是无参数固定入口：分别以非 shell child capture运行普通 `verify:capabilities` 与 `smoke:release`，逐条断言 nonzero exit、stdout精确空、stderr精确固定脱敏行，并再用结构化 assessment断言唯一八项 stale；任一子命令被后续成功命令覆盖都不可能让它通过。Task 12/14用 `npm run verify:expected-stale`，不依赖人工观察 `$LASTEXITCODE`。

```powershell
npx vitest run test/release/prequalification-smoke.test.ts test/qualification/preflight.test.ts test/qualification/capability-index.test.ts
```

预期：FAIL；`release-smoke-core`、expected-stale capture与prequalification/candidate固定入口尚不存在，preflight仍错误调用普通 `smoke:release`。

- [ ] **Step 3B（Task 12C）：实现双态门禁、确认 GREEN 并提交**

实现共享release core、四个固定入口和非shell独立失败捕获；保持普通release fail closed，只让精确八项stale进入prequalification core，并把本阶段preflight固定到core。

```powershell
npx vitest run test/release/prequalification-smoke.test.ts test/qualification/preflight.test.ts test/qualification/capability-index.test.ts
npm run verify:expected-stale
npm run smoke:prequalification:core
git diff --check
git add package.json scripts/release-smoke-core.mjs scripts/release-smoke.mjs scripts/prequalification-core-smoke.mjs scripts/prequalification-smoke.mjs scripts/candidate-smoke.mjs scripts/assert-expected-stale.mjs src/qualification/preflight.ts test/release/prequalification-smoke.test.ts test/qualification/preflight.test.ts
git commit -m "feat: distinguish stale prequalification from release"
```

预期：expected-stale helper机器证明两条普通命令各自满足失败合同；最后一条在所有本地 native/package gate已通过且恰好八项 stale时 exit 0，但尚不构成最终 prequalification。

- [ ] **Step 4A（Task 12D）：先写公共 npm 与缓存 artifact RED 合同**

公共包没有完整 TS fingerprint source，因此不伪称在 `packageRoot` 重算能力指纹。验收采用最小闭包方案：工作树权威 verifier 8/8；已安装 `capabilities.json`、manifest/evidence与验证 checkout逐字节/哈希一致；registry返回的 npm integrity验证下载 tarball；再对实际 installed tree按 attestation同一 canonical path/raw-byte算法重算**完整 package-set digest**并与当前 release composite attestation一致，从而覆盖 dist、plugin runtime、docs与helper，而不只比较 index/evidence。package helper、插件缓存 helper和SHA manifest三者还要单独一致；direct MCP与缓存 MCP都解析 canonical helper。任何一项不同都 fail closed。

更新两份上游计划，明确 Task 9 前使用 prequalification，Task 11 使用上述 installed qualification closure，不扩大 npm 包到全部 TS source；同时把 Windows 实际宿主 evidence和 stable validation marker纳入 Task 11/12。

先只扩展 `test/acceptance/npm-package.test.ts`，注入严格fake composite verifier，覆盖exact installed path set、npm integrity、checkout evidence闭包、helper/cache/SHA一致与fetcher缺失fail closed；实现文件保持不变。

```powershell
npx vitest run test/acceptance/npm-package.test.ts
```

预期：FAIL；现有acceptance没有installed full package-set/composite verifier合同，也不会在production fetcher缺失时按新固定错误fail closed。

- [ ] **Step 4B（Task 12D）：实现 installed closure合同并提交**

本阶段先实现对exact installed path set、npm integrity、checkout evidence闭包和helper/cache SHA的可注入 verifier；release composite fetch依赖Task13 schema，因此用严格fake verifier写RED/GREEN合同，production默认在fetcher缺失时fail closed，绝不暂时跳过。

```powershell
npx vitest run test/acceptance/npm-package.test.ts
npm run typecheck
git diff --check
git add scripts/npm-package-acceptance.mjs src/acceptance/npm-package.ts test/acceptance/npm-package.test.ts docs/superpowers/plans/2026-07-31-stdio-lifecycle-and-native-execution-budget.md docs/superpowers/plans/2026-07-29-beta-to-stable-release.md
git commit -m "test: define installed native package closure"
```

- [ ] **Step 5：组合复验 12A–12D 已提交结果**

```powershell
npx vitest run test/cli/doctor.test.ts test/plugin/artifact.test.ts test/release/assurance.test.ts test/release/prequalification-smoke.test.ts test/release/package-set-digest.test.ts test/release/package-eol-reproducibility.test.ts test/qualification/capability-index.test.ts test/qualification/capability-verifier-cli.test.ts test/qualification/preflight.test.ts test/qualification/manifest.test.ts test/qualification/verifier.test.ts test/qualification/coordinator.test.ts test/acceptance/npm-package.test.ts
npm run build
npm run verify:package-eol
npm run smoke:prequalification:core
npm run acceptance:plugin:isolated -- --check-report
npm pack --dry-run --json
npm run typecheck
git diff --check
```

预期：12A–12D提交后的组合全绿；若任一最终命令要求改代码，回到对应子任务RED/GREEN并追加该子任务的修复提交与双审，不在本步骤混合修改。

## Task 13：增加 Windows CI 与跨 OS immutable release attestation

本大项拆成13A schema/fetch/installed closure与13B workflows两次独立提交和双审；Task14才运行final SHA远端矩阵。

**Files**

- Create: `src/release/windows-native-attestation.ts`
- Create: `scripts/create-windows-native-partial.mjs`
- Create: `scripts/aggregate-windows-native-attestation.mjs`
- Create: `scripts/verify-windows-native-attestation.mjs`
- Create: `scripts/fetch-current-windows-native-attestation.mjs`
- Create: `scripts/fetch-release-windows-native-attestation.mjs`
- Create: `test/release/windows-native-attestation.test.ts`
- Modify: `scripts/prequalification-smoke.mjs`
- Modify: `scripts/candidate-smoke.mjs`
- Modify: `src/qualification/preflight.ts`
- Modify: `test/qualification/preflight.test.ts`
- Modify: `scripts/npm-package-acceptance.mjs`
- Modify: `src/acceptance/npm-package.ts`
- Modify: `test/acceptance/npm-package.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `test/release/workflows.test.ts`
- Modify: `package.json`
- Modify: `tsup.config.ts`

- [ ] **Step 1（Task 13A）：先写 attestation/fetch/installed closure RED 测试**

定义两层 schema。每个 Node shard的 partial必须包含 immutable commit SHA、workflow/run identity、checked-in helper actual SHA、source/build/toolchain identity、toolchain package-set digest、按规范化路径排序并对原始字节 hash的实际 npm package-set digest、Windows OS/build、精确 Node version、每项测试结果、schema version和自身 digest。composite只接受同一 workflow/run/current SHA的精确 20.20.2/22.23.2/24.18.1三份 partial，核对 helper/toolchain/package-set完全相同后记录三份 digest和自身 digest；禁止 credential、完整命令行、用户名或原始临时路径。

partial/composite 的 `selfDigest` 不参与自身输入：先移除该字段，对剩余普通 JSON值递归按 Unicode code point排序 object keys、保持 array顺序、拒绝 float/NaN/Infinity/accessor/symbol/prototype污染，以无空白 UTF-8 `JSON.stringify` bytes计算 SHA-256小写 hex，再把结果写回 `selfDigest`。测试固定 partial/composite golden JSON bytes与digest，避免自引用、key order或换行歧义。

workflow测试断言 Ubuntu Node20/22/24保留；新增 `windows-2022` x64 Node20.20.2/22.23.2/24.18.1阻断矩阵，每个 shard上传唯一 partial；单独 `windows-native-aggregate` 只下载**当前 run**三份精确命名 partial并生成 composite。两侧显式 checkout `${{ github.sha }}` 并核对 HEAD；release publish `needs: windows-native-aggregate`；取得 OIDC前已验证 composite/current SHA/helper/package-set；Ubuntu不重建/下载替换 helper。

```powershell
npx vitest run test/release/windows-native-attestation.test.ts test/acceptance/npm-package.test.ts test/qualification/preflight.test.ts
```

预期：schema/fetch scripts与production release composite verifier不存在而失败。

- [ ] **Step 1B（Task 13A）：实现 attestation schema、固定 fetchers 与 installed closure并提交**

实现上述partial/composite canonical JSON/selfDigest合同和两个固定fetcher；current fetch只认当前HEAD的固定`ci.yml` aggregate，release fetch只认exact semver→registry gitHead/integrity→同commit tag→固定`release.yml` aggregate。npm acceptance用共享package-set算法验证installed全文件。`tsup.config.ts`增加`windows-native-attestation` entry；package-set算法继续复用Task 12A已有的独立dist entry，`.mjs`只导入这两个build后入口。

```powershell
npx vitest run test/release/windows-native-attestation.test.ts test/acceptance/npm-package.test.ts test/qualification/preflight.test.ts
npm run build
npm run typecheck
git diff --check
git add src/release/windows-native-attestation.ts scripts/create-windows-native-partial.mjs scripts/aggregate-windows-native-attestation.mjs scripts/verify-windows-native-attestation.mjs scripts/fetch-current-windows-native-attestation.mjs scripts/fetch-release-windows-native-attestation.mjs scripts/prequalification-smoke.mjs scripts/candidate-smoke.mjs src/qualification/preflight.ts test/qualification/preflight.test.ts scripts/npm-package-acceptance.mjs src/acceptance/npm-package.ts test/acceptance/npm-package.test.ts test/release/windows-native-attestation.test.ts package.json tsup.config.ts
git commit -m "feat: verify Windows native attestations"
```

- [ ] **Step 2（Task 13B）：先写并转绿 CI/release workflow gate**

```powershell
npx vitest run test/release/workflows.test.ts
```

预期：FAIL，两个workflow没有Windows三shard/aggregate/OIDC前digest依赖。随后按下列精确job命令实现workflow。

Windows 全版本运行：

```powershell
npm ci
npm run native:preflight:current
npm run native:test:managed
npm run native:test:kernel
npm run native:verify
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npm run smoke:candidate
npm pack --dry-run --json
node scripts/create-windows-native-partial.mjs
```

每个 shard都以自身当前 Node运行相同 build/package exact-set并创建 partial，避免 Node24结果冒充其它版本。`windows-native-aggregate` 在干净 checkout上验证三份 partial的版本集合、run/SHA/digest一致，运行 `smoke:prequalification:core`（stale候选）或普通 `smoke:release`（已资格候选），再生成 composite。Ubuntu branch CI只运行本地 `smoke:candidate` core；最终阻断性的 attested candidate结论属于 aggregate job。

aggregate job完整序列固定为：

```powershell
git rev-parse HEAD
npm ci
npm run build
# actions/download-artifact 只下载当前 run 的三个精确 partial 名称到固定临时子目录
node scripts/verify-windows-native-attestation.mjs --partials-from-fixed-workflow-directory
npm run smoke:candidate
node scripts/aggregate-windows-native-attestation.mjs
node scripts/verify-windows-native-attestation.mjs --composite-from-fixed-workflow-path
```

workflow测试必须证明 checkout HEAD等于 `${{ github.sha }}`，download step拒绝其它 run/artifact名称；先验证partials、recompute package digest并通过candidate gate，随后才生成/验证/upload composite。composite记录aggregate candidate gate结果；aggregate只接受精确三个版本，fetcher只接受整个aggregate job成功的当前run。

release 的三个 Windows shards在 tag SHA重跑所有 native门禁并上传 partial，aggregate job生成当前 workflow composite；Ubuntu publish下载 composite、核对来源/SHA/digests，自身 build后以 `npm pack --dry-run --json` 重算 package-set，再跑 typecheck、单 worker全量、普通 capability verifier和普通 release smoke，最后才允许 OIDC/npm publish。

`fetch-current-windows-native-attestation.mjs` 不接受 run/path参数：它从当前 git HEAD、固定 repository与固定 `ci.yml` 查找精确 SHA的成功 aggregate check，只下载该 run的 composite到系统临时目录，验证后删除。最终 `smoke:prequalification` 固定调用它再运行 core；`src/qualification/preflight.ts` 从临时 core入口升级为该最终入口。找不到当前 SHA的 composite即 fail closed。

`fetch-release-windows-native-attestation.mjs` 只接收 npm acceptance 已要求的精确 semver/version，不接收 run/path/workflow覆盖：它读取 registry该精确版本的 `dist.integrity`/`gitHead`，要求由字符串 `"v" + version` 形成的 tag精确解析到同一 commit，再定位固定 `release.yml` 在该 commit的成功 aggregate job并验证 composite的 workflow/run/tag/SHA/三partial集合。npm acceptance复用同一 verifier与 `package-set-digest.ts`，对 installed tree全文件摘要核对；Task 12 的预先合同到本任务才获得可执行 release attestation获取路径。

`tsup.config.ts` 增加固定 `windows-native-attestation` entry；所有 `.mjs` 脚本只从 build后的 `dist/windows-native-attestation.js` 导入 schema/digest/fetch verifier，不用 `tsx` 直读源码，也不复制算法。package scripts均先运行 build或由所在 workflow显式保证 build完成。

```powershell
npx vitest run test/release/workflows.test.ts
git diff --check
git add .github/workflows/ci.yml .github/workflows/release.yml test/release/workflows.test.ts
git commit -m "ci: attest Windows native release artifact"
```

- [ ] **Step 3：本地组合验证**

```powershell
npx vitest run test/release/windows-native-attestation.test.ts test/release/workflows.test.ts test/acceptance/npm-package.test.ts
npm run native:verify
npm run smoke:prequalification:core
npm run typecheck
git diff --check
```

本任务只提交 workflow/attestation实现，不把该中间 SHA当 clean freeze，也不要求它承担最终远端证据。最终 push、三 shard、aggregate与 full prequalification统一放在 Task 14的最终文档/代码提交之后，避免 attestation绑定旧 SHA。

## Task 14：完成 prequalification 全矩阵、双审与 clean freeze

**Files**

- Create: `docs/release/windows-native-prequalification.md`
- Modify: `docs/release/real-host-acceptance.md`
- Modify: `AGENTS.md`

- [ ] **Step 1：运行 fresh deterministic matrix**

```powershell
npm run native:preflight
npm run native:test:managed
npm run native:test:kernel
npm run native:verify
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npm run verify:package-eol
npm run smoke:prequalification:core
npm run acceptance:plugin:isolated -- --check-report
npm pack --dry-run --json
git diff --check
```

然后由固定 helper分别运行并记录两条预期失败：

```powershell
npm run verify:expected-stale
```

helper必须捕获二者各自的非零 exit、空 stdout、固定脱敏 stderr，并由结构化 assessment证明唯一原因是八项 `runtime_fingerprint_stale`；不得用 shell `|| true` 或后续命令抹掉 exit code。检查 qualification lock absent，Kimi ACP/Pi RPC/helper/fixture目标进程为0；不得按全机模糊命令清理来制造通过。

- [ ] **Step 2：独立规格审阅与质量/安全审阅**

第一位 reviewer 逐条对照批准 spec、14 项计划、测试输出和 diff；第二位 reviewer独立检查 Win32 ownership、CREATING竞态、handle inheritance、cmd quoting、protocol failure、无隐藏预算、reproducibility、package/qualification/release supply chain。任何 P0/P1/P2 或非 Ready意见回到原任务 TDD 修复并重跑完整矩阵，直至两者 PASS/Ready。

- [ ] **Step 3：持久化最小充分证据并提交 freeze**

`windows-native-prequalification.md` 记录：当前 Windows 10 x64 product/build、CLR、三个 Node版本、helper actual SHA、toolchain/package digests、本地测试计数、普通 verifier/release smoke的精确 stale状态、无真实模型/无发布/无配置插件变更、Task 9重入条件。为避免“先写未来 CI URL → 改 commit → attestation失效”的自引用，文档不硬编码未来 run；它固定说明远端权威是 GitHub上与**文档所在最终 commit SHA完全相同**的 `ci.yml/windows-native-aggregate` check及其 composite artifact，Task完成前必须由下一步机器验证。

更新 `AGENTS.md` 为最新事实，并明确：GitHub Server不是桌面宿主；stable前还必须从公开 beta.2、官方插件完整重启后在一台实际 Windows 10 或 Windows 11 x64维护者宿主记录 Kimi/Pi与 Stop/interrupt全归零。本机 Windows 10 build 19045 可在上游 Task 11 承担该真实宿主门禁。

```powershell
git add docs/release/windows-native-prequalification.md docs/release/real-host-acceptance.md AGENTS.md
git commit -m "docs: freeze Windows native prequalification"
git status --short
```

预期：提交后工作树 clean，但此时仍不能宣称允许进入 Task 9，必须先让这个精确 SHA 通过远端 aggregate。

- [ ] **Step 4：让最终 freeze SHA 取得三版 composite attestation**

```powershell
git push -u origin codex/stdio-lifecycle-and-native-budget
$candidateSha = git rev-parse HEAD
$nativeCiRun = gh run list --commit $candidateSha --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $nativeCiRun --exit-status
npm run smoke:prequalification
git status --short
```

`smoke:prequalification` 必须固定获取刚才同一 `$candidateSha`、同一 workflow run 的 composite，验证精确三版 partial集合和全部 digest，再运行本地 core；工作树仍必须 clean。Windows三版本、aggregate或本地 full prequalification任一失败即回到对应 TDD任务修复、重审、生成新 commit并对**新 SHA**重跑，不能沿用旧 attestation、skip job或 continue-on-error。

只有本步全绿后，才宣称“允许进入 Task 9”；仍不宣称能力已通过、beta已发布或 stable可发布。

## Task 14 后恢复上游 Task 9–12

严格回到 `docs/superpowers/plans/2026-07-31-stdio-lifecycle-and-native-execution-budget.md`：

1. standing authorization 下在 clean frozen SHA 串行运行八项真实能力；single-attempt、首错停、无 resume/retry/fallback，更新同一 `capabilities.json`，历史证据不改。
2. 只有新 8/8 后普通 `verify:capabilities` 与 `smoke:release` 才真实 exit 0；此时 expected-stale prequalification必须拒绝，candidate smoke切换为 qualified状态。
3. GitHub Actions tag `v0.1.1-beta.2` 先过 Windows native attestation，再由 Ubuntu OIDC发布 npm `next`；不本地 publish。
4. 公共 npm验收按 Task 12 的 installed closure执行，官方升级插件、完整退出重开 App，在真实 Windows 10/11 x64宿主验证 compatible nested Job、Kimi/Pi、普通 Stop/dedicated interrupt和 helper/target/descendant归零；unrelated peer、App、Kimi Desktop和旧工具不受影响。
5. `.release-validation/v0.1.1.md` 增加并机器复核 `Windows-Native-CI: pass`、`Windows-Host-Stop: pass`、helper SHA、宿主 evidence SHA、宿主 OS/build 与 `RC: v0.1.1-beta.2`。只有这些固定 RC证据全部通过，才由 stable tag走同一 Windows gate + Ubuntu OIDC发布 `latest`。

## 规格覆盖自审索引

| 批准规格章节 | 本计划落点 |
|---|---|
| 1–3 目标、范围、helper拓扑 | 不可变边界；Task 1–2；Task 5 |
| 4 Node wrapper/fd3/ready/retained handle | Task 2、7、8 |
| 5 frame/config/terminal协议 | 协议冻结；Task 1、3、4、8 |
| 6 Job/CreateProcess/handles/CREATING线性化 | Task 4；Task 5A–5D |
| 7 native与cmd分类、可信shell、转义/8191 | Task 3；Task 5B；Task 8 |
| 8 terminate/drain/error/helper强杀 | Task 5C–5D；Task 7–11 |
| 9 可复现build、artifact、probe、package/doctor | Task 1–2、6、12A |
| 10 Windows CI、release attestation、真实宿主边界 | Task 13A–13B、14、上游Task 11–12 |
| 11 TDD矩阵、expected-stale prequalification | 每任务RED/GREEN/双审；Task 12B–12C、14 |
| 12 capability fingerprint与发布顺序 | Task 12B–12D、13、14后上游Task 9–12 |

自审结论：所有章节均有实现与机器门禁落点；协议类型名/reason/stage、schema v2/v3、core/final prequalification、partial/composite和installed package-set在前后任务中使用同一命名。placeholder扫描、planned Modify路径顺序和diff whitespace由计划提交前主线程机器检查。

## 完成定义

本计划完成仅表示 Windows P1 已以 native ownership、协议、可复现 artifact、package/doctor/fingerprint、Windows CI与 prequalification共同闭合，并冻结了可进入 Task 9 的候选。项目总目标仍要继续完成真实 8/8、beta.2、公共 npm/官方插件/完整重启/真实 Stop以及 stable；任何后续失败都回到相应任务，不得复用 stale evidence、跳过 Windows gate或以 PID/全机清理伪造成功。
