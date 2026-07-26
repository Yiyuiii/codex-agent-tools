# 十门禁原子重认证设计

日期：2026-07-26

状态：已获用户批准，已完成设计审阅收敛，待实施

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
- 能机器证明本项目 adapter、运行时明示事件和协调器可观测层内只有一次 client 调用，没有可见重试或替代模型；
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

检查器先用 `lstat` 拒绝符号链接、目录和其它非普通文件，并在读取前执行 64 KiB 上限；随后打开 file handle，用 `fstat` 核对文件类型、identity 与长度没有在 `lstat`/open 之间漂移，只通过该 handle 读取，并在读取后再次 `fstat`。任何 identity/type/size 漂移都 fail closed，不能让路径替换把工作区外文件哈希进 evidence。随后计算原始哈希，再用 fatal UTF-8 decoder 解码。非法 UTF-8 仍可记录原始长度与哈希，但不生成规范化字段。规范化只用于诊断和明确记录，严格验收语义保持为当前 `decoded.trim() === expectedLine`，不因新增字段而放宽。无法读取时用明确状态并省略不成立的派生值。

不得保存：

- 文件原文或原始模型长输出；
- 凭据值、完整子进程环境；
- 会话 ID；
- 可能含用户数据的工具参数或工具返回值。

### 4.2 命令证据

`requiredCommandObserved` 必须证明捕获的命令中存在精确的 `git status --short`，不能继续用“执行过任意命令”代替。evidence 只保存该布尔结论和既有命令计数，不保存完整命令清单。

### 4.3 单次调用证据

每项 evidence 增加以下可观测统计：

- `adapterClientInvocationCount`；
- `adapterRetryCount`；
- `runtimeReportedAutoRetryCount`；
- `adapterReportedFallbackUsed`；
- `orchestratorFallbackUsed`；
- `executionTelemetrySource`，固定说明该 runtime 的可观测来源与边界。

资格认证 smoke 与协调器必须合计得到 `1 / 0 / 0 / false / false`，否则该项失败。该结论只覆盖本项目 adapter client 调度、Kimi ACP 可见的 session/prompt 路径、Pi RPC 明示重试/模型事件和协调器 profile 选择；它不声称能观察 provider 服务端或底层 SDK 未上报的内部 HTTP 重试或 fallback。

Pi 资格认证入口在 prompt 前显式发送 `set_auto_retry=false` 与 `set_auto_compaction=false`，并在隔离 settings 中把 provider retry 上限钉死为 0；同时禁用 Gemini review 的 adapter 外层重试。生产环境是否保留现有有界只读重试不由本设计改变。

Pi RPC 报告的 `auto_retry_start/end`、`agent_end.willRetry` 和 `compaction_end.willRetry` 必须被交叉核对并聚合为整数，不能重复计数同一次重试，也不能把可能含上游错误正文的原始事件写入 evidence。Kimi 记录已提交的 ACP prompt 调用；当前 ACP 没有可依赖的重试事件，因此 evidence 必须明确该可观测边界。

适配器在调用是否已经触达外部模型不确定时，统计必须为 `null` 并使资格认证失败，不能伪造 `0 / 0 / false`。这些统计只通过内部 observer 传给 smoke，不改变公开 MCP 结果 schema。

## 5. 原子资格认证批次

“原子”不表示十次真实调用可事务回滚；已经发生的调用和额度消耗不可撤销。本设计保证的是同一批次身份、不可变证据、失败即停，以及注册表/发布状态的 all-or-none 晋升。

新增一个批次协调器、不可变递增 checkpoint 和只发布一次的脱敏终态 manifest。manifest 至少固定：

- 新生成的 `batchId`；
- Git commit、dirty 状态；
- package 版本与 lockfile SHA-256；
- 构建产物身份；
- Node、Codex、Kimi、Pi 版本；
- Pi 隔离配置 SHA-256；
- 五条固定逻辑 LLM 身份；
- 仅凭据变量名的命中结果，不保存值；
- 每项 evidence 路径、SHA-256、结果和五项可观测调用统计；
- 批次最终状态、停止原因和未执行项目。

