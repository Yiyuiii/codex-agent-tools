# Stdio Lifecycle and Native Execution Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Kimi/Pi 在调用方未显式传入 `timeoutMs` 时按外部 CLI 原生预算持续执行，同时把 MCP stdio 断开、宿主信号和显式取消可靠传播到在途任务，并在 owned 进程树清理完成后才结束会话。

**Architecture:** 执行预算与连接生命周期分成两条独立通道：公共 schema 只保留单次可选 `timeoutMs`，adapter/client 不再从 profile 注入默认上限；一个可取消、可分段的 deadline 调度器仅服务显式 timeout。MCP 侧用会话协调器持有 server、stdio transport、流监听器、宿主信号监听器和在途 handler 集合；首次关闭事件调用 `server.close()` 触发 SDK request abort，再等待 handler 的 adapter `finally` 完成 owned 进程回收，最后移除监听器并自然退出。

**Tech Stack:** TypeScript 5.9、Node.js 20+、Vitest 4、`@modelcontextprotocol/sdk` 1.30、`@agentclientprotocol/sdk` 1.2、`execa` 9、Zod 4、tsup、GitHub Actions npm Trusted Publishing。

---

## 执行上下文与不可变边界

- 实施分支：`codex/stdio-lifecycle-and-native-budget`
- 隔离 worktree：`<isolated-worktree>`
- 批准规格：`docs/superpowers/specs/2026-07-31-stdio-lifecycle-and-native-execution-budget-design.md`
- 基线：53 个测试文件，891 passed / 1 skipped / 0 failed；单 worker 全量用时约 425 秒。
- 不读取或修改活动 `~/.codex/config.toml`。
- 不修改相邻仓库 `codex-cc-tools`、本机 Claude Code、旧 `codex_cc_tools` 或用户 Kimi/Pi 全局配置。
- 不给外部 CLI 增加全局或持久化的 step、turn、tool-call、context、token、duration 上限。
- 不在本计划中关闭 Pi 生产默认 auto retry；资格模式继续显式 no-retry。
- 不通过本地 `npm publish` 发布；beta 与 stable 都由现有 GitHub Actions Trusted Publishing 工作流根据 tag 自动发布。
- 不改写历史 batch、manifest 或 evidence；新的源码指纹必须使旧能力索引 fail closed。
- 每个行为改动先出现目标失败测试，再写最小实现。

### 执行修正（2026-07-31）

- Task 1 已由 `2224c9d` 与测试补强提交 `bd0db4d` 完成。
- Task 2 与 Task 3 在实现时确认存在不可拆分的类型依赖：从 `LlmProfile` 删除
  `timeoutMs` 会立即要求 adapter、client 与 smoke 同步改用可选单次值，否则中间提交无法通过
  类型检查。因此两项按一个原子 TDD 批次由 `7ac2d7a` 完成，测试边界再由 `c221a6e`
  加固；这不改变两项各自的规格范围。
- Task 1 新增共享运行时源码后，已签入的八项 capability fingerprint 从该提交起就应
  fail closed；Task 2/3 又进一步改变 profile 与 adapter 输入。Task 9 生成并晋级新证据前，
  `npm run verify:capabilities` 退出 1 且只输出固定脱敏错误是权威预期状态。期间只允许精确
  排除该 live checked-in gate 来运行 capability 单元测试；不得把旧索引改成通过、把门禁
  永久 skip，或从发布验收中删除 verifier。
- Task 4 已由 `a2f7d28` 实现在途 handler 与可取消 progress drain。规格复审命中的
  Promise 微任务提前 drain 竞态及 review/delegate 测试缺口由 `f0c71f7` 修复，质量复审的
  同步 progress notification 抛错覆盖由 `10322a5` 补齐；最终规格与质量复审均通过，父线程
  聚焦验证为 16/16。
- Task 5 已由 `90a2253` 实现幂等 stdio session shutdown、同一 tracker 的 server 接线与
  顶层脱敏错误。规格复审复现的 listener cleanup 抛错导致 completion 错误 resolve/pending
  问题由 `7395a05` 修复；五项自有 listener 现在逐项 best-effort 清理，connect/close/drain/
  stdin 首错保持不变。最终规格与质量复审均通过，父线程聚焦验证为 28/28。
- Task 6 已由 `f87104a` 建立真实 `StdioServerTransport → MCP tool → service → adapter →
  client → fake executable` 的取消链，并由 `db2f947`、`c4004b5`、`599b1ba` 逐轮加固。
  Kimi 的 root、carrier、grandchild 三层与 Pi 的 root、grandchild 两层都会在 stdin 断开前
  捕获 `PID + startTime`，client 与 session 只有在完整 owned tree 归零后才返回。测试 teardown
  只会终止断开前已记录且当前 startTime 精确匹配的进程；未知晚到 PID、格式损坏或不可读的
  PID 证据一律不重新认领、不终止，并报告失败、保留现场。最终规格与三轮质量闭环均通过，
  父线程 fresh 验证为 5 文件 63/63、类型检查通过、专用临时目录残留 0；没有真实模型调用、
  生产执行预算变化、活动配置/插件修改或发布。
- Task 7 已由 `5a6104f` 同步现行执行预算、stdio 取消、stale 能力状态、打包清单与发布
  门禁；规格审阅发现的 beta.2 循环依赖、现行索引与不可变 evidence 混淆由 `2804166`
  修正，active plan 两处歧义由 `0165146` 勘误。质量审阅发现 packaged plan 的机器路径、
  CRLF 章节解析、跨函数正则假绿与历史/现行状态漂移，分别由 `fd3b3a6`、`0628213`
  以 TDD 闭合。最终规格复审 PASS，质量复审 Ready: Yes；父线程 fresh 验证为 2 文件
  39/39、类型检查和构建通过、dry-run pack 230 files、批准 design/plan 各精确 1 项、
  持久 tgz 0、打包文档 Windows 绝对路径 0、隐藏全局限制 0。旧能力索引仍按预期以
  code 1、空 stdout 与固定脱敏 stderr fail closed；Task 9 新 8/8 evidence 前不得转绿。
  本阶段没有真实模型、发布、网络后端、活动配置或插件变更。
- Task 8 的确定性矩阵已先完成两项门禁修正。`4b1f8f3` 删除了通用单元测试里重复的
  live current-index readiness 断言，但没有弱化独立 capability verifier 或 release smoke；
  随后全量单 worker 结果为 58 files、951 passed / 1 skipped / 0 failed。`4102b6a`
  把离线矩阵改为纯 local helper 单测和隔离插件 `--check-report`；此前因计划误分类而误跑
  `acceptance:local` 触发的真实调用不计 Task 8 证据，临时清理后 Kimi ACP、Pi RPC、
  real-smoke 目标进程均为 0，qualification lock absent。`5d78d0f` 又精确排除三个 Codex
  CLI `arg0` shim，使隔离报告在三次只读复验及后续 check 中稳定通过；首次漂移的根因目前
  只有高置信时序候选，未被证实。
- Task 8 的 Ark `cc_review` 因 429 没有产生审阅意见；Kimi `external_review` 被当前已安装
  beta.1/宿主调用链在 300 秒截断，也没有意见，并留下了该次精确 owned Kimi ACP。父线程
  只按 PID、命令与精确 start time 清理该 ACP，未触碰 Kimi Desktop，目标计数随后回到 0。
  这次运行只证明旧公开 beta.1 调用路径的行为，不计候选验收，也不能冒充候选修复已通过。
