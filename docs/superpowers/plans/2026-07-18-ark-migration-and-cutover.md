# Ark Pi Migration and Local Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Ark Coding Plan 与 Ark Agent Plan 的目标模型迁移到隔离 Pi 后端，通过真实门禁后在本机 Codex 中用 `codex_external_agents` 完整替代 `codex_cc_tools`。

**Architecture:** 在既有 Pi 配置生成器中加入两个 Anthropic-compatible 自定义 provider，但这只是 Pi 的线路协议，不调用 Claude Code，也不提供 Anthropic Claude 模型。凭据由父进程按优先级规范化到项目私有环境变量，`models.json` 只引用变量名；所有 Ark logical LLM 固定 direct 路由。最终 cutover 先备份并验证 Codex TOML，再原子移除旧 MCP 表、安装新表和运行 MCP 自检；不修改旧项目源码，也不卸载本机 Claude Code。

**Tech Stack:** 已完成的 Kimi/Pi 运行层、Pi `models.json` 的 `anthropic-messages` provider、Vitest、Codex MCP TOML 配置、npm pack/release smoke。

---

## 文件结构

- `src/adapters/pi/config.ts`：生成 Ark provider/model 的版本化 `models.json`。
- `src/runtime/credentials.ts`：按逻辑 profile 选择并规范化一个凭据，不暴露值。
- `src/llms/registry.ts`：三个 Ark logical LLM 固定绑定。
- `src/cli/doctor.ts`：endpoint、凭据变量名、路由、模型和门禁诊断。
- `src/cli/cutover.ts`：备份、安装新 MCP、移除旧 MCP、回滚和幂等检查。
- `scripts/real-ark-smoke.mjs`：逐 profile × task 的真实门禁。
- `scripts/local-acceptance.mjs`：从已安装 MCP 入口验证 list/call/cancellation。
- `docs/smoke/ark.md`：非秘密 Ark 证据矩阵。
- `docs/migration-from-codex-cc-tools.md`：边界、映射、回滚和删除项。
- `docs/release/checklist.md`：本地可发布验收，不自动公开发布 npm。

### Task 1: 规范化 Ark 凭据而不复制其它 provider 秘密

**Files:**
- Create: `src/runtime/credentials.ts`
- Test: `test/runtime/credentials.test.ts`
- Modify: `src/runtime/environment.ts`
- Modify: `test/runtime/environment.test.ts`

- [x] **Step 1: 写优先级和隔离失败测试**

```ts
import { expect, it } from "vitest";
import { resolveCredential } from "../../src/runtime/credentials.js";

it("normalizes only the first Ark Coding credential", () => {
  const result = resolveCredential(
    ["ARK_API_KEY", "VOLCENGINE_API_KEY"],
    "CODEX_AGENT_ARK_CODING_KEY",
    { ARK_API_KEY: "primary", VOLCENGINE_API_KEY: "secondary", ANTHROPIC_API_KEY: "forbidden" }
  );
  expect(result).toEqual({ sourceName: "ARK_API_KEY", targetName: "CODEX_AGENT_ARK_CODING_KEY", value: "primary" });
});
```

另测全部为空时错误只列变量名；child env 只含规范化 target，不含原始两个变量、Anthropic、OpenAI、DeepSeek、Gemini 或 Kimi 凭据。

- [x] **Step 2: 运行并确认失败**

Run: `npm test -- --run test/runtime/credentials.test.ts test/runtime/environment.test.ts`

Expected: FAIL，凭据规范化器尚不存在。

- [x] **Step 3: 实现纯函数和环境注入**

`resolveCredential(sourceNames, targetName, parentEnv)` 返回第一个 trim 后非空值；缺失时抛出 `Missing credential: ARK_API_KEY or VOLCENGINE_API_KEY`。Coding Plan 使用目标变量 `CODEX_AGENT_ARK_CODING_KEY`，Agent Plan 使用 `CODEX_AGENT_ARK_AGENT_KEY`，其唯一来源为 `OPENAI_API_KEY_DOUBAO`。诊断只使用 `sourceName/targetName`，`value` 只在构建 child env 时存在，绝不序列化。

- [x] **Step 4: 验证**

Run: `npm test -- --run test/runtime/credentials.test.ts test/runtime/environment.test.ts && npm run typecheck`

