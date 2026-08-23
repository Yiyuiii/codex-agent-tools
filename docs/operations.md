# 五模型 beta 运维流程

本文适用于 `codex-agent-tools@0.1.2-beta.2` 候选。公开工具为 `external_review` 与 `external_delegate`，公开逻辑 LLM 为：

- `kimi-k3`
- `ark-coding-plan`
- `ark-agent-plan`
- `ark-agent-deepseek-v4-flash`
- `deepseek-v4-flash`

日常审阅与委派优先选择 `kimi-k3` 或合适的 Ark Plan 路线。Direct `deepseek-v4-flash` 使用独立 DeepSeek API 计费，只在调用方明确要求该路线，或 Plan 路线不适合当前任务时使用。该选择策略只影响调用方选型，不改变 `llm` 必填、固定 provider/model/credential 绑定、无自动 retry/fallback 或精确路线验收边界。

## 1. 前置条件

- Windows x64 / Node.js 24+；
- `@earendil-works/pi-coding-agent` 0.80.10；
- Kimi Code 可用；
- Ark Coding 存在 `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`API_KEY_DOUBAO_CODING` 中至少一项；
- Ark Agent 存在 `OPENAI_API_KEY_DOUBAO`；
- Direct DeepSeek 存在 `OPENAI_API_KEY_DEEPSEEK`。

只检查凭据是否存在，不输出其值。插件 `.mcp.json` 只转发上述五个变量名；运行时再为每条 Pi 路线注入一个项目私有目标变量。

## 2. 构建与离线门禁

```powershell
npm ci
npm run gate:offline
```

门禁必须证明：

- 注册表精确包含五个逻辑 LLM；
- 能力索引精确包含五个逻辑 LLM × review/delegate 共十项；
- 十项 evidence 均有效，十项运行时指纹均为 current；
- npm 包携带能力索引、十个 case 与两个不可变 manifest；
- 插件凭据白名单精确包含五个变量名；
- MCP 仍只公开两个工具且 `llm` 必填。

开发候选若仍有 stale 能力，`npm run verify:capabilities` 与 release smoke 必须失败关闭。不得用历史成功、doctor、凭据存在或文档声明替代该门禁。

## 3. 真实资格刷新

Direct `deepseek-v4-flash` 使用独立的 `direct-deepseek-v1` 两项计划。`four-llm-v1` 保留 Kimi 与三条 Ark 路线的八项广覆盖回归顺序；开发候选只刷新当前失效能力时使用 `capability-refresh-v1`。刷新入口启动前会把固定七项目标与机器能力分析逐项比较；目标为空、重复、包含 current 能力或漏掉非 Direct 的 stale/invalid 能力都会在锁和模型调用前失败关闭。三个计划的配置哈希、执行顺序和 evidence 不得拼接或互换。

当前候选的十项 evidence 与十项运行时指纹均为 current。2026-08-23 的 `capability-refresh-v1` passed batch `2026-08-23T11-11-13.828Z-f5c1cb1c-9b94-4dee-8c2f-b3f5d6098e60` 绑定 frozen commit `388f0fdc37db02b5c6104988aa68baa793eda791`，固定七项全部通过；每项一次 client invocation、零 adapter/runtime retry、零 fallback、模型/provider/direct route 正确且 owned process drained。terminal 为 `passed`、`promotionEligible=true`，manifest SHA-256 为 `968c00d5ecf9a612fd8e9b5bff34ef84c31126ac6598078d9f9c74ee4f48e550`；immutable-evidence 与精确 frozen-candidate verifier 均通过。能力索引已用七项新 case 更新，`npm run verify:capabilities` 与 release smoke 通过。此前误用广覆盖入口和首次定向入口的两个 blocked 终态保持不可变；根因、哈希与修复见 GitHub 上的[能力刷新资格设计与阻断记录](https://github.com/Yiyuiii/codex-agent-tools/blob/main/docs/release/capability-refresh-qualification-2026-08-23.md)。

## 4. 隔离官方插件生命周期

十项能力全部 current 后运行：

```powershell
npm run acceptance:plugin:isolated:built
```

脚本只使用一次性 `CODEX_HOME`，依次执行官方 marketplace add、plugin add/list、缓存副本 MCP 启动、fake Pi 调用、plugin remove 与 marketplace remove。验收必须覆盖五模型注册表、Direct DeepSeek 与 Ark Agent DeepSeek 的凭据隔离、代理清除、工具契约和进程回收。

## 5. 发布与公共 npm 验收

beta 只通过 `.github/workflows/release.yml` 的 GitHub Actions OIDC 路线发布到 npm `next`，禁止本地 `npm publish`。发布前必须确认：

- `0.1.2-beta.2` 在 npm 尚不存在；
- 候选已进入发布分支并通过 CI；
- `v0.1.2-beta.2` 指向精确候选提交；
- `.release-validation/v0.1.2-beta.2.json` 绑定最终 runtime、十项能力索引、插件树与宿主冻结证据；
- tag workflow 全绿并创建 GitHub prerelease。

发布后运行：

```powershell
npm run acceptance:npm-package -- --version 0.1.2-beta.2
```

该命令从公共 npm registry 安装精确版本，禁用 lifecycle scripts，并在临时目录和临时 `CODEX_HOME` 中验证 CLI、doctor、MCP、官方插件生命周期与包内证据闭包。

## 6. 活动插件升级

发布与公共隔离验收不授权活动插件变更。取得针对该次升级的明确许可后，按官方插件命令执行 cachebuster、remove/add，并完整退出重开 Codex App。重启后创建新任务，核对工具元数据，再分别做所需的最窄真实调用。

项目代码不得直接读取、写入、备份、恢复或手工编辑活动 `~/.codex/config.toml`。失败时也不得手工修补配置。旧 `codex_cc_tools` 是否退役属于独立决定。
