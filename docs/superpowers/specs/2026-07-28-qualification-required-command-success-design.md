# Pi 资格规定命令成功语义设计

状态：已批准进入离线 TDD 实施。批准依据是维护者对真实批次失败后的
自主离线诊断、修复、审阅、验证和重新冻结授权。本设计不授权真实模型
重试、补跑或第二批。

## 1. 已证漏洞

批次
`2026-07-28T10-56-09.704Z-649886e3-233e-4da1-ac80-185227342bef`
首次产生 Pi 命令生命周期 evidence：

- ordinal 1 `ark-coding-plan/delegate` 的 5 个 bash 生命周期全部为
  `error`，其中规定写入命令为 `exact/error`；
- 目标结果文件最终存在且内容正确，因此旧 producer 仍把该 case 标为
  `passed`；
- ordinal 6 `ark-agent-plan/delegate` 的 18 个 bash 生命周期同样全部
  为 `error`，目标文件最终正确但多出 `where.cmd`，adapter 随后报告
  `account_quota_exceeded`。

离线复现已证明所有 bash 失败来自 Windows 程序根变量遗漏；该直接缺口
由独立 TDD 修复处理。但真实证据同时证明现有资格验收有独立漏洞：

1. `commandsRun.includes("git status --short")` 只证明命令形成，不证明
   工具成功；
2. 目标文件存在只证明最终工作区状态，不证明规定写入命令成功；
3. `writeCommandObservations` 当前被 verifier 当作纯形状诊断；
4. 因此模型可在规定 bash 失败后使用其它工具形成制品，仍得到 case
   `passed`。

该历史 case 仍是旧 producer 的真实不可变记录，但不能解释为规定 bash
合同已经通过，也不能作为未来晋级的正证据。

## 2. 方案比较

### 方案 A：在既有 schema 内收紧资格成功合同（采用）

保持 `four-llm-v1`、manifest schema v2 和 qualification evidence
schema v3 不变：

- `writeCommandObservations.match` 增加 `status_exact`；
- 资格模式内部要求规定写入命令和精确 `git status --short` 各出现恰好
  一次，且 lifecycle `outcome` 都是 `success`；
- 现有 check 名 `requiredCommandObserved` 在 Pi qualification delegate
  中表示完整的双命令成功合同；非资格 smoke 维持原有命令出现语义；
- future terminal `passed` 的 verifier 必须看到
  `writeCommandObservations`，并从脱敏数组复算同一合同。

优点：

- 直接封堵已命中的假阳性；
- 不增加命令正文、路径、toolCallId、输出或模型正文；
- 不修改公开 MCP、正常 delegate 或资格调度；
- 历史 blocked/interrupted evidence 仍可按其生成时合同验证；
- 未来可晋级终态必须满足新成功语义。

### 方案 B：升级 qualification plan、manifest 和 evidence schema（不采用）

显式引入 `four-llm-v2`、manifest v3 与 evidence v4 可以形成完全独立协议，
但会同步改动锁、preflight、coordinator、recovery、manifest、verifier、
授权材料和大量历史兼容测试。当前结构没有变化，只有一个脱敏枚举扩展和
通过条件收紧；大版本迁移成本与已证问题不成比例。

### 方案 C：资格时只允许 bash 工具（不采用）

移除 edit/write 等工具会改变 delegate 能力面，也不能单独证明两个规定
bash 调用各自成功。成功语义仍应由生命周期证据明确验证。

## 3. Producer 合同

规定命令为：

1. `buildPiDelegateSmokeContract()` 返回的精确写入命令；
2. 精确字符串 `git status --short`。

仅在 `qualification !== null` 时：

- 从内部 `PiCommandLifecycleObservation[]` 检索；
- 每个规定命令都必须满足：
  - `source === "raw_input"`；
  - `origin === "raw_input"`；
  - `command` 与目标逐字符相等；
  - 匹配总数恰好为 1；
  - 唯一匹配的 `outcome === "success"`；
- 任一缺失、重复、trim-only、embedded、error、missing 或 unknown 都
  令 `checks.requiredCommandObserved=false`；
- `passed` 继续由所有 checks 为 true 且 adapter `completed` 共同决定。

非资格 smoke 没有 lifecycle callback，继续使用原有
`commandsRun.includes("git status --short")`，避免把本次资格加固扩张到
公开任务或独立 smoke 契约。

## 4. 脱敏 evidence

`writeCommandObservations` 继续只保存三个字段：

```json
{
  "source": "raw_input",
  "match": "status_exact",
  "outcome": "success"
}
```

`match` 枚举为：

- `exact`：精确写入命令；
- `status_exact`：精确 `git status --short`；
- `trim_only`；
- `embedded`；
- `other`。

分类优先级是写入 exact、status exact、写入 trim/embedded、other。
不会保存 target 字符串、命令、结果文件名、Base64 payload、工具 ID、路径
或输出。

新增枚举不改变 observation 的字段集合、数组上限和 commandCount 关系，
因此沿用 schema v3。旧 evidence 中 status 命令仍表现为 `other`；它们是
旧 producer 的真实记录，不重写。

## 5. Verifier 与历史兼容

verifier 继续严格校验数组原型、稠密性、三字段形状、枚举、
`commandCount` 和脱敏边界，并增加：

- 接受 `status_exact` 枚举；
- 从数组计算：
  - `exact` 写入匹配是否恰好一条且 success；
  - `status_exact` 是否恰好一条且 success；
- 只要 evidence 出现 `status_exact`，就要求复算结果与
  `checks.requiredCommandObserved` 一致；
- 对 terminal manifest `status === "passed"` 的 Pi delegate：
  - `writeCommandObservations` 必须存在；
  - 双命令成功合同必须为 true；
  - `checks.requiredCommandObserved` 必须为 true。

历史 retained manifests 全部是 `blocked` 或 `interrupted`。它们继续通过
immutable-evidence verifier，即使旧 producer 的个别 case entry 记录为
passed 且没有 `status_exact`；整个 terminal 从未具备晋级资格。未来任何
terminal passed 则不能使用旧的弱语义。

## 6. TDD 与验证

RED 用例至少覆盖：

1. 最终制品、filesChanged、commandsRun 和 telemetry 全部正确，但规定
   写入 lifecycle 为 error 时，qualification evidence 必须 failed；
2. status lifecycle 缺失、重复或 error 时必须 failed；
3. 两个规定命令各恰好一次 success 时仍 passed；
4. sanitizer 只输出 `status_exact`，不泄露目标字符串；
5. verifier 拒绝 future terminal passed 中缺字段、写入失败、status
   缺失/失败、重复匹配或 check 不一致；
6. 现有真实 blocked/interrupted manifests 继续全部通过 immutable
   verifier。

完成后运行 focused smoke/sanitizer/verifier 测试、类型检查、全量测试、
构建、release smoke、隔离插件 check-report、全部 retained evidence
校验、进程/锁清理和 clean-tree freeze。

## 7. 不变量与停止条件

不修改：

- 模型、provider、direct route、凭据、代理策略；
- 资格提示词、结果文件 validator、case 顺序、single-attempt；
- adapter/runtime retry、fallback 或 coordinator 停止规则；
- 活动插件、`~/.codex/config.toml`、Claude Code、`codex_cc_tools`；
- 历史 evidence 文件。

若无法同时做到 future passed 严格验证和历史 blocked evidence 不变校验，
停止并重新评估协议版本，不以放宽 verifier 或改写历史 evidence 解决。
