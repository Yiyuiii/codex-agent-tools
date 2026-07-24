# 0.1.0-alpha.1 本机替换验收记录

日期：2026-07-20

分支：`codex/ark-cutover`

验收前基线提交：`9ea404272bad`
结论：**Kimi、Gemini、Ark 的 14 项真实能力门禁、确定性检查和独立 stdio MCP 验收已通过；活动 Codex 配置的自动 cutover 在重启后导致 Codex 无法正常运行，用户已于 2026-07-24 恢复原始配置。因此不能声称 `codex_external_agents` 已在真实 Codex App 中完全替代 `codex_cc_tools`。未获授权公开发布。**

## 环境

- Windows / PowerShell
- Node.js `v24.14.1`
- npm `11.11.0`
- Pi `0.80.10`
- Kimi Code `0.27.0`
- 包版本 `0.1.0-alpha.1`

## 确定性验证

以下命令在本轮工作树执行，退出码均为 0：

```powershell
npm run typecheck
npm test -- --run
npm run build
npm run smoke:release
git diff --check
```

结果：31 个测试文件、157 项测试通过；类型检查、构建、release smoke、stdio MCP 契约、doctor JSON、凭据脱敏和包内容检查通过。`npm pack --dry-run --json` 列出 80 个文件，packed 114,917 bytes，unpacked 443,259 bytes。

## 真实能力矩阵

| 逻辑 LLM | 固定路由 | review | delegate |
| --- | --- | --- | --- |
| `kimi-k2.7` | Kimi ACP / direct | passed | passed |
| `kimi-k2.7-highspeed` | Kimi ACP / direct | passed | passed |
| `kimi-k3` | Kimi ACP / direct | passed | passed |
| `gemini-3.5-flash` | Pi / Google / `proxy-10808` | passed | passed |
| `ark-coding-plan` | Pi / `ark-code-latest` / direct | passed | passed |
| `ark-agent-glm-5.2` | Pi / `glm-5.2` / direct | passed | passed |
| `ark-agent-doubao-seed-2.0-pro` | Pi / 同名模型 / direct | passed | passed |

Kimi 证据见 [Kimi 门禁](../smoke/kimi.md)，Gemini 证据见 [Gemini 门禁](../smoke/pi-gemini.md)，Ark 证据见 [Ark 门禁](../smoke/ark.md)。2026-07-20 新增的八份 Pi 证据均为串行运行；所有模型身份、固定路由、隔离环境、工作区边界和进程清理检查通过。

## 凭据与 doctor

本机用户环境中的 Ark Coding key 命名为 `API_KEY_DOUBAO_CODING`。项目已把它作为 `ARK_API_KEY`、`VOLCENGINE_API_KEY` 之后的兼容候选，并加入 Codex MCP `env_vars` 白名单。doctor 只报告：

- Gemini：`GEMINI_API_KEY`；
- Ark Coding：`API_KEY_DOUBAO_CODING -> CODEX_AGENT_ARK_CODING_KEY`；
- Ark Agent：`OPENAI_API_KEY_DOUBAO -> CODEX_AGENT_ARK_AGENT_KEY`。

切换前后 `doctor --strict --json` 均返回 `ok: true`，七个逻辑 LLM 的 review/delegate 均报告 passed，未输出密钥值。

## stdio MCP 本机验收

`npm run acceptance:local` 退出码为 0：

- 工具清单只有 `external_review`、`external_delegate`；
- `kimi-k2.7-highspeed` review 命中 `kimi-code/kimi-for-coding-highspeed`；
- `gemini-3.5-flash` review 命中同名模型和 `10808` 固定代理；
- `kimi-k3` delegate 一次完成；
- 取消传播观察到进度，结束后无新增 Kimi/Pi 进程。

验收摘要 SHA-256：`0e4aca2d35c4e124a5f3b6ca60e8df440bfad27253d3e710334ba0fe29169d04`。

## 正式 cutover

执行：

```powershell
# 历史事故命令，仅作证据记录
codex-agent-tools install --replace-codex-cc-tools
```

2026-07-20 当时观察到：

- 切换前配置 SHA-256：`1595fc9fd379a9b011711666c21c0c2212adacf2d207707146c55b175249d5c2`；
- 备份：`~/.codex/config.toml.codex-agent-tools-backup-2026-07-20T07-53-30.322Z`；
- 备份 SHA-256 与切换前配置完全相同；
- 切换后配置 SHA-256：`b6db369ee23184f4d31cfed45cd5ec24101d094f7b8fe52bf6d40dd26a79de54`；
- `[mcp_servers.codex_cc_tools]` 已不存在；
- `[mcp_servers.codex_external_agents]` 存在并包含 `API_KEY_DOUBAO_CODING` 白名单；
- 内置 MCP initialize/listTools 自检通过；
- 切换后 `doctor --strict --json` 全绿。

这些检查只覆盖配置文件、独立 MCP 子进程和项目 doctor，未覆盖重启后的真实 Codex App 启动与完整运行。用户随后确认 Codex 无法正常运行，并于 2026-07-24 恢复原始配置。上述哈希和备份仅作为历史事故证据，不再代表当前活动配置，也不得据此重复 cutover。

显式回滚命令：

```powershell
# 历史回滚命令，仅作证据记录
codex-agent-tools restore --backup "$HOME\.codex\config.toml.codex-agent-tools-backup-2026-07-20T07-53-30.322Z"
```

本轮未修改 `D:\Codes\codex-cc-tools`，未调用、修改或卸载本机 Claude Code。

## 2026-07-24 配置事故与当前约束

- 用户已恢复 `~/.codex/config.toml` 原始配置；项目不读取或修改恢复后的文件。
- 自动 cutover 的“成功”结论撤销。独立 MCP 验收通过不等于 Codex App 集成通过。
- 后续默认只生成候选配置或操作显式测试副本，不对活动配置执行 `install`、`install --replace-codex-cc-tools` 或 `restore`。
- 若未来确实需要写活动配置，必须先取得用户对该次写入的明确许可，并在写前提供精确 diff、离线解析结果、Codex 兼容性依据和回滚步骤。

## 发布状态

- 未生成需保留的 tarball。
- 未执行 `npm publish`，未推送远端。
- 公开发布必须等待用户明确授权，并在发布时重新检查 npm 名称与依赖公告。
