# Codex 官方插件隔离状态取证

## 隔离边界

- 本报告由唯一临时根目录下的独立 `CODEX_HOME` 生成；脚本逐次调用 Codex 前都会验证其位于该临时根内，且不是继承的 `CODEX_HOME` 或用户主目录下的 `.codex`。
- 报告只记录相对路径、文件大小所参与的差异判断和 SHA-256，不记录文件正文、凭据值或实际临时绝对路径。
- Codex CLI：`codex-cli 0.135.0`。

## 官方生命周期状态差异

### marketplace add

- 新增：`config.toml`
- 变化：无
- 删除：`tmp/arg0/<ephemeral>/.lock`、`tmp/arg0/<ephemeral>/apply_patch.bat`、`tmp/arg0/<ephemeral>/applypatch.bat`

### plugin list before install

- 新增：无
- 变化：无
- 删除：无

### plugin add

- 新增：`plugins/cache/codex-external-agents-local/codex-external-agents/0.1.1-beta.0/.codex-plugin/plugin.json`、`plugins/cache/codex-external-agents-local/codex-external-agents/0.1.1-beta.0/.mcp.json`、`plugins/cache/codex-external-agents-local/codex-external-agents/0.1.1-beta.0/runtime/codex-external-agents-mcp.mjs`
- 变化：`config.toml`
- 删除：无

### plugin list after install

- 新增：无
- 变化：无
- 删除：无

### plugin remove

- 新增：无
- 变化：`config.toml`
- 删除：`plugins/cache/codex-external-agents-local/codex-external-agents/0.1.1-beta.0/.codex-plugin/plugin.json`、`plugins/cache/codex-external-agents-local/codex-external-agents/0.1.1-beta.0/.mcp.json`、`plugins/cache/codex-external-agents-local/codex-external-agents/0.1.1-beta.0/runtime/codex-external-agents-mcp.mjs`

### plugin list after remove

- 新增：无
- 变化：无
- 删除：无

### marketplace remove

- 新增：无
- 变化：`config.toml`
- 删除：无

### marketplace list after remove

- 新增：无
- 变化：无
- 删除：无

## config.toml 状态

官方 marketplace 配置包含调用时间，因此报告用同一次取证内的稳定标签表示原始字节 SHA-256；标签相同即原始 hash 相同，标签变化即原始 hash 变化。

- marketplace add：存在，SHA-256 状态 `H1`
- plugin list before install：存在，SHA-256 状态 `H1`
- plugin add：存在，SHA-256 状态 `H2`（相对上一步有变化）
- plugin list after install：存在，SHA-256 状态 `H2`
- plugin remove：存在，SHA-256 状态 `H1`（相对上一步有变化）
- plugin list after remove：存在，SHA-256 状态 `H1`
- marketplace remove：存在，SHA-256 状态 `H3`（相对上一步有变化）
- marketplace list after remove：存在，SHA-256 状态 `H3`

## 已安装副本验收

- 官方安装器接受仓库插件中的直接 server-map `.mcp.json`。
- 官方缓存相对位置：`plugins/cache/codex-external-agents-local/codex-external-agents/0.1.1-beta.0`。
- 已安装副本声明并强制校验 `cwd: "."`；宿主将其解析到上述缓存目录后，MCP initialize/listTools 成功。
- 工具严格为 `external_review` 与 `external_delegate`；二者输入均要求 `llm`。
- `external_review` 为只读且非破坏性；`external_delegate` 为可写且具破坏性提示。
- 已退役的 Gemini review 被已安装 MCP 以 unknown logical LLM 明确拒绝；错误列出精确四项活动 LLM，没有启动 Pi，也没有返回伪造的结构化成功结果。
- fake Pi 的 Ark Agent Plan DeepSeek V4 Flash review 恰好调用一次并返回 `completed`，实际模型为 `deepseek-v4-flash`，且没有文件变化。
- fake Pi 包装器确认 direct 子进程没有继承父 MCP 的 HTTP(S)/ALL proxy；只收到规范化后的 Agent Plan 目标凭据，未收到原始候选变量、其它 Ark 目标凭据或 Google 凭据。
- 异常清理仅管理本脚本所启动 transport 的 PID，并在关闭 MCP client/transport 前终止其整个进程树。

## 语义回滚

- `plugin remove` 后官方列表显示目标插件为未安装。
- `marketplace remove` 后官方 marketplace 列表不再包含目标 marketplace。
- 官方 CLI 合法保留空缓存父目录与状态文件；验收以官方列表状态回滚和残留差异可解释为准，不声称字节级完全回滚。

## 结论边界

这不是活动 Codex home，也不构成真实 Codex App 验收。它只证明本机 Codex CLI 在隔离 `CODEX_HOME` 中接受、安装、启动并卸载当前插件产物。