- 两轮内部独立审阅命中的 P2 已由 `b03ad6c`、`123a7bd`、`a3fdf03` 以 TDD 闭合：
  pre-ended、pre-destroyed、pre-errored 与 late-error stdin 均有合同覆盖；最终规格审阅 PASS、
  质量审阅 Ready: Yes，父线程复验 4 files 37/37 与 typecheck，并有额外 34 次时序探针通过。
  但质量审阅仍留下 Task 9 前必须闭合的 P1：Windows 生产 `terminateProcessTree` 只按 PID，
  root 先退出时可能留下 orphan，PID 复用时可能误杀。该风险是审阅结论，不是已由真实事故
  证实的根因；基于 Windows Job Object 的新设计已请求维护者明确批准，当前尚未获批或实现。
  因此 Task 9 与 beta 发布仍 blocked。现行 capability index 与历史 evidence 未改，verifier
  继续 stale fail closed；本阶段未发布、推送或更新配置/插件。

## Task 1：建立只服务显式 timeout 的分段 deadline 调度器

**Files**

- Create: `src/runtime/deadline.ts`
- Create: `test/runtime/deadline.test.ts`

- [ ] **Step 1：写出 deadline 调度器的失败测试**

测试固定四个合同：

1. `timeoutMs === undefined` 时不创建 timer；
2. 大于 Node 单 timer 上限的安全整数会被分段，不会溢出为 1ms 或提前触发；
3. 最后一段真正到期时只调用一次回调；
4. `cancel()` 幂等并清除当前分段。