批次目录位于 `docs/smoke/evidence/batches/<batchId>/`：每个 checkpoint 和 case evidence 都通过既有的“同目录排他临时文件 + hard link”机制发布，不能覆盖；终态 `manifest.json` 也只能发布一次。运行中不持续替换同一个文件，从而避免 Windows 覆盖语义和崩溃窗口。

这里的“不可变”是本项目发布协议的排他、只追加语义：它能阻止发布器覆盖既有目标，并通过互相引用的 SHA-256 发现非一致篡改或损坏；它不是数字签名、外部时间戳或仓库外信任锚，不能证明来源真实性，也不能抵抗拥有同等文件写权限的进程一致重写 evidence、checkpoint、manifest 及其全部引用。后续 verifier 和审阅材料必须明确这一威胁边界，不得把磁盘内哈希重算夸大为对同权限恶意重写的鉴真。

批次开始前必须：

1. 在系统临时目录以仓库 realpath 的 SHA-256 为身份取得排他锁目录；锁记录 PID、进程启动时间、owner nonce、batchId、授权引用 SHA-256 和取得时间。临时目录、固定锁根和仓库哈希目录在取得、读取、恢复与释放时都必须以 `lstat`、`realpath` 和直接父子 containment 复验，拒绝 junction/symlink 祖先；Windows 合法的短路径/长路径规范别名不能被误判为逃逸。
2. 要求源码工作树干净并冻结 commit。
3. 重新通过类型检查、全量测试、构建、release smoke、diff check 和隔离插件生命周期。
4. 再次确认工作树干净、commit 未变，并冻结构建 identity；此后工作树只允许新增当前批次目录。
5. 验证 10808 本地监听和固定路由配置；这不等价于证明 Gemini 额度可用。
6. 对 Kimi Code、Pi RPC 和本项目真实 smoke 进程取得边界快照，并要求目标分类基线为零。只持久化分类计数和布尔结论，不保存全机命令行、PID 清单或无关进程信息。
7. 所有 preflight 均通过后、任何真实调用前，先发布不可变 `batch_started` checkpoint，记录本次由当前会话用户“继续”授权的一次不确定额度资格认证动作；只记录脱敏授权种类、唯一引用 SHA-256 与时间，不保存对话原文。相同授权引用不能启动第二批，复用检查必须扫描终态 manifest、未完成 checkpoint 和 live/stale lock owner。

在 `batch_started` 发布前，协调器不得创建批次目录或修改任何 tracked source/doc；preflight 只可重建预期的 gitignored 构建产物，隔离生命周期以 check-only 模式比较报告而不写 tracked 报告。普通 preflight 失败只返回脱敏错误并释放自己的锁，不发布 batch manifest，也不消费授权；若进程崩溃留下 stale owner，则恢复流程保守发布 `interrupted` 记录并把该授权引用视为已消费。

锁只能排除遵守本协调器协议的并发批次，边界快照也不能证明两个采样点之间绝无极短进程；文档和 manifest 不得夸大为全系统互斥证明。遇到已有锁时：

- owner 仍存活：fail closed；
- owner 已死亡：不得继续旧批次；
- 只有显式恢复入口在确认目标进程分类均为零后，才可根据不可变 checkpoint/evidence 把没有合法终态 manifest 的旧批次发布为 `interrupted` 并释放 stale 锁；若终态 manifest 已合法发布而只差释放锁，恢复入口只验真该终态后释放，不得再发布第二个终态；
- 新批次仍需新的授权引用，并从十项第一项开始。

批次执行过程中：

- 严格串行；
- 每项调用前先发布含 `running`、ordinal、LLM、task、时间戳和固定身份的不可变 checkpoint；
- 每项结束后独立做边界进程快照，要求目标分类绝对计数仍为零；
- 每项只允许一次 adapter client 调用、零 adapter 重试、零运行时明示重试、零 adapter/runtime 明示 fallback 和零协调器 fallback；
- 每个 evidence 必须带相同的 `batchId`、commit 和构建身份；
- evidence 验真后再发布该项的 `passed` 或 `failed` checkpoint；
- 任一时刻崩溃都按最新不可变 checkpoint 与 case evidence 推导为 `interrupted`，绝不续跑。

