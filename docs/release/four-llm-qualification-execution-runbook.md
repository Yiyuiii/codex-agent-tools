# 四模型八项资格批次执行承载手册

状态：维护者运行合同；不是可执行授权脚本，也不授予任何资格批次、安装或发布权限。

## 当前状态

standing authorization 下的最新真实 `four-llm-v1` 批次 `2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c` 绑定 frozen commit `0113da97a6b1fef35cc4c45025caa9e36a002176`，已由一个 `functions.exec` cell 和一个四小时预算的前台 shell 从 ordinal 1 承载到可信首错终态。ordinal 1–5 passed；ordinal 6 `ark-agent-plan/delegate` 的模型、provider、direct route、凭据隔离、single-attempt 与零 retry/fallback 均正确，结果文件精确通过，但以 `account_quota_exceeded` failed；ordinal 7–8 notRun。终态为 `blocked / case_failed`、6 completed / 5 passed 且 `promotionEligible=false`；manifest SHA-256 为 `f1afd69ff78e63beca3e2a18995f0e181f099001e457632201d38601a1b274b7`，证据提交为 `6b4217d`。活动注册表仍为 6 passed / 2 pending，安装仍为 `blocked / not ready`。

本轮没有发生 cell 丢失或 recovery，也没有 resume、retry、fallback、补跑、第二入口或第二批。immutable-evidence verifier 通过，批次后 Kimi ACP / Pi RPC / real-smoke 为 0/0/0，资格锁不存在。ordinal 1 与 ordinal 6 的精确写入和精确状态命令均各一次 success，结果文件与文件范围都通过；这把上批的 Windows shell 与资格假阳性缺口真实闭合。当前 `account_quota_exceeded` 已成为独立、可复现的外部账户额度阻碍；无外部状态变化时不得再开新批。

离线根因确认是 Pi Windows 子进程环境缺少 `ProgramFiles` 与 `ProgramFiles(x86)`，导致 Git Bash resolver 失败；提交 `2a815c7` 已修复，生产隔离环境中的 resolver 找到 `C:\Program Files\Git\bin\bash.exe`，两个系统根变量存在且代理变量为 0，精确 Ark Agent Plan 写入探针 exit 0、28 bytes、SHA-256 `81fcf915...`。提交链 `e750052`、`b5a691f`、`3d85315`、`ceb8e9c` 还要求未来资格 Pi delegate 的精确写入与精确 `git status --short` 生命周期各一次且均 success，并由未来整批 passed verifier 重算；历史 blocked/interrupted 证据保持兼容，资格 schema/plan 与公共运行边界不变。当前收尾 fresh 全量为 49 files / 853 passed / 1 skipped / 0 failed，类型检查、构建、release smoke、隔离 `--check-report`、retained manifests 7/7、证据不变、目标进程 0/0/0、资格锁 absent 与 211-file pack dry-run 均通过。该结果证明本手册的长时承载路径可以取得正常终态，但不允许把同批任一通过项与历史证据拼接晋级。

105 秒承载演练只构成离线基础设施证据：`functions.exec` 约 1 秒后 yield，同一个 cell 随后经 4 次 `functions.wait` 完成；事件严格为 1 个 `started`、7 个有序 `heartbeat`、1 个 `completed`，shell exit code 为 0，观测 wall time 为 111.4 秒；演练后 Kimi ACP / Pi RPC / real-smoke 为 0/0/0，资格锁不存在。它不证明 cell 可存活 4 小时，不证明任何模型资格，也不授权真实批次。

未来真实批次仍需先形成一份新的 clean frozen candidate（干净冻结候选）并完成复核。维护者已给出项目内真实资格实验的 standing authorization，Codex 不再逐批或逐 SHA 等待人工回复；历史一次性授权已消费且不得复用，但每批仍生成 fresh 内部执行引用并绑定实际 frozen SHA。

## 1. 内部执行引用生成前条件

下列条件必须全部成立；任一项缺失都应在生成或消费授权引用、调用标准资格入口之前停止：

