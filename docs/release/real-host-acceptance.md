# 真实 Codex App 宿主验收记录

日期：2026-07-30

状态：**partial — beta 已发布并升级；窗口重启未结束后台宿主，等待完整进程重启后真实调用**

## 授权与边界

维护者已明确授权本次真实 `marketplace add`、`plugin add`，以及失败时使用官方
`remove` 回滚。执行始终遵守以下边界：

- 不直接读取、备份、编辑或恢复活动 `~/.codex/config.toml`；
- 不移除或修改旧 `codex_cc_tools`；
- 不调用或修改 Claude Code；
- 本轮不调用真实 Kimi 或 Pi 模型；
- 安装成功，因此没有执行回滚。

维护者随后明确授权移除同名开发期 MCP、创建一个新 Codex 任务，并在插件加载后
运行真实 Kimi/Pi、隔离 delegate 与取消门禁。新任务在工具发现阶段首错停止，因此
没有消耗任何真实模型调用，也没有进入可写或取消测试。

维护者又完成了整 App 重启并授权继续推进。重启后的第二个新任务仍在同一工具发现
门禁首错停止；后续修复、beta 发布、本机官方升级和刷新后复验仍沿用这项授权。

## 发布身份

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
生命周期及其 `--check-report` 复核已通过；修复版尚未发布、升级或在真实 App
复验。

## 尚未通过的门禁

完整第 4 层仍缺少以下证据：

1. 发布并通过公共 npm 隔离验收后，用官方 remove/add 升级到
   `0.1.1-beta.1`，再完整重启宿主。
2. 真实宿主调用：复用既有 Kimi 通过证据，重点完成至少一条 Pi 路线的代表性
   review。
3. 可写与取消：在隔离临时仓库完成 delegate，并从真实宿主验证取消长任务后的
   Kimi/Pi 进程回收。

在这些缺口闭合前：

- 官方插件可以称为“已安装、已启用，缓存协议验收通过”；
- 开发期直连可以称为“已通过官方命令移除，CLI 已解析到插件相对入口”；
- 不得称为“真实 App 宿主门禁全部通过”；
- 不得称为“已替代旧 `codex_cc_tools`”；
- 不得删除旧工具、恢复开发期直连或手工修改活动配置。

## 下一人工节点

下一步由 Codex 完成 `0.1.1-beta.1` 的离线门禁、PR/CI、GitHub Actions OIDC
beta 发布、公共 npm 隔离验收和官方插件升级。升级后仍需要维护者再做一次完整宿主
重启，Codex 才能在新任务验证 Pi review、隔离 delegate 与取消清理。

若修复版升级并刷新后的新任务仍报告缺少 Ark 凭据，应单独审计 App 对 `env_vars`
的实际解析，不恢复开发直连。只有确认新插件安装本身失败时，才对本次新插件使用已
授权的官方回滚：

```powershell
codex plugin remove codex-external-agents@codex-external-agents-local
codex plugin marketplace remove codex-external-agents-local
```

不得手工修补活动 `config.toml`。
