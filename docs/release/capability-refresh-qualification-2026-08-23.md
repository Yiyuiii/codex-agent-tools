# 能力刷新资格设计与阻断记录

## 结论

当前开发候选的机器状态是十项 evidence 均有效，其中 Direct DeepSeek review/delegate 与 `ark-coding-plan/delegate` 三项指纹 current，其余七项非 Direct 能力 stale。现行能力粒度政策只允许刷新这七项；旧 `four-llm-v1` 固定八项 schedule 继续用于明确授权的广覆盖回归，不能再作为本候选的定向刷新入口。

仓库新增 `capability-refresh-v1`：固定收集 Ark Coding review、Kimi review/delegate、Ark Agent Plan review/delegate、Ark Agent DeepSeek review/delegate。入口在获得资格锁、创建 batch 或调用模型前，重新分析 `capabilities.json`，并要求上述 schedule 与所有非 Direct 的 stale/invalid 项逐项相等。集合为空、重复、漏项、包含 current 能力或 Direct 能力均失败关闭。

## 触发原因

2026-08-23 在 clean frozen commit `069350fba7418a465bf6e80c4174229c3bdf3798` 上只调用一次旧标准入口，创建 `four-llm-v1` batch `2026-08-23T10-02-06.915Z-c7a6a3d9-0fef-470d-b0f6-ce6cf57b24a8`。ordinal 1 是已经 current 的 `ark-coding-plan/delegate`：

- provider `ark-coding-plan`、模型 `ark-code-latest`、direct route 正确；
- 一次 client invocation、零 adapter/runtime retry、零 fallback；
- 28 字节结果文件、预期行与精确状态命令通过，只有预期文件变化；
- 写入命令观察为 `raw_input/other/success`，未满足精确命令合同，`requiredCommandObserved=false`；
- owned process drained，资格锁释放。

协调器按合同以 `acceptance_failed` 首错停止，其余七项 notRun。terminal 为 `blocked / case_failed`、`promotionEligible=false`；immutable verifier passed，manifest SHA-256 为 `d3c38de4d0eb9a8955a29c7fb704b34567ee6a1671c2d02bf077cdcf7890130f`，不可变证据提交为 `8e01b16`。没有 retry、fallback、resume、补跑、第二入口或第二批。

这次失败不表示 Ark Coding 模型、路由或结果文件能力退化。它证明旧广覆盖入口会违反“不重复硬跑 current 能力”的当前资格政策；历史 blocked manifest 和 case evidence保持不可变。

## 首次定向入口的预模型阻断

定向计划在 clean frozen commit `6af9ef6097bd4ea94f07d041c5abd5d6c01ac1b7` 上只调用一次，创建 batch `2026-08-23T10-52-03.095Z-30f6d895-552e-4aa8-bd34-35c081e13610`。完整 deterministic preflight 通过并发布 `batch_started` 与 ordinal 1 `ark-coding-plan/review` 的 `case_running`，随后 smoke evidence 层以 `Smoke qualification context is invalid` 在 adapter 和真实模型调用前失败。

terminal 为 `blocked / infrastructure_failure`，0 completed cases、无 case evidence、`uncommittedEvidence=null`，ordinal 2–7 notRun；manifest SHA-256 为 `f99b83a1b8c5da58dd4649de3afbc2cf5c54fb9ac504a499287f3f337f714511`，immutable verifier passed，不可变证据提交为 `c8cc02e`。资格锁释放，Kimi ACP / Pi RPC / real-smoke 为 0/0/0；真实模型调用为 0，没有 retry、fallback、resume、补跑、第二入口或第二批。

根因是 `src/smoke/evidence.ts` 的严格资格上下文白名单仍只接受 `four-llm-v1` 与 `direct-deepseek-v1`。TDD 修复只加入 `capability-refresh-v1`，每个 context 仍必须匹配该计划的精确 ordinal/LLM/task；模型、路由、凭据、提示词、validator 和执行语义不变。该资格基础设施变化机械改变共享指纹，因此只迁移三项原 current 能力到新计算值，七项 stale 仍必须由真实 case 刷新。

## 实现边界

- 新计划复用现行 schema v3 manifest/checkpoint、schema v4 evidence、Ark-only Pi 配置、模型绑定、凭据、网络、提示词、validator、single-attempt、首错停止、零资格 retry/fallback 和 owned-process 合同。
- 新计划有独立 plan ID、固定七项 schedule、锁身份、preflight、ledger 与 immutable verifier 支持。
- smoke evidence 层只接受三个现行计划，并继续按各自固定 schedule 校验精确 case 身份；未知计划和跨计划 identity 均失败关闭。
- 能力索引允许非 Direct passed case 来自 `four-llm-v1` 或 `capability-refresh-v1`；Direct evidence 仍只能来自 `direct-deepseek-v1`。manifest、case evidence 与 verifier 返回的计划身份必须精确一致。
- 七项目标文件是资格选择元数据，不改变产品运行时、模型、提示词或 acceptance；它从能力运行时指纹输入中排除，但其变化会通过固定 schedule 的 immutable verifier 使不匹配批次失败。
- 资格基础设施变化机械改变共享指纹。已有三项 current 能力的证据、产品运行时和 acceptance 未变，因此只把这三项索引指纹迁移到同一候选的新计算值；七项 stale 记录不迁移，必须由新真实 case 刷新。

## 进入真实刷新前门禁

1. 新入口及三类计划的协议、preflight、ledger、lock、verifier 和能力索引测试全绿。
2. 类型检查、构建、完整单 worker 确定性回归、native/helper/observer 与隔离官方插件生命周期通过。
3. `verify:capabilities` 仍精确报告 3 current / 7 stale；定向选择器精确接受这七项。
4. npm dry-run 文件面的所有 Markdown/HTML 都通过包内链接闭包；仓库状态资料使用 GitHub 绝对链接，不扩大精确包文件面。
5. 候选形成新的 clean frozen commit，资格锁不存在，Kimi ACP / Pi RPC / real-smoke 为 0/0/0，active long-term goal 仍有效。
6. 只生成一个 fresh 内部执行引用，只调用一次 `capability-refresh-v1`；首错后停止，不补跑或重开。

七项全部 passed 后，才允许把各自新 case、manifest 哈希和当前指纹写入能力索引，再进入完整 release 门禁。活动插件、活动 `config.toml` 与公开发布不属于本设计的资格刷新动作。
