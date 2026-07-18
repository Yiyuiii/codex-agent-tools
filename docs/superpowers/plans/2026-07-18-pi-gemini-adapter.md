# Pi Gemini Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Kimi MVP 的统一工具面下加入由本机 Pi RPC 承载的 `gemini-3.5-flash`，并让项目独立维护 Pi 配置、权限、网络和真实质量门禁。

**Architecture:** 新增 `pi-rpc` 适配器而不改变 MCP schema；逻辑注册表把 Gemini 固定绑定到 Pi 的 Google provider 与 direct 网络策略。每次调用生成/使用包版本化的隔离 `PI_CODING_AGENT_DIR`，review 仅以 Pi CLI 参数启用 `read,grep,find,ls`，delegate 启用完整内置工具；JSONL、取消、期限、进程树和证据复用 Kimi MVP 的公共运行层。

**Tech Stack:** Kimi MVP 技术栈、Pi RPC JSONL、`@earendil-works/pi-coding-agent` 0.80.x 的外部可执行文件契约、Node.js 原生流。

---

## 文件结构

- `src/adapters/pi/locator.ts`：定位 `pi(.cmd)` 并读取版本。
- `src/adapters/pi/config.ts`：生成隔离 settings/models 目录，不读取或修改 `~/.pi/agent`。
- `src/adapters/pi/jsonl.ts`：只按 LF 切分的增量 JSONL 解码器。
- `src/adapters/pi/client.ts`：RPC command/response/event 生命周期、取消和硬期限。
- `src/adapters/pi/adapter.ts`：把 Pi 事件映射为统一 adapter 结果。
- `src/llms/registry.ts`：加入固定 Gemini logical LLM。
- `src/cli/doctor.ts`：加入 Pi、隔离配置和 Gemini 凭据/路由诊断。
- `test/fakes/fake-pi-rpc.mjs`：分片、CRLF、未知事件、stderr、取消和退出场景。
- `test/adapters/pi/*.test.ts`：配置、解析、协议和适配测试。
- `scripts/real-pi-smoke.mjs`：Gemini review/delegate 的独立真实门禁。
- `docs/smoke/pi-gemini.md`：非秘密真实证据。

### Task 1: 锁定本机 Pi 可执行文件和隔离目录契约

**Files:**
- Create: `src/adapters/pi/locator.ts`
- Create: `src/adapters/pi/config.ts`
- Test: `test/adapters/pi/locator.test.ts`
- Test: `test/adapters/pi/config.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it } from "vitest";
import { locatePi } from "../../../src/adapters/pi/locator.js";

it("prefers an explicit test command and otherwise resolves pi from PATH", async () => {
  await expect(locatePi({ PI_COMMAND: "C:\\fake\\pi.cmd", PATH: "" }, async (p) => p === "C:\\fake\\pi.cmd"))
    .resolves.toBe("C:\\fake\\pi.cmd");
});
```

```ts
import { expect, it } from "vitest";
import { buildIsolatedPiConfig } from "../../../src/adapters/pi/config.js";

it("writes no credentials and never targets the user's normal Pi directory", async () => {
  const result = await buildIsolatedPiConfig({ root: tempRoot, version: "0.1.0", providers: [] });
  expect(result.agentDir.startsWith(tempRoot)).toBe(true);
  expect(result.agentDir).not.toContain(".pi\\agent");
  expect(await readFile(result.modelsPath, "utf8")).not.toMatch(/api[_-]?key|secret/i);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- --run test/adapters/pi/locator.test.ts test/adapters/pi/config.test.ts`

Expected: FAIL，Pi 模块尚不存在。

- [ ] **Step 3: 实现定位和原子配置生成**

定位顺序为 `PI_COMMAND`、PATH 的 `pi.cmd/pi`、Windows 全局 npm bin 下的 `pi.cmd`。配置根固定为包缓存目录 `.../codex-agent-tools/pi/<package-version>`；先写同目录临时文件，再 rename 替换。首个 Gemini 版本的 `models.json` 可以为空，因为 Google 是 Pi 内置 provider；`settings.json` 只包含非交互运行所需的稳定设置和 `defaultProjectTrust: "never"`。返回的 child env 显式设置 `PI_CODING_AGENT_DIR`，不读取、不复制、不修改用户的 `~/.pi/agent`。

- [ ] **Step 4: 验证**

Run: `npm test -- --run test/adapters/pi/locator.test.ts test/adapters/pi/config.test.ts && npm run typecheck`

Expected: 全部通过；重复生成得到相同内容和路径。

- [ ] **Step 5: 提交**

```bash
git add src/adapters/pi/locator.ts src/adapters/pi/config.ts test/adapters/pi
git commit -m "feat: create isolated Pi runtime configuration"
```

### Task 2: 实现严格 LF JSONL 解码和 Pi RPC 状态机

