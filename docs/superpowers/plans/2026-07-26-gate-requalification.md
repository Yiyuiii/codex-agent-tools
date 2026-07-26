# 十门禁原子重认证实施计划

> **历史状态：** 本文记录已完成并终止的五模型 `five-llm-v1` 实施，现已由 [Gemini 退役与四模型资格认证实施计划](2026-07-26-gemini-retirement-and-four-llm-qualification.md) 取代。下文 Gemini、`proxy-10808`、十项批次与旧授权只用于历史审计，不得作为当前执行入口。

> **执行要求：** 使用 `superpowers:subagent-driven-development` 逐任务实现；每个行为任务都必须遵守 `superpowers:test-driven-development`，先观察正确的 RED，再写最小实现。每个任务完成后依次做独立规格审阅、代码质量审阅和主代理 fresh verification。

**目标：** 补齐真实模型资格认证的安全诊断、可观测重试统计、不可变批次记录和 fail-fast 协调器，然后只执行一次全新十门禁批次；仅当同批 10/10 全过且磁盘重验通过时才晋升 pending 能力并准备 `ready` 审阅包。

**架构：** 现有 Kimi ACP、Pi RPC、`ExternalAgentService` 和三个真实 smoke 保持产品执行主链。新增共享结果文件检查器与内部 execution telemetry；资格模式通过程序化 smoke context 关闭 Pi 可见重试，并把 evidence 发布到批次目录。维护者专用协调器负责 preflight、系统临时目录锁、不可变 checkpoint、严格串行 case 调用和终态 manifest；独立 verifier 只从磁盘 artifact 判断是否允许晋升。

**技术栈：** TypeScript 5.9、Node.js 20+、Vitest、execa、MCP/ACP SDK、现有 `fs.link` 排他发布、PowerShell/Unix 进程探测。

**批准设计：** `docs/superpowers/specs/2026-07-26-gate-requalification-design.md`

**不变量：**

- 不读取、写入、备份或恢复活动 `~/.codex/config.toml`。
- 不调用、修改或卸载 Claude Code；不调用或修改 `codex_cc_tools`。
- 不安装、卸载或发布真实插件；不执行 `npm publish`。
- 不改变五个逻辑 LLM、固定 provider、模型或网络路由。
- 不放宽 review/delegate 验收，不增加 qualification retry/fallback。
- 真门禁批次只能消费当前用户“继续”授权的一次新尝试；失败即停，不自动重开。

---

## Task 1：共享的安全结果文件诊断与精确命令验收

**文件：**

- 新增：`src/smoke/result-file-evidence.ts`
- 新增：`test/smoke/result-file-evidence.test.ts`
- 修改：`src/smoke/pi.ts`
- 修改：`src/smoke/kimi.ts`
- 修改：`test/smoke/pi.test.ts`
- 修改：`test/smoke/kimi.test.ts`
- 修改：`test/smoke/ark.test.ts`

### Step 1：为结果文件检查器写 RED

测试希望 API：

```ts
const evidence = await inspectResultFile({
  filePath,
  expectedLine: "ARK_SMOKE_OK:ark-coding-plan",
  maximumBytes: 65_536,
});
```

覆盖：

- 精确内容与一个尾换行通过；
- 空文件、额外行、错误行失败；
- 额外行包含期望整行时 `containsExpectedLine=true`、`valid=false`；
- missing 为 `missing`；
- 非法 UTF-8 为 `invalid_utf8`，保留 raw length/hash，不生成 normalized 字段；
- 目录、symbolic link、其它非普通文件和超过 64 KiB 为 `read_error`；
- symbolic link 目标的字节和哈希绝不进入结果；
- `lstat` 后路径被替换成 symbolic link/其它文件时，在任何读取和哈希前 fail closed；
- CRLF 保持当前 `trim()` 验收语义；
- raw hash、normalized hash、expected hash 与 line count 正确；
- 返回对象与序列化 JSON 不包含原文 sentinel、错误消息或绝对路径。

运行：

```powershell
npm test -- --run test/smoke/result-file-evidence.test.ts
```

Expected：因模块/API 不存在而失败。

### Step 2：实现最小检查器并转 GREEN

实现顺序：

1. `lstat`；
2. 只接受普通文件；
3. 依据 stat size 在读取前拒绝超限；
4. 打开 file handle 并以 `fstat` 核对 type、size、`dev`/`ino` identity；
5. 只通过 handle 读取 Buffer，读后再次 `fstat`；
6. 任一 identity/type/size 漂移 fail closed；
7. raw SHA-256；
8. `new TextDecoder("utf-8", { fatal: true })`；
9. `decoded.trim()`；
10. normalized/expected SHA-256、line count、contains、valid。

测试通过注入的文件操作在 `lstat` 与 `open/fstat` 之间执行路径替换，不能依赖不稳定的竞态概率。不得暴露异常对象或路径。运行同一测试，Expected：PASS。

### Step 3：把 Pi/Kimi delegate 接到共享检查器并写 RED

