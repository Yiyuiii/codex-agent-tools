# 官方插件运维流程

本文只描述 `codex_external_agents` 的官方插件候选构建、隔离验收、已授权官方升级与官方回滚。活动 Codex 当前安装的是已发布的 `0.1.1-beta.1`，旧 `codex_cc_tools` 继续共存。本轮源码已改变执行预算和 stdio 生命周期，因而旧能力索引的八项运行时指纹全部 stale；当前 `npm run verify:capabilities` 必须以脱敏错误和退出码 1 fail closed，分支不可发布。Task 9 形成新批次 8/8 passed evidence 并更新索引之前，不得准备或发布 beta.2。

standing authorization 下的最新真实批次绑定 frozen commit `0113da97a6b1fef35cc4c45025caa9e36a002176`，批次 ID 为 `2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c`。标准入口和 `functions.exec` cell 各只有一个；批次按首错停为 6 completed / 5 passed、`blocked / case_failed`、`promotionEligible=false`，ordinal 7–8 notRun。没有 resume、retry、fallback、补跑、第二入口或第二批。manifest SHA-256 为 `f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`，证据提交为 `6b4217d`。

ordinal 1–5 passed；ordinal 6 `ark-agent-plan/delegate` 的 provider、model、direct route、凭据来源和 telemetry 正确，结果文件精确通过，但以 `account_quota_exceeded` 失败。ordinal 1 与 6 的精确写入和状态命令均各一次 success，文件范围只含预期结果；此前 Pi Windows shell 与资格假阳性缺口已经真实闭合。该错误记录的是当时 Agent Plan 的账户可用性，不再撤销其它已通过能力，也不要求为产品资格重跑完整八项；实际调用该路线时仍可能受当前额度影响。

离线调查确认 Pi Windows 子进程环境遗漏 `ProgramFiles` 与 `ProgramFiles(x86)`，导致 Git Bash resolver 失败；提交 `2a815c7` 修复后，真实 resolver 与精确 Node spawn 探针离线成功，代理和凭据边界保持不变。资格合同提交 `e750052`、`b5a691f`、`3d85315`、`ceb8e9c` 要求未来资格 Pi delegate 的精确写入与精确 `git status --short` 生命周期各恰好一次且均为 success，并由未来整批 passed verifier 重算；历史 blocked/interrupted 继续兼容。schema/plan、公开 MCP、provider/model/route/credential、提示词、结果 validator、retry/fallback 均未改变；独立质量复审为 PASS、无 P0–P3。

48 个测试文件、837 passed / 1 skipped / 0 failed 与 171 files / 15 Markdown/HTML / 3 plugin files 是旧候选历史数字。`v0.1.0` tagged candidate 的 fresh 矩阵已经通过：53 个测试文件、890 passed / 1 skipped / 0 failed，类型检查、构建、8/8 能力索引、release smoke 与生产依赖审计均通过；tagged artifact 的 pack dry-run 为 228 个文件，且不得保留 `.tgz`。

全量测试曾暴露 Kimi ACP client 早于 child close 返回的既有竞态，98/100 时序探针可观察；提交 `4af8b34` 加入 close 等待、1000ms 有界失败、stdio 销毁与两个确定性回归测试，独立复审 PASS、无 P0–P3，最终全量已经包含。状态文档提交与最终 clean frozen SHA 仍由主线程完成。

当前活动插件仍为已发布的 `0.1.1-beta.1`；本轮没有访问或修改 `~/.codex/config.toml`，没有移除 `codex_cc_tools`，也没有调用或修改 Claude Code。standing authorization 继续有效，本轮源码已使八项能力指纹失效，因此 Task 9 将运行新的八项资格。`npm run verify:capabilities` 是当前机器资格与发布权威；registry 的旧 passed 文案、历史授权页和批次结果页只作审计，不能越过当前 stale 状态。

