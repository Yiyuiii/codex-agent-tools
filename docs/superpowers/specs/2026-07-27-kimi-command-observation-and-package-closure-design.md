# Kimi 资格命令观测与发布包闭包设计

> 历史状态说明（2026-07-28）：本文记录的逐批人工授权停点已被 [standing authorization](2026-07-28-standing-experiment-authorization-design.md) 覆盖；Kimi exact validator、同批 no-retry/no-resume 和 package 闭包要求保持不变。

## 状态与授权

本设计在 2026-07-27 由用户批准按推荐方案 A 继续收敛。批准范围包括：

- 强化 Kimi delegate 资格提示词；
- 在 Kimi ACP 事件链中保留协议允许晚到的工具字段；
- 增加不含命令正文的来源/匹配分类；
- 保持严格命令 validator；
- 修复资格承载文档的 npm package 闭包和包内链接检查覆盖；
- 通过 TDD、独立审阅、完整离线/隔离验证并重新冻结候选。

本设计不授权新的真实 LLM 资格批次、活动 Codex 插件安装或升级、活动 `~/.codex/config.toml` 访问、`codex_cc_tools` 移除、Claude Code 调用或修改、npm 发布、推送、合并或正式工作树 fast-forward。

## 背景与可证事实

最新 `four-llm-v1` 批次 `2026-07-27T10-08-39.404Z-3d2f7d30-45a6-43c1-9bd6-09a7557285fa` 在 ordinal 4 Kimi delegate 阻断。Kimi 的固定模型、direct 路由、14-byte 单行结果文件、唯一文件变更、进程清理和 `1 / 0 / 0 / false / false` telemetry 都正确；唯一失败检查是 `requiredCommandObserved=false`。

现有 evidence 只保存 `commandCount=1`，不保存命令正文。它只能证明桥接层提取出的唯一命令字符串不与 `git status --short` 完全相等，不能证明模型省略了命令，也不能证明模型把命令合并进了另一条命令。

当前实现存在两个确定事实：

1. `src/tasks/service.ts` 只从 `tool_call` 读取 `rawInput.command`，缺失时回退到人类可读的 `title`。
2. ACP 1.2.1 明确允许 `tool_call_update` 更新 `kind`、`title` 和 `rawInput`，但 `src/adapters/kimi/client.ts` 当前只保留 update 的 `status`。

这两个事实说明观测链有歧义，但不能反向证明最新真实批次的具体命令内容。

独立的发布包审计还确认：当前 npm package 内有 13 份 Markdown/HTML。README、运维文档、发布清单和 Ark 状态页的缺失本地链接全部指向：

- `docs/release/qualification-carrier-rehearsal.md`
- `docs/release/four-llm-qualification-execution-runbook.md`

这两份文档自身只链接当前已打包文件，因此把它们纳入 package 后不会引出新的级联依赖。

## 方案比较与结论

### 方案 A：提示词强化、脱敏观测和全包链接闭包

这是已批准方案。

- 用两个独立工具调用表达“写文件”和“执行精确状态检查”。
- 保持 `commandsRun.includes("git status --short")` 不变。
- 按 ACP tool-call ID 合并协议允许晚到的工具字段。
- 只在 evidence 中保存来源与匹配类别，不保存命令正文。
- 把两份承载文档纳入 npm package，并检查全部已打包 Markdown/HTML。

优点是既不降低资格标准，也能在下一次失败时区分提示词遵循问题与桥接观测问题。代价是需要修改 Kimi ACP 事件类型、命令提取、smoke evidence 和 release assurance。

### 方案 B：只强化提示词

改动最小，但如果再次失败，evidence 仍只能显示 `requiredCommandObserved=false`，无法判断 raw input、title fallback 或 late update。该路线不满足“未来 agent 无需读取原始日志即可定位”的长期维护目标，因此不采用。

### 方案 C：放宽 validator

把 substring、任意命令事件或复合命令视为通过，会让附带副作用的命令也满足资格要求，并削弱已有严格证据合同。该路线不采用。

## 设计一：资格提示词

Kimi delegate 资格提示词必须把任务写成两个有序、独立的工具调用：

1. 创建 `result.txt`，内容严格为单行 `KIMI_SMOKE_OK`。
2. 在另一个 execute/shell 工具调用中，只执行 `git status --short`，不得添加前后命令、管道、重定向、shell 连接符或包装命令。

提示词同时保留“不得修改其它文件”和“报告执行结果”的要求。它只约束资格 smoke，不改变公开 `external_delegate` 的一般提示词或权限语义。

严格 validator 保持原样：

```ts
result.commandsRun.includes("git status --short");
```

空白不同、复合命令、substring 命中、title 中出现相同文字或模型正文自述均不通过。

