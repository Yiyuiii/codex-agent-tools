# 四模型八项资格批次执行承载手册

状态：维护者运行合同；不是可执行授权脚本，也不授予任何资格批次、安装或发布权限。

## 当前状态

最新真实 `four-llm-v1` 批次 `2026-07-28T01-52-35.087Z-cb1be2f4-62ab-4af1-b3f1-9f36cba83678` 绑定 frozen commit `07fd0d79e6885ee1e0af4a021e12170ef6c9f470`，已由一个 `functions.exec` cell 和一个四小时预算的前台 shell 从 ordinal 1 完整承载八项到可信终态。ordinal 1–7 passed；ordinal 8 `ark-agent-deepseek-v4-flash/delegate` 的模型、provider、direct route、凭据隔离、single-attempt、0 retry/fallback、精确 `git status --short` 观测和进程清理均正确，但结果文件缺失而 `acceptance_failed`。终态为 `blocked / case_failed`、8 completed / 7 passed 且 `promotionEligible=false`；活动注册表仍为 6 passed / 2 pending，安装仍为 `blocked / not ready`。

本轮没有发生 cell 丢失或 recovery，也没有 resume、retry、fallback、补跑、第二入口或第二批。immutable-evidence verifier 通过，批次后 Kimi ACP / Pi RPC / real-smoke 为 0/0/0，资格锁不存在。该结果证明本手册的长时承载路径可以取得正常终态，但不允许把同批任一通过项与历史证据拼接晋级。

105 秒承载演练只构成离线基础设施证据：`functions.exec` 约 1 秒后 yield，同一个 cell 随后经 4 次 `functions.wait` 完成；事件严格为 1 个 `started`、7 个有序 `heartbeat`、1 个 `completed`，shell exit code 为 0，观测 wall time 为 111.4 秒；演练后 Kimi ACP / Pi RPC / real-smoke 为 0/0/0，资格锁不存在。它不证明 cell 可存活 4 小时，不证明任何模型资格，也不授权真实批次。

未来真实批次仍需先形成一份新的 clean frozen candidate（干净冻结候选），完成复核，再取得针对该精确候选的一次新明确授权。历史授权已经消费，不得复用。

## 1. 授权消费前条件

下列条件必须全部成立；任一项缺失都应在生成或消费授权引用、调用标准资格入口之前停止：

- 已有精确且 clean 的 frozen candidate，候选内容、构建身份和资格协议已经独立复核；
- 确定性测试、隔离插件生命周期、package 闭包、不可变证据校验和必要的视觉检查均针对同一候选通过；
- 最新真实资格状态仍按证据如实标记为 blocked/interrupted 或其它实际不可晋级终态，注册表和安装状态没有被单项结果越过；
- 维护者已经针对该精确冻结候选，明确授权一次全新的、从 ordinal 1 开始的完整 `four-llm-v1` 八项批次；
- 历史授权页只作为已消费审计记录，没有被当作本次授权；
- 已创建并确认 active long-term goal；没有 active goal 时不得生成或消费授权引用；
- 当前会话同时提供 `functions.exec` 与 `functions.wait`，并已复核 105 秒离线承载演练报告；
- 资格锁不存在，Kimi ACP / Pi RPC / real-smoke 目标进程为 0/0/0；
- 没有计划访问活动配置、变更活动插件、移除旧工具、调用 Claude Code、发布或修改正式工作树。

维护者完成上述核对后，仍只能在受控执行阶段消费一次新授权；本手册和任何审阅页都不能替代用户的明确授权。

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

出现 failed、blocked、interrupted、preflight 失败、进程异常退出、锁/身份不一致、任何 case 未通过或 evidence 校验失败时，立即停止并保留既有证据。不得补跑单项，不得重开入口，不得另开批次。

### 歧义终态

cell 无法恢复等待且 owner、batch、authorization hash、terminal 或目标进程任一身份无法可靠确认时，按歧义处理：fail closed，保持现状，整理最小只读证据并请求人工判断。歧义不能解释为成功或失败，也不能成为 recovery、retry 或第二批的理由。

## 6. 明确禁止

本运行合同明确禁止：

- retry、fallback、resume、跳项、单项补跑、入口重调、第二次 recovery 或第二批；
- 读取、备份、恢复、手工编辑或以其它方式访问活动 `~/.codex/config.toml`；
- 安装、升级、卸载、回滚或修改活动插件；
- 调用、修改或卸载 Claude Code；
- 移除、修改或替换旧 `codex_cc_tools`；
- 发布 npm、marketplace、Git tag 或 GitHub release；
- push、merge、fast-forward 或以其它方式修改正式工作树；
- 把离线演练、执行手册、结果审阅页或重新授权审阅页解释为真实资格授权。

## 7. 文档与授权边界

本手册只告诉维护者在未来另获明确授权后如何 fail closed 地承载一个批次。演练报告只记录离线基础设施证据；结果页只记录历史终态；已经消费的重新授权审阅页只保留审计材料。任何一份文档、任何文档组合、对设计或计划的确认、以及 active long-term goal 本身，都不生成、替代或暗示真实资格授权。

相关材料：

- [105 秒离线承载演练](qualification-carrier-rehearsal.md)
- [历史：2026-07-27 Kimi 命令观测阻断结果审阅](four-llm-qualification-result-review.html)
- [已消费的历史授权材料](four-llm-qualification-authorization-review.html)
- [发布验收清单](checklist.md)
- [运维边界](../operations.md)