Expected: 全部通过，测试 secret 不出现在 snapshot/diagnostics。

- [x] **Step 5: 提交**

```bash
git add src/runtime/credentials.ts src/runtime/environment.ts test/runtime
git commit -m "feat: normalize Ark credentials for Pi"
```

### Task 2: 生成无秘密的 Ark Pi provider 配置

**Files:**
- Modify: `src/adapters/pi/config.ts`
- Modify: `test/adapters/pi/config.test.ts`
- Create: `test/fixtures/pi/expected-ark-models.json`

- [x] **Step 1: 写完整 models.json 失败测试**

```ts
it("generates the approved Ark providers without literal secrets", async () => {
  const result = await buildIsolatedPiConfig({ root: tempRoot, version: "0.1.0", providers: ["ark"] });
  expect(JSON.parse(await readFile(result.modelsPath, "utf8"))).toEqual({
    providers: {
      "ark-coding-plan": {
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
        api: "anthropic-messages",
        apiKey: "$CODEX_AGENT_ARK_CODING_KEY",
        models: [{ id: "ark-code-latest", name: "Ark Coding Plan", reasoning: true, contextWindow: 200000, maxTokens: 32000 }]
      },
      "ark-agent-plan": {
        baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
        api: "anthropic-messages",
        apiKey: "$CODEX_AGENT_ARK_AGENT_KEY",
        models: [
          { id: "glm-5.2", name: "GLM 5.2 Agent Plan", reasoning: true, contextWindow: 200000, maxTokens: 32000 },
          { id: "doubao-seed-2.0-pro", name: "Doubao Seed 2.0 Pro Agent Plan", reasoning: true, contextWindow: 200000, maxTokens: 32000 }
        ]
      }
    }
  });
});
```

- [x] **Step 2: 运行并确认失败**

Run: `npm test -- --run test/adapters/pi/config.test.ts`

Expected: FAIL，Ark provider 尚未生成。

- [x] **Step 3: 实现确定性配置和内容哈希**

配置键、provider 和 models 以固定顺序输出，结尾一个 LF；同版本内容不变时不重写。只写上述 endpoint、API 类型、变量引用和模型元数据，不写 `/v3` OpenAI endpoint，不写真实 key，不加入 Claude/Codex/DeepSeek 模型。生成结果返回 SHA-256，供 doctor 和 smoke 记录。

- [x] **Step 4: 验证**

Run: `npm test -- --run test/adapters/pi/config.test.ts && npm run typecheck`

Expected: 与 fixture 完全一致，重复生成哈希相同。

- [x] **Step 5: 提交**

```bash
git add src/adapters/pi/config.ts test/adapters/pi/config.test.ts test/fixtures/pi/expected-ark-models.json
git commit -m "feat: generate Ark providers for isolated Pi"
```

### Task 3: 注册三个固定 Ark logical LLM