若 `running` 之后恰好一份 case evidence 已排他落盘、但在 completion checkpoint 前被判为旧 schema、JSON 损坏、身份或 telemetry 不合法，终态不得采信其正文、结果或观测统计，也不得因此永久卡死批次。受控基础设施异常写为 `blocked`，进程崩溃恢复写为 `interrupted`；两者只在 `uncommittedEvidence` 中保存固定 running identity、受限仓库相对路径、原始文件 SHA-256、`validationStatus: "invalid"` 和固定基础设施失败类别，所有不可信观测值为 `null`。它不进入 completed cases，不能参与晋升；多份、未配对、路径异常或无法安全有界读取的文件仍 fail closed。

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
- manifest 写为 `blocked`，保留已完成 evidence、失败原因、可观测调用统计和未执行清单；
- 不晋升任何 pending 能力；
- 后续若重新授权重入，必须创建新批次并从十项第一项开始，不能复用或拼接本批次通过项。

## 6. 成功与失败的状态转换

### 全部通过

只有十项在同一批次全部得到新的 `passed` evidence，才执行：

1. 运行独立的冻结候选验证器：只从磁盘重读 manifest、十份 evidence、冻结 preflight record 和构建产物，重新计算全部 SHA-256，并核对当前 HEAD、batchId、commit、package/lockfile、Pi 配置、固定逻辑身份、运行时/凭据名称记录、构建身份、固定模型/provider/route、门禁结果和 `1 / 0 / 0 / false / false`；任何不一致都 fail closed。
2. 成对晋升 Gemini 与 Ark Coding Plan。
3. 更新三份 smoke 索引、注册表、README、运维文档和发布清单。
4. 把 `docs/release/real-plugin-install-review.md` 重新编写并独立审阅为 `ready`。
5. 晋升修改发生后，使用第二种 immutable-evidence verifier 重新校验不可变 manifest/evidence/checkpoint 及其原始冻结身份，但不要求新构建产物等于晋升前构建；新源码、registry、bundle 与隔离生命周期由 fresh 类型检查、测试、构建和 acceptance 独立验证。最终构建后再运行一次 immutable-evidence verifier。
6. 再次完成只读外部审阅。
7. 停止并向用户提交真实安装前的最小充分审阅材料。

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

## 8. 设计审阅记录

- 独立 Ark 根因审计确认历史 evidence 只能支持“正确文件名下内容不符”，不能支持产品行为修复；假 adapter 重放复现同一布尔组合。
- 独立资格策略审计发现 Gemini review 的 adapter 重试与 Pi 明示自动重试事件未进入 evidence，促成可观测统计、零基线和 fail-fast 批次设计。
- 独立实现审计进一步收窄“原子”“一次调用”“零进程”的可证明边界，并给出不可变 checkpoint、stale 锁恢复和受控工作区差异方案。
- Kimi K3 聚焦只读审阅成功完成且 `filesChanged=[]`，独立命中四项实质问题：可观测重试边界、调用前 `running` checkpoint、崩溃锁恢复、晋升前磁盘验真和进程快照脱敏；均已吸收。
- Ark Agent Plan 聚焦只读审阅保持 `filesChanged=[]`，但 Pi RPC 在形成正文前因输出管道 `EPIPE` 失败；该次不计审阅通过，也没有提供可吸收结论。

## 9. 明确不做

- 不读取、写入、备份或恢复活动 `~/.codex/config.toml`；
- 不调用、修改或卸载 Claude Code；
- 不调用或修改现有 `codex_cc_tools`；
- 不改变五个逻辑 LLM、固定模型、固定 provider 或网络路由；
- 不放宽 review/delegate 验收；
- 不执行真实插件安装、卸载、发布或旧工具移除；
- 不把当前用户的“继续”解释为未来真实安装授权。
