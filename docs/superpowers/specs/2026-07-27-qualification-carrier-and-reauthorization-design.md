# 资格长时承载修复与再授权准备设计

日期：2026-07-27

状态：设计草案，待用户确认；本文不授权实施、真实模型调用、资格批次、安装、发布或配置访问

## 1. 决策摘要

下一轮只解决一个问题：让 Codex 能在不丢失控制权、不杀死协调器、不中断用户沟通的前提下承载最坏约 140 分钟、并按 4 小时工具预算保护的资格批次进程，然后重新冻结候选并准备一份新的人工授权审阅包。

采用的主方案是 **Codex 原生可让出执行单元**：

1. 由 `functions.exec` 启动一个等待中的 `tools.shell_command`；
2. `exec` 在短时间内返回 `cell_id`，而不是让前台工具超时；
3. 主 agent 以不超过 30 秒的 `functions.wait` 周期继续等待；
4. 等待期间只做只读状态核对和用户进度更新；
5. 同一个资格入口始终只调用一次。

该方案修复的是本次事故真实发生的 Codex 调用层，不修改资格协调器、锁、manifest、checkpoint、evidence、模型、provider、代理、凭据、重试或 fallback 语义。

下一轮实施仍停在真实批次之前。只有承载演练、候选重冻结、独立审阅和新授权材料全部完成后，才向用户请求针对精确冻结提交的另一份明确授权。

## 2. 事实链与根因边界

最新且唯一获授权的 `four-llm-v1` 批次：

`2026-07-27T04-27-07.245Z-3ee30234-325e-450f-8562-1598d5843cde`

其可证事实为：

- 冻结提交 `287b9a8bfa14805f84707adff6c7f2af19065475` 的 preflight 通过；
- 标准 `--authorization-ref` 入口只调用一次；
- 执行宿主前台 shell 约 14 秒后返回 `timeout 124`；
- 协调器子进程随后仍继续运行，发布 `batch_started` 和 ordinal 1 `case_running`；
- 协调器后来退出并留下 stale owner，没有发布 case evidence 或终态；
- 原进程死亡且目标进程为 0/0/0 后，只对同一批次执行一次 `--recover-interrupted`；
- 恢复没有调用模型、retry、fallback 或 resume，只发布 `interrupted / process_interrupted` 并释放锁；
- immutable-evidence verifier 通过，manifest SHA-256 为 `3e200dca507fe886d4e3a4bbf67cc811cca485120e6969e7632f933537ba902b`。

因此，证据只支持以下因果链：

```text
普通前台 shell 使用了过短的调用层超时
→ 调用工具提前返回 timeout
→ 协调器脱离了可靠的父级等待链
→ 协调器后来中断并留下 stale owner
→ 恢复协议安全冻结为 process_interrupted
```

证据不支持把失败归因于 Ark Coding Plan、Pi、模型质量、路由、凭据、网络、额度、acceptance、重试或 fallback。ordinal 1 是否完成过后端请求也无法证明，因此不得虚构 telemetry、case 结果或响应。

## 3. 目标与非目标

### 3.1 下一轮目标

- 证明当前 Codex 运行环境能用 `exec`/`wait` 可靠承载超过既有前台超时阈值的无网络长任务；
- 把唯一入口、持续等待、进度报告、cell 丢失、owner 存活、进程死亡和 stale recovery 的处理写成不可歧义的执行合同；
- 保持资格生产代码与协议不变；
- 将新的再授权审阅页纳入 release package 闭包；
- 重新执行完整确定性、隔离、证据完整性与视觉验收；
- 冻结 clean candidate；
- 停止并请求针对该精确冻结提交的一次新授权。

### 3.2 明确非目标

下一轮不得：

- 生成或消费真实资格授权 UUID；
- 运行带 `--authorization-ref` 的入口；
- 运行 standalone Kimi/Ark real smoke；
- 调用任何资格模型或网络；
- 恢复、续跑或改变历史 interrupted 批次；
- 修改活动 `~/.codex/config.toml`；
- 安装、升级、卸载或回滚活动插件；
- 移除 `codex_cc_tools`；
- 调用、修改或卸载 Claude Code；
- fast-forward 正式工作树；
- 发布 npm、marketplace、Git tag 或 GitHub release。

外部 LLM 只读审阅如果由用户既有协作偏好授权，可以用于审阅设计和差异；它不是资格调用，不得写文件，也不能作为承载演练的替代证据。

## 4. 方案比较

### 方案 A：Codex 原生 `exec`/`wait` 可让出承载（采用）

`functions.exec` 内等待一个具有充分 `timeout_ms` 的 `tools.shell_command`。外层在约一秒后让出，主 agent 持有 `cell_id`，使用短周期 `functions.wait` 继续等待。

优点：

- 修复发生故障的调用层；
- 不改变产品代码和资格协议；
- 资格进程仍是前台受控子进程，不需要后台守护进程；
- 不需要额外持久化明文授权；
- 主 agent 可以每 30–60 秒更新用户并检查状态；
- `functions.wait` 是当前 Codex 环境专门用于等待 yielded cell 的能力。

