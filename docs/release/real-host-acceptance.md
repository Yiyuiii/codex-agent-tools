# 真实 Codex App 宿主验收记录

最近更新：2026-08-07

状态：**stable published / host Stop skipped — 0.1.1 已公开发布、公共验收并完成官方升级；维护者终止的普通 Stop 验收仍为 `host_stop_unverified`，未取得 `cancelled + owned-zero` receipt**

## 2026-08-07 维护者跳过决定

维护者明确要求跳过当前真实 Stop 测试，转而检查下一步计划。两次 beta.4 会话都不能
计为 PASS：第一次 delegate 在点击普通 Stop 前自然完成；第二次旧宿主只读握手通过，
完整重启后对应会话最终出现 completion marker，但没有 observer receipt，且 launcher /
observer 已不再运行。第二次遗留的活动 descriptor 已移动到该会话目录中的
`skipped-session.v1.json`，保留审计内容并解除后续公开工具调用的陈旧会话绑定；session、
completion marker 与第一次失败证据均未删除或改写。

这项决定只表示不再继续消耗维护者时间重复交互测试，不表示取消传播、handler cancelled、
in-flight removed 或 owned descendants zero 已在真实 App Stop 中得到证明。维护者随后
批准方案 A：stable marker schema 2 将真实 `passed + receipt` 与
`skipped_by_maintainer + host_stop_unverified + decision` 建模为互斥状态，风险跳过只硬锁
`0.1.1-beta.4 → 0.1.1`，不能泛化到未来版本，也不能输出宿主验收通过。

## 当前发布状态

beta.1 handoff 暴露了调用方离开后 MCP 服务端任务继续运行的缺口，不是 stable Stop gate 的唯一证据。本轮源码已经为 stdio end/close/error、SIGINT/SIGTERM 和 SDK 取消建立统一关闭协调；beta.4 已修复 beta.3 clean-tag 启动层缺口。稳定版发布采用维护者明确批准的风险跳过状态，因此确定性、公共包与安装证据已经闭合，但真实 App 普通 Stop 仍没有 PASS 证据。

八项 verifier、唯一 Node 24 离线 release gate、PR/双重 CI、精确标签、GitHub Actions OIDC 发布、公共 npm 精确包验收和官方插件升级均已完成。PR #12 merge commit 为 `f503f0c51c5fc5c51a31cbd2db63d2b8434b0c0f`，release run `31168431472` 成功；npm 为 `latest=0.1.1`、`next=0.1.1-beta.4`。普通 Stop receipt 未完成且已按维护者决定跳过；互斥且可审计的 stable 发布状态、仓库内决策记录、0.1.1 版本与 marker 均已验证。禁止用风险跳过伪装 PASS。

公共stable在当前Windows x64 / Node 24宿主完成隔离复验，结果见[0.1.1公共npm隔离验收](0.1.1-npm-acceptance.md)。活动插件已通过官方remove/add升级为installed/enabled `0.1.1`，版本化缓存五个文件与发布源逐项同SHA、无reparse，旧`codex_cc_tools`仍enabled。桌面App不会热刷新插件；维护者已在升级后完整退出重开，新宿主进程现已实际加载stable。

## 2026-08-07 stable 重启后加载确认

维护者报告完整退出并重开后，本次新任务的工具发现结果包含`external_review`与
`external_delegate`。官方只读状态同时确认：

- marketplace仍指向stable工作树，插件为installed/enabled `0.1.1`；
- `codex_external_agents`的cwd精确指向版本化`0.1.1`缓存，四个凭据变量名白名单保持不变，
  没有静态`env`；
- 新产生的插件MCP Node进程均以当前新`codex.exe app-server`为父进程；
- 旧`codex_cc_tools`仍enabled。

本轮只做工具发现、官方状态和进程归属检查，没有调用真实Kimi/Pi/Ark模型，也没有读取
或修改活动配置。该证据证明stable插件已经被新App宿主加载，不证明普通Stop的取消传播或
owned-zero，因此第四层仍保持`skipped / unverified`。

真实宿主门禁只接受 App 的普通 Stop：必须在 observer 发布 `REQUEST_STARTED` 后点击，并确认外层状态为 `cancelled`、完成标记没有写入、SDK abort 到达、owned descendants zero 且不重生。

## 历史：早期安装授权与边界