在 Pi/Kimi smoke 测试中断言：

- delegate evidence 含安全 artifact 字段；
- `resultFileValid` 继续保持现有含义；
- `requiredCommandObserved` 仅在
  `commandsRun.includes("git status --short")` 时为 true；
- `["pwd"]`、`["echo x && git status --short"]`、仅工具标题都失败；
- Ark delegate 与 Gemini delegate 使用各自 expected line；
- evidence 不含完整命令清单或结果原文。

先只改测试并运行：

```powershell
npm test -- --run test/smoke/pi.test.ts test/smoke/kimi.test.ts test/smoke/ark.test.ts
```

Expected：新字段/精确命令断言失败。

### Step 4：最小接线并转 GREEN

删除 Pi/Kimi 直接 `readFile(..., "utf8")` 的重复逻辑，统一调用检查器；命令改为精确 `includes`。运行目标测试与：

```powershell
npm run typecheck
git diff --check
```

### Step 5：提交并审阅

```powershell
git add src/smoke/result-file-evidence.ts src/smoke/pi.ts src/smoke/kimi.ts test/smoke/result-file-evidence.test.ts test/smoke/pi.test.ts test/smoke/kimi.test.ts test/smoke/ark.test.ts
git commit -m "test: harden smoke result artifact evidence"
```

独立规格审阅核对设计 §4.1/§4.2；质量审阅重点检查 symlink、TOCTOU、长度上限、UTF-8、原文泄漏和命令精确匹配。任何 Critical/Important 先 TDD 修复再继续。

---

## Task 2：内部 execution telemetry 与 Pi 单次资格模式

**文件：**

- 修改：`src/adapters/adapter.ts`
- 修改：`src/adapters/pi/client.ts`
- 修改：`src/adapters/pi/adapter.ts`
- 修改：`src/adapters/pi/config.ts`
- 修改：`src/adapters/kimi/client.ts`
- 修改：`src/adapters/kimi/adapter.ts`
- 修改：`src/tasks/service.ts`
- 修改：`src/smoke/pi.ts`
- 修改：`src/smoke/kimi.ts`
- 修改：`test/fakes/fake-pi-rpc.mjs`
- 修改：`test/adapters/pi/client.test.ts`
- 修改：`test/adapters/pi/adapter.test.ts`
- 修改：`test/adapters/pi/config.test.ts`
- 修改：`test/adapters/kimi/client.test.ts`
- 修改：`test/adapters/kimi/adapter.test.ts`
- 修改：`test/tasks/service.test.ts`
- 修改：`test/smoke/pi.test.ts`
- 修改：`test/smoke/kimi.test.ts`
- 修改：`test/smoke/ark.test.ts`

### Step 1：定义内部 telemetry 契约并写 RED

在 adapter/service 测试先使用希望的类型：

```ts
interface AdapterExecutionTelemetry {
  adapterClientInvocationCount: number;
  adapterRetryCount: number;
  runtimeReportedAutoRetryCount: number;
  adapterReportedFallbackUsed: boolean;
  source: "kimi-acp-observable" | "pi-rpc-observable";
}
```

`AdapterRunResult.executionTelemetry` 为
`AdapterExecutionTelemetry | null`。`TaskExecutionContext` 新增内部
`onExecutionTelemetry` observer；公开任务 result/Zod/MCP schema 不增加字段。

测试：

- review/delegate 把 telemetry 交给 observer；
- adapter 抛出时 observer 收到 `null`；
- MCP/任务 JSON 结果没有 telemetry 字段。

先运行：

```powershell
npm test -- --run test/tasks/service.test.ts test/mcp/server.test.ts
```

Expected：类型或行为断言失败。

### Step 2：最小实现内部通道并转 GREEN

给所有现有 client/fake result 补显式 telemetry 或 `null`；service 在捕获 adapter 结果后调用 observer，但不复制到公开结果。运行 Step 1 测试，Expected：PASS。

### Step 3：Pi RPC 明示重试统计与禁用命令 RED

扩充 fake Pi：

- 接受并记录 `set_auto_retry`；
- 接受并记录 `set_auto_compaction`；
- 产生一组和两组 `auto_retry_start/end`；
- 产生不平衡事件；
- 产生 `compaction_end.willRetry=true`；
- retry 事件放入 secret sentinel。

Pi client 测试：

- 普通 prompt 为 `1 / 0 / 0 / false` 的可观测统计；
- 一组/两组运行时重试的 `runtimeReportedAutoRetryCount` 为 1/2；
- `agent_end.willRetry` 与同组 `auto_retry_start/end` 不重复计数；
- 不平衡事件保守计数并只产生固定脱敏诊断标签；
- secret 不进入 result JSON；
- qualification 选项使两个 disable 命令都在 `prompt` 前；
- model/provider 绑定偏差仍失败，不能伪装成无 fallback。

先运行：

```powershell
npm test -- --run test/adapters/pi/client.test.ts
```

