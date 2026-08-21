# 2026-08-21 能力索引与 npm 证据闭包预飞阻断

维护者明确确认 Ark 额度已重置后，在 clean frozen candidate `3a4bfde8a15e027e0bf38d43d3aa85fff26dcee4`、分支 `codex/multi-model-beta-0.1.2` 上只调用了一次标准 `four-llm-v1` 入口。fresh 执行引用只存在于承载 PowerShell 进程，命令行保持脱敏。入口约五分半后以退出码 1 和 `Gate requalification failed` 停止；没有第二入口、retry、resume、fallback 或补跑。

## 可信终态

停止发生在资格 preflight 的 deterministic test 阶段，早于 ledger 创建和任何模型 case：

- `docs/smoke/evidence/batches/` 仍为 12 个历史批次，最新批次仍是 `2026-08-21T03-00-25.070Z-6d98cc4f-ebab-46d8-ba5f-8f34810a2777`；
- 没有新增 batch、manifest、checkpoint 或 case evidence；
- 资格锁目录数和 owner 数均为 0；
- 入口退出后工作树保持 clean；
- 本次真实模型调用为 0，因此不能更新任何能力资格，也不能生成 beta marker。

## 精确根因

入口为避免泄露而丢弃 deterministic 子命令输出。对直接读取能力索引和包闭包的四个测试文件做聚焦复现后，82 项中 80 passed、2 failed：

1. `test/qualification/capability-index.test.ts` 仍断言 Kimi/Ark 八项全部 stale，没有反映上一批已通过并入索引的 `ark-coding-plan/delegate`；实际可信状态是 Direct 两项与该 delegate 共 3 current、其余 7 stale。
2. `test/plugin/artifact.test.ts` 检出 `package.json#files` 仍携带旧 Ark Coding delegate case，且缺少当前索引引用的新 delegate case 与其 blocked manifest。包闭包没有与能力索引同步。

这两项均是上一批终态收敛后的离线一致性缺口，不是模型、provider、凭据、额度或 owned process 失败。

## 最小修复与验证

- `package.json#files` 移除不再由现行索引引用的旧 delegate case，加入当前 passed delegate case 和所属不可变 manifest；
- 能力索引测试精确断言 Direct 2 项与 Ark Coding delegate 1 项 current、其余 7 项 stale；
- 未修改模型/provider/route/credential、公开 MCP、retry/fallback、资格协议、历史 evidence 或 manifest。

修复后的聚焦矩阵为 4 files / 82 tests passed；完整单 worker deterministic suite 为 70 files passed / 1 marker file skipped、1273 passed / 6 skipped。native preflight、typecheck、隔离插件 `--check-report` 与 `git diff --check` 也通过。

本次单入口处理链到此停止，不重开真实入口。下一次资格实验只能在包含本修复的新 clean frozen commit 上启动独立 fresh 批次；在此之前能力索引保持 3 current / 7 stale，`verify:capabilities` 与 release smoke 必须继续失败关闭。
