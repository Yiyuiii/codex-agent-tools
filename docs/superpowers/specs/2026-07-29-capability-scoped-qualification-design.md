# 能力级资格复用与变更影响失效设计

状态：维护者已于 2026-07-29 批准。本文取代“只有完整四模型同批 8/8 才能晋级任一能力”的当前资格政策；既有批次、manifest 与证据保持不可变，只改变这些证据如何支持产品能力资格。

## 1. 用户目标

维护者明确要求：

- 历史上已真实跑通且仍能代表当前实现的能力，不必在每次候选中重新全量硬跑；
- 当前只需确认 Ark Coding Plan 可用，暂不调试或重复调用 Ark Agent Plan；
- 产品目标是公开能力按预期运行，而不是让其它模型的瞬时额度故障连带阻断已通过能力。

## 2. 当前证据事实

最新 `four-llm-v1` 批次
`2026-07-28T14-33-04.239Z-3b17ac96-4bb1-4a63-9f37-6caf35ad715c`
整体保持 `blocked / case_failed`，不能改写为 passed：

- ordinal 1 `ark-coding-plan/delegate` passed；
- ordinal 2 `ark-coding-plan/review` passed；
- 两项均使用 `ark-code-latest`、`ark-coding-plan` provider 与 direct route；
- 两项均为一次 client invocation、零 adapter/runtime retry、零 adapter/orchestrator fallback；
- delegate 的结果文件、变更范围、精确写入命令与精确状态命令均通过；
- immutable-evidence verifier 已验证该批次；
- 批次 frozen commit 为
  `0113da97a6b1fef35cc4c45025caa9e36a002176`；
- 从该 frozen commit 到本设计开始前，仅有文档和不可变证据变更，没有 `src/`、`plugins/`、`scripts/`、`package.json` 或 `package-lock.json` 变化。

ordinal 6 `ark-agent-plan/delegate` 的 `account_quota_exceeded` 仍是该批次整体失败原因。它不改变前述两个 Coding Plan case 的真实观测。

## 3. 核心语义

### 3.1 资格单位

产品资格的最小单位是：

```text
logical LLM × task kind
```

即一个 `llm/review` 或 `llm/delegate` 能力。批次只是串行采集多个 case 证据的执行容器，不再是能力晋级的唯一原子单位。

### 3.2 批次事实与 case 事实分离

- batch manifest 的 `status`、`stopReason`、`promotionEligible` 和 `notRun` 保持原义；
- blocked/interrupted 批次不能被改写、拼接或宣称为 passed；
- 但 immutable verifier 已接受的 `passed` case 可以独立支持同一
  `llm × task` 的能力资格；
- failed 或 notRun case 永远不能支持能力资格；
- 使用多个 case 的资格记录不等于把多个 batch 拼成一个成功 batch，因为产品不再要求一个聚合 batch 结论。

### 3.3 能力资格与运行可用性分离

资格回答“当前产品实现是否曾在代表性真实环境中严格通过该能力合同”。
运行可用性回答“当前凭据、额度、账户权限和外部服务是否此刻可用”。

凭据缺失、额度耗尽、服务临时故障：

- 应在 doctor、运行错误或状态文档中如实报告；
- 不自动撤销历史能力资格；
- 不连带使其它 provider 或 LLM 的能力失效；
- 只有证据表明产品实现本身发生回归时，才使相关能力 pending。

## 4. 机器可验证的能力资格索引

仓库新增单一受版本控制的能力资格索引。每个公开
`llm × task` 条目至少记录：

- LLM 与任务身份；
- passed case evidence 的仓库相对路径与 SHA-256；
- 所属 manifest 的仓库相对路径与 SHA-256；
- evidence 绑定的 frozen commit；
- evidence 中的 build identity；
- 当前资格所依赖的运行输入集合及其内容指纹。

验证器必须 fail closed，并完成：