Expected：缺命令和统计而失败。

### Step 4：实现 Pi client 统计并转 GREEN

只把聚合整数写入 telemetry；不得把 `auto_retry_*` 原始事件放入
`events` 或 diagnostics。对重复信号用 correlation/状态机交叉核对，避免简单累加。运行目标测试。

### Step 5：Pi adapter 单次模式与配置 RED

希望的依赖选项：

```ts
retryMode?: "default" | "qualification-single-attempt";
```

测试：

- production default 保留一次有界 Gemini review adapter 重试；
- qualification 模式 client 只调用一次、wait 不调用；
- qualification client request 设置 auto retry/compaction 为 false；
- adapter 外层重试与 child telemetry 正确聚合；
- 任一 child telemetry 为 `null` 时聚合为 `null`；
- delegate 继续无 adapter 重试；
- 隔离 `settings.json` 显式 `retry.provider.maxRetries = 0` 且配置哈希随之冻结。

先运行：

```powershell
npm test -- --run test/adapters/pi/adapter.test.ts test/adapters/pi/config.test.ts
```

Expected：缺选项/配置而失败。

### Step 6：最小实现并转 GREEN

production default 不变；只有 qualification context 创建的 PiAdapter 使用 single-attempt。运行 Pi adapter/config/client 全组。

### Step 7：Kimi 可观测统计与 smoke 门禁 RED/GREEN

Kimi client/adapter 测试：

- ACP prompt 已提交时 client invocation 为 1；
- model/session 初始化前失败可为 0；
- 无可见 runtime retry 时计 0 并把 source 固定为
  `kimi-acp-observable`；
- 文档/类型不宣称观察 provider 内部请求。

Pi/Kimi/Ark smoke 测试：

- observer 未报告或为 `null` 时失败；
- client invocation 非 1、adapter retry 非 0、runtime retry 非 0、fallback true 任一均失败；
  -正常为 `1 / 0 / 0 / false`。

分别观察 RED 后最小实现，运行：

```powershell
npm test -- --run test/adapters/kimi/client.test.ts test/adapters/kimi/adapter.test.ts test/smoke/pi.test.ts test/smoke/kimi.test.ts test/smoke/ark.test.ts
npm run typecheck
```

### Step 8：提交并审阅

```powershell
git add src/adapters src/tasks/service.ts src/smoke/pi.ts src/smoke/kimi.ts test/adapters test/tasks/service.test.ts test/smoke test/fakes/fake-pi-rpc.mjs
git commit -m "feat: observe qualification execution retries"
```

规格审阅逐条核对设计 §4.3；质量审阅重点检查双计数、未知值伪造、secret event 泄漏、production retry 漂移和公开 MCP schema 漂移。

---

## Task 3：Evidence v2 与批次上下文接线

**文件：**

- 修改：`src/smoke/evidence.ts`
- 修改：`src/smoke/pi.ts`
- 修改：`src/smoke/kimi.ts`
- 修改：`src/smoke/ark.ts`
- 修改：`scripts/real-smoke-main.mjs`
- 修改：`scripts/real-kimi-smoke.mjs`
- 修改：`scripts/real-pi-smoke.mjs`
- 修改：`scripts/real-ark-smoke.mjs`
- 修改：`test/smoke/evidence.test.ts`
- 修改：`test/smoke/script-entrypoints.test.ts`
- 修改：`test/smoke/pi.test.ts`
- 修改：`test/smoke/kimi.test.ts`
- 修改：`test/smoke/ark.test.ts`

### Step 1：批次上下文与 v2 schema RED

定义内部 `SmokeQualificationContext`：

```ts
{
  batchId: string;
  ordinal: number;
  repositoryCommit: string;
  buildIdentitySha256: string;
  authorizationReferenceSha256: string;
  orchestratorFallbackUsed: false;
}
```

测试：

- standalone evidence 也升级 schema v2，但 qualification 可为空；
- batch evidence 必须复制完整 context；
- infrastructure failure evidence 同样保留 context；
- infrastructure telemetry 为 `null`，不能伪装无重试；
- batch evidence 目录可由入口注入；
- CLI 不新增 `--batch`、`--retry`、`--model` 等旁路参数；
- stdout 的 evidence path 正确指向批次 case 目录；
- 旧 schema v1 可保留为历史文件，但后续 verifier 必须拒绝把它放入新批次。

运行：

```powershell
npm test -- --run test/smoke/evidence.test.ts test/smoke/script-entrypoints.test.ts
```

Expected：新 context/schema 断言失败。

### Step 2：最小实现并转 GREEN

`runRealSmokeMain` 只接受程序化 `options.qualificationContext`，不从公开
CLI 或任意父进程环境隐式解析。程序化 wrapper 同时：

- 传给 `runSmoke`，使 Pi 创建 single-attempt adapter；
- 传给 infrastructure evidence；
- 指定 batch case evidenceDirectory。

运行 Step 1 测试与三个 smoke 测试。

### Step 3：导出通用不可变 JSON 发布器

