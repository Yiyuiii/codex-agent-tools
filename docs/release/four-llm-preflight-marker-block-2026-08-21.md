# 2026-08-21 `four-llm-v1` 资格预飞 marker 阻断

## 结论

维护者已明确确认 Ark Coding Plan 账户存在剩余额度。该事实满足 2026-08-14 额度阻断后的外部状态变化条件。

在 clean candidate `48e6ec21155d13bde12d5c73c311dd357e35611d` 上只调用了一次标准 `four-llm-v1` 入口。fresh 执行引用只在承载 PowerShell 进程内生成，命令行显示为脱敏值。入口以退出码 1 停止；没有第二入口、retry、resume 或 fallback。

本次停止发生在资格 preflight，早于 ledger 创建和任何模型 case：

- `docs/smoke/evidence/batches/` 没有新增目录；
- 工作树没有新增 manifest、checkpoint 或 case evidence；
- Kimi、Ark 与 DeepSeek 的真实模型调用均为 0；
- 资格锁在入口结束后没有活动 owner。

## 根因

`test/plugin/artifact.test.ts` 要求当前 prerelease 版本必须已有 `.release-validation/v0.1.2-beta.1.json`。资格 preflight 固定运行完整 `test:deterministic`，因此在该文件缺失时停止。

该要求形成循环：当前 beta marker 必须绑定最终十项能力索引，只有 Kimi/Ark 八项 stale 能力刷新为 current 后才能生成；资格批次却在刷新前要求 marker 已存在。

## 修复

修复只调整测试组织，不修改资格、模型或运行时输入：

- 将 marker 与插件树绑定断言移到 `test/release/current-prerelease-marker.test.ts`；
- 同版本 marker 已存在时，断言仍重算并比较插件树摘要；
- marker 尚未生成时，该单文件明确 skipped；
- `gate:offline` 仍执行完整 `test:deterministic` 和严格 `smoke:release:built`，后者继续在 marker 缺失、能力未 current 或插件树不匹配时失败关闭。

因此本修复不会让发布绕过 marker，也不会改变 Direct DeepSeek、Kimi 或 Ark 的能力指纹输入。

## 验证

- 可复现 RED：完整 preflight 在 `test/plugin/artifact.test.ts` 精确报错缺少 `.release-validation/v0.1.2-beta.1.json`；
- 聚焦复核：4 files passed / 1 marker file skipped，71 passed / 1 skipped；
- 完整资格 preflight 序列：
  - build passed；
  - typecheck passed；
  - 70 files passed / 1 marker file skipped；
  - 1273 tests passed / 6 skipped；
  - isolated plugin `--check-report` passed；
  - `git diff --check` passed；
- 能力分析保持 Direct DeepSeek 2 current，Kimi/Ark 8 stale。
- `npm run smoke:release:built` 在当前八项 stale 状态以退出码 1 和 `Capability qualification evidence is invalid` 失败关闭，证明测试调整没有开放发布路径。

## 后续

先把本修复和状态记录冻结为新的 clean commit。当前单入口处理链到此停止，不在同一轮重开真实资格。后续可依据 standing authorization，在新 frozen commit 上使用 fresh 内部执行引用启动一个独立 `four-llm-v1` 批次；仍遵守严格串行、首错停、无 retry/resume/fallback。
