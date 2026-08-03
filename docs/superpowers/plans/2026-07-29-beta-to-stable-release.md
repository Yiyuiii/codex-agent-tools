# codex-agent-tools Beta → Stable 发布实施计划

日期：2026-07-29

状态：已获维护者授权，执行中。

> 2026-08-03 当前覆盖：发布实施以[Windows 当前宿主精简计划](2026-08-01-windows-current-host-owned-process.md)为准。下文 Node 20/22/24 矩阵、跨宿主兼容与旧 Markdown marker 只记录历史流程，不是下一版本门禁；当前发布线只使用维护者 Windows x64 / Node 24 宿主、严格 JSON marker、GitHub Actions OIDC、公共 npm 与官方插件完整重启/真实 Stop 验收。Ark Coding Plan 额度恢复只改变当前可调用性，四模型八项资格已为8 current / 0 legacy，不重复运行模型。`0.1.1-beta.4` 已完成PR/双重CI、精确标签、OIDC发布、公共精确包隔离验收与活动官方插件升级；npm为`next=0.1.1-beta.4`、`latest=0.1.0`，五文件活动缓存摘要与marker一致。下一步完整退出并重开App，从beta.4 clean tag启动observer，在`REQUEST_STARTED`后使用普通Stop取得`cancelled + owned-zero` receipt，随后准备stable。

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
   npm publish --ignore-scripts --tag next --access public --registry=https://registry.npmjs.org/
   ```

6. 验证精确版本与 `next` dist-tag，再配置：

   ```powershell
   npm trust github codex-agent-tools --file release.yml --repo Yiyuiii/codex-agent-tools --yes
   ```

   本次使用执行机 npm 11.11.0 的参数面；相同命令加 `--dry-run --json` 先确认
   package、repository 与 workflow filename，真实执行在 beta.0 已存在后经
   单次 2FA 确认并以 exit 0 建立信任。未来若升级 npm，应先按目标版本
   `npm trust github --help` 复核参数，不复用已变化的历史参数。

7. 推送 `v0.1.0-beta.0`；workflow 对已存在版本只做幂等验证并创建 prerelease，不重复发布。

执行进度：发布基础设施由 `8f46d81` 提交；beta.0 已完成版本统一、公共 npm
精确版本验收入口和本地候选矩阵。当前 fresh 结果为 53 files / 890 passed /
1 skipped / 0 failed，类型检查、8/8 能力索引、release smoke、生产依赖审计和
228-file pack dry-run 均通过。公开 GitHub 仓库与 `main` / `next` 已建立。
首轮 GitHub CI 在 Linux 暴露 fake Pi 于 settled 后才写 stderr flood 的夹具
时序问题；生产代码按完成合同清理进程是正确行为，因此只把 flood 调整到
settled 前。聚焦测试连续三轮和全量单 worker 回归均通过。第二轮 CI 的
Node 22 已通过全部测试，随后因 hosted runner 未预装 Codex CLI 而在插件
release smoke 以 ENOENT 失败；Node 20/24 被 fail-fast 取消。CI 与 release
workflow 现按官方安装路径固定 `@openai/codex@0.146.0` 并核对版本，插件
门禁本身不降级。固定 CLI 后的第三轮 Node 20/22/24 CI 已全绿。发布控制自审
继续补充 `fail-fast: false` 与强制 `refs/tags/v*` ref 校验，避免矩阵结果被
连带取消，也拒绝普通 branch 上的手动发布；契约测试先红后绿。当时最终远端 CI、
npm 首包与独立复审仍是本 Task 的未完成门禁。随后发布/OIDC 窄审 PASS；npm
隔离初审命中 npm 子进程继承宿主 `.npmrc`/token 的 HIGH blocker，现已把
HOME/CODEX_HOME/AppData/TEMP/TMP/TMPDIR、npm userconfig/globalconfig/cache
全部移入一次性目录，并让 npm view/install/version 使用空 install cwd 与该
环境，定向复审 PASS。宿主 `codex plugin` 是官方插件生命周期测试器，不是本包
CLI 的替代关系；该建议经产品边界复核后未采纳。隔离修复提交 `4cc9c33` 的最终
CI `30454587529` 已在 Node 20/22/24 全绿。2026-07-30 已手工 bootstrap
`codex-agent-tools@0.1.0-beta.0`，配置 `Yiyuiii/codex-agent-tools` /
`release.yml` Trusted Publisher，并推送 `v0.1.0-beta.0`；幂等 release run
`30506918996` 完整通过并创建 GitHub prerelease，Task 2 完成。

## Task 3：用 `0.1.0-beta.1` 验证 OIDC 并做本地 npm 验收

2026-07-29 进度：为避免 npm web login 等待浪费确定性准备时间，已从 beta.0
候选提交创建隔离 `codex/beta1-prep` 工作树。该工作树只准备 beta.1 版本元数据、
测试与审阅记录；在 beta.0 bootstrap 和 Trusted Publisher 建立前不得推送
`v0.1.0-beta.1`，也不得把预备分支误记为公开发布。

2026-07-30 结果：预备提交 `31e61cb` 已 fast-forward 到 `next`；CI run
`30507055208` 的 Node 20/22/24 全绿。`v0.1.0-beta.1` release run
`30507178009` 通过真实 npm OIDC 发布、registry/`next` dist-tag 复核与 GitHub
prerelease 创建。随后从公共 registry 精确安装 beta.1 的隔离验收通过：CLI、
doctor、stdio MCP、官方插件 add/list/remove、缓存副本 MCP、8/8 能力索引与
零残留门禁全部为 pass，真实模型调用为 0；Task 3 完成。

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
   - 本次 owned MCP transport 已清理、资格锁不存在、隔离根可回收；不扫描或要求全机 Kimi/Pi 进程归零。
3. 不在该验收中调用产品真实模型；能力真实性继续由 8/8 能力索引承担。
4. 将命令、版本、包摘要、MCP/插件结果和进程状态写入脱敏 beta 验收记录。

## Task 4：稳定版发布

2026-07-30 进度：stable 版本 TDD 已完成；第二轮全库为 53 files / 890 passed /
1 skipped / 0 failed，类型检查、8/8 能力索引、release smoke、生产依赖 0
vulnerabilities 与 228-file pack dry-run 均通过。首轮全库仅有两个 verifier
临时 Git 夹具在负载下触发 30 秒 timeout；两项聚焦、完整 verifier 94/94 和
第二轮全库均通过，没有修改生产 verifier 或放宽超时。独立 `cc_review` 为 PASS，
三项非阻断文档建议全部采纳；`.release-validation/v0.1.0.md` 已写入七项精确
marker。当前剩余 `main` CI、stable tag OIDC 发布和公共 stable 包隔离复验。

2026-07-30 完成：stable 提交 `20c6922` 已 fast-forward 到 `main`，CI run
`30509477415` 的 Node 20/22/24 全绿。`v0.1.0` release run `30509627373`
通过 stable validation、真实 npm OIDC 发布、registry/`latest` 校验与正式
GitHub Release 创建。随后从公共 registry 精确安装 `0.1.0` 的隔离复验通过；
最终 dist-tags 为 `latest=0.1.0`、`next=0.1.0-beta.1`。Task 4 与本计划完成。

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
