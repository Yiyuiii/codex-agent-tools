# 从 codex-cc-tools 迁移

## 目标边界

本项目以 MCP 服务 `codex_external_agents`、工具 `external_review` 与 `external_delegate` 替代 `codex_cc_tools`。迁移只修改 Codex 的 `config.toml`：不会运行旧包卸载器，不会修改 `D:\Codes\codex-cc-tools`，也不会调用、修改或卸载本机 Claude Code。

新工具每次都要求显式选择逻辑 `llm`。调用者不能指定 backend、provider、真实模型、代理、工具集或推理强度。

## 来源映射

| 旧来源或用途 | 新逻辑 LLM | 当前状态 |
| --- | --- | --- |
| Kimi Code 外部审阅/委派 | `kimi-k2.7`、`kimi-k2.7-highspeed`、`kimi-k3` | review/delegate 已通过真实门禁 |
| Gemini direct review | `gemini-3.5-flash`（Pi/Google） | review/delegate 已通过真实门禁 |
| Ark Coding Plan | `ark-coding-plan`（Pi/`ark-code-latest`） | 缺少可继承凭据，保持 pending |
| Ark Agent Plan GLM | `ark-agent-glm-5.2`（Pi/`glm-5.2`） | 周额度耗尽，保持 pending |
| Ark Agent Plan Doubao | `ark-agent-doubao-seed-2.0-pro`（Pi/同名模型） | 周额度耗尽，保持 pending |
| Anthropic Claude / Claude Code 后端 | 无 | 从新产品面删除；本机 Claude Code 安装保留 |
| DeepSeek | 无 | 按维护者要求不迁移 |
| OpenAI/Codex 模型家族 | 无 | 不作为外部来源引入，因为顶层已是 Codex |

Ark 当前证据和复跑条件见 [Ark / Pi 真实能力门禁](smoke/ark.md)。禁用能力不会静默切换到其它 LLM。

## 可回滚切换

只有 doctor 的运行时、凭据和所有目标能力门禁都满足时，以下命令才会写真实配置：

```powershell
codex-agent-tools install --replace-codex-cc-tools
```

流程为：

1. 运行 fail-closed readiness 检查；失败时配置零写入、零备份。
2. 获取同配置文件锁。
3. 在原目录创建带 UTC 时间戳的逐字节备份。
4. 只删除 `[mcp_servers.codex_cc_tools]` 表，安装带拥有标记的 `[mcp_servers.codex_external_agents]`。
5. 通过临时文件、文件同步和 rename 原子替换。
6. 启动新 MCP 并验证 initialize/listTools 只暴露两个批准工具。
7. 任一写后验证失败时从内存中的原始字节自动恢复；备份保留供审计。

当前 Ark 门禁仍 pending，因此该命令会明确拒绝切换。这是安全门禁，不是安装器故障。普通 `codex-agent-tools install` 仍可用于独立安装新表，不会删除旧表；正式替换只使用上述参数。

## 显式回滚

成功切换会输出备份绝对路径。需要回滚时执行：

```powershell
codex-agent-tools restore --backup "<输出的备份绝对路径>"
```

如测试非默认配置，可同时传入 `--config <path>`。restore 使用同一配置锁和原子替换，不删除备份。恢复后重启 Codex，让 MCP 进程列表重新加载。

## 切换后复核

```powershell
codex-agent-tools doctor --json
```

应确认：

- `codex_external_agents` 注册归本包所有；
- 公开工具只有 `external_review` 与 `external_delegate`；
- `codex_cc_tools` 表已不存在；
- 本机 Claude Code 文件与旧项目源码没有变化；
- 每个启用能力仍有真实门禁证据。
