# codex-agent-tools Beta → Stable 发布实施计划

日期：2026-07-29

状态：已获维护者授权，执行中。

## 用户目标

维护者授权 Codex 自主推进正式集成与公开发布，优先复用 `codex-cc-tools` 已验证的发布形态：先发布 beta，在本机从 npm 安装并验证，全部通过后再发布稳定版。

本授权覆盖本仓库的 GitHub 仓库创建、分支、提交、推送、标签、GitHub Release、npm beta/stable 发布以及隔离本地安装验证。它不授权直接读写活动 `~/.codex/config.toml`、替换活动插件、移除 `codex_cc_tools` 或修改 Claude Code。

## 发布协议

- 公共 GitHub 仓库固定为 `Yiyuiii/codex-agent-tools`。
- `next` 承载预发布；带 prerelease 后缀的 `v*` 标签发布到 npm `next`。
- `main` 承载稳定版；稳定 `v*` 标签发布到 npm `latest`。
- 首包 `0.1.0-beta.0` 需要一次交互式 npm 身份验证和手动 bootstrap，因为 npm 要求包存在后才能配置 Trusted Publisher。
- 首包存在后，用 npm CLI 配置精确的 GitHub Actions `release.yml` OIDC 信任。
- `0.1.0-beta.1` 必须由 GitHub Actions Trusted Publishing 发布，用来验证自动发布链。
- 只有从 npm 安装的 `0.1.0-beta.1` 通过隔离本地验收，才允许准备和发布 `0.1.0`。
- 发布过的版本永不复用；失败后修复使用新的 prerelease 序号。
- 任一门禁失败都停止当前阶段，不跳过、不把 beta 直接改标为 stable。

## Task 1：发布基础设施与 fail-closed 门禁

**文件**

- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `scripts/release-smoke.mjs`
- Modify: `src/release/assurance.ts`
- Modify: `test/release/assurance.test.ts`
- Modify: `test/smoke/script-entrypoints.test.ts`

**TDD**

1. 先写失败测试，固定：
   - package 的 repository/homepage/bugs 精确指向公共 GitHub 仓库；
   - npm 名称未注册时允许 bootstrap；已注册时只接受相同包名与相同 repository，拒绝身份漂移；
   - release workflow 只接受 `next` prerelease 与 `main` stable 标签祖先；
   - stable 标签必须携带 `.release-validation/v<version>.md`；
   - workflow 使用 GitHub-hosted Node 24、npm OIDC、`--ignore-scripts`、public access、registry 传播复核和 GitHub Release。
2. 最小实现至绿。
3. 运行聚焦测试、类型检查、release smoke。

执行记录：release smoke 首轮发现能力指纹错误纳入整个 lockfile，使 MCP SDK
升级和未来版本号变更会误伤全部模型资格。该边界已先按 TDD 修正为能力执行
依赖闭包；MCP SDK/Hono 改由 MCP、供应链与发布门禁覆盖，八项历史证据本身
保持不变。

## Task 2：准备并 bootstrap `0.1.0-beta.0`