**Files:**
- Create: `src/adapters/pi/jsonl.ts`
- Create: `src/adapters/pi/client.ts`
- Create: `test/fakes/fake-pi-rpc.mjs`
- Test: `test/adapters/pi/jsonl.test.ts`
- Test: `test/adapters/pi/client.test.ts`

- [ ] **Step 1: 写分片、未知事件、取消和期限失败测试**

```ts
import { expect, it } from "vitest";
import { LfJsonlDecoder } from "../../../src/adapters/pi/jsonl.js";

it("splits only on LF and retains an incomplete tail", () => {
  const decoder = new LfJsonlDecoder();
  expect(decoder.push(Buffer.from('{"text":"a\u2028b"}\r'))).toEqual([]);
  expect(decoder.push(Buffer.from('\n{"n":1'))).toEqual([{ text: "a\u2028b" }]);
  expect(decoder.finish()).toEqual({ incomplete: '{"n":1' });
});
```

fake RPC 收到 `{type:"set_model"}`、`{type:"set_thinking_level"}`、`{type:"prompt"}` 后发出 response、message/tool events 和 agent_end；测试断言 command ID 正确关联、未知 event 被记录为限长诊断而不终止、stderr 不进入 stdout parser。AbortSignal 触发 `{type:"abort"}`，随后终止整个 fake 进程树；硬期限映射为 `timed_out`。

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- --run test/adapters/pi/jsonl.test.ts test/adapters/pi/client.test.ts`

Expected: FAIL，decoder/client 尚不存在。

- [ ] **Step 3: 实现 decoder 和 request/event 循环**

`LfJsonlDecoder` 维护 Buffer，只寻找字节 `0x0A`；记录末尾 `0x0D` 时移除 CR 后 JSON.parse；单条记录和总诊断都有大小上限。`PiRpcClient.run` 启动：

```text
pi --mode rpc --no-approve --provider google --model gemini-3.5-flash --thinking medium
```

review 追加 `--tools read,grep,find,ls`；delegate 追加 `--tools read,bash,edit,write,grep,find,ls`。启动后依序发送带递增 id 的 `set_model`、`set_thinking_level` 和 `prompt`，等待对应 response 与最终 `agent_end`；收集 assistant text、tool_execution_start/update/end、session 信息和非秘密 usage。收到取消时先发送 RPC abort，等待短宽限，再调用公共 `terminateProcessTree`；不使用 stdout 空闲超时，每 15 秒发桥接心跳。

- [ ] **Step 4: 验证协议和进程生命周期**

Run: `npm test -- --run test/adapters/pi/jsonl.test.ts test/adapters/pi/client.test.ts && npm run typecheck`

Expected: 正常、分片、CRLF、未知事件、异常退出、取消、超时和 stderr 洪泛用例全部通过且无孤儿进程。

- [ ] **Step 5: 提交**

```bash
git add src/adapters/pi/jsonl.ts src/adapters/pi/client.ts test/adapters/pi test/fakes/fake-pi-rpc.mjs
git commit -m "feat: implement Pi RPC process bridge"
```

### Task 3: 接入统一适配器并从 Pi 事件提取证据

**Files:**
- Create: `src/adapters/pi/adapter.ts`
- Modify: `src/adapters/adapter.ts`
- Modify: `src/tasks/service.ts`
- Test: `test/adapters/pi/adapter.test.ts`
- Modify: `test/tasks/service.test.ts`

- [ ] **Step 1: 写运行时路由和证据失败测试**

测试 registry profile 的 `runtime: "pi-rpc"` 只会调用 Pi adapter；Kimi profile 仍只会调用 Kimi adapter。Pi fake 声称没有命令/文件改动但发出 bash/write tool events，断言 adapter 收集事件、任务层仍以 after workspace 为最终文件证据。review 若出现 bash/edit/write 工具事件，即使工作区未变也返回 `failed` 和 `review_policy_violation`。

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- --run test/adapters/pi/adapter.test.ts test/tasks/service.test.ts`

Expected: FAIL，Pi adapter 尚未注册。

- [ ] **Step 3: 实现 Pi adapter 和 runtime map**

`PiAdapter` 实现与 Kimi 相同的 `ExternalAgentAdapter` 接口，实际 model 从 Pi 启动/事件信息获取并校验等于 profile 固定 model。任务服务接收 `ReadonlyMap<RuntimeKind, ExternalAgentAdapter>`；找不到 runtime 明确失败。review 允许的工具名集合固定为 `read/grep/find/ls`，delegate 记录 bash 命令标题、edit/write 相对路径和工具结果摘要，所有字段脱敏和限长。

- [ ] **Step 4: 验证**

Run: `npm test -- --run test/adapters/pi/adapter.test.ts test/tasks/service.test.ts && npm run typecheck`

Expected: 全部通过，现有 Kimi 测试无回归。

- [ ] **Step 5: 提交**