先在 evidence 测试中要求一个通用：

```ts
publishImmutableJson(destination, value, fileOperations?)
```

覆盖：同目录临时文件、`wx`、hard-link 排他发布、碰撞不覆盖、临时文件清理、发布失败不报告目标路径。观察 RED 后从现有 `writeEvidence` 提取最小实现。

### Step 4：提交并审阅

```powershell
git add src/smoke scripts/real-smoke-main.mjs scripts/real-kimi-smoke.mjs scripts/real-pi-smoke.mjs scripts/real-ark-smoke.mjs test/smoke
git commit -m "feat: bind smoke evidence to qualification batches"
```

规格审阅核对 v1 历史兼容与 v2 batch fail-closed；质量审阅检查 context 注入旁路、路径逃逸、infrastructure evidence 丢身份和发布碰撞。

---

## Task 4：目标进程分类、排他锁与不可变 manifest

**文件：**

- 新增：`src/runtime/agent-processes.ts`
- 新增：`test/runtime/agent-processes.test.ts`
- 新增：`src/qualification/types.ts`
- 新增：`src/qualification/lock.ts`
- 新增：`src/qualification/manifest.ts`
- 新增：`test/qualification/lock.test.ts`
- 新增：`test/qualification/manifest.test.ts`
- 修改：`tsup.config.ts`

### Step 1：统一目标进程分类 RED/GREEN

希望 API 只返回：

```ts
{
  kimi: {
    count: number;
  }
  piRpc: {
    count: number;
  }
  realSmoke: {
    count: number;
  }
}
```

测试 Windows/Unix 样例：

- 只分类 Kimi ACP、带固定 RPC identity 的 Pi、三个 real smoke；
- 不把无关 node/codex/PowerShell 计入；
- 原始命令行、PID、凭据 sentinel 不出现在返回/JSON；
- 探测失败抛固定基础设施错误。

先 RED，再抽取现有 smoke 私有探测逻辑形成只读共享模块；standalone smoke 可继续复用 PID 集合做自身清理，但 manifest 只拿分类计数。

### Step 2：锁 RED

锁位于：

```text
%TEMP%/codex-agent-tools-qualification-locks/<sha256(realpath(repo))>/
```

测试：

- `mkdir` 原子抢锁；
- owner 包含 repository hash、PID、process start time、nonce、batchId 和
  `authorizationReferenceSha256`；
- 第二 owner fail closed；
- 非 owner nonce 不能释放；
- owner 活着时不能恢复；
- owner 已死也不能自动启动新批次；
  -显式 recover 在目标分类非零时失败；
- recover 在零进程时调用 manifest interrupt publisher，验证后释放；
  -已有合法终态 manifest 时 recover 只验真并释放锁，不尝试发布第二个终态；
  -缺失/损坏 owner、终态冲突和 nonce 漂移全部 fail closed；
- PID reuse/process start time 不匹配按死 owner 处理；
  -异常退出不误删别人锁。

### Step 3：不可变 checkpoint/manifest RED

目录：

```text
docs/smoke/evidence/batches/<batchId>/
  checkpoints/000000.json
  cases/*.json
  manifest.json
```

覆盖：

- checkpoint 序号单调且不可覆盖；
  -任何真实调用前必须发布 `batch_started`，其中只含 authorization ref SHA-256；
  -授权复用扫描终态 manifest、未完成 checkpoint 与 live/stale owner；不可读状态 fail closed；
- 调用前必须先发布 `running`；
  -完成 checkpoint 只能跟在同 ordinal running 后；
  -终态 manifest 只能发布一次；
  -碰撞/哈希不一致 fail closed；
- evidence 已发布但完成 checkpoint 未发布的恢复结果为 `interrupted`；
  -首个 checkpoint 前、`running` 后、evidence 后和终态 manifest 发布后/释放锁前四个崩溃窗口都有确定恢复结果；
- v1 evidence、其它 batchId/commit/build 的 evidence 拒绝；
- manifest 和 checkpoint JSON 不含异常原文、PID、命令行、凭据；
  -授权 reference 只存 SHA-256，重复 ref 可被历史批次索引拒绝。

定义不可变 `FrozenPreflightRecord`，由 `batch_started` checkpoint、case evidence 和终态 manifest 共同绑定，至少包含：

- commit/branch/package version/package-lock hash；
  -构建 artifact hash 与 build identity；
- Node/Codex/Kimi/Pi 版本；
- Pi config hash；
  -五条固定逻辑 LLM 身份；
  -命中的凭据变量名称；
- 10808 与目标进程分类结论。

先 RED，再用 Task 3 的通用不可变 JSON 发布器实现。

### Step 4：构建入口与验证

给 `tsup.config.ts` 增加 qualification 所需内部 entry（若维护者脚本通过
tsx 直接导入，则只增加 verifier/测试需要的最小 entry，避免扩张公开 bin）。

运行：