**文件**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.ts`
- Modify: `plugins/codex-external-agents/.codex-plugin/plugin.json`
- Modify: 当前版本状态文档
- Create: `docs/release/0.1.0-beta.0-review.md`

**步骤**

1. 用统一版本检查确保 package、runtime 与插件 manifest 全部为 `0.1.0-beta.0`。
2. 运行完整单 worker 测试、类型检查、build、8/8 能力索引、release smoke、7/7 retained manifests、隔离插件 check-report。
3. 独立审阅发布差异并修复至收敛。
4. 创建 public GitHub 仓库，推送 `main` 与 `next`；等待 CI 全绿。
5. 通过交互式 npm web login 完成首包发布：

   ```powershell
   npm publish --ignore-scripts --tag next --access public
   ```

6. 验证精确版本与 `next` dist-tag，再配置：

   ```powershell
   npm trust github codex-agent-tools --file release.yml --repo Yiyuiii/codex-agent-tools --allow-publish
   ```

7. 推送 `v0.1.0-beta.0`；workflow 对已存在版本只做幂等验证并创建 prerelease，不重复发布。

执行进度：发布基础设施由 `8f46d81` 提交；beta.0 已完成版本统一、公共 npm
精确版本验收入口和本地候选矩阵。当前 fresh 结果为 53 files / 889 passed /
1 skipped / 0 failed，类型检查、8/8 能力索引、release smoke、生产依赖审计和
228-file pack dry-run 均通过。公开 GitHub 仓库与 `main` / `next` 已建立。
首轮 GitHub CI 在 Linux 暴露 fake Pi 于 settled 后才写 stderr flood 的夹具
时序问题；生产代码按完成合同清理进程是正确行为，因此只把 flood 调整到
settled 前。聚焦测试连续三轮和全量单 worker 回归均通过。修正后的远端 CI、
npm 首包与独立复审仍是本 Task 的未完成门禁。

## Task 3：用 `0.1.0-beta.1` 验证 OIDC 并做本地 npm 验收

**文件**

- Create: `scripts/npm-package-acceptance.mjs`
- Modify: version-bearing files
- Create: `docs/release/0.1.0-beta.1-review.md`
- Add tests for the acceptance entrypoint and installed-package contract.

**验收**

1. `0.1.0-beta.1` 从 `next` 的 tag-triggered GitHub workflow 发布到 npm `next`，带 provenance。
2. 在唯一临时目录与临时 `CODEX_HOME` 中从公共 registry 安装精确版本，验证：
   - 两个 npm bin 的版本、帮助和退出码；
   - `doctor --json` 的产品面与脱敏；
   - 真实 stdio MCP `initialize` / `tools/list`，且只暴露 `external_review` / `external_delegate`、`llm` 必填；
   - npm 包内 marketplace/plugin manifest/runtime 完整；
   - 官方插件 add/list、缓存副本 MCP 启动、remove/list 回滚；
   - 不继承活动插件状态，不触碰活动 `CODEX_HOME`；
   - Kimi ACP / Pi RPC / real-smoke 目标进程为 0，资格锁不存在。
3. 不在该验收中调用产品真实模型；能力真实性继续由 8/8 能力索引承担。
4. 将命令、版本、包摘要、MCP/插件结果和进程状态写入脱敏 beta 验收记录。

## Task 4：稳定版发布

**文件**

- Modify: version-bearing files to `0.1.0`
- Create: `.release-validation/v0.1.0.md`
- Create: `docs/release/0.1.0-review.md`
- Modify: README、发布清单、运维文档和 `AGENTS.md`

**步骤**

1. 将已通过 beta 验收的提交线 fast-forward 到 `main`，只加入稳定版版本/验证记录变更。
2. stable validation 必须精确记录：
   - `RC: v0.1.0-beta.1`
   - `Doctor: pass`
   - `Local-Npm-Smoke: pass`
   - `MCP-Smoke: pass`
   - `Plugin-Isolated: pass`
   - `Capability-Index: pass`
   - `Release-Review: pass`
3. 重新运行完整确定性矩阵和独立发布复审。
4. 推送 `main` 与 `v0.1.0`，由 Trusted Publishing 发布到 npm `latest`。
5. 从公共 registry 新建隔离目录安装 `codex-agent-tools@0.1.0`，重复 Task 3 的非模型验收。
6. 核对 npm `latest` / `next`、GitHub Release、provenance、包文件面与仓库 clean 状态。

## 完成条件

- GitHub public repo、`main` / `next`、CI 和 tag release workflow 可复核；
- npm 至少存在 `0.1.0-beta.0`、OIDC 发布的 `0.1.0-beta.1` 和稳定 `0.1.0`；
- beta.1 与 stable 均由公共 registry 的安装结果通过隔离本地验收；
- npm `next=0.1.0-beta.1`，`latest=0.1.0`；
- 8/8 能力索引和历史 evidence 保持有效、不可变；
- 活动 Codex 配置/插件、旧 `codex_cc_tools`、Claude Code 未改变；
- 所有发布证据和失败/重试事实已写回仓库。