- 已有精确且 clean 的 frozen candidate，候选内容、构建身份和资格协议已经独立复核；
- 确定性测试、隔离插件生命周期、package 闭包、不可变证据校验和必要的视觉检查均针对同一候选通过；
- 最新真实资格状态仍按证据如实标记为 blocked/interrupted 或其它实际不可晋级终态，注册表和安装状态没有被单项结果越过；
- 当前 standing authorization 仍有效，本批属于项目内真实资格实验，而不是活动安装、发布或其它未授权的外部状态动作；
- 历史授权页只作为已消费审计记录，没有被当作本次授权；
- 已创建并确认 active long-term goal；没有 active goal 时不得生成内部执行引用；
- 当前会话同时提供 `functions.exec` 与 `functions.wait`，并已复核 105 秒离线承载演练报告；
- 资格锁不存在，Kimi ACP / Pi RPC / real-smoke 目标进程为 0/0/0；
- 没有计划访问活动配置、变更活动插件、移除旧工具、调用 Claude Code、发布或修改正式工作树。

Codex 完成上述核对后，在受控执行阶段生成一个 fresh UUID v4。现有 CLI/schema 字段仍名为 `authorizationReference`，但在 standing authorization 下它只是一批一次性的内部执行引用：明文不写入仓库或报告，只把规范化后的 SHA-256 用于锁、防复用、checkpoint、manifest 和 case evidence 关联。它不能跨批复用，也不需要维护者查看或回复。

## 2. one-cell / one-entry 承载合同

同一个未来批次必须同时遵守以下不变量：

1. 健康执行期间只创建一个 `functions.exec` cell。
2. 该 cell 内只启动一个前台 `tools.shell_command`。
3. 内层 `shell_command.timeout_ms` 必须不低于 `14,400,000` 毫秒（4 小时）。
4. 标准资格入口只调用一次，且只创建一个 coordinator/owner；健康执行期间不得启动第二个资格承载 shell、第二入口、并行 watcher、第二 coordinator 或第二批次。
5. `functions.exec` 应在约 1 秒后 yield；之后只用 `functions.wait` 重新进入同一个 cell，绝不因为暂时无输出、用户询问、消息更新或上下文压缩而重调入口。
6. 每次 `functions.wait` 的 `yield_time_ms` 不得超过 30,000 毫秒；不得使用超过 60 秒的单次阻塞等待。
7. 只要工具仍在运行，“本轮没有新输出”就只表示暂无新输出，不构成失败、超时或重试理由。
8. 执行期间每 30–60 秒至少向用户更新一次非秘密状态，任何连续静默不得超过 60 秒。

如果 cell 丢失，one-cell / one-entry 不变量只允许两个受限例外：可以启动一个只读诊断载体，仅观察 lock owner、checkpoint、terminal 和目标进程计数；只有第 4 节的严格条件全部成立时，才可以再启动一个且仅一个 same-batch interrupted recovery 载体。只读诊断载体不得调用标准入口或模型；诊断载体和 recovery 载体都不得创建新 owner、新 batch、调用模型或演变成新的资格承载入口。

active long-term goal、4 小时内层预算、短周期 wait 和现有锁/checkpoint/terminal 恢复协议缺一不可。105 秒演练不能替代其中任何一项。

## 3. 等待期间允许的只读观察

等待和异常判断期间只允许观察：

- 资格锁是否存在，以及 lock owner 的非秘密身份与存活状态；
- 最新 checkpoint 的序号与所属 batch 身份；
- terminal manifest 是否存在；
- Kimi ACP / Pi RPC / real-smoke 目标进程计数。

这些观察不得修改候选树、锁、checkpoint、manifest 或 evidence，不得读取活动 `~/.codex/config.toml`，也不得读取模型输出正文。健康执行期间不得启动额外 watcher、shell 或 coordinator；cell 丢失后只能使用第 2 节定义的一个只读诊断载体，以及在第 4 节严格条件成立时使用一次 same-batch interrupted recovery 载体。观察结果只用于决定继续等待、验证既有终态或 fail closed，不能推导模型、route、凭据、网络或 acceptance 结论。

## 4. cell 丢失或 wait 失败时的唯一处理链

如果 `functions.wait` 无法继续同一个 cell，必须严格按以下顺序处理：

