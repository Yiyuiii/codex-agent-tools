# 官方插件运维流程

本文是 `codex_external_agents` 官方插件候选构建、隔离验收、已授权官方升级与回滚的现行运维真值源。活动 Codex 当前已安装并启用已发布的 `0.1.1-beta.3`，旧 `codex_cc_tools` 继续共存；当前 app-server 在升级前已启动，必须完整退出并重开 App 后才能进入真实宿主验收。当前发布线只保证维护者的 Windows x64 / Node 24 宿主；原生辅助层、Job-owned process、observer、固定启动层和 current-host freeze 已完成，不再运行 Node 矩阵或跨宿主认证。

最新真实批次 `2026-08-03T02-04-45.497Z-44fcbde6-a2bd-4f58-80c5-d723a374a923` 绑定 frozen commit `9054cbc45aaf1c91c2c62817244be5288032ede8`；四个逻辑 LLM 的八项 review/delegate 全部 passed。每项均为一次 client invocation、零 adapter/runtime retry、零 adapter/orchestrator fallback，owned process 全部排空；终态为 `passed`、`promotionEligible=true`，manifest SHA-256 为 `835224ccc7893d1e5f930bf2f63f29ef0bbb0a1daddaf7e85e807e626c79ecac`，不可变证据提交为 `c09ce74`。

现行 `capabilities.json` 已统一绑定该批八个精确 case 与当前运行时指纹，旧的受限 legacy 入口归零；`npm run verify:capabilities` 返回 8 项 current、0 项 legacy。2026-08-02 的额度失败批次与其它历史 manifest/case 继续保持不可变，但不再是当前资格状态。维护者再次报告 Ark Coding Plan 额度恢复只表示当前可调用性，不触发资格重跑。`0.1.1-beta.3` 已由 GitHub Actions OIDC 发布到 npm `next`，通过当前宿主的公共精确包隔离验收，并完成活动官方插件升级；下一步只执行完整 App 重启，并在 observer 发布 `REQUEST_STARTED` 后使用普通 Stop 取得 `cancelled + owned-zero` receipt。

资格执行与恢复的唯一详细合同见[执行承载手册](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/four-llm-qualification-execution-runbook.md)；历史 Kimi/Ark case、旧 shell 根因和旧测试计数分别保留在 `docs/smoke/` 与不可变 evidence 中，不在运维入口重复维护。package/release assurance 只证明离线候选，不构成资格、安装或发布。

当前流程没有访问或修改 `~/.codex/config.toml`，没有移除 `codex_cc_tools`，也没有调用或修改 Claude Code。`npm run verify:capabilities` 是当前机器资格与发布权威；registry 文案、历史授权页和旧批次结果页不能替代它。

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

要求 Node.js 24+；当前真实宿主为 v24.14.1，公开验证只覆盖这套维护者本机环境，不构成其它 Node 或 Windows 版本的兼容认证。真实 Kimi 调用还要求本机 Kimi Code 已安装并完成其原生 OAuth 登录；本项目不复制 OAuth 数据。

## 2. 构建候选产物

```powershell
npm run build
```

构建会同时生成库产物与 `plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs` 自包含 bundle。不要手工编辑 bundle。

## 3. 运行隔离官方生命周期验收

```powershell
npm run acceptance:plugin:isolated:built
```

该入口复用第2节已经构建的候选，只在自动创建的临时 `CODEX_HOME` 中调用官方 marketplace/plugin add、list 与 remove，并从官方缓存副本启动 MCP。它不得使用活动 Codex home，也不构成真实 Codex App 宿主门禁。若跳过第2节而单独运行本验收，使用`npm run acceptance:plugin:isolated`让脚本先构建一次。

## 4. 查看隔离证据

检查 [官方插件隔离状态报告](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/plugin-isolated-state.md)，确认：

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

以下命令是历史的首次 `0.1.0` 安装验收模板。验收下一个 beta 时，必须在该版本已由
GitHub Actions OIDC 发布后，把 `--version` 改成公共 npm 中存在的精确版本；不得预先猜测版本号。

```powershell
npm run acceptance:npm-package -- --version 0.1.0
```

脚本把 registry 固定为 `https://registry.npmjs.org/`，按精确版本安装到一次性
临时目录且禁用 lifecycle scripts。随后用伪 Kimi/Pi 检查 CLI/doctor，从已
安装 package 与官方插件缓存副本分别启动 stdio MCP，并在临时 `CODEX_HOME`
中完成 marketplace/plugin add/list/remove。它不调用真实模型，不继承活动
插件状态，不读取或修改活动 Codex home；结束前只验证本次 owned MCP transport
已清理、资格锁不存在且隔离根可回收，不扫描或要求全机 Kimi/Pi 进程归零。成功后
生成对应版本的 `docs/release/<version>-npm-acceptance.md`，供稳定版发布证据引用。