2026-07-27 的 105 秒演练只构成离线基础设施证据；后续真实批次证明同一 cell 可以承载到协调器正常终态，但不证明四小时存活。standing authorization 下的唯一承载和 fail-closed 边界见[执行承载手册](release/four-llm-qualification-execution-runbook.md)，演练原始结论见[承载演练报告](release/qualification-carrier-rehearsal.md)。package/release assurance 只证明离线候选，不构成资格、安装或发布。

项目代码和维护者都不得直接读取、写入、备份、恢复或手工编辑活动 `~/.codex/config.toml`。Codex 官方插件命令可能由官方机制更新该状态文件，因此真实 add/remove 每次都必须先准备权限包并取得针对该次动作的明确许可。

## 执行预算与取消合同

- `timeoutMs` 是调用方为单次请求显式设置的可选值；它不会写入 profile 或外部 CLI 配置。
- 省略时，Kimi 与 Pi 都不设置模型执行 deadline，让后端保留原生执行预算；不存在 profile 级的 600 秒或 900 秒执行上限。
- stdio 的 end、close、error 与 SIGINT、SIGTERM 都会触发幂等 session shutdown；shutdown 调用 `server.close()`，由 SDK abort handlers 取消在途请求，再等待 owned 子进程树与 tracker drain，最后移除本 session 自己注册的监听器并结束 session。
- 调用方普通取消保持 cancelled；只有显式 deadline 到期才报告 timed out，两个路径都必须完成进程树清理。
- Pi 生产路径的原生 retry 策略保持不变；资格模式仍按独立协议使用 single-attempt 与零 retry/fallback。

## 1. 安装依赖

在仓库根目录执行：

```powershell
npm ci
```

要求 Node.js 20+。真实 Kimi 调用还要求本机 Kimi Code 已安装并完成其原生 OAuth 登录；本项目不复制 OAuth 数据。

## 2. 构建候选产物

```powershell
npm run build
```

构建会同时生成库产物与 `plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs` 自包含 bundle。不要手工编辑 bundle。

## 3. 运行隔离官方生命周期验收

```powershell
npm run acceptance:plugin:isolated
```

脚本只在自动创建的临时 `CODEX_HOME` 中调用官方 marketplace/plugin add、list 与 remove，并从官方缓存副本启动 MCP。它不得使用活动 Codex home，也不构成真实 Codex App 宿主门禁。

## 4. 查看隔离证据

检查 [官方插件隔离状态报告](release/plugin-isolated-state.md)，确认：

- 临时 `CODEX_HOME` 隔离边界成立；
- 官方安装器接受插件 manifest、直接 server-map `.mcp.json` 与自包含 bundle；
- 缓存副本只公开 `external_review` 与 `external_delegate`，且 `llm` 必填；
- 隔离验收先证明已退役的 Gemini 被已安装 MCP 以 unknown logical LLM 明确拒绝，错误列出精确四项活动 LLM，且没有启动 Pi 或返回伪造的结构化成功结果；
- 再用 qualified 的 `ark-agent-deepseek-v4-flash` 与 fake Pi 证明恰好一次调用、固定模型、direct 路由、父进程代理清除、只注入目标 Agent 凭据和进程清理门禁通过；
- 官方 remove 后列表语义回滚，残留状态可解释；
- 报告结论没有被扩张成真实 Codex App 已通过。

任一项失败即停止，不准备真实安装。

## 5. 验收公共 npm 精确版本

只有版本已存在于公共 npm registry 后才运行：

```powershell
npm run acceptance:npm-package -- --version 0.1.0
```

脚本把 registry 固定为 `https://registry.npmjs.org/`，按精确版本安装到一次性
临时目录且禁用 lifecycle scripts。随后用伪 Kimi/Pi 检查 CLI/doctor，从已
安装 package 与官方插件缓存副本分别启动 stdio MCP，并在临时 `CODEX_HOME`
中完成 marketplace/plugin add/list/remove。它不调用真实模型，不继承活动
插件状态，不读取或修改活动 Codex home；结束前还要求 Kimi ACP、Pi RPC、
real-smoke 进程为 0 且资格锁不存在。成功后生成对应版本的
`docs/release/<version>-npm-acceptance.md`，供稳定版发布证据引用。

