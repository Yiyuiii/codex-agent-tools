# 长期默认授权与自主资格收敛实施计划

> 2026-07-29 状态：本计划已经结束并作为历史执行记录保留。其“同批 8/8”停止目标被后续[能力粒度资格实施计划](2026-07-29-capability-scoped-qualification.md)取代；真实调用的 standing authorization 与 batch fail-closed 边界继续有效。

> 执行方式：在 `codex/gemini-retirement` 隔离 worktree 中由 active long-term goal 持续执行。维护者已默认授权项目内真实资格实验，不设置逐批人工停点。

**目标：** 把长期默认实验授权持久化为不削弱原子资格协议的操作合同，并自主运行、诊断和收敛 `four-llm-v1`，直到同批 8/8 通过或出现确需维护者处理的外部阻碍。

**设计依据：** `docs/superpowers/specs/2026-07-28-standing-experiment-authorization-design.md`

## Task 1：同步长期边界与当前状态

修改：

- `AGENTS.md`
- `README.md`
- `docs/operations.md`
- `docs/release/checklist.md`
- `docs/release/real-plugin-install-review.md`
- `docs/smoke/kimi.md`
- `docs/smoke/ark.md`
- `docs/release/four-llm-qualification-execution-runbook.md`
- `docs/release/qualification-carrier-rehearsal.md`
- `docs/release/four-llm-qualification-result-review.html`
- `docs/release/pi-write-command-diagnostics-design-review.html`
- `docs/release/four-llm-qualification-next-authorization-review.html`
- 仍由 `AGENTS.md` 索引的旧授权边界设计/计划（只增加 superseded 注，不重写历史）

要求：

1. 用户原始要求中增加 2026-07-28 standing authorization，明确它覆盖真实资格实验及离线收敛，但不覆盖活动配置/插件、Claude Code、旧工具、发布或正式工作树动作。
2. 保留既有一次性授权和失败批次为历史事实，不改历史 evidence、历史授权页或已执行计划。
3. 把 `authorizationReference` 解释为兼容 schema 的内部批次执行引用；每批 fresh、只存哈希、无需用户回复。
4. 把“单批不得另开批次”收窄为不得在同一终态处理链内续跑；终态证据提交和新 clean freeze 后，可按 standing authorization 自主启动新批。
5. 明确无状态变化时不重复烧额度，外部账户/凭据/登录/权限或身份歧义才是人工停点。

验证：

```powershell
rg -n "standing|默认授权|内部批次执行引用|无需逐批|无需逐 SHA|不得.*config.toml|不得.*第二批" AGENTS.md README.md docs/operations.md docs/smoke/kimi.md docs/release/four-llm-qualification-execution-runbook.md docs/release/four-llm-qualification-next-authorization-review.html
```

## Task 2：独立审阅并修正文档漂移

并行进行两个只读审阅：

- 当前有效文档中是否仍有会阻止默认授权执行的陈旧门槛；
- 协调器、CLI 和测试是否把 `authorizationReference` 技术上实现为人工审批，而不是唯一身份/防复用引用。

Codex 汇总、反驳和修正。历史文档里的旧要求只标注为历史，不重写历史。

## Task 3：完整离线验收并形成 clean frozen candidate

按顺序执行：

```powershell
npm.cmd run typecheck
npm.cmd test -- --run
npm.cmd run build
npm.cmd run smoke:release
```

随后使用新临时 `CODEX_HOME` 运行隔离插件 `--check-report`，逐份验证 retained manifests，确认 evidence 文件字节未改变、Kimi ACP / Pi RPC / real-smoke 进程为 0/0/0、资格锁 absent、没有持久 `.tgz`，并检查工作树差异。

提交本任务文档和状态改动。只有提交后工作树 clean，才把该 HEAD 作为新的 frozen candidate。

## Task 4：自主运行一个完整真实批次

前置条件：

- active long-term goal；
- clean frozen SHA 与构建身份一致；
- 完整离线门禁刚刚通过；
- 资格锁 absent，目标进程 0/0/0；
- 所需凭据只检查存在性，不读取值；
- 当前没有另一个 coordinator 或真实 smoke；
- `functions.exec` 和 yielded cell 可用。

