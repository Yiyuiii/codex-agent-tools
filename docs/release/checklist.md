# 0.1.0-alpha.1 本机替换验收记录

日期：2026-07-18  
已验证实现提交：`5b563f2ee892650d2d7a47f14b6222109812afb4`  
结论：**软件与 Kimi 本机链路可验证，新旧 MCP 已安全并存；尚不可移除 `codex_cc_tools`，也未获授权公开发布。**

## 环境

- Windows / PowerShell
- Node.js `v24.14.1`
- npm `11.11.0`
- Pi `0.80.10`
- Kimi Code `0.27.0`
- 包版本 `0.1.0-alpha.1`

## 确定性验证

以下命令在实现提交前的同一工作树执行，退出码均为 0：

```powershell
npm clean-install
npm run typecheck
npm test
npm run build
npm run smoke:release
git diff --check
```

结果：31 个测试文件、156 项测试通过；类型检查、构建、release smoke、stdio MCP 契约、doctor JSON 和包内容检查通过。`npm clean-install` 报告一个低危开发期传递依赖问题：`esbuild` 的 Windows dev server 本地文件读取公告（GHSA-g7r4-m6w7-qqqr）。本项目不启动该 dev server；为避免强制覆盖 `tsup/vite` 依赖图，本阶段不使用 override，发布前随上游依赖更新复核。

## 真实能力矩阵

| 逻辑 LLM | review | delegate | 当前结论 |
| --- | --- | --- | --- |
| `kimi-k2.7` | passed | passed | enabled |
| `kimi-k2.7-highspeed` | passed | passed | enabled |
| `kimi-k3` | passed | passed | enabled |
| `gemini-3.5-flash` / `proxy-10808` | pending | pending | 两次 review 均被 Google 共享免费层额度阻塞；delegate 未在已知阻塞下继续消耗请求 |
| `ark-coding-plan` | pending | pending | 缺少 `ARK_API_KEY` / `VOLCENGINE_API_KEY` |
| `ark-agent-glm-5.2` | pending | pending | 上游周额度耗尽 |
| `ark-agent-doubao-seed-2.0-pro` | pending | pending | 上游周额度耗尽 |

Kimi 最新 K3 delegate 证据为 `docs/smoke/evidence/2026-07-18T10-35-18.032Z-kimi-k3-delegate.json`，文件 SHA-256 `a43c7454eda5bb729155bffbc1de276f8b01fc143178bc73196f69db8a7d7ce8`。Gemini 新路由第二次失败证据为 `docs/smoke/evidence/2026-07-18T11-14-05.781Z-gemini-3.5-flash-review-pi.json`，文件 SHA-256 `bd87b76a1d29d1ece12781cdd2068f8efdbf881e09c801f7213416da88091559`。

## 本机安装与 MCP 验收

- `npm link` 成功。
- `codex-agent-tools --version`、`--help` 成功。
- `codex-external-agents-mcp --help` 成功，只声明 `external_review` 与 `external_delegate`。
- 新 MCP 已用普通 `install` 写入真实 Codex 配置；`doctor --json` 正确报告注册归本包所有、Kimi 六项 passed、Gemini/Ark pending、Ark Coding 缺凭据。
- stdio MCP 本机验收通过：工具 schema/annotations、`kimi-k2.7-highspeed` review、`kimi-k3` delegate、取消传播、无新增 Kimi/Pi 进程。
- 本机验收对 Gemini 的调用被硬门禁即时拒绝：`Logical llm "gemini-3.5-flash" review is disabled pending real smoke`。
- 本机验收摘要 SHA-256：`8cf0b321d73c44802f9f20af44d2f11c5af22d9fd11be2b4aaedcf380b3d0d99`。

## 真实 cutover 的拒绝与不变性

执行 `codex-agent-tools install --replace-codex-cc-tools` 得到预期退出码 1。拒绝项为 Ark Coding 凭据，以及 Gemini/三个 Ark 逻辑 LLM 的 pending 门禁。

- `~/.codex/config.toml` 切换前 SHA-256：`28adad4e2891e0fb5de09e8a8c7472000b761d816a3f3a3522e277b0c8f132ca`
- 切换后 SHA-256：相同
- 新建 cutover 备份：0
- `D:\Codes\codex-cc-tools`：未修改
- 本机 Claude Code：未调用、未修改、未卸载

上述拒绝测试发生在并存安装之前，证明正式替换路径能在 readiness 失败时保持原配置；这是门禁的预期行为。

随后执行普通 `codex-agent-tools install`，只新增本包拥有的 `codex_external_agents` 表，没有删除旧表：

- 并存安装后配置 SHA-256：`06cbc866006bbcb12c8de1b9dd361ddd5507dd8d68a9f95bcc7ffdf23b1d83c5`
- `codex_cc_tools`：仍存在
- `codex_external_agents`：存在且包含拥有标记与凭据 `env_vars` 白名单
- 第二次普通安装：报告 `already installed`，SHA-256 不变
- 当前运行中的 Codex App：需要重启后才会加载新 MCP

## 包与发布

- npm registry 对 `codex-agent-tools` 当前返回 E404；名称尚未发现公开占用，但发布时必须再次检查。
- `npm pack --dry-run --json` 共列出 72 个文件；文件白名单由 release smoke 验证，验收清单本身也包含在包内，README 链接不会断开。
- release smoke 已检查两个 bin、包文件白名单、开发机绝对路径和当前环境密钥泄漏。
- 未生成持久 tarball，未执行 `npm publish`，未推送远端。

## 解除阻塞后的固定续跑顺序

1. Google 额度恢复后分别复跑 Gemini `proxy-10808` review/delegate；仅把各自通过项改为 passed。
2. 获得 Ark Coding 凭据后复跑其两项门禁；Agent Plan 额度恢复后复跑四项门禁。
3. 全部目标门禁通过后重跑确定性检查和 `acceptance:local`。
4. 再执行真实 cutover，核对备份、新旧 MCP 表与 MCP 自检；重启 Codex 后复跑本机验收。
5. 只有用户明确授权时才准备正式版本并执行公开发布。
