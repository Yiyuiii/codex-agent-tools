# 真实资格实验长期默认授权设计

日期：2026-07-28
状态：维护者已在当前会话明确批准，立即生效

## 1. 背景与用户原始要求

维护者把此前“每个真实资格批次都必须绑定一个精确 frozen SHA，并逐批等待人工回复授权”的边界调整为：

> Codex 可以自主推进到确实需要维护者处理的位置；项目内真实资格实验默认授权，不再要求逐批或逐 SHA 人工批准。

这条新要求覆盖项目内四模型资格、必要的真实 smoke、失败后的离线诊断、TDD 修复、复核、重新冻结和后续新批。它不授权活动插件安装或卸载、活动 `~/.codex/config.toml` 访问、Claude Code 或 `codex_cc_tools` 变更、npm/marketplace 发布、Git push/merge/fast-forward 等不同性质的外部状态动作。

## 2. 要解决的概念混淆

现有协议里的 `authorizationReference` 同时承担了两个被文档混在一起的概念：

1. **是否允许花费真实模型额度并启动实验**：此前由一次性人工回复决定；现在由维护者的长期默认授权决定。
2. **一次批次的唯一身份和防复用关联**：协调器把 fresh UUID 规范化后只保存 SHA-256，用于锁、checkpoint、manifest、case evidence 和授权复用索引。

第二项仍然有价值，而且不等同于人工审批。为兼容已冻结 schema 和历史 evidence，本轮不重命名代码字段；运行手册和状态材料把每批 fresh UUID 解释为**内部批次执行引用**。明文 UUID 仍不写入仓库、日志或用户材料，只有哈希进入不可变证据。

## 3. 决策

### 3.1 长期默认授权

- 在 active long-term goal 内，只要候选为 clean frozen commit、离线门禁通过、资格锁不存在、目标进程为零且凭据存在，Codex 可以自主生成一个 fresh UUID 并启动一批完整 `four-llm-v1`。
- 用户不需要看到或回复该 UUID，也不需要逐字回复 frozen SHA。
- 每一批仍必须在证据中绑定实际的 40 位 frozen commit、build identity、plan、固定八项顺序和内部执行引用哈希。
- 默认授权覆盖真实模型调用的合理时间与计划额度开销；Codex 仍应避免没有信息增益的重复调用。

### 3.2 单批原子合同不变

一批内部仍然遵守：

- 一个标准入口、一个 execution cell；
- 从 ordinal 1 开始，固定八项严格串行；
- 每个 case single-attempt；
- 首个失败立即形成终态并停止；
- 不 resume、retry、fallback、跳项、补跑或在同一批内重开入口；
- blocked/interrupted/failed 批次不能与其它批次拼接晋级；
- 只有同批 8/8 passed 才可进入离线晋级。

旧手册中的“不得另开批次”应解释为**不得在同一终态处理链里悄悄续跑或绕过失败**，不再解释为“未来任何新 frozen candidate 永久等待人工逐批批准”。

### 3.3 批次间自主重入

批次达到可信终态后，Codex 先保存并提交不可变证据，再分类：

1. **8/8 passed**：完成注册表、文档、状态包和 release candidate 的离线晋级与验证；不自动执行活动安装或公开发布。
2. **可由仓库内代码、夹具或协议修复的故障**：系统定位根因，先补失败测试，再最小修复、独立复核、完整验证、重新提交为 clean frozen candidate，然后可在新 SHA 上启动新批。
3. **凭据、登录、账户额度、服务权限、活动系统变更等外部阻碍**：整理最小充分证据并停止，请维护者完成唯一必要动作。
4. **终态、owner、lock、checkpoint、进程身份不可信或无法消歧**：fail closed，请维护者判断；不得靠新批掩盖歧义。

没有代码变化、没有外部状态变化、也没有新增诊断价值时，不重复同一真实批次。相同的不可自解阻碍重复出现，应停止而不是消耗额度。

## 4. 状态机

```text
clean frozen candidate
        |
        v
deterministic + isolated preflight
        |
        v
fresh internal execution reference
        |
        v
one-cell / one-entry four-llm-v1 batch
        |
        v
immutable terminal evidence committed
        |
        +--> 8/8 passed ------------------> offline promotion
        |
        +--> repository-fixable failure --> TDD fix --> new clean frozen candidate
        |
        +--> external actionable blocker --> maintainer action required
        |
        +--> ambiguous integrity state ----> fail closed / maintainer judgment
```

## 5. 明确保留的边界

长期默认实验授权不意味着：

- 读取、备份、恢复或修改活动 `~/.codex/config.toml`；
- 安装、升级、卸载或切换活动 Codex 插件；
- 调用、修改或卸载 Claude Code；
- 移除、修改或替换 `codex_cc_tools`；
- `npm publish`、marketplace 发布、Git tag、GitHub release；
- push、merge、fast-forward 或修改正式工作树；
- 放宽模型、provider、route、credential、代理、single-attempt、validator、telemetry 或 evidence 合同；
- 把历史 blocked/passed 单项拼接为当前资格。

这些动作仍按各自风险和既有门禁单独处理。

## 6. 本轮落地选择

本轮不修改协调器 schema 或 CLI 参数，因为 `authorizationReference` 的机器级唯一性、防复用和审计作用仍成立。落地工作只需要：

1. 更新项目记忆、README、运维、Kimi 状态和执行手册；
2. 把下一批人工授权页改为长期默认授权与自主执行状态页；
3. 完成完整离线验证并冻结；
4. 在新 frozen SHA 上直接启动一个完整真实批次；
5. 按第 3.3 节分类继续，直到 8/8 离线晋级或出现真正需要维护者动作的阻碍。

## 7. 验收标准

- 当前有效文档不再要求逐批/逐 SHA 人工回复才能运行真实资格实验；
- 历史授权页、历史计划和历史 evidence 保持原样并明确只作审计；
- 运行手册清楚区分 standing authorization、frozen identity 与 internal execution reference；
- 单批原子合同、fail-closed 语义和外部状态排除项没有弱化；
- 完整测试、类型检查、构建、release smoke、隔离报告和 retained evidence 校验通过；
- 工作树 clean 后才生成 fresh 内部执行引用并启动真实批次。