执行合同：

1. 在内存中生成一个 fresh UUID，作为内部批次执行引用；不回显、不持久化明文。
2. 只调用一次标准入口：

   ```powershell
   npm.cmd run --silent qualify:gates -- --authorization-ref <内存中的 fresh UUID>
   ```

3. 使用一个 `functions.exec` cell，内层 timeout 不低于 14,400,000 ms。
4. cell yield 后只用同一 cell 的短周期 wait；不启动第二入口。
5. 任一 case 失败即接受协调器终态，不 resume/retry/fallback/补跑/跳项。

## Task 5：终态分类与自主收敛

终态落盘后立即：

1. 验证 manifest、case evidence、冻结身份、内部引用哈希、锁释放和进程 0/0/0；
2. 提交不可变 evidence；
3. 更新 AGENTS、README、运维、模型状态和单文件 HTML 审阅材料。

分支：

- **8/8 passed**：TDD 更新注册表与相关断言，生成 ready 离线状态包，完整复验并冻结；不安装、不发布。
- **仓库内可修复**：系统调试 → 失败测试 → 最小修复 → 独立复审 → 完整复验 → 新 clean freeze → 新批。
- **外部可操作阻碍**：停止，给维护者最小充分证据和唯一必要动作。
- **证据或 owner 身份歧义**：fail closed，停止并请求维护者判断。

同一外部错误在没有外部状态变化时不重复运行。此前最新批次已在 ordinal 6 得到 `account_quota_exceeded`；如果新 frozen candidate 的新批仍在同一路线返回同类额度错误，而本地路由/凭据/协议证据正常，应将其定为需要维护者处理的账户额度阻碍，不再烧第二个无信息增益批次。

## Task 6：最终完成前验证

在声称完成、通过或阻断前，重新执行与结论相称的验证：

- 变更后的测试、typecheck、build、release smoke；
- frozen/immutable verifier；
- evidence 字节和哈希；
- 目标进程、资格锁、临时产物和工作树；
- 文档与实际终态一致；
- 未访问活动 `~/.codex/config.toml`，未触碰活动插件、Claude Code、`codex_cc_tools`、发布或正式工作树。

完成条件只有两类：

1. 同批 8/8 通过并完成离线晋级候选；或
2. 已证明确需维护者完成一个外部动作，且 Codex 已把所有可自动验证和修复的工作收敛完毕。

## 执行结果（2026-07-28）

本计划已到达第 2 类完成条件：

- standing authorization 文档与状态边界由提交 `0113da9` 冻结，完整离线门禁通过；
- 在 frozen commit `0113da97a6b1fef35cc4c45025caa9e36a002176` 上只调用一次标准入口，以一个 execution cell 运行批次 `2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c`；
- ordinal 1–5 passed；ordinal 6 `ark-agent-plan/delegate` 以 `account_quota_exceeded` failed；ordinal 7–8 notRun；没有 resume、retry、fallback、补跑、第二入口或第二批；
- ordinal 1 与 6 的规定写入和规定状态命令均各一次 success，结果文件与变更范围精确通过；本地 Windows shell、命令观测和资格假阳性缺口已由真实证据闭合；
- 所有已执行项均为一次 client invocation、零 adapter/runtime retry、零 adapter/orchestrator fallback；immutable-evidence verifier 通过，进程 0/0/0，资格锁 absent；
- manifest SHA-256 为 `f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`，20 个不可变证据文件由提交 `6b4217d` 保存；
- 当前已确认且需要维护者处理的阻碍是 `OPENAI_API_KEY_DOUBAO` 所属 Ark Agent Plan 账户额度；ordinal 7–8 尚未运行，不能据此排除后续可能出现其它问题。维护者需补充/恢复该计划额度或等待重置，无需提供密钥值。外部状态变化后，Codex 可按 standing authorization 在新 clean frozen SHA 上从 ordinal 1 自主运行新批。

在额度状态变化前不重复运行；活动配置、活动插件、Claude Code、`codex_cc_tools`、发布、推送、合并和 fast-forward 均保持未触碰。