测试主体使用 Vitest fake timers，代码形态如下：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_TIMER_DELAY_MS,
  scheduleDeadline,
} from "../../src/runtime/deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleDeadline", () => {
  it("does not create a timer without an explicit timeout", () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();

    const deadline = scheduleDeadline(undefined, onElapsed);

    expect(vi.getTimerCount()).toBe(0);
    deadline.cancel();
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("chunks delays above the Node timer limit without firing early", async () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();
    const timeoutMs = MAX_TIMER_DELAY_MS + 250;

    scheduleDeadline(timeoutMs, onElapsed);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(onElapsed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(onElapsed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onElapsed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the active chunk idempotently", async () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();
    const deadline = scheduleDeadline(
      MAX_TIMER_DELAY_MS + 250,
      onElapsed,
    );

    deadline.cancel();
    deadline.cancel();
    await vi.runAllTimersAsync();

    expect(onElapsed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
```

- [ ] **Step 2：运行红灯**

```powershell
npx vitest run test/runtime/deadline.test.ts
```

预期：测试因 `src/runtime/deadline.ts` 不存在而失败。

- [ ] **Step 3：实现最小分段调度器**

实现必须用单调时钟上的“剩余时长”，而不是 `Date.now() + timeoutMs`，避免系统时钟跳变，
也避免把 `Number.MAX_SAFE_INTEGER` 与当前 epoch 相加后失去整数精度：

```ts
import { performance } from "node:perf_hooks";

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface CancellableDeadline {
  cancel(): void;
}

export function scheduleDeadline(
  timeoutMs: number | undefined,
  onElapsed: () => void,
): CancellableDeadline {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  let remainingMs = timeoutMs;
  let armedAt = 0;

  const arm = (): void => {
    if (cancelled || remainingMs === undefined) return;
    const delayMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
    armedAt = performance.now();
    timer = setTimeout(() => {
      timer = undefined;
      if (cancelled || remainingMs === undefined) return;
      const elapsedMs = Math.max(0, performance.now() - armedAt);
      remainingMs = Math.max(0, remainingMs - elapsedMs);
      if (remainingMs === 0) {
        cancelled = true;
        onElapsed();
        return;
      }
      arm();
    }, delayMs);
  };

  arm();

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
```

若 fake timer 暴露“恰好到段末但 `performance.now()` 尚未推进”的平台差异，只允许把单调
clock/timer 函数抽成模块内可注入依赖；不得改回单个超大 timer，也不得增加产品最大时长。

- [ ] **Step 4：运行绿灯与类型检查**

```powershell
npx vitest run test/runtime/deadline.test.ts
npm run typecheck
```

预期：deadline 测试全绿；类型检查通过。

- [ ] **Step 5：提交原子变更**

```powershell
git add src/runtime/deadline.ts test/runtime/deadline.test.ts
git commit -m "feat: add cancellable chunked deadlines"
```

## Task 2：移除 profile 默认时限并扩展公共单次 timeout 合同

**Files**

- Modify: `src/domain/types.ts`
- Modify: `src/llms/registry.ts`
- Modify: `src/tasks/schemas.ts`
- Modify: `src/qualification/capability-index.ts`
- Modify: `test/tasks/schemas.test.ts`
- Modify: `test/llms/registry.test.ts`
- Modify: `test/qualification/capability-index.test.ts`
- Modify: `test/adapters/pi/adapter.test.ts`

- [ ] **Step 1：先更新 schema 失败测试**

把“global timeout range”测试改为“optional per-call safe integer timeout”，覆盖：

```ts
it("accepts only optional per-call safe integer timeouts of at least one second", () => {
  const base = {
    llm: "kimi-k3",
    prompt: "Continue",
    cwd: process.cwd(),
  };

  expect(externalDelegateInputSchema.safeParse(base).success).toBe(true);
  expect(
    externalDelegateInputSchema.safeParse({
      ...base,
      timeoutMs: 900_001,
    }).success,
  ).toBe(true);
  expect(
    externalDelegateInputSchema.safeParse({
      ...base,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    }).success,
  ).toBe(true);
  for (const timeoutMs of [
    999,
    1_000.5,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(
      externalDelegateInputSchema.safeParse({
        ...base,
        timeoutMs,
      }).success,
    ).toBe(false);
  }
});
```

- [ ] **Step 2：先更新 profile 与指纹失败测试**

从 registry 期望对象、测试 helper `profile()` / `codingProfile()` 和
`CapabilityFingerprintProfile` fixture 中删除 `timeoutMs`。增加类型断言，固定 profile
不再承载执行预算：

```ts
const profile = resolveLlm("kimi-k3");
expect(profile).not.toHaveProperty("timeoutMs");
expectTypeOf<LlmProfile>().not.toHaveProperty("timeoutMs");
```

在指纹测试中固定规范化 profile 仅包含模型身份、route、凭据目标、并发合同，不再包含
资格开关或执行时限。

- [ ] **Step 3：运行红灯**

```powershell
npx vitest run test/tasks/schemas.test.ts test/llms/registry.test.ts test/qualification/capability-index.test.ts test/adapters/pi/adapter.test.ts
npm run typecheck
```

预期：

- 900,001 和 `Number.MAX_SAFE_INTEGER` 被现有 `.max(900_000)` 拒绝；
- `LlmProfile` 与 registry 仍含 `timeoutMs`；
- capability profile 投影仍要求 `timeoutMs`。

- [ ] **Step 4：做最小合同修改**

`src/tasks/schemas.ts` 使用平台安全整数边界，不设置产品时长上限：

```ts
timeoutMs: z
  .number()
  .int()
  .min(1_000)
  .max(Number.MAX_SAFE_INTEGER)
  .optional(),
```

`Number.MAX_SAFE_INTEGER` 只是 JavaScript 精确整数表示边界，不是外部 CLI 的产品预算。

从 `LlmProfile`、四个 `DEFAULT_PROFILES`、`CapabilityFingerprintProfile`、
`normalizedFingerprintProfile()` 和 `fingerprintProfile()` 删除 `timeoutMs`。不要用新的
`defaultTimeoutMs`、环境变量、manifest 字段或常量替代。

- [ ] **Step 5：验证聚焦范围**

```powershell
npx vitest run test/tasks/schemas.test.ts test/llms/registry.test.ts test/qualification/capability-index.test.ts test/adapters/pi/adapter.test.ts
npm run typecheck
```

预期：聚焦测试和类型检查全绿。

- [ ] **Step 6：明确记录能力索引已失效**

```powershell
npm run verify:capabilities
```

预期：退出码 1，stderr 只含固定脱敏错误
`Capability qualification verification failed`。这是正确中间状态：profile 投影和共享运行输入
已变化，不能修改 verifier 或复用旧指纹让命令转绿。

- [ ] **Step 7：提交原子变更**

```powershell
git add src/domain/types.ts src/llms/registry.ts src/tasks/schemas.ts src/qualification/capability-index.ts test/tasks/schemas.test.ts test/llms/registry.test.ts test/qualification/capability-index.test.ts test/adapters/pi/adapter.test.ts
git commit -m "refactor: remove profile execution deadlines"
```

## Task 3：让 Kimi/Pi adapter、client 与 smoke 只透传显式 timeout

**Files**

- Modify: `src/adapters/kimi/adapter.ts`
- Modify: `src/adapters/kimi/client.ts`
- Modify: `src/adapters/pi/adapter.ts`
- Modify: `src/adapters/pi/client.ts`
- Modify: `src/smoke/kimi.ts`
- Modify: `src/smoke/pi.ts`
- Modify: `test/adapters/kimi/adapter.test.ts`
- Modify: `test/adapters/kimi/client.test.ts`
- Modify: `test/adapters/kimi/client-cleanup.test.ts`
- Modify: `test/adapters/pi/adapter.test.ts`
- Modify: `test/adapters/pi/client.test.ts`

- [ ] **Step 1：先写 adapter 失败测试**

Kimi 与 Pi 各覆盖“未提供则字段不存在”和“大显式值原样透传”：

```ts
it("does not inject a timeout when the caller omits it", async () => {
  await adapter.run({
    profile,
    task: "review",
    cwd: process.cwd(),
    prompt: "Review",
    parentEnvironment: { PATH: "x" },
  });

  expect(runClient.mock.calls[0]![0]).not.toHaveProperty("timeoutMs");
});

it("passes an explicit timeout without profile clipping", async () => {
  await adapter.run({
    profile,
    task: "review",
    cwd: process.cwd(),
    prompt: "Review",
    timeoutMs: 1_800_000,
    parentEnvironment: { PATH: "x" },
  });

  expect(runClient.mock.calls[0]![0].timeoutMs).toBe(1_800_000);
});
```

现有 Kimi “固定为 600,000”断言与 Pi “固定为 900,000”断言必须先失败，再改实现。

- [ ] **Step 2：先写 client 失败测试**

把 `KimiAcpRunRequest.timeoutMs` 与 `PiRpcRunRequest.timeoutMs` 改成可选之后，增加无 timeout
的 hold 场景：

```ts
const controller = new AbortController();
const running = runKimiAcp({
  ...baseRequest,
  timeoutMs: undefined,
  signal: controller.signal,
  onProgress: (message) => {
    if (message === "kimi prompt started") controller.abort();
  },
});
const result = await running;
expect(result.status).toBe("cancelled");
```

由于启用了 `exactOptionalPropertyTypes`，实际测试对象应通过解构删除字段，而不是显式写
`timeoutMs: undefined`：

```ts
const { timeoutMs: _timeoutMs, ...withoutTimeout } = baseRequest;
```

Pi 使用同样模式。保留现有 100ms/75ms 显式 hard deadline 用例，继续断言
`timed_out`；保留 caller abort 用例，继续断言 `cancelled`。新增 `vi.spyOn(globalThis,
"setTimeout")` 不能简单断言调用次数，因为 heartbeat、termination grace 和 fake runtime
也使用 timer；是否创建 deadline 由 Task 1 单元测试和请求缺失字段共同证明。

- [ ] **Step 3：先写 smoke 输入失败测试**

在现有 smoke 测试中注入 fake service：

- `options.timeoutMs` 缺失时，传给 `service.review` / `service.delegate` 的 input 不含
  `timeoutMs`；
- 显式 `timeoutMs: 1_800_000` 时原样存在；
- 资格入口当前若显式给 timeout，仍只属于该次调用。

- [ ] **Step 4：运行红灯**

```powershell
npx vitest run test/adapters/kimi/adapter.test.ts test/adapters/kimi/client.test.ts test/adapters/kimi/client-cleanup.test.ts test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts test/smoke/kimi.test.ts test/smoke/pi.test.ts
```

预期：adapter 仍注入/裁剪 profile timeout，client 类型仍要求 timeout，smoke 仍回退到
profile timeout。

- [ ] **Step 5：最小修改 adapter**

Kimi/Pi client request 基础对象不含 `timeoutMs`，只在调用方提供时添加：

```ts
const clientRequest: KimiAcpRunRequest = {
  executable,
  args: ["acp"],
  task: request.task,
  cwd: request.cwd,
  prompt: request.prompt,
  model: request.profile.model,
  environment: childEnvironment,
  secretValues,
};
if (request.timeoutMs !== undefined) {
  clientRequest.timeoutMs = request.timeoutMs;
}
```

Pi 使用同样条件赋值。删除两处 `Math.min(...)`，不引入 fallback、clip 或默认值。

- [ ] **Step 6：最小修改 client**

两个 request interface 都改为：

```ts
timeoutMs?: number;
```

导入 Task 1 的调度器：

```ts
const deadline = scheduleDeadline(
  request.timeoutMs,
  () => cancel("timed_out"),
);
```

在 `finally` 中用：

```ts
deadline.cancel();
```

替换 `clearTimeout(deadline)`。caller signal 继续调用 `cancel("cancelled")`；只有 deadline
回调调用 `cancel("timed_out")`。不要改变 heartbeat、局部 `terminationGraceMs`、Kimi
ACP session cancel、Pi RPC abort 或 `terminateProcessTree` 合同。

- [ ] **Step 7：最小修改 smoke**

删除：

```ts
const timeoutMs = options.timeoutMs ?? profile.timeoutMs;
```

构造任务 input 后，仅在 `options.timeoutMs !== undefined` 时添加该字段。不要让真实 smoke、
资格 runner 或 profile 自动获得执行时长上限。

- [ ] **Step 8：运行聚焦绿灯**

```powershell
npx vitest run test/adapters/kimi/adapter.test.ts test/adapters/kimi/client.test.ts test/adapters/kimi/client-cleanup.test.ts test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts
npx vitest run test/smoke/kimi.test.ts test/smoke/pi.test.ts
npm run typecheck
```

预期：显式 timeout 为 `timed_out`；caller abort 为 `cancelled`；缺失 timeout 不再从任何
profile 或 smoke 注入。

- [ ] **Step 9：提交原子变更**

```powershell
git add src/adapters/kimi/adapter.ts src/adapters/kimi/client.ts src/adapters/pi/adapter.ts src/adapters/pi/client.ts src/smoke/kimi.ts src/smoke/pi.ts test/adapters/kimi/adapter.test.ts test/adapters/kimi/client.test.ts test/adapters/kimi/client-cleanup.test.ts test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts
git add test/smoke/kimi.test.ts test/smoke/pi.test.ts
git commit -m "feat: preserve native external execution budgets"
```

## Task 4：跟踪真实 MCP handler promise 并提供无上限 drain

**Files**

- Create: `src/mcp/in-flight.ts`
- Create: `test/mcp/in-flight.test.ts`
- Modify: `src/mcp/progress.ts`
- Create: `test/mcp/progress.test.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `test/mcp/server.test.ts`

- [ ] **Step 1：写 in-flight tracker 失败测试**

```ts
import { describe, expect, it, vi } from "vitest";

import { InFlightTasks } from "../../src/mcp/in-flight.js";

describe("InFlightTasks", () => {
  it("drains every tracked task and removes settled tasks", async () => {
    const tracker = new InFlightTasks();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const tracked = tracker.track(pending);
    let drained = false;
    const drain = tracker.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await Promise.all([tracked, drain]);
    expect(tracker.size).toBe(0);
  });

  it("drains rejected tasks without creating an unhandled rejection", async () => {
    const tracker = new InFlightTasks();
    const tracked = tracker.track(Promise.reject(new Error("expected")));
    await expect(tracked).rejects.toThrow("expected");
    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(tracker.size).toBe(0);
  });
});
```

- [ ] **Step 2：让 tool registration 测试先失败**

给 `registerExternalTools` 传入 tracker。启动一个未完成 review handler，断言
`tracker.drain()` 在 service settle 前不完成，并在 handler 完成/失败后归零。保留现有
`extra.signal` 和 progress 测试。

- [ ] **Step 3：锁定连接关闭时 progress 不阻塞 drain**

真实 stdio 在 stdout backpressure 时，SDK notification promise 可能等待 `drain`；stdin
已经断开后不能让这个非模型 promise 永远卡住 handler finally。写失败测试：

```ts
it("stops waiting for progress delivery after authoritative request abort", async () => {
  const controller = new AbortController();
  const reporter = createMcpProgressReporter({
    signal: controller.signal,
    _meta: { progressToken: "progress-1" },
    sendNotification: () => new Promise<void>(() => undefined),
  });
  reporter.report("running");

  let finished = false;
  const finishing = reporter.finish().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);

  controller.abort();
  await finishing;
  expect(finished).toBe(true);
});
```

再加反例：`sendNotification` 自身 reject 只被吞掉并让 `finish()` 完成，不能触发或伪造
request cancellation。

- [ ] **Step 4：运行红灯**

```powershell
npx vitest run test/mcp/in-flight.test.ts test/mcp/progress.test.ts test/mcp/server.test.ts
```

预期：模块不存在，`registerExternalTools` 也不接受 tracker。

- [ ] **Step 5：实现最小 tracker**

```ts
export class InFlightTasks {
  readonly #tasks = new Set<Promise<unknown>>();

  public get size(): number {
    return this.#tasks.size;
  }

  public track<T>(task: Promise<T>): Promise<T> {
    this.#tasks.add(task);
    void task.finally(() => {
      this.#tasks.delete(task);
    }).catch(() => undefined);
    return task;
  }

  public async drain(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }
}
```

这里没有 timer、watchdog、持久化、重试、resume、replay 或跨进程锁。

- [ ] **Step 6：让 progress finish 响应权威 request abort**

`ProgressExtra` 接受 `signal?: AbortSignal`。report 在 signal aborted 后不再发送；finish
等待“所有已发 notification settle”或“request signal abort”两者先发生，并在正常完成时移除
自己的 abort listener。pending notification promise 自己继续带 `.catch(() => undefined)`，
所以 finish 提前返回不会制造 unhandled rejection。

这里用的是 SDK request signal，不是 progress failure；因此完全保持“progress 错误本身不是
cancellation”的批准语义，也不新增 timer/watchdog。

- [ ] **Step 7：在 tool handler 最外层登记 promise**

`registerExternalTools` 增加可选 tracker 参数，默认创建 session-local tracker 只用于不经
`serveMcp` 的单元测试兼容。把每个 handler 的完整异步操作（包括 `progress.finish()`）交给
`tracker.track(...)`：

```ts
(_input, _extra) =>
  inFlight.track(
    (async () => {
      const progress = createMcpProgressReporter(_extra);
      try {
        // 原有 service 调用、schema parse 与结构化返回。
      } finally {
        await progress.finish();
      }
    })(),
  )
```

不要把 progress notification 发送失败解释为 caller cancel；只有 `extra.signal` abort 能让
finish 放弃等待不可达 transport。

- [ ] **Step 8：运行绿灯与类型检查**

```powershell
npx vitest run test/mcp/in-flight.test.ts test/mcp/progress.test.ts test/mcp/server.test.ts
npm run typecheck
```

- [ ] **Step 9：提交原子变更**

```powershell
git add src/mcp/in-flight.ts src/mcp/progress.ts src/mcp/tools.ts test/mcp/in-flight.test.ts test/mcp/progress.test.ts test/mcp/server.test.ts
git commit -m "feat: track in-flight MCP handlers"
```

## Task 5：实现幂等 stdio session shutdown

**Files**

- Create: `src/mcp/stdio-session.ts`
- Create: `test/mcp/stdio-session.test.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/main.ts`

- [ ] **Step 1：定义可测试的 session 边界**

`src/mcp/stdio-session.ts` 对生产与测试暴露：

```ts
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { InFlightTasks } from "./in-flight.js";

export interface McpSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface McpStdioSessionDependencies {
  server: McpServer;
  transport: StdioServerTransport;
  input: Readable;
  output: Writable;
  inFlight: InFlightTasks;
  signalSource: McpSignalSource;
  reportError?: (message: string) => void;
}

export interface McpStdioSession {
  run(): Promise<void>;
  close(): Promise<void>;
}
```

`output` 被显式持有以固定所有权和测试注入边界，即使 shutdown 不主动 end stdout。

- [ ] **Step 2：写关闭顺序失败测试**

用 fake server/transport、`PassThrough` 与 deferred handler 固定顺序：

```ts
expect(events).toEqual([
  "server.close",
  "handler.cancel",
  "handler.settle",
  "listeners.removed",
]);
```

至少覆盖：

- stdin `end`；
- stdin `close`；
- stdin `error`；
- `SIGINT`；
- `SIGTERM`；
- 显式 `session.close()`；
- `end` 后紧接 `close` 只执行一次 `server.close()`；
- handler 未 settle 时 `run()`/`close()` 均不提前完成；
- connect 之前同步触发关闭也会在 connect 完成后执行真实 shutdown；
- `server.connect()` 失败时移除本 session 安装的所有监听器并拒绝 `run()`；
- `server.close()` 或 `drain()` 失败时仍移除监听器，错误只经脱敏报告/Promise 传播。

- [ ] **Step 3：运行红灯**

```powershell
npx vitest run test/mcp/stdio-session.test.ts
```

预期：session 模块不存在。

- [ ] **Step 4：实现首次事件获胜的 shutdown 状态机**

实现结构必须满足“close 失败也不能跳过 drain”的顺序：

```ts
let connected = false;
let closeRequested = false;
let shutdownPromise: Promise<void> | undefined;

const shutdown = (): Promise<void> => {
  closeRequested = true;
  if (!connected) return completion.promise;
  shutdownPromise ??= (async () => {
    let failure: unknown;
    try {
      await server.close();
    } catch (error) {
      failure = error;
    }
    try {
      await inFlight.drain();
    } catch (error) {
      failure ??= error;
    } finally {
      removeListeners();
    }
    if (failure !== undefined) throw failure;
  })();
  return shutdownPromise;
};
```

实际实现可用一个 deferred completion 把 connect 前的 close request 与上面的
`shutdownPromise` 连接起来；completion 只能 settle 一次，`run()` 必须看到
connect/close/drain 错误，监听器始终在 `finally` 移除。所有 stream/signal listener 使用保存
的同一函数引用，禁止 `removeAllListeners()` 影响宿主其它逻辑。

关闭顺序固定：

1. 标记 `closeRequested`；
2. connect 已完成后调用一次 `server.close()`；
3. SDK transport `onclose` abort 全部在途 request handler；
4. `await inFlight.drain()`；
5. 移除本 session 的 `end`/`close`/`error`/`SIGINT`/`SIGTERM` listeners；
6. resolve/reject session completion。

不增加 drain 最大时长或 `process.exit()`。

- [ ] **Step 5：接入 `serveMcp()`**

`createMcpServer` 接受 session 创建的同一个 `InFlightTasks`；`serveMcp` 创建
`StdioServerTransport(process.stdin, process.stdout)` 和 session，然后：

```ts
await session.run();
```

生产 signal source 使用 `process`。`src/mcp/main.ts` 只保留顶层脱敏错误输出与
`process.exitCode = 1`，不得强制 kill 外部 CLI，也不得增加全局退出 timer。

- [ ] **Step 6：运行聚焦绿灯**

```powershell
npx vitest run test/mcp/stdio-session.test.ts test/mcp/server.test.ts test/mcp/in-flight.test.ts
npm run typecheck
```

- [ ] **Step 7：提交原子变更**

```powershell
git add src/mcp/stdio-session.ts src/mcp/server.ts src/mcp/main.ts test/mcp/stdio-session.test.ts
git commit -m "feat: coordinate stdio session shutdown"
```

## Task 6：用真实 StdioServerTransport 和 fake owned 进程树闭合取消链

**Files**

- Create: `test/mcp/stdio-process-cleanup.test.ts`
- Modify: `test/fakes/fake-kimi-acp.mjs`
- Modify: `test/fakes/fake-pi-rpc.mjs`

- [ ] **Step 1：写 JSONL stdio 测试 helper**

测试必须用注入的 `PassThrough` 驱动真正
`StdioServerTransport(input, output)`，依次发送：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"stdio-test","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"external_review","arguments":{"llm":"kimi-k3","task":"review_plan","prompt":"hold","cwd":"<isolated-test-cwd>"}}}
```

第三条中的 `cwd` 只是合法 JSONL 形态示例；实际测试必须由 `mkdtemp` 得到路径并经
`JSON.stringify` 生成，不能复制示例路径。helper 等待 initialize response 后才发
initialized/call；等待 fake client
报告“prompt started”后调用 `input.end()`。

- [ ] **Step 2：写 Kimi 失败测试**

fake Kimi 使用 `FAKE_KIMI_SCENARIO=hang`，并在启用
`FAKE_KIMI_CHILD_PID_FILE` 时启动现有 `spawn-grandchild.mjs`、写出 child PID。service
应走真实 `KimiAdapter` / `runKimiAcp`，仅 locator 与环境指向 fake executable；不得直接
伪造 `cancelled` 结果。

断言：

- stdin end 后 request signal aborted；
- Kimi 结果为 `cancelled` 而非 `timed_out`；
- ACP root 和 grandchild 都不可存活；
- session `run()` 只在 Kimi `finally` 完成后 resolve；
- 没有第二个 Kimi invocation；
- 临时目录只含测试预期文件。

- [ ] **Step 3：写 Pi 失败测试**

fake Pi 使用现有 `FAKE_PI_SCENARIO=hold` 与 `FAKE_PI_CHILD_PID_FILE`。service 走真实
`PiAdapter` / `runPiRpc`，`buildConfig` 和 locator 指向隔离 fake 配置。

断言：

- stdin end 触发一次 Pi RPC `abort`；
- 结果为 `cancelled`；
- RPC root 和 grandchild 都不可存活；
- session 等待 adapter `finally`；
- `adapterClientInvocationCount === 1`；
- 生产 retry 默认未被测试实现改写。

- [ ] **Step 4：Windows 测试清理边界**

每个测试把精确 root/grandchild PID 记录到本地数组。`afterEach` 只对仍存活的这些 PID 调用
项目已有 `terminateProcessTree`，再删除已验证位于 `os.tmpdir()` 下且带专用前缀的目录。
禁止按 `node.exe`、`kimi`、`pi` 或命令行片段全机清理。

- [ ] **Step 5：运行红灯**

```powershell
npx vitest run test/mcp/stdio-process-cleanup.test.ts
```

预期：现有 `serveMcp()` 不等待 stdio close/drain，至少 Kimi/Pi 之一留下活跃 owned PID 或
session 提前完成。

- [ ] **Step 6：只补 fake fixture 所需能力**

不要在生产路径增加测试开关。fake fixture 只在相应 PID-file 环境变量存在时生成 grandchild；
默认场景和现有 adapter tests 保持不变。

- [ ] **Step 7：运行绿灯和取消回归**

```powershell
npx vitest run test/mcp/stdio-process-cleanup.test.ts test/mcp/stdio-session.test.ts test/adapters/kimi/client.test.ts test/adapters/kimi/client-cleanup.test.ts test/adapters/pi/client.test.ts
npm run typecheck
```

- [ ] **Step 8：提交原子变更**

```powershell
git add test/mcp/stdio-process-cleanup.test.ts test/fakes/fake-kimi-acp.mjs test/fakes/fake-pi-rpc.mjs
git commit -m "test: prove stdio cancellation cleans owned trees"
```

## Task 7：同步有效文档、发布门禁与 stale 能力状态

**Files**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/release/real-host-acceptance.md`
- Modify: `docs/release/four-llm-qualification-execution-runbook.md`
- Modify: `docs/smoke/kimi.md`
- Modify: `docs/smoke/pi-gemini.md`
- Modify: `docs/smoke/ark.md`
- Modify: `package.json`
- Modify: `scripts/release-smoke.mjs`
- Modify: 与上述文档断言对应的现有测试文件

- [ ] **Step 1：先写文档/package 失败断言**

用现有 package/release smoke 测试固定：

- 公共输入说明 `timeoutMs` 为单次可选值；
- 缺失时 Kimi/Pi 不设置模型执行 deadline；
- stdio end/close/error 与 SIGINT/SIGTERM 会取消在途任务并等待清理；
- 不存在 profile 600/900 秒上限叙述；
- Pi 生产 native retry 未在本轮关闭；
- handoff 不是 stable Stop gate 的唯一证据；
- Task 9 取得 8/8 passed 并使 verifier green 后，Task 10 通过 GitHub Actions 先把 beta.2 发布到 npm next；Task 11 再做公开 npm/官方插件/完整 App 重启/真实 Stop；Task 11 只阻断 stable，Task 12 才发布 stable。

- [ ] **Step 2：运行文档红灯**

```powershell
rg -n "600_000|900_000|600000|900000|10 minutes|15 minutes|timeout" README.md docs AGENTS.md
npx vitest run test/smoke/script-entrypoints.test.ts test/plugin/artifact.test.ts
```

先区分历史证据/规格中的事实叙述和现行用户文档。历史文档里的旧值不得删除；只有现行合同改为
新语义。

- [ ] **Step 3：同步当前事实**

`AGENTS.md` 明确分三类记录：

- 用户原始要求：外部 CLI 不接受全局预算；
- 事实状态：实现已移除 profile timeout 并建立 stdio shutdown；
- AI 历史总结：beta.1 handoff 暴露的取消缺口和本轮修复证据。

在完成真实资格前，明确写：

- 当前源码变更已使八项能力指纹 stale；Task 7/8 与 Task 9 新证据形成前，`capabilities.json` 保持原样；Task 9 在新批次 8/8 passed 后更新同一索引；历史 batch manifest 与 case evidence 永久不可变；当前 verifier 必须失败；
- 当前分支不可发布；
- 待新 batch passed evidence 后才更新索引。

不要把 registry 的旧 `passed` 文案当作当前候选可发布证据；发布权威是
`verify:capabilities`。

把本轮批准规格与实施计划加入 `package.json.files`：

```text
docs/superpowers/specs/2026-07-31-stdio-lifecycle-and-native-execution-budget-design.md
docs/superpowers/plans/2026-07-31-stdio-lifecycle-and-native-execution-budget.md
```

`scripts/release-smoke.mjs` 和对应测试必须断言两者出现在 dry-run package 清单中；不能因为
新增文档而跳过 `verify:capabilities`。

- [ ] **Step 4：检查没有隐藏新上限**

```powershell
rg -n "maxSteps|maxTurns|maxTool|tokenLimit|contextLimit|defaultTimeout|profile\\.timeoutMs|Math\\.min\\([^\\r\\n]*timeout|timeoutMs:\\s*(600_000|900_000)" src scripts plugins
```

预期：没有本轮禁止的全局/默认执行预算。局部 `terminationGraceMs`、heartbeat、测试 harness
timeout、HTTP/进程清理保护不等于外部 agent 能力上限，逐项人工复核而不是机械删除。

- [ ] **Step 5：运行文档与打包聚焦验证**

```powershell
npx vitest run test/smoke/script-entrypoints.test.ts test/plugin/artifact.test.ts
npm run build
npm pack --dry-run --json
git diff --check
```

`npm pack --dry-run --json` 只生成清单输出，不发布。

- [ ] **Step 6：提交原子变更**

先用 `git status --short` 确认精确文档/测试范围，再逐文件 `git add`：

```powershell
git commit -m "docs: document native execution and stdio cancellation"
```

## Task 8：完整确定性验证与两轮独立审阅

**Files**

- Modify: 仅限审阅命中且先有失败测试的文件
- Create: `docs/release/0.1.1-beta.2-review.md`

- [ ] **Step 1：先跑聚焦矩阵**

```powershell
npx vitest run test/runtime/deadline.test.ts test/tasks/schemas.test.ts test/llms/registry.test.ts test/adapters/kimi/adapter.test.ts test/adapters/kimi/client.test.ts test/adapters/kimi/client-cleanup.test.ts test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts test/mcp/in-flight.test.ts test/mcp/progress.test.ts test/mcp/server.test.ts test/mcp/stdio-session.test.ts test/mcp/stdio-process-cleanup.test.ts
npm run typecheck
npm run build
```

- [ ] **Step 2：单 worker 跑全量测试**

```powershell
npm test -- --maxWorkers=1
```

外层 shell 工具预算至少 600,000ms；这是测试承载预算，不写入 Kimi/Pi 产品配置。预期：
0 failed，现有平台 skip 数不增加。若失败，使用 `superpowers:systematic-debugging`，不得直接放宽
产品 timeout。

- [ ] **Step 3：运行离线发布矩阵**

```powershell
npm run typecheck
npm run build
npx vitest run test/acceptance/local.test.ts
npm run acceptance:plugin:isolated -- --check-report
npm run smoke:release
git diff --check
```

在能力 index 更新前：

- `test/acceptance/local.test.ts` 只验证 local acceptance helper 的纯函数契约，不调用真实模型；
- `acceptance:plugin:isolated -- --check-report` 只用隔离假后端核对既有报告，不更新仓库内报告；
- `smoke:release` 应精确因 stale capability verifier 退出码 1；在此之前的 deterministic 子检查已独立通过，
  且该失败路径不会运行联网 npm 名称检查；
- 不允许跳过、mock 或弱化 capability verifier 来取得伪绿。

**执行更正（2026-07-31）：** 早先版本的本计划把 `acceptance:local` 脚本误分类为离线检查，
执行时意外触发了真实 Kimi/Pi 调用。该结果不计入 Task 8 验收；脚本已清理临时目录，随后审计确认 owned
Kimi、Pi、real-smoke 进程计数均为 0，qualification lock 不存在。Task 8 后续严禁重跑该命令，
只执行上方明确列出的纯单测与隔离假后端检查。

- [ ] **Step 4：用 `cc_review` 审阅规格符合性**

调用旧 `codex_cc_tools` 的 `cc_review`，优先
`providerProfile: "ark_coding_plan"`；若当前周额度仍 429，只记录外部可用性事实，不重试同一
来源，再用本地 Kimi 可用 review 来源做独立审阅。prompt 必须包含：

- 批准规格；
- 本计划；
- `git diff origin/next...HEAD`；
- 聚焦/全量验证摘要；
- 要求只报可复现的 P0/P1/P2；
- 明确检查“是否偷偷引入默认 timeout”和“stdio close 是否真正等待 adapter cleanup”。

Codex 逐条复核。任何采纳项先补失败测试；不成立的建议记录反证。

- [ ] **Step 5：第二轮独立审阅**

用与第一轮不同的可用来源检查：

- Node stream/signals 监听器竞态；
- MCP SDK `server.close()` abort 语义；
- Promise rejection/unhandled rejection；
- Windows owned process-tree cleanup；
- capability fingerprint 与发布门禁是否被绕过。

审阅不得调用 writable delegate，不得修改活动配置或插件。

- [ ] **Step 6：写 beta.2 审阅稿**

`docs/release/0.1.1-beta.2-review.md` 只记录脱敏最小证据：

- 背景与 beta.1 失败；
- 改动范围；
- 无默认 timeout 的机器证据；
- stdio→request abort→adapter cleanup 的测试证据；
- 全量测试结果；
- 两轮外审命中、反驳与修订；
- 八项能力仍 stale，因此此时尚不可发布；
- 后续资格、公开 npm、App 重启和真正 Stop gate。

- [ ] **Step 7：提交审阅收敛**

```powershell
git add docs/release/0.1.1-beta.2-review.md
git commit -m "docs: review stdio lifecycle candidate"
```

若审阅修复产生代码提交，代码应按命中问题分别原子提交，审阅稿最后单独提交。

## Task 9：冻结 clean candidate 并按 standing authorization 重跑八项能力

**Files**

- Create: 标准资格入口在 `docs/smoke/evidence/batches/` 下生成的唯一新 batch 目录
- Modify: `docs/smoke/evidence/capabilities.json`
- Modify: `src/qualification/capability-index.ts`
- Modify: `test/qualification/capability-index.test.ts`
- Modify: `test/qualification/capability-verifier-cli.test.ts`
- Modify: `AGENTS.md`
- Modify: `docs/release/0.1.1-beta.2-review.md`

这里的 batch id 是标准资格入口生成并写入 terminal manifest 的运行时事实，不是待办占位符；
后续命令只使用该次入口返回/落盘的精确值。

- [ ] **Step 1：确认 clean freeze 与实时前置条件**

```powershell
git status --short
git rev-parse HEAD
npm run typecheck
npm test -- --maxWorkers=1
npm run build
```

然后按 `docs/release/four-llm-qualification-execution-runbook.md` 只读确认：

- active long-term goal 存在；
- 资格锁不存在；
- Kimi ACP / Pi RPC / real-smoke 目标进程 0/0/0；
- credentials 只做存在性检查，不输出值；
- 当前 Ark Coding/Agent 可用性已变化；Coding Plan 周额度已知最早于
  2026-08-03 00:00 +0800 重置；
- frozen candidate 与 `git status --short` 精确干净。

若额度/凭据仍阻断，停止在此，不生成伪 evidence，不发布 beta。

- [ ] **Step 2：生成一次性内部执行引用**

在 standing authorization 范围内生成 fresh UUID v4，只把其 SHA-256 交给标准资格协议。明文
不写入文档、日志或 Git。不得复用历史授权 UUID。

```powershell
$freshAuthorizationReference = [guid]::NewGuid().ToString()
```

不要输出该变量。

- [ ] **Step 3：只调用一次标准资格入口**

使用 runbook 规定的一个 `functions.exec` cell、一个前台 shell 和至少 4 小时 shell 承载预算：

```powershell
npm run --silent qualify:gates -- --authorization-ref $freshAuthorizationReference
```

执行期间只用同一个 cell 的短周期 wait；不启动第二入口、第二 batch、watcher、retry、
resume、fallback 或单项补跑。任何 case 失败即接受既有首错停止终态。

- [ ] **Step 4：验证终态与不可变证据**

从唯一 terminal manifest 读取精确 batch id，并运行：

```powershell
$newBatchRelativePath = "docs/smoke/evidence/batches/$batchId"
npm run verify:qualification -- --mode immutable-evidence --manifest $terminalManifestPath
```

要求：

- 八项 case 都是相同 frozen commit/build identity；
- 8/8 passed；
- invocation/retry/fallback/identity/route/credential/file-scope checks 精确通过；
- Kimi ACP / Pi RPC / real-smoke 回到 0/0/0；
- 资格锁释放。

任何一项失败：提交真实 blocked/interrupted evidence，更新状态并停止当前 batch；不得继续发布。

- [ ] **Step 5：更新能力索引但不改历史 evidence**

对 terminal manifest 的八个 passed case 逐项计算：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath $terminalManifestPath
Get-FileHash -Algorithm SHA256 -LiteralPath $caseEvidencePath
```

同时调用现有 `computeCapabilityRuntimeFingerprint` 对八个 `llm × task` 生成当前指纹。用
`apply_patch` 把 `docs/smoke/evidence/capabilities.json` 的八个 source 全部指向这次新 batch
的对应 passed case，并写入：

- 当前 `runtimeFingerprintSha256`；
- 精确 manifest/evidence 仓库相对路径；
- 精确 SHA-256；
- frozen commit；
- build identity。

旧 batch/evidence 文件保持不变。因为八项都已有新 batch evidence，历史
`legacy-standalone` 入口应从活动索引消失；不得删除其历史文件。

- [ ] **Step 6：让能力 verifier 真正转绿**

```powershell
npm run verify:capabilities
npm run verify:qualification -- --mode immutable-evidence --manifest $terminalManifestPath
npm run smoke:release
```

预期：8 entries、0 legacy entries（若 verifier 返回该计数）；release smoke 全绿。若现有
verifier 把 legacy 数硬编码为 1，先在
`test/qualification/capability-index.test.ts` 与
`test/qualification/capability-verifier-cli.test.ts` 写失败断言，再修正为从 entries 实际计数，
不得为了兼容旧索引伪报。

- [ ] **Step 7：提交证据与索引**

```powershell
git status --short
git add -- $newBatchRelativePath
git add docs/smoke/evidence/capabilities.json AGENTS.md docs/release/0.1.1-beta.2-review.md
git add src/qualification/capability-index.ts test/qualification/capability-index.test.ts test/qualification/capability-verifier-cli.test.ts
git commit -m "test: requalify native execution capabilities"
```

提交前确认新增 batch 目录就是唯一标准入口生成的精确目录，没有临时凭据、prompt 正文或未脱敏
错误。

## Task 10：发布 `0.1.1-beta.2` 到 npm `next`

**Files**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.ts`
- Modify: `plugins/codex-external-agents/.codex-plugin/plugin.json`
- Modify: `test/version.test.ts`
- Modify: `test/cli/main.test.ts`
- Modify: `test/qualification/preflight.test.ts`
- Modify: `docs/release/0.1.1-beta.2-review.md`
- Modify: `AGENTS.md`

- [ ] **Step 1：按现有版本脚本把候选改为 beta.2**

```powershell
npm version 0.1.1-beta.2 --no-git-tag-version
```

随后用 `apply_patch` 把 `src/version.ts`、插件 manifest、version/CLI 测试和 qualification
preflight fixture 中的当前候选版本精确改为 `0.1.1-beta.2`。历史 release 文档里的 beta.1
版本不改。运行：

```powershell
npx vitest run test/version.test.ts test/cli/main.test.ts test/qualification/preflight.test.ts test/plugin/artifact.test.ts
```

检查 package、lockfile、runtime 和插件 manifest 的既有一致性测试全绿。

- [ ] **Step 2：最终候选验证**

```powershell
npm ci
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npm run verify:capabilities
npm run smoke:release
npm pack --dry-run --json
git diff --check
```

预期全部通过；不调用真实模型。

- [ ] **Step 3：提交版本候选并进入 `next`**

```powershell
git add package.json package-lock.json src/version.ts plugins/codex-external-agents/.codex-plugin/plugin.json
git add test/version.test.ts test/cli/main.test.ts test/qualification/preflight.test.ts
git add docs/release/0.1.1-beta.2-review.md AGENTS.md
git commit -m "chore: prepare 0.1.1-beta.2"
```

推送当前分支并创建到 `next` 的 PR：

```powershell
git push -u origin codex/stdio-lifecycle-and-native-budget
gh pr create --base next --head codex/stdio-lifecycle-and-native-budget --title "fix: preserve native agent execution across stdio lifecycle" --body-file docs/release/0.1.1-beta.2-review.md
gh pr checks --watch
gh pr merge --merge --delete-branch=false
git fetch origin next
```

只有 GitHub CI 的 Node 20/22/24 matrix 全绿才执行 merge。

- [ ] **Step 4：由 tag 触发 Trusted Publishing**

只在 beta.2 merge commit 已可从 `origin/next` 到达时创建并推送：

```powershell
$beta2CommitSha = git rev-parse origin/next
git tag v0.1.1-beta.2 $beta2CommitSha
git push origin v0.1.1-beta.2
```

现有 `.github/workflows/release.yml` 会因 prerelease tag 自动使用 npm `next` 和 OIDC Trusted
Publishing。不得运行本地 `npm publish`，也不需要本地 npm 发布批准。

- [ ] **Step 5：验证自动化发布结果**

通过 GitHub Actions 检查：

- tag ancestry；
- package/tag version；
- typecheck；
- 单 worker 全量测试；
- release smoke；
- npm OIDC publish；
- registry propagation；
- GitHub prerelease。

再只读验证：

```powershell
npm view codex-agent-tools@0.1.1-beta.2 version
npm view codex-agent-tools@next version
npm view codex-agent-tools@latest version
```

预期 `next=0.1.1-beta.2`，`latest` 仍是 0.1.0。

## Task 11：公开 npm 隔离验收、官方插件升级与真实 App Stop gate

**Files**

- Create: `docs/release/0.1.1-beta.2-npm-acceptance.md`
- Modify: `docs/release/real-host-acceptance.md`
- Modify: `AGENTS.md`

- [ ] **Step 1：从公共 registry 精确版本隔离安装**

先从已发布 beta.2 的 `origin/next` 创建只承载验收证据的分支：

```powershell
git fetch origin next
git switch -c codex/beta-0.1.1-host-acceptance origin/next
```

运行现有公共 registry 精确版本隔离验收：

```powershell
npm run acceptance:npm-package -- --version 0.1.1-beta.2
```

该脚本必须在仓库外专用临时目录和隔离 `CODEX_HOME` 中从公共 registry 安装精确
`codex-agent-tools@0.1.1-beta.2`，不使用本地 tarball、workspace link 或活动 npm 配置。
记录 package integrity、CLI version/doctor、官方临时插件 `--check-report`、插件
cwd/env_vars、MCP 两工具发现、8/8 capability verifier 和目标进程 0/0/0；不调用真实模型。

- [ ] **Step 2：生成活动插件变更审阅材料**

活动插件升级是外部状态动作。按既有官方 remove/add 流程先给出：

- 当前 installed/enabled 版本；
- 目标 beta.2；
- 预计精确变更；
- 不触碰旧 `codex_cc_tools`；
- 回滚到 beta.1 的命令；
- 完整退出 App 后再打开的要求。

只有当前用户授权覆盖该次升级时执行；否则在此请求一次精确授权。不得手改活动
`~/.codex/config.toml` 或缓存目录。

- [ ] **Step 3：用官方插件流程升级并完整重启**

使用 `codex plugin remove/add` 的当前官方命令，处理 Windows 占用时只精确识别并清理属于
该插件的 MCP 进程树。确认：

- beta.2 installed/enabled；
- `codex_external_agents` 指向 beta.2 版本化 cache；
- 旧 `codex_cc_tools` 仍 enabled；
- App 相关 `ChatGPT.exe` / `codex.exe app-server` 进程确实终止后再重开。

不要把 CLI 新进程发现工具解释为 App 已热更新；当前事实是完整进程重启才加载新 MCP。

- [ ] **Step 4：真实宿主代表性成功用例**

在新 App 任务中验证：

- `external_review` / `external_delegate` 与旧工具共存；
- 一项代表性 Kimi review；
- 一项代表性 Pi review（Coding Plan 或可用 Ark 路线）；
- 一项隔离 delegate，只允许精确预期文件变化；
- 所有调用缺失 `timeoutMs`，证明不会在 600/900 秒由产品默认截断；
- 每次结束后 owned Kimi ACP / Pi RPC 归零。

外部 provider 429/额度错误记录为可用性事实，不伪称代码失败；不自动关闭 Pi native retry。

- [ ] **Step 5：真正的 Stop/interrupt 取消门禁**

启动一个可观察夹具：

1. 写入精确 `STARTED\n`；
2. 启动长时间等待的 owned child；
3. 不传 `timeoutMs`；
4. 等待模型/工具进入运行态；
5. 由用户点击普通 Stop，或使用 App 明确提供的 dedicated interrupt 原语；
6. 不使用 handoff 作为唯一证据。

验收：

- 外层工具状态为 interrupted/cancelled；
- 夹具没有写入完成标记；
- service 收到 SDK abort；
- ACP/RPC 和夹具完整 owned 进程树归零且不重生；
- 插件 MCP 不因断开遗留在途 handler；
- App、Kimi 桌面、其它插件和旧工具未被误杀。

如果当前 App 没有可自动调用的 interrupt API，这一步保留为最小人工点击；Codex 负责其余
进程、文件和日志的自动核验。

- [ ] **Step 6：持久化 beta 验收**

`docs/release/0.1.1-beta.2-npm-acceptance.md` 与
`docs/release/real-host-acceptance.md` 记录脱敏证据、时间、版本、进程前后快照、成功/失败、
风险和 stable 判断。`AGENTS.md` 更新为最新全面事实。

若 Stop gate 失败，beta.2 保持 prerelease，stable 阻断；回到 systematic debugging 和新的
beta，不在同一版本上隐藏失败。

- [ ] **Step 7：提交验收材料**

```powershell
git add docs/release/0.1.1-beta.2-npm-acceptance.md docs/release/real-host-acceptance.md AGENTS.md
git commit -m "docs: record 0.1.1-beta.2 host acceptance"
git push -u origin codex/beta-0.1.1-host-acceptance
gh pr create --base next --head codex/beta-0.1.1-host-acceptance --title "docs: record 0.1.1-beta.2 host acceptance" --body-file docs/release/0.1.1-beta.2-npm-acceptance.md
gh pr checks --watch
gh pr merge --merge --delete-branch=false
git fetch origin next
```

## Task 12：仅在 beta.2 全部通过后发布 stable `0.1.1`

**Files**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.ts`
- Modify: `plugins/codex-external-agents/.codex-plugin/plugin.json`
- Modify: `test/version.test.ts`
- Modify: `test/cli/main.test.ts`
- Modify: `test/qualification/preflight.test.ts`
- Create: `.release-validation/v0.1.1.md`
- Modify: `AGENTS.md`
- Modify: 必要 stable 发布说明

- [ ] **Step 1：确认 stable 前置条件**

必须同时满足：

- beta.2 公共 npm 精确安装通过；
- 新 App 完整重启后工具发现通过；
- 代表性 Kimi/Pi 成功；
- 隔离 delegate 文件范围通过；
- 真正 Stop/interrupt gate 通过；
- 8/8 当前能力指纹与不可变 evidence 通过；
- 完整 deterministic release matrix 通过；
- 无活动资格锁、无 owned 残留进程；
- beta.2 审阅无未解决 P0/P1/P2。

- [ ] **Step 2：准备 stable 版本与验证文件**

从包含 beta.2 验收证据的最新 `origin/next` 创建 stable 分支：

```powershell
git fetch origin next
git switch -c codex/release-0.1.1 origin/next
```

```powershell
npm version 0.1.1 --no-git-tag-version
```

随后用 `apply_patch` 把 `src/version.ts`、插件 manifest、version/CLI 测试和 qualification
preflight fixture 精确改为 `0.1.1`；历史 beta 文档不改。

完成版本与验证文件后提交：

```powershell
git add package.json package-lock.json src/version.ts plugins/codex-external-agents/.codex-plugin/plugin.json
git add test/version.test.ts test/cli/main.test.ts test/qualification/preflight.test.ts
git add .release-validation/v0.1.1.md AGENTS.md
git commit -m "chore: prepare 0.1.1"
```

`.release-validation/v0.1.1.md` 必须包含 release workflow 要求的精确行：

```text
Doctor: pass
Local-Npm-Smoke: pass
MCP-Smoke: pass
Plugin-Isolated: pass
Capability-Index: pass
Release-Review: pass
RC: v0.1.1-beta.2
```

并在同一文件附上 beta.2 公共 npm/真实 App/Stop gate 文档链接，不含秘密。

- [ ] **Step 3：最终 stable 验证**

```powershell
npm ci
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npm run verify:capabilities
npm run acceptance:local
npm run acceptance:plugin:isolated
npm run smoke:release
npm pack --dry-run --json
git diff --check
```

- [ ] **Step 4：合入 `main` 并自动发布**

从 `origin/next` 创建 `codex/release-0.1.1`，提交 stable 候选并通过 PR 合入 `main`：

```powershell
git push -u origin codex/release-0.1.1
gh pr create --base main --head codex/release-0.1.1 --title "release: codex-agent-tools 0.1.1" --body-file .release-validation/v0.1.1.md
gh pr checks --watch
gh pr merge --merge --delete-branch=false
git fetch origin main
$stableCommitSha = git rev-parse origin/main
git tag v0.1.1 $stableCommitSha
git push origin v0.1.1
```

只有 CI 全绿且 stable merge commit 可从 `origin/main` 到达才推 tag。release workflow
自动选择 npm `latest` 并通过 OIDC 发布。不得本地 `npm publish`。

- [ ] **Step 5：验证 stable 结果并完成项目记忆**

只读确认：

```powershell
npm view codex-agent-tools@0.1.1 version
npm view codex-agent-tools@latest version
npm view codex-agent-tools@next version
```

预期 `latest=0.1.1`；`next` 是否仍指 beta.2 按 npm 现有 dist-tag 状态如实记录，不手工移动
tag，除非发布政策另有明确要求。

更新 `AGENTS.md` 的事实状态、后续监控和已知限制；总结：

- 更大目标推进现状；
- 本轮自主推进内容；
- 真实验证证据；
- 尚未解决的外部可用性风险；
- 后续小版本计划。

## 最终验收矩阵

只有下表所有项目为 pass，才能声称 stable 完成：

| 层级 | 必须证明 | 失败处理 |
|---|---|---|
| Schema | timeout 缺失可用；安全整数 ≥1000；无 900,000 产品上限 | TDD 修复 |
| Deadline | 缺失不设 timer；超长分段；cancel 幂等；仅到期为 timed_out | TDD 修复 |
| Adapter | Kimi/Pi 不注入默认值；显式值不裁剪 | TDD 修复 |
| Client | caller abort 为 cancelled；显式 deadline 为 timed_out；owned tree 清理 | TDD 修复 |
| MCP | end/close/error/SIGINT/SIGTERM/close 幂等；server.close 后 drain | TDD 修复 |
| Real stdio | 真 StdioServerTransport 关闭能使 fake Kimi/Pi 完整树归零 | TDD 修复 |
| Capability | 八项当前指纹均有新的真实 passed evidence | 停止发布 |
| Beta publish | GitHub Actions OIDC 发布到 npm next | 修复 workflow/候选 |
| Public install | 精确 registry beta.2 隔离安装和插件检查通过 | 停止 stable |
| Real host | 完整 App 重启、成功用例、普通 Stop/interrupt 取消通过 | 停止 stable |
| Stable publish | GitHub Actions OIDC 发布 0.1.1 到 latest | 修复后新 tag/版本 |

## 实施完成定义

“代码完成”只表示 Task 1–8 通过，能力索引仍可合理处于 stale；“beta 候选完成”要求 Task 9
通过；“beta 发布完成”要求 Task 10；“stable 可晋级”要求 Task 11；只有 Task 12 的 registry
和 GitHub release 都验证后，整个计划才完成。
