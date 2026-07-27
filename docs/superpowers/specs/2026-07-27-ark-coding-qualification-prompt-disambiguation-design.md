# Ark Coding Plan 资格提示词消歧与后续替代路线设计

日期：2026-07-27

状态：设计已获用户确认；逐任务实施计划已建立，离线执行已获授权

## 1. 决策摘要

下一阶段采用最小修复路线：修复 Ark Coding Plan delegate 资格夹具中期望结果与自然语言标点相邻的歧义，保持结果文件、命令、模型身份、网络、凭据、单次执行和进程清理验收全部严格不变，然后重新冻结候选。

离线修复与确定性验证完成后，项目停在真实模型调用之前。新的 `four-llm-v1` 完整八项资格批次、活动插件安装、旧 `codex_cc_tools` 移除和公共发布分别属于后续独立授权边界。

本设计取代 [Gemini 退役与四模型资格认证设计](2026-07-26-gemini-retirement-and-four-llm-qualification-design.md) 中对 Ark Coding Plan delegate 内容失败原因的旧推测，但不改写该设计已经完成的 Gemini 退役、四模型协议和历史证据边界。

## 2. 当前事实与阻断点

当前活动产品面固定为：

| 逻辑 LLM | 运行时 | provider / 模型 | 网络 |
| --- | --- | --- | --- |
| `kimi-k3` | Kimi Code ACP | `kimi-code/k3` | direct |
| `ark-coding-plan` | Pi RPC | `ark-coding-plan` / `ark-code-latest` | direct |
| `ark-agent-plan` | Pi RPC | `ark-agent-plan` / `ark-code-latest` | direct |
| `ark-agent-deepseek-v4-flash` | Pi RPC | `ark-agent-plan` / `deepseek-v4-flash` | direct |

公开 MCP 仍为 `codex_external_agents`，只公开 `external_review` 和 `external_delegate`，两者的 `llm` 始终必填。当前八项 review/delegate 能力为 6 passed / 2 pending，只有 Ark Coding Plan 成对 pending；安装状态保持 `blocked / not ready`。

冻结候选 `b57382ed4f2fddce4946613b5aa5739c6eed5c8f` 上唯一获授权的 `four-llm-v1` 批次为：

`2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d`

批次在第一项 Ark Coding Plan delegate 以 `acceptance_failed` 停止，后七项均未运行。该次授权已经消费；没有 retry、fallback、resume、跳项或第二批。

## 3. 根因证据

### 3.1 提示词中的确定性歧义

`src/smoke/pi.ts` 当时把两项强制动作写在同一个自然语言句子中，其中第一项末尾为：

```text
... with exactly one line: ARK_SMOKE_OK:ark-coding-plan; (2) invoke ...
```

分号是自然语言分隔符，但与要求模型精确写入的目标字符串紧邻。现有测试只断言提示词包含“两项均必做”和 `git status --short`，没有约束期望内容后的分隔边界。

### 3.2 双哈希反推

schema v3 case evidence 没有保存文件正文，但保存了足以做确定性复核的脱敏字段：

| 字段 | evidence 值 |
| --- | --- |
| `resultFileByteLength` | `30` |
| `resultFileNormalizedLineCount` | `1` |
| `expectedResultNormalizedSha256` | `4cf493d60030fed3f4936d1ad56df60e0352025fd992aaf789ae15bc4f40d32c` |
| `resultFileRawSha256` | `5c3ae3a993f9b1cf485f886e3f02c6dcebb321e39351c2accef9e6eb509c8b74` |
| `resultFileNormalizedSha256` | `0555faa8158199923b4d16e2d74e3a54b42bff3bdf2fb63388e2877f465a2b20` |

本地只读复算得到：

- `SHA-256("ARK_SMOKE_OK:ark-coding-plan;")` 精确等于记录的 normalized SHA-256；
- `SHA-256("ARK_SMOKE_OK:ark-coding-plan;\n")` 精确等于记录的 raw SHA-256；
- 该原始内容恰为 30 bytes、规范化后恰为一行。

在可忽略 SHA-256 碰撞的工程前提下，失败文件可以确定为目标字符串后多了提示词中紧邻的分号。路由、模型身份、凭据隔离、唯一预期文件、必需命令、单次调用 telemetry 和进程清理在同一 evidence 中均通过。

因此当前证据不支持更换 provider、模型、endpoint、凭据、网络策略或增加 retry/fallback，也不支持放宽结果验收。需要修复的是资格夹具的表达边界。

## 4. 方案比较

### 方案 A：修复夹具歧义并重新完整认证（采用）