**Files:**
- Modify: `src/llms/registry.ts`
- Modify: `test/llms/registry.test.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `test/cli/doctor.test.ts`

- [x] **Step 1: 写唯一映射失败测试**

```ts
it.each([
  ["ark-coding-plan", "ark-coding-plan", "ark-code-latest"],
  ["ark-agent-glm-5.2", "ark-agent-plan", "glm-5.2"],
  ["ark-agent-doubao-seed-2.0-pro", "ark-agent-plan", "doubao-seed-2.0-pro"]
])("binds %s to one Pi provider/model", (id, provider, model) => {
  expect(resolveLlm(id)).toMatchObject({ runtime: "pi-rpc", provider, model, network: "direct" });
});
```

断言 supported IDs 排序稳定，MCP schema 不接受 provider/model/network override；三个 profile 初始 review/delegate 都 pending。

- [x] **Step 2: 运行并确认失败**

Run: `npm test -- --run test/llms/registry.test.ts test/cli/doctor.test.ts`

Expected: FAIL，Ark profile 尚不存在。

- [x] **Step 3: 实现 profile 和 doctor**

三个 profile 的 `network` 均为 `direct`、`timeoutMs` 为 900000、每个 provider pool 的 `maxConcurrency` 为 1。doctor 检查 Pi 能否从隔离目录列出确切 provider/model，endpoint host 为 `ark.cn-beijing.volces.com`，凭据只报告命中的 source variable name。若模型缺失、endpoint 漂移或配置哈希不匹配，能力保持 disabled。

- [x] **Step 4: 验证**

Run: `npm test -- --run test/llms/registry.test.ts test/cli/doctor.test.ts && npm run typecheck`

Expected: 全部通过。

- [x] **Step 5: 提交**

```bash
git add src/llms/registry.ts src/cli/doctor.ts test/llms/registry.test.ts test/cli/doctor.test.ts
git commit -m "feat: register Ark logical llms"
```

### Task 4: 逐 Ark profile × task 执行真实门禁

**Files:**
- Create: `scripts/real-ark-smoke.mjs`
- Create: `docs/smoke/ark.md`
- Modify: `src/llms/registry.ts`
- Modify: `AGENTS.md`

- [x] **Step 1: 实现六项独立 smoke 矩阵**

复用真实 Pi smoke harness，但每个 logical ID 都创建全新临时仓库和 Pi 进程。review 使用确定缺陷并要求路径/行号；delegate 创建该次运行唯一文件并执行内容校验。每次记录实际 endpoint host、provider、model、direct 路由、配置哈希、elapsed、workspace evidence 和无孤儿进程结果；不记录 key、header、完整 env 或响应原始敏感内容。

- [x] **Step 2: 运行 Coding Plan 两项门禁**

Run: `npm run build && node scripts/real-ark-smoke.mjs --llm ark-coding-plan --task review`

Run: `node scripts/real-ark-smoke.mjs --llm ark-coding-plan --task delegate`

Expected: 两项 `completed`，实际 model 为 `ark-code-latest`；review 零修改，delegate 证据一致。

Actual: 两项均在模型启动前以 `missing_credential` 失败，工作区无修改且无残留进程；对应能力保持 pending。

- [x] **Step 3: 运行 Agent Plan 四项门禁**

Run: `node scripts/real-ark-smoke.mjs --llm ark-agent-glm-5.2 --task review`

Run: `node scripts/real-ark-smoke.mjs --llm ark-agent-glm-5.2 --task delegate`

Run: `node scripts/real-ark-smoke.mjs --llm ark-agent-doubao-seed-2.0-pro --task review`

Run: `node scripts/real-ark-smoke.mjs --llm ark-agent-doubao-seed-2.0-pro --task delegate`

Expected: 四项 `completed`；模型标识正确；无 review 修改和孤儿 Pi 进程。

Actual: 四项均正确命中 provider/model、隔离环境和 direct 路由，但上游以 `AccountQuotaExceeded` 拒绝；对应能力保持 pending。

- [x] **Step 4: 按实际结果启用能力**

在 `docs/smoke/ark.md` 写六行证据矩阵和失败说明。只启用已通过 task；失败项保留 pending 并不影响其它 profile/task。同步 `AGENTS.md` 当前事实。

- [x] **Step 5: 完整验证和提交**

Run: `npm run typecheck && npm test && npm run build && npm run smoke:release && node dist/cli.js doctor --json`

Expected: 全部通过；doctor 门禁与证据矩阵一致。

Actual: 类型检查、134 项测试、构建和 release smoke 全部通过；doctor 如实报告 Coding Plan 缺凭据、六项 Ark pending，并与证据矩阵一致。

```bash
git add scripts/real-ark-smoke.mjs docs/smoke/ark.md src/llms/registry.ts AGENTS.md
git commit -m "test: qualify Ark Pi profiles"
```

### Task 5: 实现可回滚的本机 Codex cutover

**Files:**
- Create: `src/cli/cutover.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/config.ts`
- Test: `test/cli/cutover.test.ts`
- Create: `docs/migration-from-codex-cc-tools.md`

- [ ] **Step 1: 写原子性、所有权和回滚失败测试**

临时 config 含用户注释、`codex_cc_tools` 表、其它 MCP 表。测试：

1. 所有目标 profiles/tasks 未通过时拒绝 cutover 且文件字节不变；
2. 通过时创建时间戳备份，只删除旧 `mcp_servers.codex_cc_tools` 表并安装新表，其它字节保持；
3. 写后解析或 MCP 自检失败时从备份恢复；
4. 第二次执行幂等；
5. 不删除 Claude Code 文件、不运行旧包 uninstall、不修改 `D:\\Codes\\codex-cc-tools`。

- [ ] **Step 2: 运行并确认失败**

Run: `npm test -- --run test/cli/cutover.test.ts`

Expected: FAIL，cutover 尚不存在。

- [ ] **Step 3: 实现 `install --replace-codex-cc-tools`**

流程固定为：运行 doctor 并确认所有目标 enabled → 锁定 config → 同目录写备份 → 在内存中删除旧表/安装新 owned block → 写临时文件并 fsync → rename → 启动新 MCP 做 initialize/listTools → 成功后释放锁。任何错误恢复备份并返回非 0。命令输出中文摘要和备份路径；不会调用或卸载 Claude Code。迁移文档列出旧到新映射、明确删除 Anthropic/DeepSeek/Codex 来源、保留本机 Claude Code 安装以及 `restore --backup <path>` 回滚命令。

- [ ] **Step 4: 验证**

Run: `npm test -- --run test/cli/cutover.test.ts && npm run typecheck`

Expected: 全部通过，失败注入均恢复原始 config。

- [ ] **Step 5: 提交**

```bash
git add src/cli test/cli/cutover.test.ts docs/migration-from-codex-cc-tools.md
git commit -m "feat: add reversible Codex MCP cutover"
```

### Task 6: 完成本地安装验收和可发布准备

**Files:**
- Create: `scripts/local-acceptance.mjs`
- Create: `docs/release/checklist.md`
- Modify: `scripts/release-smoke.mjs`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 扩展 release smoke 和本地 MCP 验收脚本**

release smoke 额外检查 npm 名称当前是否可用、包中不含 secret/smoke 原始会话/开发机绝对路径、安装命令指向有效 bin。local acceptance 通过 stdio MCP client 执行 initialize/listTools，验证两个工具 schema/annotations，再分别用一个已通过的 Kimi 与 Pi logical LLM 做低成本 review；delegate 只在临时仓库运行。取消测试启动长任务后 abort 并验证没有 Kimi/Pi 后代。

- [ ] **Step 2: 执行全部确定性检查**

Run: `npm clean-install && npm run typecheck && npm test && npm run build && npm run smoke:release`

Expected: 全部退出码 0；`npm pack --dry-run --json` 内容符合 allowlist。

- [ ] **Step 3: 执行本地安装与 MCP 端到端验收**

Run: `npm link && codex-agent-tools doctor --json && node scripts/local-acceptance.mjs`

Expected: doctor 无阻断项；MCP 仅列两个工具；Kimi/Pi review、临时 delegate 和取消清理均通过。

- [ ] **Step 4: 执行本机 cutover 并复核**

Run: `codex-agent-tools install --replace-codex-cc-tools`

Run: `codex-agent-tools doctor --json`

Expected: `codex_external_agents` 已启用，`codex_cc_tools` 已从 Codex MCP 配置移除，备份存在；本机 Claude Code 和旧项目源码均未改变。若 Codex App 需要重启才能刷新 MCP，文档记录这一事实并在重启后重跑 local acceptance。

- [ ] **Step 5: 更新发布清单并提交**

`docs/release/checklist.md` 记录版本、commit、Node/Pi/Kimi 版本、确定性检查、真实 smoke 矩阵、local acceptance、cutover 备份和 npm 名称复核。只准备 pack/tarball；没有用户明确授权时不执行公开 `npm publish`。

```bash
git add scripts/local-acceptance.mjs scripts/release-smoke.mjs docs/release/checklist.md README.md AGENTS.md
git commit -m "chore: complete local replacement acceptance"
```

## 本计划完成条件

- 三个 Ark logical LLM 固定映射到隔离 Pi provider/model/direct，调用者无法覆盖。
- Ark 配置不含真实凭据，子进程看不到其它 provider 密钥。
- 六个 Ark profile × task 能力按各自真实 smoke 结果启用。
- 本机 Codex 配置已可回滚地从 `codex_cc_tools` 切换到 `codex_external_agents`。
- 旧仓库未被修改，本机 Claude Code 未被调用、修改或卸载。
- Kimi、Gemini、Ark 的新工具面完成本地端到端验收；DeepSeek 不迁移。