```bash
git add src/adapters/pi/adapter.ts src/adapters/adapter.ts src/tasks/service.ts test/adapters/pi/adapter.test.ts test/tasks/service.test.ts
git commit -m "feat: route Pi runtimes through the task service"
```

### Task 4: 注册固定 Gemini 逻辑 LLM 和 doctor 诊断

**Files:**
- Modify: `src/llms/registry.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `test/llms/registry.test.ts`
- Modify: `test/cli/doctor.test.ts`

- [ ] **Step 1: 写固定绑定失败测试**

```ts
it("binds Gemini to Pi Google without caller overrides", () => {
  expect(resolveLlm("gemini-3.5-flash")).toMatchObject({
    runtime: "pi-rpc",
    provider: "google",
    model: "gemini-3.5-flash",
    network: "direct",
    credentialEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]
  });
});
```

doctor 测试断言凭据按优先级只选择第一个非空变量，并只报告变量名；报告 Pi binary/version、隔离 agentDir、direct 路由和 review/delegate pending 状态。

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- --run test/llms/registry.test.ts test/cli/doctor.test.ts`

Expected: FAIL，Gemini profile 尚不存在。

- [ ] **Step 3: 实现 profile 和诊断**

新增 `provider?: string` 作为内部 profile 字段但不加入 MCP schema。Gemini 固定 `provider: "google"`、`model: "gemini-3.5-flash"`、`network: "direct"`、`timeoutMs: 600000`、`maxConcurrency: 2`，两个 task 初始 pending。环境构造器只把优先级最高的一个 Gemini credential 复制到 Pi 子进程；若本机 Pi 的 Google OAuth 已可用，doctor 报告 `native-auth`，但不显示 token/文件内容。

- [ ] **Step 4: 验证**

Run: `npm test -- --run test/llms/registry.test.ts test/cli/doctor.test.ts && npm run typecheck`

Expected: 全部通过，public schema 仍不包含 provider/model/proxy。

- [ ] **Step 5: 提交**

```bash
git add src/domain/types.ts src/llms/registry.ts src/cli/doctor.ts test/llms/registry.test.ts test/cli/doctor.test.ts
git commit -m "feat: register Gemini through isolated Pi"
```

### Task 5: 执行 Gemini review/delegate 真实门禁

**Files:**
- Create: `scripts/real-pi-smoke.mjs`
- Create: `docs/smoke/pi-gemini.md`
- Modify: `src/llms/registry.ts`
- Modify: `AGENTS.md`

- [ ] **Step 1: 实现与 Kimi 等价的真实 smoke**

脚本创建两个临时 Git 仓库：review 仓库含一个可确定定位的缺陷，调用 `gemini-3.5-flash` 后断言结果命中缺陷且前后 fingerprint 相同；delegate 仓库要求创建文件并运行验证，断言真实文件、Pi tool events 和任务结果一致。记录 Pi/Kimi 不共享环境：Pi 子进程不得看到 Kimi/Ark/Anthropic/OpenAI/DeepSeek 密钥；固定 direct 路由必须清除父环境代理。

- [ ] **Step 2: 运行 review 门禁**

Run: `npm run build && node scripts/real-pi-smoke.mjs --llm gemini-3.5-flash --task review`

Expected: `completed`，已知缺陷被识别，仓库无修改，实际 model 为 `gemini-3.5-flash`。

- [ ] **Step 3: 运行 delegate 门禁**

Run: `node scripts/real-pi-smoke.mjs --llm gemini-3.5-flash --task delegate`

Expected: `completed`，文件、命令和验证证据一致，结束后无 Pi 子孙进程。

- [ ] **Step 4: 启用通过能力并记录证据**

只把成功 task 的 quality gate 改为 passed。在 `docs/smoke/pi-gemini.md` 写运行时间、Pi 版本、逻辑 ID、实际 model、direct 路由、任务、耗时、结果、工作区证据摘要和隔离 agentDir 内容哈希；不记录密钥或完整环境。同步 `AGENTS.md`。

- [ ] **Step 5: 完整验证和提交**

Run: `npm run typecheck && npm test && npm run build && npm run smoke:release && node dist/cli.js doctor --json`

Expected: 全部通过；doctor 的 Gemini 能力与真实门禁一致。

```bash
git add scripts/real-pi-smoke.mjs docs/smoke/pi-gemini.md src/llms/registry.ts AGENTS.md
git commit -m "test: qualify Gemini Pi profile"
```

## 本计划完成条件

- `gemini-3.5-flash` 是调用者唯一可见的选择，固定映射到 Pi/Google/Gemini 3.5 Flash/direct。
- 项目只使用自己的 `PI_CODING_AGENT_DIR`，不读取或修改用户日常 Pi 配置。
- review 只启用只读 Pi 工具；delegate 的真实变更和命令由桥接层取证。
- Pi 的取消、硬期限和 Windows 进程树清理达到与 Kimi 相同的验收标准。
- Gemini review/delegate 分别通过真实 smoke 后才启用。