用独立、可复制的精确写入命令表达结果文件要求，使目标 payload 不再与自然语言标点相邻；严格验收保持不变。完成离线验证后，再在新授权下从第一项开始运行完整八项批次。

该方案改动最小，保留两个 Ark Plan 额度池，也最符合现有证据。

### 方案 B：退役 Ark Coding Plan，收缩为三模型六能力

只有在消歧后的新完整批次仍在同一内容层失败时才考虑。该方案可缩小稳定性表面，但会失去独立 Coding Plan 额度池，并偏离用户此前保留两条 Ark Plan 路线的目标。

转入方案 B 必须先形成并确认新的三模型/六能力设计。任何真实六项资格批次还必须取得另一份明确授权，不能复用失败八项批次的授权、证据、冻结提交或构建身份。

### 方案 C：长期维持 blocked

保留三个已通过 LLM 和 pending Ark Coding Plan，不安装新插件，继续使用旧工具。风险最低，但不能实现 Pi/Kimi 对现有 cc tools 的完整替代。

不采用“带 pending 能力直接安装”或“只补跑 Ark 后拼接旧证据”的折中方案。两者都会破坏已经建立的同批资格语义。

## 5. 离线修复设计

### 5.1 提示词合同

delegate 资格提示词必须：

1. 把结果文件写入表达为独立、可复制的精确命令；
2. 使期望 payload 与任何自然语言标点、编号和后续说明物理分离；
3. 明确文件规范化后只能等于目标行；
4. 继续要求通过 bash 工具执行精确的 `git status --short`；
5. 不要求模型自行推断引号、换行或句子分隔符是否属于 payload。

实现计划应在 Windows 主机与 Pi bash 工具边界上选择可确定转义的命令形式，并由测试从生成后的完整提示词中解析和验证该命令，而不是只做宽松的 `contains` 断言。

### 5.2 验收合同保持不变

以下行为不得因消歧而放宽：

- 安全文件读取仍使用现有普通文件、identity、大小、UTF-8 和 bounded-read 校验；
- 规范化内容仍必须精确等于期望行；
- 带分号、说明文字、多行、非法 UTF-8 或超限内容仍失败；
- `commandsRun` 仍必须包含精确 `git status --short`；
- 工作区只能出现预期结果文件；
- review 写工具禁令、模型/provider/route/credential 身份、single-attempt telemetry 与进程清理语义不变。

### 5.3 测试边界

所有行为变化使用 RED → GREEN → REFACTOR。至少覆盖：

- 当前提示词中 `expectedLine;` 相邻形式的回归失败；
- 新提示词中的精确写入命令可被无歧义解析；
- 目标 payload 后没有自然语言分隔标点；
- validator 继续拒绝目标行尾部分号；
- 原有命令观察、文件范围、环境隔离、telemetry 和清理断言继续通过；
- Kimi 与三个 Ark 逻辑 LLM 的其它行为没有漂移。

现有 batch、case evidence、manifest、checkpoint 和历史 Gemini evidence 均保持字节不变。

## 6. 候选冻结与验证