维护者已明确授权本次真实 `marketplace add`、`plugin add`，以及失败时使用官方
`remove` 回滚。执行始终遵守以下边界：

- 不直接读取、备份、编辑或恢复活动 `~/.codex/config.toml`；
- 不移除或修改旧 `codex_cc_tools`；
- 不调用或修改 Claude Code；
- 首次安装阶段未调用真实 Kimi 或 Pi 模型；
- 安装成功，因此没有执行回滚。

维护者随后明确授权移除同名开发期 MCP、创建一个新 Codex 任务，并在插件加载后
运行真实 Kimi/Pi、隔离 delegate 与取消门禁。新任务在工具发现阶段首错停止，因此
没有消耗任何真实模型调用，也没有进入可写或取消测试。

维护者又完成了整 App 重启并授权继续推进。重启后的第二个新任务仍在同一工具发现
门禁首错停止；后续修复、beta 发布、本机官方升级和刷新后复验仍沿用这项授权。

## 0.1.1 stable 发布身份

- 仓库：`main`，merge commit `f503f0c51c5fc5c51a31cbd2db63d2b8434b0c0f`；
- 稳定标签：`v0.1.1`，精确指向上述 merge commit；
- release workflow：`31168431472`，GitHub Actions OIDC / provenance 成功；
- npm精确版本：`codex-agent-tools@0.1.1`，`latest=0.1.1`、`next=0.1.1-beta.4`；
- npm `dist.shasum`：`59ab23d0a6eea27a084a686c1ba04f727939044f`；
- npm `dist.integrity`：`sha512-f4nBGcOkjy1ze3GhM1RRHc5pe67BaQy8pco1mhlbORWeZ4cwmhnT4aPxShPtTWkY74l0fHkOBq9h80i78SE9LA==`；
- GitHub Release明确记录`host Stop: skipped / unverified`。

## 历史：0.1.0 初始发布身份

- 仓库：`main`，提交 `74ad8137c7a253fd4b2c35fd3b92943ed23a34b9`；
- 稳定标签：`v0.1.0`，提交
  `20c6922fa4395b3015aee2d2b1ca3aec84ca6cf5`；
- 插件目录和 marketplace 清单相对 `v0.1.0` 无差异；
- npm 精确版本：`codex-agent-tools@0.1.0`；
- npm `dist.shasum`：
  `ce9db452dda78a414ed1fbe9a7028d192e299dfa`；
- npm `dist.integrity`：
  `sha512-HY4z888/sCJe6GPwPlOGCON03dQzFC82K7I50RnGtdnP/RpwwSPNMD57MdobqDW8uBCQX4u6YkOop8XKpwqHcQ==`。

## 安装前状态

只使用官方只读命令取得状态，没有打开活动配置文件。

- Codex CLI：`0.135.0`；
- `codex-external-agents-local` marketplace 尚不存在；
- `codex-external-agents` 官方插件尚未安装；
- 旧 `codex_cc_tools` MCP 已启用；
- 活动配置还存在一个开发期 `codex_external_agents` MCP 注册，指向当前仓库
  `dist/mcp.js`，并公开 `external_review` / `external_delegate`；
- 目标进程快照为 Kimi 10、Pi 0。Kimi 是全机共享进程，后续只能比较相对变化，
  不能把非零基线归因于本插件。

最后一项构成来源消歧限制：当前任务在安装前已经可以连接同名开发期 MCP，因此当前
任务内发现工具不能单独证明工具来自新安装的版本化缓存。

## 官方安装结果

依次执行并成功：

```powershell
codex plugin marketplace add <repo-root>
codex plugin add codex-external-agents@codex-external-agents-local
```

官方列表结果：

- marketplace `codex-external-agents-local` 指向当前仓库；
- `codex-external-agents@codex-external-agents-local` 为
  `installed, enabled`；
- 版本为 `0.1.0`；
- 官方缓存位于
  `~/.codex/plugins/cache/codex-external-agents-local/codex-external-agents/0.1.0`。

缓存中只有三个插件文件，且逐文件 SHA-256 与仓库源文件相同：