## 设计二：Kimi ACP 更新字段保留

`KimiAcpEvent` 的 `tool_call_update` 分支增加协议允许晚到的可选字段：

```ts
{
  type: "tool_call_update";
  toolCallId: string;
  kind?: string | null;
  status?: string | null;
  title?: string | null;
  rawInput?: unknown;
}
```

`collectUpdate` 只复制 ACP SDK 已解析出的字段，不解释命令、不把 raw input 写入诊断，也不改变权限判定。`locations`、`content` 和 `rawOutput` 与本次命令观测无关，不扩大保存范围。

fake ACP 必须新增一个确定性场景：初始 `tool_call` 只给 execute 身份或通用 title，随后同一 `toolCallId` 的 `tool_call_update` 才给出 `rawInput.command`。先用该场景证明当前桥接丢字段，再实现保留。若 SDK 没有交付 late raw input，测试应失败关闭，不能用 title 或模型正文伪造 late-update 证据。

## 设计三：最终命令观测

命令提取从“逐个读取初始事件”改为“按 tool-call ID 归并后再提取”。归并只发生在同一次 adapter 结果内部，不跨任务、会话或重试。

每个工具调用按首次出现顺序最多形成一个最终观测：

1. 合并同 ID 的 `tool_call` 和后续 `tool_call_update`。
2. 最终 `kind` 必须为 `execute`；其它 kind 不形成命令观测。
3. 优先使用最终 `rawInput.command` 的原始字符串。
4. raw input 没有字符串命令时，才使用最终非空 `title`。
5. 两者都没有时形成不可提取观测，但不向公开 `commandsRun` 添加字符串。

内部观测类型为：

```ts
type CommandObservationSource =
  "raw_input" | "title_fallback" | "late_update" | "unextractable";

interface CommandObservation {
  source: CommandObservationSource;
  command: string | null;
}
```

来源定义：

- `raw_input`：最终命令来自初始 `tool_call.rawInput.command`。
- `title_fallback`：没有可用 raw command，最终命令来自初始 `tool_call` 的非空 title。
- `late_update`：决定最终 kind 或最终命令字符串的字段由 `tool_call_update` 首次提供或替换。
- `unextractable`：最终 kind 是 execute，但 raw command 和可用 title 都不存在。

如果同一字段多次更新，以 ACP 的最终状态为准。未知 ID 的 update 可以先暂存，若之后出现同 ID 的初始 tool call 再归并；会话结束仍没有对应 tool call 的孤立 update 不产生公开命令或资格观测，避免把无主体更新当成执行事实。

公开 `ExternalDelegateResult.commandsRun` 保持 `string[]`，只包含 `command !== null` 的最终字符串，顺序与首次出现顺序一致。MCP schema 和用户可见工具结果不增加字段。

`TaskExecutionContext` 增加仅供内部调用者使用的观测回调。服务每次 delegate 恰好报告一次最终 `CommandObservation[]`；和现有 execution telemetry 一样，该内部值不进入公开任务结果或 MCP structured content。

## 设计四：脱敏 evidence

Kimi delegate smoke 把内部命令观测映射为：

```ts
type CommandMatchClass = "exact" | "trim_only" | "embedded" | "other";

interface SanitizedCommandObservation {
  source: CommandObservationSource;
  match: CommandMatchClass;
}
```

匹配顺序固定为：

1. 字符串与 `git status --short` 完全相等：`exact`。
2. 仅 `trim()` 后完全相等：`trim_only`。
3. 原字符串包含目标文本但不是前两类：`embedded`。
4. 其它字符串或 `null`：`other`。

新产生的 Kimi delegate evidence 增加 `commandObservations` 数组，只保存上述两个枚举。数组不保存命令、title、raw input、tool-call ID、路径、输出或模型正文。`commandCount` 继续表示公开 `commandsRun` 的字符串数量，因此不可提取的 execute 观测可以让 `commandObservations.length` 大于 `commandCount`。

`requiredCommandObserved` 仍只由公开命令数组中的精确字符串决定，不能由 `match` 分类反向替代。这样分类只是诊断证据，不是第二条宽松通过路径。

当 `commandObservations` 存在时，verifier 还要检查：

- 数组长度不超过 256，且不小于 `commandCount`；
- `source="unextractable"` 只能与 `match="other"` 配对；
- `match="exact"` 至少出现一次，当且仅当 `checks.requiredCommandObserved=true`；
- 该字段只允许出现在 Kimi delegate evidence；
- 对象只能包含 `source` 与 `match` 两个枚举字段。

为了保持四份历史批次和 standalone evidence 的不可变验证：