风险：

- 依赖当前会话提供 `functions.exec` 与 `functions.wait`；
- cell 标识属于会话瞬态，不能被误当成跨会话恢复协议；
- 如果 cell 意外丢失，必须回到现有 owner/terminal/target-process 证据链，绝不能重调入口。

这些风险可以通过“授权前 105 秒实机演练”和 fail-closed 运行手册控制。

### 方案 B：仓库内新增后台 supervisor 与 status 命令（暂不采用）

标准入口启动 detached worker 后立即返回，另设 status/watch 命令轮询。

优点是与调用工具生命周期解耦；缺点是会新增授权引用传递、后台进程身份、输出文件、worker/supervisor 双 PID、锁 owner、崩溃回收和 Windows 进程树语义。它把一次调用层问题扩展成新的生产协议，验证成本和故障面明显更大。

只有方案 A 在当前 Codex 环境中无法通过离线演练时，才单独设计方案 B；本轮不预先实现。

### 方案 C：只增大普通 shell 超时或使用 `Start-Process`（拒绝）

只增大 `shell_command.timeout_ms` 会让单次工具调用长期阻塞，无法保证 60 秒内与用户沟通，也无法利用专用等待机制。`Start-Process` 会把进程后台化，重新引入孤儿进程、输出归属和授权传递问题。

这两种做法都没有闭合本次事故的控制链。

## 5. 承载合同

### 5.1 授权消费前门禁

真实批次之前必须同时满足：

1. 当前会话明确提供 `functions.exec` 和 `functions.wait`；
2. 105 秒无网络演练通过；
3. 演练经至少三个独立 `wait` 周期完成；
4. 演练只产生一个 started、七个有序 heartbeat 和一个 completed；
5. 演练进程正常退出，无残留；
6. 资格锁不存在；
7. Kimi ACP、Pi RPC、real-smoke 目标进程为 0/0/0；
8. 执行手册、授权页和精确冻结候选已经独立审阅并通过。

任一条件不满足，都必须在生成授权引用和调用标准入口之前停止。

### 5.2 真实批次的单入口语义

后续另获授权的真实批次必须：

- 先创建独立长期 goal；没有 active goal 时不得消费授权；
- 只在一个 `functions.exec` cell 内调用一次标准资格入口；
- 内层 `shell_command.timeout_ms` 不低于 14,400,000 毫秒（4 小时），覆盖最长 30 分钟 preflight、当前八项 profile 合计约 110 分钟的各自 timeout 和确定性余量；
- 外层迅速 yield，随后只以 `functions.wait` 继续同一个 cell；
- 不因 wait 暂无输出、前台消息更新、上下文压缩或用户询问而重调入口；
- 不启动并行 watcher、第二 shell、第二 coordinator 或第二批次；
- 不把 `cell_id`、授权 UUID 或进程命令行写入仓库。

资格 UUID 仍只由执行阶段在内存中生成一次。仓库、审阅页、日志摘要和最终报告只保存其 SHA-256 身份，不保存明文。

### 5.3 等待与进度

- 每次 `functions.wait` 的 `yield_time_ms` 不超过 30,000；
- 每 30–60 秒至少向用户报告一次非秘密状态；
- 工具仍运行时，“没有新输出”只表示本轮无新输出，不是失败；
- 不使用超过 60 秒的阻塞等待；
- 可以只读检查 lock owner、checkpoint 序号、terminal 是否存在和目标进程计数；
- 不读取活动配置或模型输出正文；
- 不修改候选树。

### 5.4 cell 异常时的唯一处理链

如果 `functions.wait` 无法继续同一 cell：

1. 绝不再次调用资格入口；
2. 只读检查资格锁和 owner；
3. owner 身份仍存活时，只继续等待并观察 terminal，不执行 recovery；
4. owner 已死但目标进程非零时，继续等待其受控超时/退出，不执行 recovery；
5. owner 已死、目标进程为 0、terminal 缺失时，只允许对该 batch 执行一次现有 `--recover-interrupted`；
6. terminal 已存在时只验证，不发布第二终态；
7. 无法确认 owner、batchId、authorization hash 或目标进程时，fail closed 并请求人工判断。

该链路沿用现有锁与恢复协议，不新增 resume、retry 或 takeover。

## 6. 离线承载演练

演练使用固定的 105 秒本地 Node 程序：

- 第 0 秒输出 `started`；
- 每 15 秒输出一个递增 heartbeat；
- 第 105 秒输出第七个 heartbeat 和 `completed`；
- 不读环境秘密；
- 不访问网络；
- 不读取或写入仓库；
- 不启动子进程；
- 正常退出码为 0。

演练必须由与未来资格完全相同的外层 `functions.exec → tools.shell_command → functions.wait` 形态承载。直接运行该 Node 程序只能证明程序自身，不能证明承载机制。