```powershell
npm test -- --run test/runtime/agent-processes.test.ts test/qualification/lock.test.ts test/qualification/manifest.test.ts
npm run typecheck
git diff --check
```

### Step 5：提交并审阅

```powershell
git add src/runtime/agent-processes.ts src/qualification test/runtime/agent-processes.test.ts test/qualification tsup.config.ts
git commit -m "feat: add immutable qualification batch ledger"
```

质量审阅重点检查 Windows 锁、PID reuse、nonce owner、stale 恢复、checkpoint 覆盖、目录穿越和中断空档。

完成状态（2026-07-26）：代码与测试已由 `d70f368` 提交。审阅发现并修复了 ledger/lock 祖先 junction 逃逸、失败后仍可继续、owner 写后未验真、`running` 基础设施终态、evidence 固定身份未交叉核对、Windows CIM fail-open、Unix 长命令截断、终态与 stale owner 授权未绑定，以及无效未完成 evidence 永久封死批次等问题。最终独立规格与质量复审均为 PASS；主线程受影响验证为 124 passed / 1 个平台权限条件 skip，类型检查、构建、diff check 和格式检查通过。未运行真实模型门禁。

---

## Task 5：Preflight、协调器与晋升前磁盘 verifier

**文件：**

- 新增：`src/qualification/preflight.ts`
- 新增：`src/qualification/coordinator.ts`
- 新增：`src/qualification/verifier.ts`
- 新增：`scripts/gate-requalification.ts`
- 新增：`scripts/verify-qualification.ts`
- 新增：`src/plugin/isolated-report.ts`
- 新增：`test/plugin/isolated-report.test.ts`
- 新增：`test/qualification/preflight.test.ts`
- 新增：`test/qualification/coordinator.test.ts`
- 新增：`test/qualification/verifier.test.ts`
- 修改：`package.json`
- 修改：`scripts/plugin-isolated-acceptance.mjs`
- 修改：`test/smoke/script-entrypoints.test.ts`
- 修改：`AGENTS.md`

### Step 1：Preflight RED

Preflight 固定采集：

- clean tree、40 hex commit、branch；
- package version、`package-lock.json` SHA-256；
- Node、Codex、Kimi、Pi 版本；
- `dist/kimi-smoke.js`、`dist/pi-smoke.js`、`dist/ark-smoke.js`、
  `dist/smoke-evidence.js` 和插件 bundle 哈希组成的 build identity；
- Pi 配置 SHA-256；
- 10808 loopback listener；
  -每个 profile 实际命中的 credential env **名称**；
  -目标进程分类全为零；
  -当前授权 reference 未使用。