- 不修改既有 JSON；
- 不改变 `four-llm-v1`、manifest 或 checkpoint schema；
- 历史 schema v2/v3 evidence 可以没有 `commandObservations`；
- 当前 producer 的单元/集成测试要求新 Kimi delegate evidence 必须生成该字段；
- immutable verifier 在字段存在时严格校验数组、枚举、长度和 Kimi delegate 适用范围，字段缺失时继续接受历史 evidence。

这一兼容策略依赖当前构建的 producer 测试和 release/preflight 门禁来防止新代码漏写诊断字段；分类本身不参与通过判定，因此不为诊断字段单独引入新的资格 plan/schema 版本。

## 设计五：发布包闭包

`package.json.files`、release assurance 允许清单和 required package 清单加入两份承载文档：

- `docs/release/qualification-carrier-rehearsal.md`
- `docs/release/four-llm-qualification-execution-runbook.md`

`reviewPackageSources` 不再承担“所有链接来源”的角色。release smoke 必须从 npm pack 的实际、已安全解析文件列表中选出全部 `.md` 和 `.html`：

1. 每份都必须已被读取并进入敏感信息扫描。
2. 每份都传入 `assertPackageLocalLinks`。
3. 相对本地目标必须存在于同一次 pack 的实际文件集合。
4. 逃逸路径、绝对路径、`file:`、`data:`、`javascript:` 等继续 fail closed。
5. `http`、`https`、`mailto`、protocol-relative CDN 和页内 fragment 保持现有忽略语义。

现有固定审阅文档仍可作为“必须打包”的产品清单，但不能再限制链接检查范围。测试必须证明新增任意已打包 Markdown/HTML 后，其缺失链接会被发现，而不需要同步修改另一份固定扫描数组。

## 错误、安全与隐私边界

- ACP raw input 只在当前进程内用于命令提取；新 evidence 不保存正文。
- 诊断错误不得回显 raw target、命令、title、文档正文或 secret。
- late update 归并不得把不同 tool-call ID、不同任务或不同会话的数据混合。
- 无初始主体的孤立 update 不构成执行事实。
- raw input 只有在它是非 Proxy 的普通对象，且 `command` 是自有 data descriptor 中的字符串时才可提取；accessor、Proxy 和其它形态按无 raw command 处理，不调用 getter、`toString` 或其它对象方法。
- 任何观测异常都不能把非精确命令升级为通过。
- package 链接检查必须以 `npm pack --dry-run --json` 的实际文件面为准，不以仓库文件存在替代包内存在。

## TDD 与验证策略

实现按以下红绿链推进：

1. fake ACP late-update 场景先证明 `rawInput.command` 当前丢失。
2. Kimi client 测试证明 update 字段被保留且不进入 diagnostics。
3. service 测试覆盖 raw input、title fallback、late update、unextractable、孤立 update、重复 update、不同 ID 和稳定顺序。
4. Kimi smoke 测试覆盖四种 match 分类、严格 validator 不变、evidence 无命令正文和历史 evidence 兼容。
5. qualification verifier 测试覆盖合法分类、非法枚举、错误适用范围、正文形字段拒绝或不出现，以及历史四批 immutable verifier。
6. release assurance 先用缺失承载文档和未被固定数组列出的 Markdown 制造 RED，再加入两份文件并推广到全部 pack Markdown/HTML。
7. 运行目标测试、类型检查、全量测试、构建、release smoke、隔离 plugin check-report、两个 qualification help、四份 retained batch immutable verifier、5/5 与 14/14 SHA/blob、进程 0/0/0、资格锁 absent 和 `git diff --check`。

实现完成后进行独立规格审阅与代码质量审阅；所有有证据的 Critical/Important 问题必须修复，Minor 项逐条技术裁决。最终候选必须 clean，并以独立提交冻结。

## 成功条件

同时满足以下条件才算本设计实施完成：

- Kimi 资格提示词明确要求两个独立工具调用。
- 精确 validator、模型、路由、凭据、权限、single-attempt 和无 retry/fallback 语义不变。
- fake ACP 证明 late update 字段可被保留并按 ID 归并。
- 新 Kimi delegate evidence 只保存脱敏来源/匹配分类，不出现命令正文。
- 历史 evidence 和四份 retained batch 继续通过不可变验证。
- 两份承载文档进入 npm package。
- 全部实际打包 Markdown/HTML 都接受包内链接闭包检查。
- 完整确定性与隔离验证通过，工作树 clean。
- 没有运行真实 LLM 资格批次或任何其它越界外部状态变更。

## 后续人工门槛

离线实现和冻结完成后，下一步只能准备新的资格批次授权材料。用户需要在届时看到精确 frozen SHA、构建 identity、验证证据、风险和执行承载合同后，另行明确授权一个新的完整八项批次。当前设计批准不能复用为该授权。
