# 跳过真实 Stop 后的 0.1.1 Stable 晋级计划

日期：2026-08-07

状态：**实施中 — Task 1/2 已完成，最终门禁复验后进入 Task 3**

## 目标

在不声称真实 Codex App 普通 Stop 已通过的前提下，把已经完成公共 npm、官方插件和
八项能力验收的 `0.1.1-beta.4` 运行时晋级为 `0.1.1` stable。所有 npm 发布继续只走
GitHub Actions Trusted Publishing / OIDC；本地不执行 `npm publish`。

## 已知起点

- 公共 npm 为 `next=0.1.1-beta.4`、`latest=0.1.0`；
- `origin/next` 包含精确 beta.4 标签提交与后续发布记录，`origin/main` 是其祖先；
- 四个逻辑 LLM 的八项 review/delegate 能力均为 current passed / 0 legacy；
- beta.4 已通过当前 Windows x64 / Node 24 的唯一离线门禁、公共精确包隔离验收和
  官方插件安装升级；
- 两次真实宿主会话都没有 PASS receipt；维护者已明确终止继续重试，真实
  `cancelled + owned-zero` 保持 unverified。

## 设计选择

推荐增加一个**窄的稳定版验收决策联合类型**，不建立可泛化到其它门禁的通用 waiver
框架：

1. `passed`：保持现有行为，必须绑定并严格验证 observer 唯一写入的真实 receipt；
2. `skipped_by_maintainer`：只表示维护者显式接受当前版本的真实 Stop 未验证风险，
   必须绑定精确公共 beta 身份、固定风险码 `host_stop_unverified` 和仓库内决策记录；
   不允许携带 receipt，也不得输出“host acceptance passed”。

stable marker 应升级 schema，使用互斥字段表达上述两种状态。解析器对未知状态、额外
字段、beta 身份漂移、风险码漂移、决策记录缺失或摘要不匹配继续 fail closed。GitHub
Release 说明必须按实际状态输出 `skipped / unverified`，不能沿用当前固定的 `passed` 文案。

这一路线保留安全诚实性：发布者可以接受风险，但不能伪造证据或把缺失证据解释为通过。

## 非目标与去冗余边界

- 不再次运行 Kimi、Pi 或 Ark；版本号、发布验证器和文档变化不得使八项能力指纹 stale；
- 不恢复 Node 20/22/24 矩阵，只使用当前 Node 24 工作流；
- 不读取或修改活动 `~/.codex/config.toml`，不移除旧 `codex_cc_tools`，不修改 Claude Code；
- 不给任何外部 CLI 增加默认、全局或持久化执行预算；
- 不为了发布策略变化再发一个 beta；beta.4 已经是公共和本机验证过的运行时候选；
- 本次不删除 observer、descriptor client 或 native helper。它们已经进入 beta.4 的运行时
  证据边界，发布前删除会制造无必要的能力指纹变化与真实模型重认证。是否退役这些仅供
  验收的部件留到 stable 后单独做影响分析；
- 不建立“任意失败门禁都可跳过”的通用豁免机制。

## 实施步骤

当前进度：窄决策联合类型、beta.4→0.1.1 硬锁、决策摘要绑定、动态 Release 说明、
0.1.1 版本元数据与 stable marker 均已按 TDD 完成；八项能力仍为 8 current / 0 legacy，
首次完整 `gate:offline` 已通过。Windows Node 24 上发现发布验证器直接启动 `npm.cmd`
会产生 `spawn EINVAL`，现已按 TDD 收敛到当前 `node.exe + 固定 npm-cli.js` 并固定官方
registry；本机真实只读 registry 查询通过。完成最终完整门禁复验与文档收敛后进入 PR。

### Task 1：用 TDD 固定窄决策语义

状态：**completed**

修改 `src/release/release-validation.ts` 与 `test/release/release-validation.test.ts`：

1. 先写失败测试，固定 `passed` 与 `skipped_by_maintainer` 互斥；
2. 固定 skipped 状态必须绑定 beta.4 的版本、标签、tagged commit、npm integrity/shasum、
   插件摘要、canonical runtime digest 和固定风险码；
3. 固定 skipped 状态不读取、不接受、不推断 receipt；
4. 固定 passed 状态仍必须完整验证真实 receipt，现有强门禁不得退化；
5. 固定 release notes 对 skipped 只能写 `host Stop: skipped / unverified`；
6. 最小实现至绿，运行聚焦测试与类型检查。

### Task 2：准备 0.1.1 stable 候选

状态：**completed；最终完整门禁将在 Windows npm 启动修复后复验一次**

从最新 `origin/next` 创建 `codex/stable-0.1.1`：

1. 统一把 package、lockfile、runtime version 和插件 manifest 设置为 `0.1.1`；
2. 新增严格 stable JSON marker 与仓库内 host Stop 决策记录；
3. marker 精确绑定 `v0.1.1-beta.4`、公共 npm identity、beta plugin tree、observer artifact、
   canonical runtime digest 与 8/8 能力索引；
4. 运行能力指纹差异分析，必须得到 8 current / 0 stale；若任何运行时文件导致 stale，
   立即停止，不通过重跑模型掩盖非预期范围；
5. 运行唯一 `gate:offline`、`git diff --check` 和一次针对发布验证边界的独立审阅。

### Task 3：通过 GitHub Actions OIDC 发布

状态：**pending**

1. 推送稳定候选并向 `main` 提交 PR，等待 Node 24 CI；
2. 合并后确认 stable marker 在 `main` 精确重算通过；
3. 创建不可变 `v0.1.1` 标签，只由 `.github/workflows/release.yml` 发布 npm `latest`；
4. workflow 必须在 GitHub Release 中明确记录 `host Stop: skipped / unverified`；
5. 核对 npm 最终为 `latest=0.1.1`、`next=0.1.1-beta.4`，并验证 provenance 和精确包身份。

### Task 4：公共 stable 隔离复验

状态：**pending**

从公共 registry 精确安装 `codex-agent-tools@0.1.1`，只做当前宿主的确定性验收：

- CLI、doctor、stdio MCP initialize/listTools；
- 8/8 能力索引与包文件闭包；
- 官方临时插件 add/list/remove 与缓存入口/凭据名掩码；
- owned process 的确定性 kernel/managed 检查；
- 不调用真实模型，不再运行普通 Stop observer。

全部通过后记录 stable 公共验收。活动插件是否从 beta.4 升级到 stable 只使用官方插件
命令，并保持旧 `codex_cc_tools` enabled；不直接接触活动配置文件。

## 停止条件

以下任一项发生就停止 stable 晋级并保留 `latest=0.1.0`：

- 八项能力出现 stale 或 verifier 失败；
- skipped 决策能被误报为 passed，或 passed receipt 校验被削弱；
- stable package 除版本/发布元数据外出现未计划的运行时差异；
- Node 24 CI、唯一离线门禁、OIDC、registry identity 或公共 stable 隔离复验失败；
- 需要本地 npm publish、活动配置直写、删除旧工具或为外部 CLI 增加全局限制才能继续。

## 完成定义

- npm `latest=0.1.1`、`next=0.1.1-beta.4`，GitHub stable Release 与 provenance 可复核；
- 公共 stable 在维护者当前环境完成隔离复验；
- 八项能力保持 current passed，不重复调用真实模型；
- 所有用户材料都准确显示真实 Stop 为 `skipped / unverified`，没有 receipt 伪造或 PASS
  暗示；
- 活动配置、旧 `codex_cc_tools`、Claude Code 与外部 CLI 默认预算均未被改变。
