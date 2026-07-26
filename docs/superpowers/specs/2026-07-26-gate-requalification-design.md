# 十门禁原子重认证设计

日期：2026-07-26

状态：已获用户批准，待外部审阅与实施

## 1. 目标

在不改变五个逻辑 LLM、固定后端、固定模型和固定网络路由的前提下，补齐真实模型门禁的诊断证据与批次一致性，然后只执行一次新的十门禁资格认证：

- `kimi-k3`：review、delegate
- `gemini-3.5-flash`：review、delegate
- `ark-coding-plan`：review、delegate
- `ark-agent-plan`：review、delegate
- `ark-agent-deepseek-v4-flash`：review、delegate

只有同一批次的十项门禁全部通过，内置注册表、文档和真实插件安装审阅状态才可一起晋升。任何失败都保持 `blocked / not ready`。

## 2. 已知事实与根因边界

2026-07-25 的原始结果是 8 passed / 2 failed；执行成对晋升规则后，注册表是 6 passed / 4 pending。

### 2.1 Ark Coding Plan delegate

现有 evidence 证明：

- 真实路由、provider、模型和环境身份正确；
- 正确文件名已落盘，且只观察到预期文件变更；
- 模型任务正常结束，进程清理检查通过；
- 唯一失败项是结果文件内容不满足严格期望。

现有 evidence 没有保存结果文件的字节长度、哈希、编码/读取状态或实际命令清单，临时工作区也已删除。因此无法区分空文件、错误逻辑 ID、额外文本、引号、编码差异或读取异常。

同一 Coding 路线在 2026-07-20 通过，同一模型经 Agent Plan 在 2026-07-25 通过。当前置信度最高的假设是一次上游内容契约/指令遵循偏差，而不是 smoke 检查串线。该假设不足以授权改 prompt、放宽验收、增加重试或改路由。

### 2.2 Gemini delegate

失败被稳定分类为 `google_free_tier_quota`。doctor 只能证明凭据变量存在，不能查询或保证 Google 免费层当前额度；不消耗真实生成请求就无法预先确认额度已经恢复。

Pi adapter 当前对 Gemini review 的特定免费层限流可做一次延迟重试，但 delegate 不重试。现有 evidence 未记录调用次数，因而无法证明资格认证要求的“恰好一次、无重试、无 fallback”。

## 3. 方案比较

### 方案 A：先增强证据，再执行原子化全量重认证（采用）

优点：

- 下一次失败能够落到可复核的非敏感事实，而不是再次只得到一个布尔值；
- 能机器证明每项只有一次外部调用，没有 adapter 重试或替代模型；
- 同一批次固定代码、构建产物和运行条件，避免拼接证据；
- 不改变产品模型面或验收标准。

代价：需要先实现并验证一小段资格认证基础设施。

### 方案 B：直接重跑十项（不采用）

实现成本低，但 Ark 若再次失败仍无法解释；Gemini review 即使通过也无法证明没有内部重试；十项之间也没有原子批次身份。它重复消耗额度，却没有修复当前证据缺口。

### 方案 C：缩减产品面、允许重试或 fallback（不采用）

这会改变用户已确认的五模型产品边界或门禁含义，需要新的用户决策。当前证据不支持主动做这种范围变更。

## 4. Evidence v2

### 4.1 委派结果文件诊断

在保留 `resultFileObserved` 与严格 `resultFileValid` 的同时，为 delegate evidence 增加以下非敏感字段：

- `resultFileReadStatus`：仅允许 `read`、`missing`、`invalid_utf8`、`read_error`；
- `resultFileByteLength`；
- `resultFileRawSha256`；
- `resultFileNormalizedSha256`；
- `expectedResultNormalizedSha256`；
- `resultFileNormalizedLineCount`；
- `resultFileContainsExpectedLine`。

规范化只用于诊断和明确记录，严格验收语义保持为当前期望文本比较，不因新增字段而放宽。哈希计算原始字节和规范化文本；无法读取时用明确状态并省略不成立的派生值。

不得保存：

- 文件原文或原始模型长输出；
- 凭据值、完整子进程环境；
- 会话 ID；
- 可能含用户数据的工具参数或工具返回值。

### 4.2 命令证据

`requiredCommandObserved` 必须证明捕获的命令中存在精确的 `git status --short`，不能继续用“执行过任意命令”代替。evidence 只保存该布尔结论和既有命令计数，不保存完整命令清单。

### 4.3 单次调用证据

每项 evidence 增加：

- `attemptCount`；
- `retryCount`；
- `fallbackUsed`。

资格认证 smoke 必须得到 `1 / 0 / false`，否则该项失败。Pi 资格认证入口显式禁用 Gemini review 的 adapter 重试；生产环境是否保留现有有界只读重试不由本设计改变。