离线修复完成后必须 fresh 运行：

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated -- --check-report
npm run qualify:gates -- --help
git diff --check
git status --short
```

还必须：

- 重验既有新批次 5/5 文件哈希；
- 重验历史 Gemini 14/14 SHA-256 与对应基线 blob；
- 确认 Kimi ACP、Pi RPC 和 real-smoke 目标进程均为零；
- 完成独立规格与代码质量复核；
- 形成新的 clean-tree 冻结提交；
- 在冻结后停止，不运行真实 smoke 或资格批次。

`four-llm-v1` 继续表示固定四模型八项日程。提示词和构建产物由新的 frozen commit 与 frozen build identity 区分，因此本次夹具修复不新建 `four-llm-v2`，也不修改历史 codec。

## 7. 新资格批次边界

新的真实资格批次必须取得针对该次执行的明确授权。授权只允许启动一次新的完整 `four-llm-v1` 批次：

1. Ark Coding Plan delegate
2. Ark Coding Plan review
3. Kimi K3 review
4. Kimi K3 delegate
5. Ark Agent Plan review
6. Ark Agent Plan delegate
7. Ark Agent DeepSeek V4 Flash review
8. Ark Agent DeepSeek V4 Flash delegate

仍执行以下停止线：

- 第一项本身就是 Ark Coding Plan 的 canary，不额外运行 standalone Ark canary；
- 任一 failed / blocked / interrupted 立即形成终态；
- 后续项标记为 not run；
- 不 retry、fallback、resume、跳项、复用旧 evidence 或启动第二批；
- 只有同批 8/8 passed 才能成对晋级 Ark Coding Plan。

若修复后的第一项仍以相同内容层失败，本路线停止，不继续通过提示词微调反复消耗额度；下一步转入方案 B 的独立设计。

## 8. 通过后的 `ready` 状态

同批 8/8 passed 后才允许：

1. 通过 frozen-candidate 与 immutable-evidence verifier；
2. 用 TDD 将 Ark Coding Plan review/delegate 成对晋级；
3. 将当前状态更新为 8 passed / 0 pending；
4. fresh 重跑完整确定性验证和隔离官方插件生命周期；
5. 完成最终只读复核；
6. 把真实安装审阅包更新为 `ready`。

`ready` 只表示可以提交活动安装权限包，不表示插件已安装。

## 9. 正式仓库与真实安装

当前长期正式工作树 `D:\Codes\codex-agent-tools` 仍停留在 `codex/ark-cutover` 的较早干净提交；本轮候选位于可清理的隔离 worktree。活动安装前必须：

1. 执行时重新确认长期正式工作树 clean、当前分支正确，且其 HEAD 是最终 `ready` 提交的祖先；
2. 只允许以可审计的 pure fast-forward 方式收敛；若 ancestry、分支或 clean 条件不成立，立即停止，不 merge、reset、强制切换或覆盖用户改动；
3. 从正式工作树的精确提交重新构建，重跑第 6 节完整命令组和隔离官方插件生命周期；
4. 以正式仓库路径作为本机 marketplace 来源，不使用 `.worktrees/...` 临时路径；
5. 单独取得覆盖官方 marketplace add、plugin add、真实 Codex App 宿主验收和失败回滚 remove 的明确授权。

项目、维护者和自动化均不得直接读取、比较、备份、写入或恢复活动 `~/.codex/config.toml`。真实安装只通过 Codex 官方插件机制进行；本设计不授权任何活动安装动作。

## 10. 完全替代旧工具

真实宿主验收通过后，新旧工具先共存。共存状态没有自动到期时间；旧工具移除的独立设计必须先定义最小真实调用覆盖、未解决故障门槛、取消与进程清理证据以及停止条件，满足这些条件并准备独立权限包后才能讨论完全替代：

1. 只通过官方状态/列表或插件管理能力识别旧 `codex_cc_tools` 的实际管理方式；
2. 如果不能在不读取或编辑活动 `config.toml` 的前提下证明存在可逆的官方移除与恢复路径，立即停止并保持共存；
3. 准备写明精确官方机制的移除与恢复方案；不得把手工 TOML 编辑作为临时回退；
4. 取得专门针对旧工具移除及失败恢复的明确授权；
5. 使用已经取证的官方机制移除旧工具，不卸载、修改或重配置本机 Claude Code；
6. 在重启或新会话中验证：
   - `codex_external_agents` 可发现；
   - `external_review` / `external_delegate` 正常；
   - `llm` 仍必填；
   - 旧命名空间消失；
   - 代表性 Kimi/Pi review、隔离 delegate、取消和进程清理通过；
7. 失败时只通过权限包预先列明的官方机制恢复旧工具。

本机完全替代不依赖 npm 发布。npm 或公共 marketplace 发布继续后置，并需要单独明确授权。

## 11. 授权矩阵

| 动作 | 当前设计确认是否足够 |
| --- | --- |
| 文档终态闭合、提示词消歧、TDD、确定性验证 | 是 |
| 临时 `CODEX_HOME` 隔离生命周期 | 是 |
| 子代理只读规格/质量复核 | 是 |
| 新候选冻结 | 是 |
| 新一次真实八项资格批次 | 否，需新的明确授权 |
| 方案 B 的真实六项资格批次 | 否，需先确认新设计并取得另一份明确授权 |
| `ready` 后正式仓库 pure fast-forward、重建与隔离复验 | 是，但必须满足 clean / branch / ancestry 前置检查 |
| 活动 marketplace/plugin add 与失败 remove | 否，需独立明确授权 |
| 旧 `codex_cc_tools` 移除与恢复 | 否，需独立明确授权 |
| npm 或公共 marketplace 发布 | 否，需独立明确授权 |
| 直接访问活动 `config.toml` | 不在当前路线内 |

## 12. 非目标

- 不改变公开 MCP、工具名或 `llm` 必填合同；
- 不加入 Claude Code、Anthropic Claude、Codex/OpenAI 或独立 DeepSeek 后端；
- 不改变 Ark endpoint、模型、凭据优先级、direct 网络或额度池；
- 不放宽结果文件、命令、工作区、telemetry 或进程清理验收；
- 不增加资格 retry、fallback 或自动恢复；
- 不修改既有 evidence；
- 不运行真实资格批次、活动安装、旧工具移除或公共发布；
- 不访问活动 Codex 或 Pi 日常配置。