## 6. 准备真实安装权限包

只有以下条件同时成立，才能准备可供授权的 ready 权限包；beta.3 的权限包已满足并消费，以下保留为未来版本模板：

- `npm run verify:capabilities` 验证四个逻辑 LLM 的八项能力、不可变 evidence、精确 case、注册表 anchor 与当前运行时指纹；
- 类型检查、测试、构建、release smoke 和隔离官方插件生命周期通过；
- 权限包明确下一个 beta 的精确版本只在 GitHub Actions OIDC 发布后确定，并给出预计影响、验证与官方回滚。

能力索引允许不同能力复用各自不可变的 passed case，但绝不允许用失败 case、模型别名、不同能力或指纹已变化的旧证据替代。历史 blocked 批次仍是不可改写的批次历史。默认实验授权不能越过活动安装门禁。

权限包必须列出：

- 为什么只有真实官方安装才能验证 Codex App 宿主；
- 下一个 beta 的精确版本已发布到公共 npm、但尚未安装或升级；
- 隔离取证支持的预计新增、修改和删除范围；
- 官方安装后的验证步骤；
- 官方 remove 回滚步骤；
- 失败时不手工恢复或编辑活动 `config.toml`；
- 旧 `codex_cc_tools` 保持原状，本轮不移除；
- 禁止本地 `npm publish`；只允许 GitHub Actions OIDC 发布下一个 beta；本权限包不执行公共 marketplace 发布。

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
MCP，并把活动插件升级到 `0.1.1-beta.1`。本轮在 `0.1.1-beta.3` 通过公共 npm
精确验收后再次执行官方升级：首次 remove 因 Windows 缓存占用失败，只精准终止 19 个
由当前 app-server 启动、命令行精确匹配插件 runtime 且无子进程的旧插件 MCP Node
进程；随后官方 remove、旧 marketplace remove、当前 worktree marketplace add 与
plugin add 全部成功。官方列表确认 `0.1.1-beta.3` installed/enabled，MCP cwd 解析到
beta.3 版本化缓存，四项凭据名只显示掩码，旧 `codex_cc_tools` 仍 enabled，精确插件
MCP 进程数为 0。没有直接读取或修改活动配置，也没有停止 App、Kimi/Pi、旧工具或其它
Node 进程。

beta.1 handoff 暴露了宿主断开没有自动取消服务端在途任务的缺口；beta.3 已携带对应
生命周期修复，但当前 app-server 在升级前已加载旧工具定义，不能把官方安装成功扩张为
真实宿主通过。下一步必须完整退出并重开 App，再按 checked-in observer 完成真实
普通 Stop 与精确 `cancelled + owned-zero` receipt。不得恢复开发直连、手工修改配置或跳过能力门禁。

## 8. 失败时使用官方回滚

本次权限包必须明确包含失败回滚授权。宿主门禁失败时只执行：

```powershell
codex plugin remove codex-external-agents@codex-external-agents-local
if ($LASTEXITCODE -ne 0) { throw "Codex plugin remove 失败，停止回滚。" }
codex plugin marketplace remove codex-external-agents-local
if ($LASTEXITCODE -ne 0) { throw "Codex marketplace remove 失败，停止回滚。" }
```

随后使用官方列表确认目标插件与 marketplace 已移除。若官方回滚也异常，停止并报告；不得手工恢复、重写或修补活动 `config.toml`。

## 9. 长期维护边界

- 每次真实安装、升级或独立卸载都是新的外部状态变更，必须重新逐动作授权。
- 永远不以手工编辑活动 `config.toml` 代替官方插件机制。
- 本轮不移除旧 `codex_cc_tools`，不调用或修改 Claude Code；禁止本地 `npm publish`。只允许 GitHub Actions OIDC 发布 beta 与 stable。
- 只有确定性检查、隔离生命周期、当前能力资格、beta.3 公共 npm 精确版本验收与官方升级、完整 App 重启，以及在 observer 发布 `REQUEST_STARTED` 后由普通 Stop 取得 `cancelled + owned-zero` receipt 全部通过后，才可说新插件具备替代旧工具的条件；stable 也只由 GitHub Actions OIDC 发布。