| 文件 | SHA-256 |
| --- | --- |
| `.codex-plugin/plugin.json` | `714AD084F9FE8F9913730A3C8E814BABB2FA37A3FBF1DCF70453930D6853EA15` |
| `.mcp.json` | `8EA399F532FC6027BD2C5A485D745FA5A9246F151A69825C6EFE1E8144541691` |
| `runtime/codex-external-agents-mcp.mjs` | `922A2B46389FFF4192BCBC73F30FC34711AE552F5190B24ECA3C00E4DA626DB6` |

## 已通过的确定性宿主检查

从上述版本化缓存目录启动 `.mcp.json` 指定的 MCP，完成
`initialize` / `tools/list`，没有调用工具或真实模型：

- 工具严格为 `external_review` 与 `external_delegate`；
- 两项工具都要求 `llm`、`prompt` 与 `cwd`；
- `external_review` 还要求 `task`；
- review 注解为只读、非破坏性；
- delegate 注解为可写、破坏性；
- transport 关闭后新增 Node 进程数为 0；
- Pi 进程保持为 0。

当前 Codex 任务可以同时发现：

- 新命名空间的 `external_review` / `external_delegate`；
- 旧命名空间的 `cc_review` / `cc_delegate`。

一次不启动外部模型的负向宿主调用使用已退役
`gemini-3.5-flash`，在约 62ms 内被本地注册表拒绝，并精确列出四项活动逻辑
LLM。该结果证明宿主参数能到达当前 `codex_external_agents` 路由层，但由于安装前
已有同名开发期 MCP，它不用于证明版本化缓存是当前任务的实际调用来源。

## 来源消歧与新任务结果

收到后续授权后，使用官方命令：

```powershell
codex mcp remove codex_external_agents
```

命令成功移除了指向仓库 `dist/mcp.js` 的开发期全局注册。随后官方只读列表仍显示
`codex_external_agents`，但来源已经变为已安装插件：

- command：`node`；
- args：`./runtime/codex-external-agents-mcp.mjs`；
- 不再包含 `dist/mcp.js`；
- `codex_cc_tools` 继续 enabled；
- `codex-external-agents@codex-external-agents-local` 继续为
  `installed, enabled`、版本 `0.1.0`。

来源消歧完成后创建了一个新的 Codex App projectless 验收任务。该任务严格先做工具
发现，结果只发现旧 `cc_review` / `cc_delegate`，没有发现插件应提供的
`external_review` / `external_delegate`，因此按首错停止：

- 没有创建临时目录；
- Kimi review 调用 0 次；
- Pi review 调用 0 次；
- delegate 调用 0 次；
- 取消测试未开始；
- 被测仓库和旧 `codex_cc_tools` 均未修改。

这证明在当前桌面 App 进程中，官方 CLI 状态已经更新且创建新任务仍不足以让插件
MCP 进入任务工具面。它不能再归因于同名开发注册，也不能用重复创建任务、恢复直连
或手工修改配置绕过。

## 完整重启后的复现与根因定位

维护者完整退出并重新启动 App 后，又创建了一个全新 projectless 验收任务。结果与
重启前一致：

- 只发现旧 `cc_review` / `cc_delegate`；
- 未发现 `external_review` / `external_delegate`；
- Kimi、Pi、delegate 调用仍全部为 0；
- 没有创建临时仓库，取消门禁仍未开始。

这排除了“只需整 App 重启”作为充分解释。随后只读对照实际宿主解析结果：

- 0.1.0 的 `.mcp.json` 使用
  `node ./runtime/codex-external-agents-mcp.mjs`，但没有声明工作目录；
- `codex mcp get codex_external_agents` 精确显示 `cwd: -`；
- 官方内置 Sites 本地 stdio 插件同样使用相对 Node 脚本，但声明 `cwd: "."`；
- `codex mcp get sites-design-picker` 会把该点解析为版本化插件缓存根目录。

因此 0.1.0 的隔离验收存在一个关键盲点：测试客户端无条件把已安装插件根目录作为
`cwd`，替宿主补齐了 manifest 没有声明的启动条件。它证明 bundle 本身可运行，却
没有证明真实宿主能从 manifest 得到相同工作目录。

`0.1.1-beta.0` 修复已经：

1. 在插件 `.mcp.json` 显式声明 `cwd: "."`；
2. 让 artifact 与 release smoke 强制验证该字段；
3. 让隔离插件和公共 npm 验收读取 manifest 的 `cwd` 后再解析启动目录，不再由
   测试代码隐式指定插件根目录；
