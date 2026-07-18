# 运维说明

本文说明 `codex_external_agents` 的本机安装、诊断、升级、卸载和故障排查流程。

## 前置条件

- Node.js 20 或更高版本。
- 本机 Kimi Code 已安装，并完成其原生 OAuth 登录。
- Codex 可以读取自己的 `~/.codex/config.toml`。

本项目不会读取或修改 Claude Code 配置，也不会卸载 Claude Code。Kimi OAuth 文件仍由 Kimi Code 自己管理；工具桥只继承定位本机用户目录所需的最小环境变量。

## 安装与重载

全局安装后运行：

```powershell
codex-agent-tools install
codex-agent-tools doctor
```

从旧 `codex_cc_tools` 正式切换时使用 fail-closed、带备份和自动回滚的专用流程；当前 Ark 门禁未通过时该命令会拒绝写入：

```powershell
codex-agent-tools install --replace-codex-cc-tools
```

完整映射、删除项和回滚说明见 [从 codex-cc-tools 迁移](migration-from-codex-cc-tools.md)。

测试其它 Codex 配置文件时可显式指定路径：

```powershell
codex-agent-tools install --config D:\path\to\config.toml
codex-agent-tools doctor --config D:\path\to\config.toml --json
```

安装器写入一个拥有标记和一个 MCP 表：

```toml
# managed-by: codex-agent-tools
[mcp_servers.codex_external_agents]
command = "<当前 Node 绝对路径>"
args = ["<当前包 dist/mcp.js 的绝对路径>"]
startup_timeout_sec = 20
tool_timeout_sec = 900
required = false
enabled = true
enabled_tools = ["external_review", "external_delegate"]
```

安装可重复运行。它只替换带有上述拥有标记的目标表，保留用户注释和其它 MCP 服务。若同名表没有拥有标记，命令会拒绝覆盖。安装或升级后应重启 Codex，让新的服务进程和工具契约生效。

## 诊断

```powershell
codex-agent-tools doctor
codex-agent-tools doctor --json
codex-agent-tools doctor --strict
```

诊断会检查：Kimi 可执行文件、版本与登录状态；Pi 可执行文件、版本、隔离配置哈希、Ark endpoint/模型清单以及 Gemini/Ark 凭据变量名；本包拥有的 MCP 注册；公开工具名；各逻辑 LLM 的真实模型、运行时、固定网络路由和 review/delegate 质量门禁。Gemini 凭据按 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_GENERATIVE_AI_API_KEY` 的顺序只选择第一个非空值；Ark Coding Plan 按 `ARK_API_KEY`、`VOLCENGINE_API_KEY` 选择，Agent Plan 使用 `OPENAI_API_KEY_DOUBAO`。报告只显示命中的变量名和项目私有目标变量名，不显示凭据内容。

普通模式即使存在警告也用于展示完整报告。`--strict` 只在出现错误级诊断时返回非零；质量门禁 pending 是警告，表示该能力尚未通过真实烟测。报告会对环境中的令牌、密钥和认证头脱敏。

Kimi 的真实门禁证据见 [Kimi 真实能力门禁](smoke/kimi.md)，Pi/Gemini 的真实门禁证据见 [Pi / Gemini 真实能力门禁](smoke/pi-gemini.md)，Ark 的当前失败矩阵和复跑条件见 [Ark / Pi 真实能力门禁](smoke/ark.md)。

## 升级

升级包后重新运行安装器，再重启 Codex：

```powershell
npm update -g codex-agent-tools
codex-agent-tools install
codex-agent-tools doctor
```

这是必要步骤，因为 MCP 配置固定保存当前 Node 和包入口的绝对路径。安装器不会要求用户维护 Pi 配置；Pi 运行时使用应用缓存下的版本化隔离目录，`settings.json` 和 `models.json` 由本包生成，不读取或修改用户的 `~/.pi/agent`。

## 卸载

```powershell
codex-agent-tools uninstall
npm uninstall -g codex-agent-tools
```

先运行本包卸载命令，删除拥有标记对应的 MCP 表，再移除 npm 包。卸载器不会删除无标记的同名表，也不会修改其它 MCP 服务、Kimi Code、Pi 或 Claude Code。完成后重启 Codex。

## 从 cutover 备份恢复

```powershell
codex-agent-tools restore --backup "<cutover 输出的备份绝对路径>"
```

restore 只将指定备份原子写回 Codex 配置，不删除备份，也不修改旧项目、Kimi、Pi 或 Claude Code。恢复后重启 Codex。

## 故障处理

### 找不到 Kimi

先运行 `kimi --version` 和 `kimi doctor`。Windows 上本包依次检查测试专用覆盖、`PATH` 以及用户目录下 Kimi Code 的标准安装位置。不要把 OAuth 令牌手工复制到项目环境变量。

### 能看到工具但模型能力被拒绝

查看 `doctor` 对应逻辑 LLM 的 review/delegate 门禁。pending 表示该精确组合尚未获得真实烟测证据；系统不会替换成其它后端或模型。需由项目维护流程完成烟测并随新版本启用。

### review 返回 workspace_changed

这表示调用前后工作区证据不同。把当前工作区视为已发生变化，先检查返回的 `filesChanged` 和 Git 状态。应用层只读控制不等于操作系统沙箱；高风险审阅应在只读副本、容器或受限账户中运行。

### delegate 超时或取消

桥接层会请求协议取消并终止 Kimi 进程树。先检查返回的诊断和工作区真实状态，再决定是否重试；委派不会自动重试，因为重复执行可能造成二次写入。

### 配置冲突

若安装器报告同名表不归本包所有，请人工确认该表来源。只有确定旧表可被替换后，才由维护者移除或改名；安装器不会抢占未知配置。

## 发布前维护验证

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
```

发布烟测会检查两个 bin、真实 stdio MCP 工具契约、doctor JSON、`npm pack --dry-run --json` 文件白名单，以及包内开发机绝对路径和当前环境密钥泄漏。真实模型烟测是独立门禁，不包含在确定性的发布烟测中。
