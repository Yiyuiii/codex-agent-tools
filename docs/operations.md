# DeepSeek-only beta 运维流程

本文适用于 `codex-agent-tools@0.1.2-beta.0`。该 beta 的公开注册表只有 `deepseek-v4-flash`，公开工具仍为 `external_review` 与 `external_delegate`。

## 1. 前置条件

- Windows x64 / Node.js 24+；
- `@earendil-works/pi-coding-agent` 0.80.10；
- 宿主环境变量 `OPENAI_API_KEY_DEEPSEEK` 存在。

只检查变量是否存在，不输出其值。插件 `.mcp.json` 仅转发该变量；Pi 子进程仅接收 `CODEX_AGENT_DEEPSEEK_KEY`。

## 2. 构建与确定性门禁

```powershell
npm ci
npm run gate:offline
```

门禁必须证明：

- 公开逻辑 LLM 精确为 `deepseek-v4-flash`；
- DeepSeek review/delegate 两项能力证据有效且当前指纹匹配；
- provider 精确使用 `https://api.deepseek.com`、`openai-completions` 与 `deepseek-v4-flash`；
- npm 包只携带 Direct DeepSeek 的能力索引、两个 case 与对应 manifest；
- 插件只声明 `OPENAI_API_KEY_DEEPSEEK`；
- MCP 工具仍精确为 `external_review` 与 `external_delegate`，且 `llm` 必填。

## 3. 隔离官方插件生命周期

```powershell
npm run acceptance:plugin:isolated:built
```

脚本只使用自动创建的一次性 `CODEX_HOME`，依次执行官方 marketplace add、plugin add/list、缓存副本 MCP 启动、fake Pi 调用、plugin remove 与 marketplace remove。它不得读取或修改活动 Codex home，也不调用真实模型。

隔离验收应确认：

- 旧模型 ID 被拒绝，错误只列出 `deepseek-v4-flash`；
- Direct DeepSeek fake Pi 恰好调用一次；
- 子进程没有继承 HTTP(S)/ALL proxy；
- 只注入规范化后的 DeepSeek 目标凭据；
- stdio 与 owned 进程清理完成。

## 4. 发布

beta 只通过 `.github/workflows/release.yml` 的 GitHub Actions OIDC 路线发布到 npm `next`。禁止本地 `npm publish`。

发布前必须满足：

- 版本 `0.1.2-beta.0` 在 npm 尚不存在；
- 候选已合并到 `next`；
- 不可变标签 `v0.1.2-beta.0` 指向已通过 CI 的提交；
- `.release-validation/v0.1.2-beta.0.json` 绑定更早的运行时冻结提交、两项能力索引、当前宿主冻结凭据、插件树和 observer 构建来源；
- tag workflow 全绿并创建 GitHub prerelease。

## 5. 公共 npm 精确验收

发布完成后运行：

```powershell
npm run acceptance:npm-package -- --version 0.1.2-beta.0
```

该命令固定从 `https://registry.npmjs.org/` 安装精确版本，禁用 lifecycle scripts，并在一次性目录和临时 `CODEX_HOME` 中验证 CLI、doctor、MCP、插件生命周期、证据哈希与包闭包。

## 6. 活动插件边界

发布和公共隔离验收不授权活动插件安装或升级。项目代码不得直接读取、写入、备份、恢复或手工编辑活动 `~/.codex/config.toml`。未来若要升级活动插件，必须另行明确授权，并只使用官方 Codex 插件命令完成；失败时也不得手工修补配置。

历史 Kimi/Ark 发布与资格证据继续保留在仓库 `docs/smoke/`、`docs/release/` 和不可变 batch 中，不进入本 beta 的公开产品面。