4. 以真实官方临时 marketplace/plugin add 验证版本化缓存副本能够
   initialize/listTools。

当前确定性矩阵为 53 个测试文件、891 passed / 1 skipped / 0 failed；类型检查、
8/8 能力索引、release smoke、生产依赖 0 vulnerabilities、隔离官方插件生命周期
与 `git diff --check` 通过。

## beta 发布、公共验收与活动升级

- PR #1 merge commit `cf7a702` 已进入 `next`；
- CI run `30516213749` 的 Node 20/22/24 全绿；
- release run `30516364128` 通过 npm OIDC、registry/`next` 校验和 GitHub
  prerelease 创建；
- npm dist-tags 为 `next=0.1.1-beta.0`、`latest=0.1.0`；
- 公共 registry 精确版本验收通过 CLI、doctor、直接 MCP、官方临时插件生命周期、
  缓存副本 manifest `cwd` 解析、8/8 能力索引、目标进程 0/0/0 和资格锁 absent；
  真实模型调用为 0，见
  [公共 npm 隔离验收](0.1.1-beta.0-npm-acceptance.md)；
- 活动插件按官方 remove/add 从 0.1.0 升至 installed/enabled 0.1.1-beta.0；
- `codex mcp get codex_external_agents` 已把 `cwd: "."` 解析到
  `.../codex-external-agents/0.1.1-beta.0/.`；
- 旧 `codex_cc_tools` 继续 enabled。

升级后没有重启 App，立即创建新的 projectless 工具发现探针。该任务仍只发现旧
`cc_review` / `cc_delegate`，没有发现 `external_review` /
`external_delegate`，并按首错停止：真实模型调用 0、文件修改 0、指定 CLI 核对
未继续执行。结合根任务已经取得的官方 CLI 结果，当前实测边界是：

- CLI 和新启动的 CLI 进程可以立即读取更新后的 MCP 配置；
- 当前桌面 App 的任务工具清单不能在本次插件升级中无重启刷新；
- 下一次完整 App 重启后的新任务才是修复闭环证据。

## 窗口重启与宿主进程边界

维护者随后报告已重启，第三个全新 projectless 探针仍只发现旧工具并按首错停止：
真实模型调用 0、文件修改 0、配置修改 0。只读进程与缓存时间线随后证明，这次操作
并没有重启实际承载任务和 MCP 的后台宿主：

- 主 `ChatGPT.exe` 创建于 `2026-07-30 12:03:40`；
- `codex.exe app-server` 创建于 `2026-07-30 12:03:47`；
- 0.1.1-beta.0 插件缓存创建于 `2026-07-30 13:25:34`；
- 当前进程树有旧 `codex_cc_tools` 和 Sites MCP 子进程，但没有
  `codex-external-agents-mcp.mjs`，说明旧 app-server 没有尝试启动新插件。

因此该探针证明的是“窗口/UI 级重启不等于宿主进程重启”，不是“beta 在真正进程
重启后仍失败”。下一轮必须从系统托盘彻底退出 Codex；若系统托盘退出后相关
`ChatGPT.exe` / `codex.exe` 仍存在，则需在任务管理器确认它们已经结束，再重新
打开 App。