它依次执行并要求退出 0：

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated -- --check-report
git diff --check
```

`--check-report` 必须执行完整隔离生命周期并把新渲染结果与已提交报告比较，但不得写报告；不一致即在模型调用前失败。先为 `src/plugin/isolated-report.ts` 写 RED，覆盖 check 相同、check 漂移、update 模式和失败不覆盖，再把脚本接到 helper。

之后再次确认 clean tree、commit 未变、build identity 未变。Codex 版本探测只能使用新临时 `CODEX_HOME`，不得访问活动 home。preflight 返回 Task 4 定义的完整 `FrozenPreflightRecord`。

先用依赖注入 fake command runner 写 RED，覆盖 dirty、commit 漂移、build 漂移、10808 未监听、凭据缺失、非零目标进程和命令失败全部在模型调用前失败。

### Step 2：实现最小 preflight 并转 GREEN

错误只输出固定 category/stage/count；不保存命令 stdout/stderr、env 值或绝对用户路径。

严格顺序为：参数/授权格式校验 → TEMP 锁 → 完整 preflight → 再次 clean/identity 检查 → 创建批次目录并发布 `batch_started`。preflight 期间不得创建批次目录或修改 tracked source/doc；只允许预期的 gitignored 构建产物。普通 preflight 失败释放 owner 自己的锁，不发布 batch 记录且不消费授权。只有进入 `batch_started` 后的异常才发布 blocked/interrupted 记录。

### Step 3：协调器 RED

固定 cases，不允许用户选择子集：

```text
1 gemini-3.5-flash delegate
2 gemini-3.5-flash review
3 ark-coding-plan delegate
4 ark-coding-plan review
5 kimi-k3 review
6 kimi-k3 delegate
7 ark-agent-plan review
8 ark-agent-plan delegate
9 ark-agent-deepseek-v4-flash review
10 ark-agent-deepseek-v4-flash delegate
```

测试：

-严格顺序、最多一个 in-flight；
-完整生命周期固定为
`acquire lock → preflight → batch_started → cases → terminal manifest → owner-checked release`；
-所有正常/失败退出路径都释放自己的锁；终态发布后释放前崩溃由 recover 只验真并释放；
-每项先 `running` checkpoint 后 runCase；
-首项失败不调用第二项；
-第四项失败不调用后六项；
-每项前 commit/build/lock owner/目标进程仍有效；
-每项后绝对目标分类为零；

- evidence 必须 v2、同 batch/commit/build/ordinal、固定实际模型/provider/route；
- adapter telemetry 与协调器选择合计必须
  `1 / 0 / 0 / false / false`；
  -失败发布 blocked manifest 与 not_run 清单；
  -十项全过只产生 `promotionEligible=true` manifest，不自行改注册表；
  -工作树只允许当前 batch 目录新增；
  -任一 infrastructure exception 仍发布脱敏 checkpoint/blocked manifest；
  -没有 retry、fallback、parallel、resume 或 only case 分支。
  -首个 checkpoint 前、running 后、evidence 后、终态发布后四类故障注入都不得续跑或重复发布终态。

### Step 4：实现协调器与维护者入口

维护者入口只提供：

```text
npm run --silent qualify:gates -- --authorization-ref <uuid>
npm run --silent qualify:gates -- --recover-interrupted <batchId>
npm run --silent qualify:gates -- --help
```

明确拒绝 `--only`、`--llm`、`--model`、`--provider`、`--retry`、
`--resume`、`--fallback`、`--parallel`。case runner 动态导入构建后的三个真实 smoke script，并通过程序化 context/evidence directory 调用现有 `main()`；不得重写另一套 smoke。

`package.json` 只新增维护者脚本，不新增公开 bin：

```json
{
  "qualify:gates": "tsx scripts/gate-requalification.ts",
  "verify:qualification": "tsx scripts/verify-qualification.ts"
}
```

### Step 5：晋升前 verifier RED/GREEN

verifier 提供两个明确模式。

`frozen-candidate` 只在任何晋升修改前运行，从磁盘重读：

-终态 manifest 不可变且 `promotionEligible=true`；
-十个 ordinal 完整且身份固定；
-所有 evidence 路径在 batch cases 目录；
-重算每个 evidence SHA-256；
-重算当前 HEAD、package version、package lock、Pi config、build artifacts/build identity；
-核对不可变 `FrozenPreflightRecord` 的运行时版本、凭据变量名称、固定逻辑 LLM 身份；
-核对 batchId/commit/model/provider/route；
-核对 task checks 与 `1 / 0 / 0 / false / false`；
-核对无 v1、missing、duplicate、extra case。

`immutable-evidence` 用于晋升改动后，只重验不可变 manifest/checkpoint/evidence 内部哈希、原始冻结身份和五元组，不要求当前 HEAD/build 等于旧批次；当前晋升代码由独立 build/test/acceptance 验证。

测试 tamper、路径逃逸、字段漂移、hash 漂移、case 缺失、旧 evidence、当前 HEAD 漂移在 frozen 模式下都 fail closed；同一 HEAD 漂移在 immutable 模式不误报，但 artifact tamper 仍失败。verifier 不写注册表。

### Step 6：验证、提交、双审阅

```powershell
npm test -- --run test/qualification
npm test -- --run test/smoke/script-entrypoints.test.ts
npm run typecheck
npm run build
npm run --silent qualify:gates -- --help
npm run verify:qualification -- --help
git diff --check
```

```powershell
git add src/qualification src/plugin/isolated-report.ts scripts/gate-requalification.ts scripts/verify-qualification.ts scripts/plugin-isolated-acceptance.mjs test/qualification test/plugin/isolated-report.test.ts test/smoke/script-entrypoints.test.ts package.json AGENTS.md
git commit -m "feat: orchestrate fail-fast gate requalification"
```

规格审阅逐条核对批准设计 §5/§6；质量审阅重点攻击参数旁路、partial promotion、锁恢复、case 身份、构建漂移、preflight 写仓库和 secret 泄漏。

完成状态（2026-07-26）：实现由 `61e4879` 提交。Preflight 以固定顺序执行六项确定性门禁，在门禁后再次闭合仓库 HEAD、clean 状态、五项受 32 MiB 上限保护的构建身份与 10808，并逐祖先拒绝 artifact 路径中的 junction/symlink；Codex 版本只在全新临时 `CODEX_HOME` 中探测。隔离 lifecycle 新增字节精确的 `--check-report`，比较不一致时不写报告。协调器只接受固定十项串行批次，授权引用统一大小写后仅持久化 SHA-256，规定入口使用 `npm run --silent` 防 npm 回显；case 前后及所有终态发布前检查 owner，owner 丢失或终态提交结果不确定时保留锁并交显式恢复，不重试 case 或终态。Ark preflight 记录父环境中实际命中的 source credential 名称，evidence 则核对注入子进程的固定 target 名称。两个 verifier 分离当前冻结候选与晋升后不可变证据语义，均只读。独立规格与质量复审最终均为 PASS；主线程最终相关验证为 191 passed / 1 个平台权限条件 skip，类型检查、完整构建、help、diff check 与格式检查全绿。未运行生产 preflight、真实资格批次、外部模型、真实网络或活动配置。

---

## Task 6：冻结候选版本并完成确定性验收

**文件：**

- 按审阅发现修改相关代码/测试
- 修改：`AGENTS.md`
- 修改：本计划的完成状态
- 必要时修改：`C:\Users\Administrator\.codex\agent-memory\model-collaboration.md`

### Step 1：全库 fresh verification

必须逐项运行并读完输出：

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated
npm run --silent qualify:gates -- --help
git diff --check
git status --short
```