1. 绝不再次调用资格入口。
2. 使用一个只读诊断载体，先确认 batch 身份与 authorization hash，再据此确认预期 terminal 的归属身份及其存在或缺失状态；任一身份或存在性无法可信确认时立即 fail closed，停止并请求人工判断。
3. 可信 terminal 已存在时，只验证该终态并停止；不得再根据 owner 或目标进程状态进入 recovery，不发布第二终态。
4. 只有可信 terminal 确认缺失时，才只读检查资格锁、owner 存活状态和 Kimi ACP / Pi RPC / real-smoke 目标进程计数。
5. owner 身份仍存活时，只继续等待并观察 terminal，绝不执行 recovery。
6. owner 已死但任一目标进程非零时，继续等待其受控超时或退出，绝不执行 recovery。
7. 只有 owner 已死、Kimi ACP / Pi RPC / real-smoke 均为 0 且可信 terminal 缺失时，才允许对同一个 batch 执行一次现有的 interrupted recovery。
8. 无法确认 owner 身份、目标进程状态或 terminal 确实缺失时，必须 fail closed，停止并请求人工判断。

唯一允许的 recovery 载体只负责把同一批次安全冻结为 `interrupted / process_interrupted`；它不得创建新 owner 或新 batch，不得调用标准入口或模型，也不得 resume、retry、fallback、takeover 或启动第二批。一次 recovery 结束后，无论成功、失败还是结果不明，都不得再次 recovery。

## 5. 成功、失败与歧义停止条件

### 成功终态

terminal 已存在且完整八项同批结果为 8/8 passed 时，只读验证 terminal、case evidence、冻结身份、不可变证据、锁释放与目标进程 0/0/0，然后停止并汇报。成功资格只表示可进入后续人工审阅，不自动授权活动安装、旧工具移除、发布或正式工作树变更。

### 失败终态

出现 failed、blocked、interrupted、preflight 失败、进程异常退出、锁/身份不一致、任何 case 未通过或 evidence 校验失败时，立即停止**当前批次**并保留既有证据。不得补跑单项，不得在同一批次或同一终态处理链中重开入口，也不得用新批掩盖未验证终态。

可信终态及其不可变证据提交后，再把原因分为三类：仓库内可修缺陷先按 TDD 修复、完整复核并形成新 clean frozen candidate，然后可依据 standing authorization 启动独立新批；账户额度、凭据、登录、服务权限或活动系统动作等外部阻碍停止并请求维护者处理；owner/lock/checkpoint/terminal 身份歧义则 fail closed 请求人工判断。没有代码变化、外部状态变化或新增诊断价值时，不得重复同一真实批次。

### 歧义终态

cell 无法恢复等待且 owner、batch、authorization hash、terminal 或目标进程任一身份无法可靠确认时，按歧义处理：fail closed，保持现状，整理最小只读证据并请求人工判断。歧义不能解释为成功或失败，也不能成为 recovery、retry 或第二批的理由。

## 6. 明确禁止

本运行合同明确禁止：

- 当前批次内的 retry、fallback、resume、跳项、单项补跑、入口重调、第二次 recovery，或在同一终态处理链中启动第二批/用新批掩盖失败；
- 读取、备份、恢复、手工编辑或以其它方式访问活动 `~/.codex/config.toml`；
- 安装、升级、卸载、回滚或修改活动插件；
- 调用、修改或卸载 Claude Code；
- 移除、修改或替换旧 `codex_cc_tools`；
- 发布 npm、marketplace、Git tag 或 GitHub release；
- push、merge、fast-forward 或以其它方式修改正式工作树；
- 把离线演练、执行手册、结果审阅页或重新授权审阅页解释为真实资格授权。

## 7. 文档与授权边界

本手册规定 standing authorization 下如何 fail closed 地承载一个批次，以及可信终态后何时可以自主进入新 clean frozen candidate。演练报告只记录离线基础设施证据；结果页只记录历史终态；已经消费的旧授权审阅页只保留审计材料。真实资格实验的长期许可来自维护者 2026-07-28 的当前明确要求，不来自任何文档、设计、计划或 active long-term goal；这些材料只负责持久化范围和执行合同。活动安装、活动配置、旧工具移除、Claude Code、发布和正式工作树动作仍各自需要满足原有边界。

相关材料：

- [105 秒离线承载演练](qualification-carrier-rehearsal.md)
- [历史：2026-07-27 Kimi 命令观测阻断结果审阅](four-llm-qualification-result-review.html)
- [已消费的历史授权材料](four-llm-qualification-authorization-review.html)
- [发布验收清单](checklist.md)
- [运维边界](../operations.md)