[官方 MCP 手册](https://learn.chatgpt.com/docs/extend/mcp)对桌面端手工 MCP
配置要求保存后选择 Restart；[官方插件构建说明](https://learn.chatgpt.com/docs/build-plugins.md)
要求刷新 ChatGPT 或 Codex，并在新会话测试；[插件连接与测试说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)
也要求刷新元数据后启动新会话。当前实测与这些安全边界一致。

## 完整宿主进程重启与凭据转发根因

维护者随后从系统托盘完整退出并重开。只读进程时间线确认这是一次真正的宿主刷新：
新 `ChatGPT.exe` 创建于 16:32:37，新 `codex.exe app-server` 创建于
16:32:45，均晚于 0.1.1-beta.0 缓存。新建验收任务
`019fb22c-9206-7352-aed1-bc47fafce56b` 得到：

- `external_review` / `external_delegate` 与旧
  `cc_review` / `cc_delegate` 四项工具共存；
- 官方 CLI 仍显示插件 installed/enabled 0.1.1-beta.0，MCP cwd 解析到版本化
  缓存根目录，旧 `codex_cc_tools` enabled；
- 一次真实 Kimi K3 review 完成，实际模型为 `kimi-code/k3`，正确识别
  `values.length === 0` 导致 `0 / 0 -> NaN`；工作区 Git 状态与两个文件
  SHA-256 不变，Kimi 进程在调用后归零；
- 一次 Ark Coding Plan review 在启动 Pi 前以缺少凭据失败；无 retry/fallback、
  无文件变化、无 Pi 进程启动或残留。

父 App 进程的脱敏存在性检查确认 `API_KEY_DOUBAO_CODING` 存在，但
0.1.1-beta.0 的插件 `.mcp.json` 没有 `env_vars`。Codex 官方
[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)明确：
stdio MCP 的 `env_vars` 是从本地父环境转发的变量白名单，字符串条目默认来源为
`local`；`env` 是静态值。因此失败发生在 App → MCP 的环境边界，不是 Pi、
模型注册表、凭据优先级或 Coding Plan 路由内部。

`0.1.1-beta.1` 候选按 TDD 增加四项精确变量名白名单，不写入任何值，并让
artifact、release smoke、隔离插件和公共 npm 消费者验收都验证该合同。隔离插件
生命周期及其 `--check-report` 复核已通过。

## beta.1 发布、公共验收与取消残留

PR #2 merge commit `6d50a73` 已进入 `next`；CI run `30531374989` 的
Node 20/22/24 全绿。标签 `v0.1.1-beta.1` 触发 release run
`30531642511`，通过 GitHub Actions OIDC 发布、registry/`next` 校验和
GitHub prerelease 创建；npm 最终为 `next=0.1.1-beta.1`、
`latest=0.1.0`。

公共 registry 精确版本验收最终通过 CLI、doctor、直接 MCP、官方临时插件
add/list/remove、缓存副本 `cwd` / `env_vars` 合同、8/8 能力索引、目标进程
0/0/0 与资格锁 absent；真实模型调用 0，见
[0.1.1-beta.1 公共 npm 隔离验收](0.1.1-beta.1-npm-acceptance.md)。

第一次公共验收在模型调用前首错停止：此前 300 秒超时的 Kimi 外审虽然已从调用方
返回，但活动 beta.0 插件 MCP 仍在服务端运行请求，并延迟拉起一个 `kimi acp`
进程。只终止该 ACP 子进程后，同一 MCP 又将其拉起。Codex 随后只清理了命令行
精确匹配插件 runtime 且拥有该 ACP 子进程的 MCP 进程树；Kimi 桌面主进程、
Codex App 与旧 `codex_cc_tools` 均保留。5 秒复核确认 ACP 为 0，公共验收才
重新执行并通过。

该事实证明“工具调用超时”目前不等于“服务端工作已取消”。这是稳定发布的独立阻断
项，不能由 beta.1 的凭据转发修复自动视为通过。

## 活动插件升级到 beta.1

活动插件第一次执行官方 remove 时，Windows 拒绝删除仍被占用的 beta.0 缓存。
该命令已移除 MCP 注册，但 plugin list 仍显示 beta.0 installed，因此没有继续
add 或手工删除文件。只读进程核对发现当前 App 宿主下累积了多项命令行精确匹配
`codex-external-agents-mcp.mjs` 的闲置 Node 进程，最高观测 24 项；它们没有
子进程。

Codex 只清理这些由当前 App 宿主启动的插件 MCP 进程树，未终止 App、Kimi 桌面、
旧 `codex_cc_tools` 或其它 Node 进程。精确目标归零后：

1. 官方 plugin remove 成功，列表显示 not installed；
2. 官方 plugin add 成功安装 0.1.1-beta.1；
3. 官方列表显示 installed/enabled 0.1.1-beta.1；
4. `codex mcp get codex_external_agents` 把 `cwd` 解析到 beta.1 版本化缓存，
   四项转发变量均只显示为 `*****`；
5. `codex mcp get codex_cc_tools` 仍显示 enabled，工具为
   `cc_review` / `cc_delegate`。

没有直接读写活动 `config.toml`，也没有手工删除插件缓存。当前 app-server 在升级
前已加载插件配置，既有实测表明版本更新不能热刷新，所以真实 Pi/delegate/取消调用
必须等完整 App 重启后在新任务执行。

## beta.3 发布、公共验收、活动升级与启动阻断

`0.1.1-beta.3` 已由 release run `30783495490` 通过 GitHub Actions OIDC 发布到
npm `next`，registry 为 `next=0.1.1-beta.3`、`latest=0.1.0`。精确公共包验收于
`2026-08-03T05:13:45.456Z` 通过 doctor、local npm、direct MCP、隔离官方插件、
8/8 能力索引与 owned MCP cleanup；真实模型调用为 0，详见
[0.1.1-beta.3 公共 npm 隔离验收](0.1.1-beta.3-npm-acceptance.md)。

活动升级前，官方列表显示插件 installed/enabled `0.1.1-beta.1`，marketplace 指向
旧仓库根，旧 `codex_cc_tools` enabled。首次官方 plugin remove 因 Windows 正在占用
beta.1 缓存而失败；该命令移除了 MCP 注册，但没有完成插件删除。只读 WMI 核对找到
19 个命令行精确为 `node ./runtime/codex-external-agents-mcp.mjs`、父进程精确为当前
`codex.exe app-server` 且没有子进程的旧插件 MCP Node 进程。Codex 只终止这 19 项，
没有停止 App、Kimi/Pi、旧 `codex_cc_tools` 或其它 Node 进程。

目标归零后，官方 plugin remove、旧 marketplace remove、当前 worktree marketplace add
与 plugin add 依次成功。升级后只读状态为：

- `codex-external-agents@codex-external-agents-local` installed/enabled `0.1.1-beta.3`；
- marketplace 根为当前 worktree；
- `codex_external_agents` 的 cwd 解析到 beta.3 版本化缓存；
- 四个允许转发的凭据名只显示为 `*****`；
- beta.1 缓存不存在，beta.3 缓存存在且只有五个预期插件文件；
- 旧 `codex_cc_tools` 仍 enabled，工具仍为 `cc_review` / `cc_delegate`；
- 命令行精确匹配的插件 MCP 进程数为 0。

全过程没有直接读取或修改活动 `config.toml`，也没有手工删除缓存。随后从不可变
`v0.1.1-beta.3` 的精确 clean checkout 运行正式启动层时，脚本在 observer 启动前
要求读取仓库中被 `.gitignore` 排除的生成 runtime，因而确定性 fail closed。活动插件
并未因此运行失败，但 beta.3 无法作为同一不可变发布身份下的宿主 receipt 生产者；不得
手工复制 runtime、外置替换脚本或移动旧标签。

`0.1.1-beta.4` 候选按 TDD 修复这一缺口：clean tag 只读取 4 个受版本控制插件制品；
活动官方 cache 的 5 个安装制品仍全部通过固定路径、realpath、普通文件和 reparse 检查，
共同计算 beta marker 已绑定的完整摘要；4 个共同文件再逐字节对照。生成 runtime 只来自
活动 cache。该修复不改变 canonical runtime、helper、observer或八项能力指纹，故不重跑
任何真实模型。

## beta.4 发布、公共验收与活动升级

`0.1.1-beta.4` 由 PR #10 merge commit
`e9390b1dc71b6b88cff3d8449c37060ecd3e75ed` 纳入 `next`。PR CI run
`30791015181`、合并后 CI run `30791125720` 与 release run `30791303240`
全部通过；GitHub Actions Trusted Publishing/OIDC 将其发布到 npm `next`，registry 为
`next=0.1.1-beta.4`、`latest=0.1.0`。精确制品身份为：

- integrity：`sha512-qkvoGlb1knReI7IrkgXcoWwX1rgVbgAR+z7Msc33wYk7wvq2f5P1GQsvJfJfDHLzTnugMhLnIwPFzlKudR96Cw==`；
- shasum：`9957a46844082f7efac5392d04db46801abd908f`；
- GitHub prerelease：`v0.1.1-beta.4`。

当前 Windows/Node 24 宿主的公共精确包隔离验收于
`2026-08-03T06:50:10.011Z` 通过 CLI、doctor、direct/cache MCP、临时官方插件生命周期、
8/8 能力投影与 owned MCP cleanup；真实模型调用为 0，详见
[0.1.1-beta.4 公共 npm 隔离验收](0.1.1-beta.4-npm-acceptance.md)。

活动插件使用官方 remove/add 一次成功，无需解除 Windows 锁或终止任何进程。升级后
官方状态为 installed/enabled beta.4，MCP cwd 指向 beta.4 版本化缓存，四项凭据名只
显示掩码，旧 `codex_cc_tools` 仍 enabled。beta.4 缓存恰好包含五个预期文件、无
reparse point，摘要
`5e374af0a92681b6eb9b4817cfeb9574f6b675906bc634df14a628159ea0e29f` 与 release marker
完全一致；beta.3 缓存已移除。没有直接读取或修改活动 `config.toml`，也没有调用真实模型。

## 未验证风险与发布后状态

真实 App 普通 Stop 的 `cancelled + owned-zero` 仍未验证。若未来恢复该项验证，PASS 仍
必须由 observer 唯一写入的 receipt 精确证明 cancelled、completion marker absent、
handler cancelled、in-flight removed、owned descendants zero 且不重生；本次 stable
决策记录不能替代或推断这些事实。

0.1.1 stable晋级、公共隔离复验和重启后stable加载确认均已完成，不再有发布或激活阻断。
这不是补写真实Stop receipt，也不能把第四层改成passed。发布后仍不得称为“真实App宿主
门禁全部通过”或“已替代旧
`codex_cc_tools`”。禁止本地`npm publish`、删除旧工具、恢复开发期直连或手工修改活动配置。

完整实施步骤见[跳过真实 Stop 后的 0.1.1 Stable 晋级计划](../superpowers/plans/2026-08-07-stable-promotion-after-host-stop-skip.md)。

后续推进仍不额外进行泛化模型复跑，不恢复多 Node 矩阵，也不为外部 CLI 增加
默认或全局执行限制。

若修复版升级并刷新后的新任务仍报告缺少 Ark 凭据，应单独审计 App 对 `env_vars`
的实际解析，不恢复开发直连。只有确认新插件安装本身失败时，才对本次新插件使用已
授权的官方回滚：

```powershell
codex plugin remove codex-external-agents@codex-external-agents-local
codex plugin marketplace remove codex-external-agents-local
```

不得手工修补活动 `config.toml`。

## 2026-08-23 本地 0.1.2-beta.1 三源宿主修复

维护者明确授权把活动官方插件精确切换到完整本地五模型候选，并终止旧插件 MCP
进程。官方 App CLI 最终显示
`codex-external-agents@codex-external-agents-local` installed/enabled
`0.1.2-beta.1+codex.20260822121123`；缓存包含单文件 runtime、`.mcp.json`、
plugin manifest 与 Windows x64 helper/哈希侧车，helper `--probe-v1` exit 0。

宿主缓存完成重建后，当前任务活动注册表同时暴露 `external_review` 与
`external_delegate`。对同一份运行规则只读调用三条代表性 review 路线，各调用一次：

| 逻辑 LLM | 实际模型 | 状态 | 耗时 | 诊断 / 文件变化 |
| --- | --- | --- | ---: | --- |
| `kimi-k3` | `kimi-code/k3` | completed | 28.958 秒 | 0 / 0 |
| `ark-coding-plan` | `ark-code-latest` | completed | 63.988 秒 | 0 / 0 |
| `deepseek-v4-flash` | `deepseek-v4-flash` | completed | 58.286 秒 | 0 / 0 |

调用层没有第二次工具调用、fallback 或模型切换。三次结束后只剩 App 管理的插件 MCP
宿主；Kimi、Pi 与 job helper 后代均为 0。项目根工作树调用前后都保持 HEAD
`34a1d5e8f18653d8eeeb7ec77295828ae8a53916` 和既有 `M AGENTS.md`，没有本次文件
修改。受保护配置继续是 `approval_policy="never"`、
`sandbox_mode="danger-full-access"`、Superpowers disabled，并已由配置维护脚本确认新
指纹。

该证据闭合的是本地 staging 的工具发现、Windows helper 与 Kimi/Ark Coding/Direct
DeepSeek review 可用性。它不替代 npm 公共包验收、`external_delegate` 真实写入验收、
普通 Stop receipt，也不把当前候选的 stale 能力晋级为 current。外审发现的 Kimi
adapter 最终模型身份缺口随后在候选源码中单独按 TDD 加固；活动插件仍对应加固前的
精确 staging 字节。