确认：

-测试总数和 0 failure；
-插件 bundle 自包含；
-隔离生命周期只使用临时 `CODEX_HOME`；
-工作树除有意文档更新外干净；
-没有 Kimi/Pi RPC/real-smoke 残留；
-没有调用真实资格门禁。

### Step 2：最终内部双审阅

分别派出：

1. 规格 reviewer：只对照批准设计与计划，列 missing/extra behavior。
2. 质量 reviewer：对锁、telemetry、artifact evidence、preflight、coordinator、
   verifier 做对抗审阅。

任何 Critical/Important 必须回到 TDD RED→GREEN，再重跑 Step 1。

### Step 3：记录模型协作经验

只记录稳定、可复用事实：

- Kimi K3 聚焦文档审阅约 294 秒成功，命中四个真实设计缺口；
- Ark Agent Plan 本轮因 Pi RPC `EPIPE` 无正文，不算 PASS；
  -并行审阅把另一个审阅的临时文件误判为 workspace change，后续只读外审应输出到 workspace 外且严格串行。

不得把一次失败写成永久模型能力结论。

### Step 4：提交冻结状态

审阅导致的任何代码/测试修复必须先独立提交并重新执行 Step 1；不得只提交文档却把修复留在工作树。最后用：

```powershell
git status --short
git add <逐项确认属于本计划的全部修改路径>
git commit -m "chore: freeze gate requalification candidate"
git status --short
```

Expected：commit 后工作树干净。此 commit 是真实批次的 `repository.commit`；批次开始后不再改源码。

完成状态（2026-07-26）：Task 6 在 Task 5 实现提交 `61e4879` 与记忆提交 `e09c12f` 上完成全库 fresh verification：`npm run typecheck` 通过，`npm test` 为 43 文件、494 passed / 1 个平台权限条件 skip，完整 build、release smoke、隔离官方 plugin lifecycle 和 qualification help 均通过，隔离报告字节未漂移，`git diff --check` 与工作树检查全绿；独立系统快照确认 Kimi ACP、Pi RPC、real-smoke 目标进程均为 0。最终规格 reviewer 与质量 reviewer 对当前提交均给出 PASS，未发现可复现 Critical/Important/Minor。全局模型协作记忆已补充 Kimi K3 聚焦审阅、Ark Agent Plan `EPIPE` 无正文，以及只读外审应严格串行并把临时输出置于 workspace 外的适用经验。本阶段没有运行生产 preflight、真实资格批次、外部模型、真实网络、活动配置或 Claude/`codex_cc_tools` 操作；冻结提交之后只能按 Task 7 入口消费当前一次性授权。

---

## Task 7：只执行一次新的十门禁批次

**前置条件：** Task 1–6 全部完成，工作树干净，目标进程分类为零，当前用户“继续”的唯一 authorization ref 尚未使用。

### Step 1：生成会话内唯一授权引用

由主代理生成随机 UUID，只作为本次用户继续授权的脱敏引用。不得把用户原文、thread ID、session ID 或秘密放入 manifest。

### Step 2：启动维护者入口

```powershell
npm run --silent qualify:gates -- --authorization-ref <uuid>
```

不并行执行其它 Kimi/Pi 外审。持续监控脱敏 progress 和终态；不得手工跳项、重试或重启失败 case。

### Step 3：分支处理

#### 普通门禁失败

立即停止：

-读取终态 manifest、新 evidence 与 SHA；
-独立确认目标进程分类为零；
-运行 verifier，Expected：拒绝 promotion；
-保持 registry pending 与 `blocked / not ready`；
-更新三份 smoke 索引、状态包、AGENTS 和本计划，只陈述本批事实；
-不得在当前授权下再开批次；
-提交 blocked evidence/docs；
-向用户报告阻断事实和下一次需要的明确决策。

#### 进程中断 / 缺终态 manifest

先只读确认 stale owner 对应 batchId，且 Kimi/Pi RPC/real-smoke 目标分类为零；随后恰好一次执行：

```powershell
npm run --silent qualify:gates -- --recover-interrupted <batchId>
```

验真新发布的 `interrupted` manifest（若已有合法终态，只验真并释放锁），再进入普通 blocked 文档分支。不得 resume、不得在同一授权下重启 batch。

#### 十项全部通过

先运行：

```powershell
npm run verify:qualification -- --mode frozen-candidate --manifest docs/smoke/evidence/batches/<batchId>/manifest.json
```

Expected：只读 verifier exit 0。然后进入 Task 8；verifier 通过前不得改 registry。

