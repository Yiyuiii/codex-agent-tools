# 真实 Codex App 宿主验收记录

日期：2026-07-30

状态：**partial — 官方安装和来源消歧完成；当前 App 进程尚未加载插件 MCP**

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

[官方 MCP 手册](https://learn.chatgpt.com/docs/extend/mcp)对桌面端手工 MCP
配置要求保存后选择 Restart；[官方插件构建说明](https://learn.chatgpt.com/docs/build-plugins.md)
要求刷新 ChatGPT 或 Codex，并在新会话测试；[插件连接与测试说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)
也要求刷新元数据后启动新会话。当前实测与这些安全边界一致。

## 尚未通过的门禁

完整第 4 层仍缺少以下证据：

1. App 刷新：当前运行中的桌面 App 需要由维护者刷新或重启；本任务不能在不终止
   自身的情况下替用户完成该动作。
2. 刷新后的新任务加载：必须在刷新后创建新任务，确认新旧四项工具共存，并再次用
   官方只读列表核对插件相对入口。
3. 真实宿主调用：插件进入工具面后，完成 Kimi 与至少一条 Pi 路线的代表性 review。
4. 可写与取消：在隔离临时仓库完成 delegate，并从真实宿主验证取消长任务后的
   Kimi/Pi 进程回收。

在这些缺口闭合前：

- 官方插件可以称为“已安装、已启用，缓存协议验收通过”；
- 开发期直连可以称为“已通过官方命令移除，CLI 已解析到插件相对入口”；
- 不得称为“真实 App 宿主门禁全部通过”；
- 不得称为“已替代旧 `codex_cc_tools`”；
- 不得删除旧工具、恢复开发期直连或手工修改活动配置。

## 下一人工节点

下一步需要维护者刷新或重启 Codex 桌面 App，然后回到本任务继续。刷新完成后才可
创建新的验收任务并消费已经批准但尚未使用的真实调用：

1. 从插件缓存重新发现 `external_review` / `external_delegate`；
2. 复核旧 `cc_review` / `cc_delegate` 仍存在；
3. 在脱敏、隔离边界内运行一项 Kimi review、一项 Pi review、一项 delegate 和
   一项可取消长任务。

当前失败是 App 进程未刷新，不是安装状态或缓存工件失败，因此不执行插件回滚。若
刷新后的新任务仍无法发现工具，再单独审计 App 插件加载，而不是恢复开发直连。只有
确认安装本身失败时，才对本次新插件使用已授权的官方回滚：

```powershell
codex plugin remove codex-external-agents@codex-external-agents-local
codex plugin marketplace remove codex-external-agents-local
```

不得手工修补活动 `config.toml`。
