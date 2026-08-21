# 2026-08-21 `four-llm-v1` 当前宿主原生测试预飞阻断

## 结论

在 clean frozen candidate `bc6a30072f55039f3298ec419a5d28d65f5566f3`、分支 `codex/multi-model-beta-0.1.2` 上只调用了一次标准 `four-llm-v1` 入口。fresh 执行引用只在承载 PowerShell 进程内生成，命令行显示为脱敏值。入口以退出码 1 和 `Gate requalification failed` 停止；没有第二入口、retry、resume、fallback、补跑或第二批。

本次停止发生在资格 preflight 的 deterministic test 阶段，早于 ledger 创建和任何模型 case：

- `docs/smoke/evidence/batches/` 没有新增目录；
- 工作树没有新增 manifest、checkpoint 或 case evidence；
- 资格锁及 owner 在入口结束后均不存在；
- tracked 与 untracked 工作树保持 clean；
- Kimi 与三条 Ark 路线的真实模型调用均为 0。

因此没有可提交或可运行 immutable verifier 的 batch manifest。本记录只固化“预飞失败且零模型调用”的事实，不能替代资格 evidence。

## 阻断证据

资格入口内置的 build 已完成；生成的 `dist/cli.js` 和插件 runtime 时间戳更新。随后单 worker Vitest 缓存记录 71 个测试文件结果，其中以下 3 个文件为 failed：

- `test/native/native-build-contract.test.ts`；
- `test/native/host-acceptance-observer-artifact.test.ts`；
- `test/native/fd3-control-preflight.test.ts`。

只复跑上述 3 个失败文件，不重复全库测试，得到 3 files failed、14 tests passed、4 tests failed：

1. `native-build-contract` 的 2 项失败与 `host-acceptance-observer-artifact` 的 1 项失败均显示：隔离启动的 Windows PowerShell 无法把 `Get-FileHash` 解析为 cmdlet；
2. `fd3-control-preflight` 的 1 项失败显示 `windows-native-helper: fd3 preflight failed`；
3. 当前终端直接运行 `native:preflight` 返回 `windows-native-helper: preflight passed node=v24.14.1 libuv=1.51.0 cases=5`。

当前 Codex 承载终端为 PowerShell 7.6.4；父终端与直接启动的系统 Windows PowerShell 均可定位 `Microsoft.PowerShell.Utility/Get-FileHash`。失败只出现在 Vitest 隔离子进程路径，且 fd3 直接路径可通过。因此当前证据把根因范围限定为测试隔离/子进程环境兼容层；没有证据支持把它归因于模型能力、Ark 额度、凭据、路由或 native helper 的生产终态。

## 状态影响

- `docs/smoke/evidence/capabilities.json` 未修改：Direct DeepSeek 两项保持 current，Kimi/Ark 八项保持 stale；
- 没有生成 `.release-validation/v0.1.2-beta.1.json`；
- 没有运行 `verify:capabilities`、release smoke 或离线发布门禁，因为本次没有新的资格 evidence；
- 没有访问活动 `~/.codex/config.toml`，没有安装或升级活动插件，没有 push、merge、tag、GitHub/npm 发布或其它外部写入。

## 停止条件

本次授权对应的标准入口已经调用并在预飞阶段失败。按照单入口、首错停和不启动第二批的边界，本处理链到此停止。后续若继续，应先修复或消除当前宿主测试隔离兼容阻断，形成新的 clean frozen candidate，再单独启动新的资格入口；不得把本次零模型调用记录解释成八项能力通过。

## 继续推进与修复

维护者随后明确要求继续开展工作，开启新的离线修复处理链。进一步窄诊断确认：Vitest 子进程继承的 `PSModulePath` 中，Codex PowerShell 7 的 `Microsoft.PowerShell.Utility` 位于系统 Windows PowerShell 5.1 模块之前。系统 `powershell.exe` 在该路径下可以枚举两个同名模块，但无法自动解析 `Get-FileHash`。native wrapper 的 fd3 报错发生在同一 build 前置路径，移除哈希 cmdlet 依赖后也随之消失。

修复保持 native helper 协议与编译源不变：

- `native/windows-job-helper/build.ps1` 和 `restore-toolchain.ps1` 改用 `System.Security.Cryptography` 的 SHA-256/SHA-512 实现；
- 回归测试明确禁止这两个入口重新依赖 `Get-FileHash`；
- `observer:update-artifact` 只重算包含 `restore-toolchain.ps1` 的输入闭包，observer 可执行文件仍为原字节，SHA-256 仍为 `dd20110b1cbcae984ab9f3560ece1bfa8e7b1a0e542b206cec5d9ff5047f5a64`。

修复验证：

- 原 3 个失败文件现在 3 files passed / 18 tests passed；
- `npm run typecheck` passed；
- `npm run native:preflight` passed，Node v24.14.1 / libuv 1.51.0 / 5 cases；
- `npm run observer:verify` passed；
- `git diff --check` passed。

修复阶段没有调用真实模型。完整 deterministic suite 留给新的独立标准资格入口内置 preflight，避免修复阶段重复全库测试。原 candidate `bc6a300...` 的零模型、无 batch 预飞失败事实保持不变。