如果 Pi RPC 自身报告自动重试事件，必须计入 `retryCount` 并使资格认证失败。不能只统计 adapter 顶层循环。

## 5. 原子资格认证批次

新增一个批次协调器和原子写入的脱敏批次 manifest。manifest 至少固定：

- 新生成的 `batchId`；
- Git commit、dirty 状态；
- package 版本与 lockfile SHA-256；
- 构建产物身份；
- Node、Codex、Kimi、Pi 版本；
- Pi 隔离配置 SHA-256；
- 五条固定逻辑 LLM 身份；
- 仅凭据变量名的命中结果，不保存值；
- 每项 evidence 路径、SHA-256、结果、调用次数；
- 批次最终状态、停止原因和未执行项目。

批次开始前必须：

1. 锁定仓库级排他文件；已有活动批次时 fail closed。
2. 要求工作树干净并冻结 commit。
3. 重新通过类型检查、全量测试、构建、release smoke、diff check 和隔离插件生命周期。
4. 验证 10808 本地监听和固定路由配置；这不等价于证明 Gemini 额度可用。
5. 对 Kimi Code、Pi RPC 和本项目真实 smoke 进程取得全机快照，并要求目标进程基线为零。
6. 记录本次由当前会话用户“继续”授权的一次不确定额度资格认证动作；只记录脱敏授权种类与时间，不保存对话原文。

批次执行过程中：

- 严格串行；
- 每项结束后独立做进程快照，要求相对基线无新增且绝对目标进程仍为零；
- 每项只允许一次外部模型尝试；
- 不使用 fallback；
- 每个 evidence 必须带相同的 `batchId`、commit 和构建身份；
- manifest 通过同目录临时文件加原子替换持续更新，以便异常中断后仍可审计。

建议的 fail-fast 顺序：

1. Gemini delegate；
2. Gemini review；
3. Ark Coding Plan delegate；
4. Ark Coding Plan review；
5. Kimi K3 review；
6. Kimi K3 delegate；
7. Ark Agent Plan review；
8. Ark Agent Plan delegate；
9. Ark Agent DeepSeek V4 Flash review；
10. Ark Agent DeepSeek V4 Flash delegate。

前四项优先验证两个历史阻断来源，避免在已知高风险项失败后继续消耗其余额度。

任一项失败或基础设施异常时：

- 立即停止剩余项目；
- manifest 写为 `blocked`，保留已完成 evidence、失败原因和未执行清单；
- 不晋升任何 pending 能力；
- 后续若重新授权重入，必须创建新批次并从十项第一项开始，不能复用或拼接本批次通过项。

## 6. 成功与失败的状态转换

### 全部通过

只有十项在同一批次全部得到新的 `passed` evidence，才执行：

1. 成对晋升 Gemini 与 Ark Coding Plan；
2. 更新三份 smoke 索引、注册表、README、运维文档和发布清单；
3. 把 `docs/release/real-plugin-install-review.md` 重新编写并独立审阅为 `ready`；
4. 再次完成确定性验证与只读外部审阅；
5. 停止并向用户提交真实安装前的最小充分审阅材料。

即使全部通过，也不得在本阶段执行真实 marketplace/plugin add/remove。

### 任一失败

保持注册表和安装审阅包为 `blocked / not ready`，只更新：

- 新批次 manifest；
- 新 evidence 与哈希索引；
- 当前阻断事实；
- 下一次必须由用户决定或重新授权的范围。

不因单项通过、旧 evidence、同 provider 的其它模型或其它逻辑 LLM 通过而降级阻断。

## 7. 实施与审阅方式

- 行为代码使用 TDD。
- 在当前独立仓库和 `codex/ark-cutover` 分支工作；不再建立嵌套 worktree。
- 每个行为任务由独立子代理实现，随后做规格审阅、质量审阅和主代理验证。
- 设计与最终状态仅使用当前已资格化的 `kimi-k3` 和 `ark-agent-plan` 做只读外部审阅；Codex 负责反驳、合并和最终裁决。
- 真模型调用只允许出现在一次资格认证批次及其明确的只读设计/代码审阅中；不以调试为名循环试错。

## 8. 明确不做

- 不读取、写入、备份或恢复活动 `~/.codex/config.toml`；
- 不调用、修改或卸载 Claude Code；
- 不调用或修改现有 `codex_cc_tools`；
- 不改变五个逻辑 LLM、固定模型、固定 provider 或网络路由；
- 不放宽 review/delegate 验收；
- 不执行真实插件安装、卸载、发布或旧工具移除；
- 不把当前用户的“继续”解释为未来真实安装授权。