该演练只证明当前 Codex 执行承载可跨越先前约 14 秒的前台工具超时，并能经多次 wait 重新进入同一执行单元；它不证明 execution cell 能无条件存活 4 小时。未来真实批次的长时持续性还依赖 active goal、4 小时内层预算、短周期 wait 和现有锁/终态恢复链。

报告只记录：

- 日期与 Codex thread；
- `exec` 首次 yield 是否成功；
- wait 周期数；
- started/heartbeat/completed 计数和顺序；
- 总持续时间区间；
- shell 退出码；
- 演练后进程、资格锁和目标进程状态。

报告不得记录环境变量值、用户目录、授权 UUID、模型输出或完整进程命令行。

## 7. 仓库改动边界

主方案不修改：

- `scripts/gate-requalification.ts`；
- `src/qualification/**`；
- `src/smoke/**`；
- `src/adapters/**`；
- `src/llms/registry.ts`；
- evidence、checkpoint、manifest 或历史文档正文。

预计只新增或修改：

- 本设计与对应实施计划；
- `docs/release/qualification-carrier-rehearsal.md`；
- `docs/release/four-llm-qualification-execution-runbook.md`；
- `docs/release/four-llm-qualification-reauthorization-review.html`；
- `package.json`；
- `src/release/assurance.ts`；
- `test/release/assurance.test.ts`；
- `scripts/release-smoke.mjs`；
- `README.md`、`docs/operations.md`、`docs/release/checklist.md`、`docs/smoke/ark.md`；
- `AGENTS.md`。

新再授权页使用新文件名，不覆盖已消费的历史授权页。历史结果页和 interrupted evidence 继续字节不变。

## 8. 验证与审阅

实施阶段至少执行：

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run smoke:release
npm.cmd run acceptance:plugin:isolated -- --check-report
npm.cmd run qualify:gates -- --help
npm.cmd run verify:qualification -- --help
git diff --check
git status --short
```

还必须：

- 重验最新 interrupted、上一代 blocked 和历史 five-llm 批次的 immutable evidence；
- 重验既有 5/5 与 14/14 历史 SHA/blob；
- 确认资格锁 absent；
- 确认 Kimi ACP、Pi RPC、real-smoke 为 0/0/0；
- 对新 HTML 做桌面与 390px 窄屏视觉检查；
- 对 package link closure、开发路径与 secret 扫描执行 release smoke；
- 由 Codex 自审并使用独立 Codex reviewer 完成规格与质量复核；
- `kimi-k3` 只做一次约 20k–30k 字符、单一问题的窄只读审阅尝试；超时或无正文不算 PASS、不重试同形任务，也不阻断由确定性证据和独立 Codex reviewer 已闭合的候选；
- 技术过滤外审结论，不直接照单全收。

## 9. 成功条件、停止条件与降级

### 9.1 下一轮成功

只有以下全部成立，下一轮才算完成：

- 105 秒承载演练通过；
- 无生产资格代码变化；
- 新运行手册和再授权页自洽、可打包、无秘密；
- 完整验证与隔离生命周期通过；
- 三代 evidence 继续不可变；
- clean frozen candidate 形成；
- 未发生任何真实资格调用；
- 向用户呈现精确冻结 SHA 和单一授权问题。

### 9.2 必须停止

- `exec` 未 yield、cell 无法由 `wait` 继续或演练出现残留；
- 为修复演练需要修改资格生产代码；
- package/review 文档闭包无法无歧义验证；
- evidence、活动配置或用户工作树出现漂移；
- 两次完全相同的承载演练以同一原因失败；
- 需要后台 supervisor、系统服务、计划任务或活动配置才能继续。

前四类问题允许在不跨边界的情况下诊断；最后两类进入新设计或人工判断，不在本计划内扩张方案。

## 10. 新授权边界

新再授权页和本设计都不是授权。下一轮完成后，用户必须明确同意：

- 精确 40 位 frozen commit；
- 一次且仅一次新的完整 `four-llm-v1` 八项批次；
- 固定风险优先顺序；
- 任一 failed / blocked / interrupted 立即停止；
- 不 retry、fallback、resume、跳项、拼接旧 evidence 或启动第二批。

该授权仍不包含活动安装、`config.toml` 访问、旧工具移除、Claude Code、发布或正式仓库 fast-forward。

## 11. 后续执行阶段 goal

用户确认本设计后，下一执行阶段应创建一个长期 goal，其目标是：

> 在 `D:\Codes\codex-agent-tools\.worktrees\gemini-retirement` 中，仅实施资格长时承载的无网络演练、执行手册、新再授权审阅页、package 闭包和完整离线/隔离验收；保持资格生产代码、历史 evidence、活动配置、活动插件、旧工具、Claude Code、正式工作树与发布状态不变；形成 clean frozen candidate 后停止，绝不生成授权 UUID或运行真实资格入口，并向用户请求针对精确冻结提交的单独授权。

该 goal 达成后关闭。真实八项批次必须由另一份用户明确授权启动，不能把“确认本设计”“继续实施”或 goal 完成自动解释为资格授权。