完成状态（2026-07-26）：冻结候选 `f7209cd5744bad12fd27fbb3f5b6cd6fc42c3521` 上只启动了一次批次 `2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f`。完整 preflight 通过后，第 1 项 `gemini-3.5-flash delegate` 以固定 Google / `gemini-3.5-flash` / `proxy-10808` 身份调用一次，结果因 `google_free_tier_quota` failed；模型、凭据隔离、结果文件、命令和工作区检查均符合契约，telemetry 为 `1 / 0 / 0 / false / false`。协调器立即发布 `blocked` manifest，把后九项记为 not run，并消费当前授权；未 retry、fallback、resume、跳项或重开。evidence SHA-256 为 `ed2e5c79c4cfbf851c7901aeeee5be885055ef244aefcf4ee11dca6ccbccf484`，manifest SHA-256 为 `78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5`；冻结 verifier 按预期 exit 1，批次后 Kimi ACP、Pi RPC、real-smoke 目标进程全为 0。注册表保持 6 passed / 4 pending，Task 8 不执行。提交 blocked 证据前的 release smoke 发现 npm 会在 `pack --json` 展示中把批次 UUID 段替换为 `***`，旧检查器随后错误读取脱敏路径；该确定性包装缺口已用 RED→GREEN 增加安全路径、唯一匹配和歧义拒绝，再次 release smoke 通过。修复不修改冻结 evidence，不构成资格重试。未来若重入必须由用户重新明确授权并从十项第一项开始。

---

## Task 8：成功批次后的成对晋升与 `ready` 审阅包（仅 10/10 时执行）

**文件：**

- 修改：`src/llms/registry.ts`
- 修改：`test/llms/registry.test.ts`
- 修改：`docs/smoke/kimi.md`
- 修改：`docs/smoke/pi-gemini.md`
- 修改：`docs/smoke/ark.md`
- 修改：`README.md`
- 修改：`docs/operations.md`
- 修改：`docs/release/checklist.md`
- 修改：`docs/release/real-plugin-install-review.md`
- 修改：`scripts/plugin-isolated-acceptance.mjs`
- 修改：`docs/release/plugin-isolated-state.md`
- 修改：相关 acceptance/release tests
- 修改：`AGENTS.md`

### Step 1：注册表晋升 TDD

先把 registry tests 改为要求 Gemini 与 Ark Coding Plan 的 review/delegate 都：

- `passed`；
- evidence anchor 指向同一新 batch；
  -没有 pending；
  -五个 logical LLM 共十项全部 enabled。

运行：

```powershell
npm test -- --run test/llms/registry.test.ts
```

Expected：当前 pending registry RED。

再修改 registry，运行同一测试转 GREEN。不得改模型/provider/route。

### Step 2：更新隔离 acceptance 的历史 pending 断言

该脚本当前没有独立单测入口，因此本步骤的 RED 是：registry 晋升后、脚本仍保留 pending 断言时，直接运行：

```powershell
npm run acceptance:plugin:isolated
```

Expected：因旧 pending 断言失败。再改为用新全通过注册表验证固定 Gemini 10808 与一个 direct Pi profile 的 fake 调用，保持仅临时 `CODEX_HOME`；同一命令转 GREEN，并审阅它重写的 `docs/release/plugin-isolated-state.md`。若集成 RED 无法精确定位，则先抽取 TS helper 并新增明确测试，不得先改生产脚本。

### Step 3：重建全部证据索引与 `ready` 包

三份 smoke 索引必须只把新批次作为当前资格来源；旧 evidence 明确留作历史。README、operations、checklist、migration 和状态包统一为：

- raw 10/10；
- pairwise 10/10；
- Layer 3 passed；
- Layer 4 尚未执行；
  -当前仍未真实安装；
- Task 8 的 `ready` 只表示可以向用户准备逐动作安装授权，不表示已授权。

### Step 4：外部只读审阅

严格串行、输出在 workspace 外：

1. `kimi-k3` 聚焦审阅新 manifest、证据索引和 `ready` 包；
2. `ark-agent-plan` 聚焦审阅同一最小文件集。

每次都要求 `filesChanged=[]`；超时/基础设施失败记为无结论，不伪装 PASS，不循环重试。Codex 逐条验证并只吸收成立问题。

### Step 5：最终 fresh verification

```powershell
npm run verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/<batchId>/manifest.json
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated
npm run verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/<batchId>/manifest.json
git diff --check
git status --short
```

再由独立规格 reviewer 与质量 reviewer 复核。完成后提交：

```powershell
git add src test scripts docs README.md AGENTS.md
git commit -m "feat: qualify all external llm routes"
```

### Step 6：停在真实安装授权前

向用户提供中文最小充分审阅材料：

- batchId/commit/build identity；
- 10/10 新 evidence 与 verifier 结果；
  -确定性/隔离/外审结果；
  -预计官方 add 对活动 Codex 的语义变化；
  -逐动作验证与回滚边界。

不得在本任务执行 marketplace/plugin add/remove；Task 9 仍需用户针对那一次真实操作另行明确授权。