## 6. 准备真实安装权限包

只有以下条件同时成立，才能准备可供授权的 ready 权限包；当前第一项因八项指纹 stale 而失败：

- `npm run verify:capabilities` 验证四个逻辑 LLM 的八项能力、不可变 evidence、精确 case、注册表 anchor 与当前运行时指纹；
- 类型检查、测试、构建、release smoke 和隔离官方插件生命周期通过；
- 权限包明确真实安装仍未执行，并给出预计影响、验证与官方回滚。

能力索引允许不同能力复用各自不可变的 passed case，但绝不允许用失败 case、模型别名、不同能力或指纹已变化的旧证据替代。最新 blocked 批次仍是不可改写的批次历史；它不再把其中 passed case 降为 pending。默认实验授权不能越过活动安装门禁。

权限包必须列出：

- 为什么只有真实官方安装才能验证 Codex App 宿主；
- 当前尚未执行真实安装；
- 隔离取证支持的预计新增、修改和删除范围；
- 官方安装后的验证步骤；
- 官方 remove 回滚步骤；
- 失败时不手工恢复或编辑活动 `config.toml`；
- 旧 `codex_cc_tools` 保持原状，本轮不移除；
- 本轮不执行 npm 或公共 marketplace 发布。

权限包必须先交给用户审阅。过去关于采用官方插件机制的同意不能推定为本次 add/remove 的许可。

## 7. 仅在明确许可后执行真实安装

只有收到针对本次真实安装的明确许可后，才可在本仓库根目录逐条执行：

```powershell
$repoRoot = (Resolve-Path "." -ErrorAction Stop).Path
codex plugin marketplace add $repoRoot
if ($LASTEXITCODE -ne 0) { throw "Codex marketplace add 失败，停止安装。" }
codex plugin add codex-external-agents@codex-external-agents-local
if ($LASTEXITCODE -ne 0) { throw "Codex plugin add 失败，停止安装。" }
```

执行后必须使用官方列表和真实 Codex App 完成工具发现、代表性调用、取消与进程清理门禁。不得直接打开、比较或修改活动 `config.toml`。命令结果若与权限包或隔离证据不一致，立即停止，不追加自定义配置修复。

维护者本机已于 2026-07-30 消费首次 add 许可，后续又通过官方命令移除同名开发期
MCP，并把活动插件升级到已发布的 `0.1.1-beta.1`；旧 `codex_cc_tools` 保持 enabled。
beta.1 handoff 暴露了宿主断开没有自动取消服务端在途任务的缺口。本轮源码已修复该
生命周期，但在 beta.2 公开 npm、官方插件升级、完整 App 进程重启和真实宿主普通
Stop/interrupt 验收全部完成前，不能把确定性测试扩张为真实宿主通过。不得恢复开发
直连、手工修改配置或跳过 stale 能力门禁。

## 8. 失败时使用官方回滚

本次权限包必须明确包含失败回滚授权。宿主门禁失败时只执行：

```powershell
codex plugin remove codex-external-agents@codex-external-agents-local
if ($LASTEXITCODE -ne 0) { throw "Codex plugin remove 失败，停止回滚。" }
codex plugin marketplace remove codex-external-agents-local
if ($LASTEXITCODE -ne 0) { throw "Codex marketplace remove 失败，停止回滚。" }
```

随后使用官方列表确认目标插件与 marketplace 已移除。若官方回滚也异常，停止并报告；不得手工恢复、重写或修补活动 `config.toml`。

## 8. 长期维护边界

- 每次真实安装、升级或独立卸载都是新的外部状态变更，必须重新逐动作授权。
- 永远不以手工编辑活动 `config.toml` 代替官方插件机制。
- 本轮不移除旧 `codex_cc_tools`，不调用或修改 Claude Code，不执行 `npm publish`。
- 只有确定性检查、隔离生命周期、当前 8/8 能力资格、beta.2 公开 npm 与官方升级、完整 App 重启和真实 Stop/interrupt 宿主门禁全部通过后，才可说新插件具备替代旧工具的条件。