1. 对所属 manifest 运行既有 immutable-evidence 验证；
2. 确认索引指向 manifest 内同一 `llm × task` 的 passed case；
3. 重新计算 evidence 与 manifest SHA-256；
4. 确认 evidence 的模型、provider、route、凭据目标、telemetry 和任务严格检查仍满足既有合同；
5. 重新计算当前相关运行输入指纹并与索引匹配；
6. 确认注册表的 passed gate 精确引用该资格条目。

索引不能保存密钥、原始提示输出或未脱敏事件。

## 5. 相关运行输入与失效

指纹按能力声明相关输入，而不是对整个仓库或整个四模型面做一个全局哈希。
至少覆盖：

- 该 LLM 的 provider/model/route/credential 绑定；
- 对应 runtime adapter 及其子进程环境隔离；
- review/delegate 公共任务执行路径；
- 影响该任务验收语义的严格 validator；
- Pi/Kimi 隔离配置生成逻辑；
- 直接影响上述运行路径的锁定生产依赖。

下列变化不使能力自动失效：

- 文档、审阅页和历史状态说明；
- 新增不可变 evidence；
- 与该能力无关的另一 provider/LLM 变化；
- 测试本身或只读开发辅助材料变化；
- 从 pending 改为 passed 的资格元数据和由此产生的派生 bundle 差异。

下列变化必须使对应能力资格变为 stale/pending，或在提交前以新证据更新：

- provider、model、endpoint、route 或 credential 目标变化；
- runtime adapter、网络/环境隔离或进程生命周期变化；
- review/delegate 工具语义、权限或文件写入边界变化；
- 相关提示合同或严格验收语义变化；
- 相关生产依赖升级；
- 真实调用暴露可归因于产品实现的系统性回归。

无法可靠判断影响范围时，保守地只使可能受影响的 runtime 或任务族失效，而不是重跑完全无关的 LLM。

## 6. 当前迁移

本轮不调用真实模型：

1. 用最新 blocked manifest 中两个严格 passed case 建立
   `ark-coding-plan/delegate` 与 `ark-coding-plan/review` 资格条目；
2. 将注册表中的 Ark Coding Plan 两项 gate 更新为 passed；
3. 保留 Ark Agent Plan 两个逻辑 LLM 的既有 passed 资格，不调试、不重跑；
4. 保留 `four-llm-v1` 协调器、所有 manifest 和历史 HTML/Markdown 作为审计与可选广域回归工具；
5. 删除当前文档中“必须同批 8/8 才能准备候选”的有效政策表述，历史段落明确标为历史；
6. 将候选门禁改为“所有公开能力资格索引有效 + 确定性发布矩阵通过”。

## 7. 确定性发布矩阵

本轮和后续候选至少要求：

- 能力资格索引验证；
- retained batch immutable-evidence 验证；
- 单元/集成测试；
- TypeScript 类型检查；
- build；
- release smoke；
- 隔离 `CODEX_HOME` 的官方插件 `--check-report`；
- package 文件面、文档链接与精确插件工件检查；
- 目标 Kimi ACP / Pi RPC / real-smoke 进程无新增残留；
- 资格锁不存在。

这些检查不调用真实模型。

## 8. 保留边界

本设计不授权：

- 读取或修改活动 `~/.codex/config.toml`；
- 安装、升级、卸载或切换活动插件；
- 调用、修改或卸载 Claude Code；
- 移除或修改活动 `codex_cc_tools`；
- `npm publish`、push、merge、fast-forward、tag 或 release；
- 修改或伪造历史 evidence、manifest 或 checkpoint。

## 9. 验收标准

- Ark Coding Plan review/delegate 从最新真实 passed case 获得机器可验证资格；
- 当前无需任何真实模型重跑；
- Ark Agent Plan 的额度状态不再阻断 Coding Plan 或产品候选；
- 修改相关运行输入会使对应资格验证失败；
- 修改无关文档或其它 provider 不会错误使 Coding Plan 资格失效；
- blocked batch 仍保持 blocked，任何报告都不会把它宣称为完整 passed；
- 完整确定性发布矩阵通过。
