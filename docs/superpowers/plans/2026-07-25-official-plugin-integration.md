# Official Plugin Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 `codex-agent-tools` 收敛为可由 Codex 官方插件机制安装的本地插件，公开五个固定路由逻辑 LLM，并在不直接读写活动 `~/.codex/config.toml`、不调用 Claude Code、不移除旧工具的前提下完成隔离取证、真实模型门禁和真实宿主验收准备。

**Architecture:** 仓库内 marketplace 指向隔离的 `plugins/codex-external-agents` 插件目录；插件用自包含 Node.js 单文件 bundle 启动现有 `codex_external_agents` stdio MCP。MCP 只公开 `external_review` 与 `external_delegate`，两个工具的 `llm` 始终必填。Kimi K3 固定走 Kimi ACP；Gemini 与三条 Ark 路线固定走 Pi RPC；只有 Gemini 子进程注入 10808 代理，两个 Ark Agent Plan 逻辑 LLM 共享并发为 1 的配额池。官方安装先在临时 `CODEX_HOME` 取证，真实安装另设逐次授权停点。

**Tech Stack:** TypeScript 5.9、Node.js 20+、tsup、Vitest、Codex `plugin` CLI、Model Context Protocol SDK、Agent Client Protocol SDK、Kimi Code ACP、Pi RPC JSONL。

---

## 实施边界

- 工作目录固定为 `D:\Codes\codex-agent-tools`。
- 不修改 `D:\Codes\codex-cc-tools`。
- 不调用、修改或卸载本机 Claude Code。
- 不直接读取、写入、备份或恢复活动 `C:\Users\Administrator\.codex\config.toml`。
- 隔离验收只能设置临时 `CODEX_HOME`；真实 `codex plugin add/remove/marketplace` 操作必须在任务 8 的许可停点之后执行。
- 不执行 `npm publish`，不发布公共 marketplace。
- 真实 Kimi/Pi smoke 串行执行，避免全机进程快照互相干扰。
- 每个行为改动都先写失败测试，再写最小实现。

## 目标文件结构

```text
D:\Codes\codex-agent-tools
├── .agents/
│   └── plugins/
│       └── marketplace.json
├── plugins/
│   └── codex-external-agents/
│       ├── .codex-plugin/
│       │   └── plugin.json
│       ├── .mcp.json
│       └── runtime/
│           └── codex-external-agents-mcp.mjs
├── scripts/
│   ├── plugin-isolated-acceptance.mjs
│   └── release-smoke.mjs
├── src/
│   ├── plugin/
│   │   └── state-snapshot.ts
│   └── ...
├── test/
│   ├── plugin/
│   │   ├── artifact.test.ts
│   │   └── state-snapshot.test.ts
│   └── ...
└── tsup.plugin.config.ts
```

`plugins/codex-external-agents/runtime/` 是构建产物目录，不手工编辑；源码仍以 `src/mcp/main.ts` 及其传递依赖为唯一实现来源。

## Task 1：移除活动 Codex 配置写入面

**Files:**

- Modify: `test/cli/main.test.ts`
- Modify: `test/cli/doctor.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/doctor.ts`
- Delete: `src/cli/config.ts`
- Delete: `src/cli/cutover.ts`
- Delete: `test/cli/config.test.ts`
- Delete: `test/cli/cutover.test.ts`

- [x] **Step 1：先把 CLI 契约测试改成只允许 `doctor`**

在 `test/cli/main.test.ts` 中把公开命令断言改为：

```ts
const program = createProgram({ doctor });
expect(program.commands.map((command) => command.name())).toEqual(["doctor"]);

const help = program.helpInformation();
expect(help).toContain("doctor");
expect(help).not.toMatch(/\binstall\b|\buninstall\b|\brestore\b/u);
expect(help).not.toContain("--config");
```

同时保留 `--json`、`--strict` 传递测试，并断言依赖只收到：

```ts
expect(doctor).toHaveBeenCalledWith({
  json: true,
  strict: true,
});
```

- [x] **Step 2：先把 doctor 测试改成“不接受配置路径、不报告 MCP 注册”**

在 `test/cli/doctor.test.ts` 中：

```ts
expect(report.checks.map((check) => check.name)).not.toContain(
  "MCP registration",
);
expect(report.checks).toContainEqual(
  expect.objectContaining({
    name: "Public MCP tools",
    detail: "external_review, external_delegate",
  }),
);
```

删除所有 `configPath`、临时 `config.toml`、`hasManagedCodexConfig` 相关测试安排。新增一项防回归测试：传入的依赖环境中即使有 `CODEX_HOME`，`collectDoctorReport` 也不调用任何配置读取依赖。

- [x] **Step 3：运行测试，确认先红**

Run:

```powershell
npx vitest run test/cli/main.test.ts test/cli/doctor.test.ts
```

Expected: 失败原因包含仍存在 `install` / `uninstall` / `restore`、仍有 `--config` 或仍报告 `MCP registration`。

- [x] **Step 4：把 `src/cli/main.ts` 收敛为只读 CLI**

保留的公开类型与依赖应为：

```ts
export interface DoctorCommandOptions {
  json?: boolean;
  strict?: boolean;
}

export interface CreateProgramDependencies {
  doctor?: (options: DoctorCommandOptions) => Promise<void>;
}
```

删除 `node:path`、`fileURLToPath`、`config.js`、`cutover.js` 导入以及所有安装、卸载、恢复函数。`createProgram` 中只注册：

```ts
program
  .command("doctor")
  .description("Check external runtimes, routes, credentials, artifacts, and logical LLM gates.")
  .option("--json", "Print machine-readable JSON.")
  .option("--strict", "Exit non-zero when an error diagnostic is present.")
  .action(async (options: { json?: boolean; strict?: boolean }) => {
    const commandOptions: DoctorCommandOptions = {};
    if (options.json !== undefined) commandOptions.json = options.json;
    if (options.strict !== undefined) commandOptions.strict = options.strict;
    await doctor(commandOptions);
  });
```

- [x] **Step 5：让 doctor 完全脱离 Codex 配置**

在 `src/cli/doctor.ts`：

- 删除 `readConfig`、`readFile` 中仅为 Codex 配置服务的分支；
- 删除 `getDefaultCodexConfigPath`、`hasManagedCodexConfig` 导入；
- 从 `CollectDoctorOptions` 删除 `configPath`；
- 从 `collectDoctorReport` 删除配置路径解析和 `MCP registration` 检查；
- 保留 Kimi、Pi、凭据、代理、模型、产物与公开工具诊断。

- [x] **Step 6：删除不再可达的配置写入实现和测试**

删除四个文件后运行：

```powershell
rg -n "getDefaultCodexConfigPath|installCodexConfig|uninstallCodexConfig|cutoverCodexConfig|restoreCodexConfigBackup|configPath" src test scripts
```

Expected: 不再出现 Codex 配置写入函数；若 `configPath` 仍出现，只能是与 Pi 或测试夹具无关的通用局部变量，逐项核实后保留。

- [x] **Step 7：验证并提交**

Run:

```powershell
npx vitest run test/cli/main.test.ts test/cli/doctor.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: 全部通过。

Commit:

```powershell
git add src/cli test/cli
git commit -m "refactor: remove codex config mutation cli"
```

## Task 2：收敛为五个固定逻辑 LLM 与两种网络策略

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/runtime/environment.ts`
- Modify: `src/llms/registry.ts`
- Modify: `src/adapters/pi/config.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `src/smoke/ark.ts`
- Modify: `src/smoke/kimi.ts`
- Modify: `scripts/local-acceptance.mjs`
- Modify: `test/runtime/environment.test.ts`
- Modify: `test/llms/registry.test.ts`
- Modify: `test/adapters/pi/config.test.ts`
- Modify: `test/fixtures/pi/expected-ark-models.json`
- Modify: `test/cli/doctor.test.ts`
- Modify: `test/smoke/ark.test.ts`
- Modify: `test/smoke/kimi.test.ts`
- Modify: `test/tasks/service.test.ts`
- Modify: `test/runtime/limiter.test.ts`
- Modify: `test/acceptance/local.test.ts`
- Modify: `AGENTS.md`
- Modify: `docs/smoke/kimi.md`
- Modify: `docs/smoke/ark.md`

- [x] **Step 1：先写目标注册表与网络失败测试**

在 `test/llms/registry.test.ts` 断言唯一 ID：

```ts
expect(supportedLlmIds()).toEqual([
  "ark-agent-deepseek-v4-flash",
  "ark-agent-plan",
  "ark-coding-plan",
  "gemini-3.5-flash",
  "kimi-k3",
]);
```

断言固定路由：

```ts
expect(resolveLlm("ark-agent-plan")).toMatchObject({
  runtime: "pi-rpc",
  provider: "ark-agent-plan",
  model: "ark-code-latest",
  network: "direct",
  concurrencyKey: "ark-agent-plan",
  maxConcurrency: 1,
});
expect(resolveLlm("ark-agent-deepseek-v4-flash")).toMatchObject({
  runtime: "pi-rpc",
  provider: "ark-agent-plan",
  model: "deepseek-v4-flash",
  network: "direct",
  concurrencyKey: "ark-agent-plan",
  maxConcurrency: 1,
});
expect(() => resolveLlm("kimi-k2.7")).toThrow(/Unknown logical llm/u);
expect(() => resolveLlm("ark-agent-glm-5.2")).toThrow(/Unknown logical llm/u);
```

新增断言：两个新 Agent Plan profile 在真实 smoke 前，`resolveLlm(id, "review")` 和 `resolveLlm(id, "delegate")` 都因 pending 明确失败。

在 `test/runtime/environment.test.ts` 删除 11808 用例，并让传入父环境：

```ts
{
  HTTP_PROXY: "http://parent:1",
  HTTPS_PROXY: "http://parent:2",
  ALL_PROXY: "socks5://parent:3",
  http_proxy: "http://parent:4",
  https_proxy: "http://parent:5",
}
```

时，`direct` 结果不含任何代理键，`proxy-10808` 结果的四个 HTTP(S) 大小写键都严格等于 `http://127.0.0.1:10808`，且不含 `ALL_PROXY`。

- [x] **Step 2：先写 Pi 配置和共享配额池测试**

目标 fixture `test/fixtures/pi/expected-ark-models.json` 的 provider 模型集合固定为：

```json
{
  "ark-agent-plan": [
    "ark-code-latest",
    "deepseek-v4-flash"
  ],
  "ark-coding-plan": [
    "ark-code-latest"
  ]
}
```

在 `test/tasks/service.test.ts` 与 `test/runtime/limiter.test.ts` 中并发发起两个不同 Agent Plan LLM，使用可控 Promise 记录同时运行数，断言峰值为 `1`；Coding Plan 与 Agent Plan 各发一个时，断言两者可以同时进入执行器。

- [x] **Step 3：运行目标测试，确认先红**

Run:

```powershell
npx vitest run test/llms/registry.test.ts test/runtime/environment.test.ts test/adapters/pi/config.test.ts test/cli/doctor.test.ts test/smoke/ark.test.ts test/smoke/kimi.test.ts test/tasks/service.test.ts test/runtime/limiter.test.ts test/acceptance/local.test.ts
```

Expected: 失败原因对应旧七模型枚举、11808 分支、旧 Agent Plan 模型和旧 smoke ID。

- [x] **Step 4：删除 11808 类型和实现分支**

`src/domain/types.ts`：

```ts
export type NetworkPolicy = "direct" | "proxy-10808";
```

`src/runtime/environment.ts`：

```ts
if (policy.network === "proxy-10808") {
  const proxy = "http://127.0.0.1:10808";
  childEnvironment.HTTP_PROXY = proxy;
  childEnvironment.HTTPS_PROXY = proxy;
  childEnvironment.http_proxy = proxy;
  childEnvironment.https_proxy = proxy;
}
```

- [x] **Step 5：实现五项注册表**

增加 pending helper：

```ts
const pendingTasks = {
  capabilities: { review: true, delegate: true },
  qualityGates: {
    review: { status: "pending" },
    delegate: { status: "pending" },
  },
} as const;
```

保留 `kimi-k3`、`gemini-3.5-flash`、`ark-coding-plan` 的现有固定路由和 passed 证据；删除两个旧 Kimi 与两个旧 Agent Plan 条目。新增：

```ts
{
  id: "ark-agent-plan",
  displayName: "Ark Agent Plan",
  runtime: "pi-rpc",
  provider: "ark-agent-plan",
  model: "ark-code-latest",
  network: "direct",
  credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
  credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
  timeoutMs: 900_000,
  maxConcurrency: 1,
  concurrencyKey: "ark-agent-plan",
  ...pendingTasks,
},
{
  id: "ark-agent-deepseek-v4-flash",
  displayName: "Ark Agent Plan DeepSeek V4 Flash",
  runtime: "pi-rpc",
  provider: "ark-agent-plan",
  model: "deepseek-v4-flash",
  network: "direct",
  credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
  credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
  timeoutMs: 900_000,
  maxConcurrency: 1,
  concurrencyKey: "ark-agent-plan",
  ...pendingTasks,
},
```

不要为 pending profile 复用旧 GLM 或 Doubao evidence。

- [x] **Step 6：实现目标 Pi 模型配置与 doctor 诊断**

`src/adapters/pi/config.ts` 的 Agent Plan 模型数组改为：

```ts
models: [
  {
    id: "ark-code-latest",
    name: "Ark Agent Plan",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash Agent Plan",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
],
```

`src/cli/doctor.ts` 的期望集合改为：

```ts
const EXPECTED_ARK_MODELS = new Map([
  ["ark-agent-plan", ["ark-code-latest", "deepseek-v4-flash"]],
  ["ark-coding-plan", ["ark-code-latest"]],
]);
```

Ark Agent 凭据诊断使用 `resolveLlm("ark-agent-plan")`；模型总数显示为 3。doctor 的 LLM 检查应列出五项，其中两个新 Agent Plan 在晋级前为 warn/pending，而不是伪装为 enabled。

- [x] **Step 7：更新 smoke 与本地验收引用**

`src/smoke/ark.ts`：

```ts
const ARK_LLM_IDS = new Set([
  "ark-coding-plan",
  "ark-agent-plan",
  "ark-agent-deepseek-v4-flash",
]);
```

`src/smoke/kimi.ts` 的参数解析在 `resolveLlm` 后继续验证 runtime 为 `kimi-acp`，确保 Ark ID 不能进入 Kimi smoke。`scripts/local-acceptance.mjs` 的 Kimi review 改为：

```js
const kimiReview = await callReview(
  client,
  "kimi-k3",
  "kimi-code/k3",
  await createFixture("kimi-review"),
);
```

同步替换所有测试中的旧 ID；历史 evidence JSON 不删除。

- [x] **Step 8：同步结构事实文档**

在同一提交中更新：

- `AGENTS.md`：当前代码模型面变为五项，但两个新 Agent Plan 精确门禁仍 pending；
- `docs/smoke/kimi.md`：旧 K2.7 证据标成历史，不再是当前公开面；
- `docs/smoke/ark.md`：旧 GLM/Doubao 证据标成历史，新 Agent Plan 两项显示 pending；
- 不改写历史 JSON 内容。

- [x] **Step 9：验证并提交**

Run:

```powershell
npx vitest run test/llms/registry.test.ts test/runtime/environment.test.ts test/adapters/pi/config.test.ts test/cli/doctor.test.ts test/smoke/ark.test.ts test/smoke/kimi.test.ts test/tasks/service.test.ts test/runtime/limiter.test.ts test/acceptance/local.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: 全部通过；两个新 Agent Plan 的任务解析测试仍明确报告 pending。

Commit:

```powershell
git add AGENTS.md docs/smoke src test scripts/local-acceptance.mjs
git commit -m "feat: define approved external llm routes"
```

## Task 3：创建官方插件源码与自包含 bundle

**Files:**

- Create: `.agents/plugins/marketplace.json`
- Create: `plugins/codex-external-agents/.codex-plugin/plugin.json`
- Create: `plugins/codex-external-agents/.mcp.json`
- Create: `tsup.plugin.config.ts`
- Create: `test/plugin/artifact.test.ts`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1：加载插件脚手架技能并限定写入范围**

实施此任务时读取 `plugin-creator` skill。明确采用“仓库内 marketplace + 仓库内插件目录”，不创建或修改个人 marketplace，不安装插件，不触碰 `CODEX_HOME`。

- [ ] **Step 2：先写插件静态契约测试**

`test/plugin/artifact.test.ts` 至少断言：

```ts
expect(marketplace).toMatchObject({
  name: "codex-external-agents-local",
  plugins: [
    {
      name: "codex-external-agents",
      source: {
        source: "local",
        path: "./plugins/codex-external-agents",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
    },
  ],
});

expect(pluginManifest).toMatchObject({
  name: "codex-external-agents",
  version: packageJson.version,
  mcpServers: "./.mcp.json",
});

expect(mcpManifest).toEqual({
  codex_external_agents: {
    command: "node",
    args: ["./runtime/codex-external-agents-mcp.mjs"],
  },
});
```

并断言 marketplace 只有一个插件，插件 manifest 不声明 hooks、skills、apps，MCP manifest 只有一个服务且不含 `env`、绝对路径或真实凭据。

- [ ] **Step 3：运行插件测试，确认先红**

Run:

```powershell
npx vitest run test/plugin/artifact.test.ts
```

Expected: 因三个 manifest 尚不存在而失败。

- [ ] **Step 4：创建仓库 marketplace**

`.agents/plugins/marketplace.json`：

```json
{
  "name": "codex-external-agents-local",
  "interface": {
    "displayName": "Codex External Agents Local"
  },
  "plugins": [
    {
      "name": "codex-external-agents",
      "source": {
        "source": "local",
        "path": "./plugins/codex-external-agents"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

- [ ] **Step 5：创建插件 manifest**

`plugins/codex-external-agents/.codex-plugin/plugin.json`：

```json
{
  "name": "codex-external-agents",
  "version": "0.1.0-alpha.1",
  "description": "Use explicitly selected external LLMs for review and delegated coding tasks.",
  "license": "MIT",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Codex External Agents",
    "shortDescription": "Review and delegate with explicitly selected external LLMs"
  }
}
```

`plugins/codex-external-agents/.mcp.json`：

```json
{
  "codex_external_agents": {
    "command": "node",
    "args": [
      "./runtime/codex-external-agents-mcp.mjs"
    ]
  }
}
```

- [ ] **Step 6：创建插件专用构建配置**

`tsup.plugin.config.ts`：

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "codex-external-agents-mcp": "src/mcp/main.ts",
  },
  outDir: "plugins/codex-external-agents/runtime",
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  noExternal: [/.*/u],
  splitting: false,
  dts: false,
  sourcemap: false,
  clean: true,
});
```

在 `.gitignore` 增加：

```gitignore
plugins/codex-external-agents/runtime/
```

`package.json` 脚本改为：

```json
{
  "scripts": {
    "build:library": "tsup",
    "build:plugin": "tsup --config tsup.plugin.config.ts",
    "build": "npm run build:library && npm run build:plugin"
  }
}
```

保留其它现有脚本不变。若 `noExternal` 对 Node 内置模块产生错误，只允许通过 `external: [/^node:/u]` 明确排除 Node 内置模块；不允许把生产 npm 依赖重新外置。

- [ ] **Step 7：验证自包含产物**

Run:

```powershell
npm run build
npx vitest run test/plugin/artifact.test.ts
node plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs --help
rg -n "D:\\\\Codes|C:\\\\Users\\\\Administrator|node_modules" plugins/codex-external-agents/runtime
```

Expected:

- 构建和测试通过；
- MCP `--help` 正常退出；
- 最后一条 `rg` 无匹配；
- bundle 运行不依赖仓库 `node_modules` 的相对导入。

- [ ] **Step 8：提交**

```powershell
git add .agents .gitignore package.json package-lock.json plugins tsup.plugin.config.ts test/plugin/artifact.test.ts
git commit -m "feat: package external agents as codex plugin"
```

构建生成的 `plugins/codex-external-agents/runtime/` 不进入 Git。

## Task 4：隔离官方安装取证与已安装副本验收

**Files:**

- Create: `src/plugin/state-snapshot.ts`
- Create: `test/plugin/state-snapshot.test.ts`
- Create: `scripts/plugin-isolated-acceptance.mjs`
- Create: `docs/release/plugin-isolated-state.md`
- Modify: `tsup.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1：先写状态快照失败测试**

`test/plugin/state-snapshot.test.ts` 使用临时目录创建嵌套文件，断言：

```ts
expect(await snapshotDirectory(root)).toEqual({
  files: [
    {
      path: "config.toml",
      size: 4,
      sha256: createHash("sha256").update("base").digest("hex"),
    },
    {
      path: "plugins/cache/item.json",
      size: 3,
      sha256: createHash("sha256").update("{}\n").digest("hex"),
    },
  ],
});
```

再用 before/after 快照断言：

```ts
expect(diffSnapshots(before, after)).toEqual({
  added: ["plugins/cache/new.json"],
  changed: ["config.toml"],
  removed: ["old-state"],
});
```

路径一律使用 `/`，结果按路径排序；快照只记录相对路径、字节数和 SHA-256，不记录文件正文。

- [ ] **Step 2：运行快照测试，确认先红**

Run:

```powershell
npx vitest run test/plugin/state-snapshot.test.ts
```

Expected: 因模块尚不存在而失败。

- [ ] **Step 3：实现纯快照与差异函数**

`src/plugin/state-snapshot.ts` 导出：

```ts
export interface StateFile {
  path: string;
  size: number;
  sha256: string;
}

export interface StateSnapshot {
  files: StateFile[];
}

export interface StateDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export async function snapshotDirectory(root: string): Promise<StateSnapshot>;
export function diffSnapshots(
  before: StateSnapshot,
  after: StateSnapshot,
): StateDiff;
```

实现规则：

- 递归只处理普通文件和目录；
- 符号链接记录为错误，避免越出临时 `CODEX_HOME`；
- 文件 hash 使用原始字节；
- 根目录不存在时返回 `{ files: [] }`；
- 差异比较路径、size 和 sha256；
- 不读取或引用默认 Codex home。

- [ ] **Step 4：验证纯函数**

Run:

```powershell
npx vitest run test/plugin/state-snapshot.test.ts
```

Expected: 通过。

- [ ] **Step 5：编写隔离官方安装脚本**

先在 `tsup.config.ts` 的 entry 中加入：

```ts
"plugin-state-snapshot": "src/plugin/state-snapshot.ts",
```

`scripts/plugin-isolated-acceptance.mjs` 从 `../dist/plugin-state-snapshot.js` 导入 `snapshotDirectory` 与 `diffSnapshots`，并且必须：

1. 先检查 `plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs` 已构建；
2. 用 `mkdtemp` 创建唯一临时目录，并把 `CODEX_HOME` 设为其中的 `codex-home`；
3. 所有 `codex` 子进程显式使用 `{ ...process.env, CODEX_HOME: isolatedHome }`；
4. 依次执行：

```text
codex plugin marketplace add D:\Codes\codex-agent-tools
codex plugin list --marketplace codex-external-agents-local
codex plugin add codex-external-agents@codex-external-agents-local
codex plugin list --marketplace codex-external-agents-local
codex plugin remove codex-external-agents@codex-external-agents-local
codex plugin marketplace remove codex-external-agents-local
```

5. 在每一步后调用 `snapshotDirectory(isolatedHome)`；
6. 安装后断言列表中 `codex-external-agents` 为已安装；
7. 卸载后断言插件列表不再显示已安装；
8. 移除 marketplace 后断言 marketplace 不再可列出；
9. 把每一步的 `StateDiff` 写入脱敏 Markdown，不写任何文件正文或环境变量值；
10. `finally` 中关闭 MCP 客户端并删除临时根目录。

脚本中的固定 selector：

```js
const marketplace = "codex-external-agents-local";
const plugin = "codex-external-agents";
const selector = `${plugin}@${marketplace}`;
```

脚本必须拒绝 `isolatedHome === process.env.CODEX_HOME` 且拒绝 `isolatedHome` 解析到 `os.homedir()` 下的 `.codex`；这是防止测试误触活动配置的硬门禁。

- [ ] **Step 6：从官方缓存副本启动 MCP**

安装后固定从：

```js
const installedPluginRoot = path.join(
  isolatedHome,
  "plugins",
  "cache",
  marketplace,
  plugin,
  "local",
);
```

读取该目录下 `.mcp.json`，拒绝绝对 `command`/`args`，然后以 `cwd: installedPluginRoot` 启动 manifest 声明的命令。使用 MCP SDK `initialize` 与 `listTools`，断言只返回：

```js
["external_delegate", "external_review"]
```

并断言两个 schema 都要求 `llm`、review 只读、delegate 可写。

- [ ] **Step 7：用 fake Pi 证明环境继承与 10808 隔离**

脚本在临时根目录生成一个 Windows `.cmd` 包装器。包装器先断言自身收到：

```text
HTTPS_PROXY=http://127.0.0.1:10808
HTTP_PROXY=http://127.0.0.1:10808
```

再调用仓库的 `test/fakes/fake-pi-rpc.mjs`。启动已安装 MCP 时传入：

```js
{
  ...process.env,
  CODEX_HOME: isolatedHome,
  PI_COMMAND: fakePiCommand,
  GEMINI_API_KEY: "isolated-plugin-sentinel",
  HTTPS_PROXY: "http://parent-proxy.invalid:9999",
  HTTP_PROXY: "http://parent-proxy.invalid:9999",
  ALL_PROXY: "socks5://parent-proxy.invalid:9999",
}
```

调用：

```js
await client.callTool({
  name: "external_review",
  arguments: {
    llm: "gemini-3.5-flash",
    task: "review_doc",
    prompt: "Review README.md without modifying files.",
    cwd: fixtureRoot,
  },
});
```

断言结果 `status === "completed"`、`actualModel === "gemini-3.5-flash"`、`filesChanged` 为空。调用成功同时证明：

- 已安装 MCP 进程继承了目标凭据候选；
- 子进程没有沿用父进程 9999 代理；
- Gemini 子进程固定收到 10808；
- 安装副本可在官方缓存路径启动。

Ark direct 的父代理清理继续由 `test/runtime/environment.test.ts` 覆盖；真实 Ark route 在任务 7 验证。

- [ ] **Step 8：生成稳定取证报告**

`docs/release/plugin-isolated-state.md` 正文固定包含：

- 隔离根目录策略，不包含实际临时绝对路径；
- Codex CLI 版本；
- marketplace add、plugin add、plugin remove、marketplace remove 的相对状态差异；
- `config.toml` 是否出现以及其 hash 是否变化；
- 官方缓存路径的相对位置；
- MCP tool contract 结果；
- fake Pi 环境/代理门禁结果；
- 卸载后的语义回滚结果；
- 明确声明“这不是活动 Codex home，也不构成真实 Codex App 验收”。

若官方卸载保留合法缓存或空状态文件，报告如实列出；验收依据是官方列表已移除目标状态且残留差异可解释，不伪造字节级完全回滚。

- [ ] **Step 9：加入脚本并运行**

`package.json` 增加：

```json
"acceptance:plugin:isolated": "npm run build && node scripts/plugin-isolated-acceptance.mjs"
```

Run:

```powershell
npm run acceptance:plugin:isolated
npx vitest run test/plugin/state-snapshot.test.ts
npm run typecheck
git diff --check
```

Expected: 全部通过；活动 `CODEX_HOME` 未被使用。

- [ ] **Step 10：提交**

```powershell
git add src/plugin test/plugin scripts/plugin-isolated-acceptance.mjs docs/release/plugin-isolated-state.md package.json package-lock.json
git commit -m "test: characterize isolated codex plugin lifecycle"
```

## Task 5：把插件产物纳入发布保障但不发布

**Files:**

- Modify: `src/release/assurance.ts`
- Modify: `test/release/assurance.test.ts`
- Modify: `scripts/release-smoke.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1：先写包内容与敏感信息失败测试**

在 `test/release/assurance.test.ts` 增加允许文件：

```ts
[
  ".agents/plugins/marketplace.json",
  "plugins/codex-external-agents/.codex-plugin/plugin.json",
  "plugins/codex-external-agents/.mcp.json",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
]
```

并增加拒绝用例：

```ts
expect(() =>
  assertAllowedPackFiles([
    "plugins/codex-external-agents/node_modules/zod/index.js",
  ]),
).toThrow(/Unexpected file/u);
```

增加 bundle 内容检查用例，拒绝开发机绝对路径、真实 secret、`../dist/mcp.js` 和指向仓库 `node_modules` 的导入。

- [ ] **Step 2：先把 release smoke 目标改成五项与无配置 doctor**

`scripts/release-smoke.mjs` 中 doctor 调用改为：

```js
const output = run(process.execPath, [cliPath, "doctor", "--json"]);
```

逻辑 LLM 数量断言改为 `5`；新增插件 manifest/version 一致、官方 marketplace 指向存在目录、构建 runtime 存在、安装副本 MCP 契约检查。

- [ ] **Step 3：运行目标测试，确认先红**

Run:

```powershell
npx vitest run test/release/assurance.test.ts
npm run smoke:release
```

Expected: 新插件文件尚未在 package allowlist 中，release smoke 仍使用旧 doctor/七项断言或缺少插件检查。

- [ ] **Step 4：扩展 release allowlist**

`src/release/assurance.ts` 的允许规则增加：

```ts
const EXACT_PLUGIN_FILES = new Set([
  ".agents/plugins/marketplace.json",
  "plugins/codex-external-agents/.codex-plugin/plugin.json",
  "plugins/codex-external-agents/.mcp.json",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
]);
```

允许条件仅增加 `EXACT_PLUGIN_FILES.has(name)`，不允许整个 `plugins/` 或 `.agents/` 任意内容。

- [ ] **Step 5：把插件文件加入 npm pack 范围**

`package.json` 的 `files` 数组增加：

```json
".agents/plugins/marketplace.json",
"plugins/codex-external-agents/.codex-plugin/plugin.json",
"plugins/codex-external-agents/.mcp.json",
"plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs"
```

这只让 `npm pack --dry-run` 验证交付闭包；本计划不执行发布。

- [ ] **Step 6：实现 release smoke 插件保障**

`scripts/release-smoke.mjs` 额外断言：

- package version 等于 plugin version；
- marketplace 只引用目标插件；
- `.mcp.json` 只引用 bundle 相对路径；
- bundle 不含仓库/用户目录绝对路径；
- bundle 不含当前进程真实凭据值；
- bundle 不含可解析到仓库 `node_modules` 的生产 import；
- `npm pack --dry-run --json` 含四个精确插件文件；
- `codex plugin --help` 与 `codex plugin marketplace --help` 可用；
- 不执行 `plugin add`，安装生命周期仍只由隔离验收脚本负责。

- [ ] **Step 7：验证并提交**

Run:

```powershell
npx vitest run test/release/assurance.test.ts
npm run smoke:release
npm run typecheck
npm test
git diff --check
```

Expected: 全部通过。

Commit:

```powershell
git add src/release test/release scripts/release-smoke.mjs package.json package-lock.json
git commit -m "test: assure codex plugin release artifact"
```

## Task 6：更新运维、迁移与验收文档

**Files:**

- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/migration-from-codex-cc-tools.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/smoke/kimi.md`
- Modify: `docs/smoke/pi-gemini.md`
- Modify: `docs/smoke/ark.md`
- Modify: `docs/superpowers/specs/2026-07-18-codex-external-agents-design.md`
- Modify: `AGENTS.md`

- [ ] **Step 1：删除所有旧配置写入指引**

Run:

```powershell
rg -n "install --replace-codex-cc-tools|restore --backup|codex-agent-tools install|codex-agent-tools uninstall|--config" README.md docs AGENTS.md
```

逐项修改所有面向当前用户的指引。历史设计中的旧命令可以保留，但必须在同一段明确标注“历史实现，当前已禁用，不得用于活动配置”。

- [ ] **Step 2：写官方插件运维流程**

`docs/operations.md` 只描述：

1. `npm ci`；
2. `npm run build`；
3. `npm run acceptance:plugin:isolated`；
4. 查看 `docs/release/plugin-isolated-state.md`；
5. 准备真实安装权限包；
6. 获得逐次明确许可后，才使用官方 `codex plugin marketplace add` 与 `codex plugin add`；
7. 官方 remove/marketplace remove 回滚；
8. 绝不手工编辑活动 `config.toml`。

真实命令放在“仅在明确许可后”代码块中：

```powershell
codex plugin marketplace add D:\Codes\codex-agent-tools
codex plugin add codex-external-agents@codex-external-agents-local
```

回滚命令：

```powershell
codex plugin remove codex-external-agents@codex-external-agents-local
codex plugin marketplace remove codex-external-agents-local
```

- [ ] **Step 3：写共存迁移边界**

`docs/migration-from-codex-cc-tools.md` 明确：

- 当前先共存；
- 新插件不调用 cc tools 或 Claude Code；
- 本轮不卸载旧工具；
- 只有真实 Codex App、五项十门禁、取消/清理全通过后才“具备替代条件”；
- 移除旧工具是后续独立变更和独立授权。

- [ ] **Step 4：写四层验收清单**

`docs/release/checklist.md` 分成：

1. 确定性单测/构建；
2. 隔离官方插件生命周期；
3. 五项真实模型门禁；
4. 真实 Codex App 宿主门禁。

每一层都有通过证据路径和失败后的停止条件。不得把隔离 CLI 验收写成真实 App 已通过。

- [ ] **Step 5：同步模型与历史证据说明**

- `docs/smoke/kimi.md`：当前只支持 K3，K2.7 仅历史；
- `docs/smoke/pi-gemini.md`：当前 Gemini 路由不变，但任务 7 将产生新的精确证据；
- `docs/smoke/ark.md`：当前三条 Ark 路由和 pending/passed 状态；
- 原始 2026-07-18 设计增加“由 2026-07-25 官方插件设计覆盖安装、网络和模型面”的链接；
- `AGENTS.md` 更新真实进度和本计划索引。

- [ ] **Step 6：验证文档无漂移并提交**

Run:

```powershell
rg -n "kimi-k2\\.7|ark-agent-glm-5\\.2|ark-agent-doubao-seed-2\\.0-pro|proxy-11808" README.md docs AGENTS.md
rg -n "config\\.toml" README.md docs/operations.md docs/migration-from-codex-cc-tools.md docs/release/checklist.md
git diff --check
npm run smoke:release
```

Expected:

- 第一条命中只能位于明确的历史段落；
- 第二条每个命中都说明禁止直接读写或逐次授权；
- release smoke 通过。

Commit:

```powershell
git add README.md AGENTS.md docs
git commit -m "docs: document official plugin operations"
```

## Task 7：串行执行五项 LLM 的十个真实门禁

**Files:**

- Modify: `src/llms/registry.ts`
- Modify: `docs/smoke/kimi.md`
- Modify: `docs/smoke/pi-gemini.md`
- Modify: `docs/smoke/ark.md`
- Create at runtime: `docs/smoke/evidence/` 下由现有 smoke runner 按 ISO 时间戳、逻辑 LLM 和任务类型命名的 JSON 证据
- Modify: `AGENTS.md`

- [ ] **Step 1：建立门禁前基线**

Run:

```powershell
npm run typecheck
npm test
npm run build
git status --short
```

Expected: 确定性检查全绿；工作树只有计划内尚未提交内容时才继续。

- [ ] **Step 2：串行执行 Kimi K3**

```powershell
npm run smoke:kimi -- --llm kimi-k3 --task review
npm run smoke:kimi -- --llm kimi-k3 --task delegate
```

两项都必须 `passed: true`、`actualModel: "kimi-code/k3"`、无新增 Kimi 进程。

- [ ] **Step 3：串行执行 Gemini**

```powershell
npm run smoke:pi -- --llm gemini-3.5-flash --task review
npm run smoke:pi -- --llm gemini-3.5-flash --task delegate
```

两项都必须 `passed: true`、`actualModel: "gemini-3.5-flash"`、route 为 10808、无新增 Pi 进程。429 额度失败保持失败，不切换其它模型。

- [ ] **Step 4：串行执行 Ark Coding Plan**

```powershell
npm run smoke:ark -- --llm ark-coding-plan --task review
npm run smoke:ark -- --llm ark-coding-plan --task delegate
```

两项都必须 `passed: true`、`actualModel: "ark-code-latest"`、provider 为 `ark-coding-plan`、route 为 direct。

- [ ] **Step 5：串行执行 Ark Agent Plan 主档**

```powershell
npm run smoke:ark -- --llm ark-agent-plan --task review
npm run smoke:ark -- --llm ark-agent-plan --task delegate
```

两项都必须 `passed: true`、`actualModel: "ark-code-latest"`、provider 为 `ark-agent-plan`、route 为 direct。

- [ ] **Step 6：串行执行 Ark Agent Plan 经济档**

```powershell
npm run smoke:ark -- --llm ark-agent-deepseek-v4-flash --task review
npm run smoke:ark -- --llm ark-agent-deepseek-v4-flash --task delegate
```

两项都必须 `passed: true`、`actualModel: "deepseek-v4-flash"`、provider 为 `ark-agent-plan`、route 为 direct。

- [ ] **Step 7：严格晋级**

只有某个逻辑 LLM 的 review 与 delegate 都通过时，才把该 profile 改为：

```ts
...qualifiedTasks("docs/smoke/ark.md", "ark-agent-plan")
```

或：

```ts
...qualifiedTasks(
  "docs/smoke/ark.md",
  "ark-agent-deepseek-v4-flash",
)
```

若任一门禁失败，该逻辑 LLM 两项都保留 pending，文档记录失败类别和脱敏证据；不复用旧模型证据，不自动 fallback。

- [ ] **Step 8：更新证据索引**

三个 smoke 文档为每个当前逻辑 LLM 建立稳定 anchor：

```text
#kimi-k3-review
#kimi-k3-delegate
#gemini-review
#gemini-delegate
#ark-coding-plan-review
#ark-coding-plan-delegate
#ark-agent-plan-review
#ark-agent-plan-delegate
#ark-agent-deepseek-v4-flash-review
#ark-agent-deepseek-v4-flash-delegate
```

每个 anchor 链接脚本实际生成的 evidence JSON，并记录实际模型、provider、route、passed、无残留进程。`AGENTS.md` 同步 passed/pending 事实。

- [ ] **Step 9：最终验证并提交**

Run:

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated
git diff --check
```

Expected: 全部通过。若真实模型因外部额度阻塞，确定性检查仍需通过，但不得宣称模型面完整完成。

Commit:

```powershell
git add src/llms/registry.ts docs/smoke/evidence docs/smoke AGENTS.md
git commit -m "test: qualify approved external llm routes"
```

## Task 8：准备真实安装逐次权限包并停止

**Files:**

- Create: `docs/release/real-plugin-install-review.md`
- Modify: `AGENTS.md`

- [ ] **Step 1：从隔离报告提取最小充分证据**

权限包只包含：

- 为什么必须用官方安装才能完成真实 App 验收；
- 当前尚未执行真实安装；
- 官方文档确认插件开关状态存储在活动 `config.toml`；
- 隔离安装实际新增/改变/移除的相对文件；
- 活动 `config.toml` 的预计精确语义差异，使用脱敏 TOML 片段表达；
- 官方安装后验证命令；
- 官方 remove 回滚命令；
- 失败时不手工恢复 TOML；
- 旧 `codex_cc_tools` 保持原状；
- 本轮不发布 npm、不移除旧工具。

- [ ] **Step 2：写权限包**

`docs/release/real-plugin-install-review.md` 的“需要用户判断”只保留一个问题：

```text
是否授权本次使用 Codex 官方命令，把本仓库 marketplace 加入当前 Codex、安装 codex-external-agents，并在验收失败时用权限包列出的官方 remove 命令回滚？
```

回答方式固定为：

```text
授权本次真实安装
```

不把后续升级、卸载旧工具或发布权限捆绑进来。

- [ ] **Step 3：用现有外部 LLM 审阅权限包**

优先使用当前会话可用的 `codex_external_agents` MCP。若当前工具面尚未暴露它，则从已构建 bundle 启动临时 stdio MCP 客户端执行同样的只读调用；不得为审阅提前安装真实插件，也不得回退到 cc tools。

按顺序调用：

1. `external_review(llm: "kimi-k3", task: "adversarial_review")`
2. `external_review(llm: "ark-coding-plan", task: "review_doc")`

审阅范围只包含设计、隔离取证报告和权限包。要求检查：

- 是否越权；
- 预计差异是否由隔离证据支持；
- 回滚是否只用官方机制；
- 是否混入旧工具移除或公共发布；
- 是否泄漏路径外的秘密值。

Codex 对反馈逐项核实，只采纳有证据的问题。

- [ ] **Step 4：验证并提交权限包**

Run:

```powershell
rg -n "API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION" docs/release/real-plugin-install-review.md
git diff --check
npm run smoke:release
```

Expected: 第一条只能命中环境变量名称或安全说明，不得出现任何值；其它检查通过。

Commit:

```powershell
git add docs/release/real-plugin-install-review.md AGENTS.md
git commit -m "docs: prepare real plugin install review"
```

- [ ] **Step 5：向用户提交权限包并停止**

给用户提供可点击的权限包路径、最小结论和精确授权语句。没有收到新的明确授权前，不执行任务 9 的任何命令。

## Task 9：仅在明确授权后执行真实官方安装与宿主门禁

**Files:**

- Create: `docs/release/real-host-acceptance.md`
- Modify: `AGENTS.md`

- [ ] **Step 1：重新核对权限**

必须在当前对话中存在用户针对任务 8 的明确授权。历史“同意使用官方插件机制”不等于本次写入许可。没有精确授权就停止。

- [ ] **Step 2：用官方命令执行真实安装**

只运行：

```powershell
codex plugin marketplace add D:\Codes\codex-agent-tools
codex plugin add codex-external-agents@codex-external-agents-local
codex plugin list --marketplace codex-external-agents-local
```

不直接打开、读取或编辑活动 `config.toml`。若官方命令输出与隔离取证不一致，立即停止，不继续追加自定义修复。

- [ ] **Step 3：刷新宿主**

按 Codex 官方机制刷新插件状态；若必须重启 Codex App，先保存当前进度到 `AGENTS.md` 和 `docs/release/real-host-acceptance.md`，再由用户重启并在新会话继续。

- [ ] **Step 4：真实 App 工具发现门禁**

在新会话中验证：

- `codex_external_agents` 只新增 `external_review` 与 `external_delegate`；
- 两个工具 `llm` 必填；
- review/delegate 注解准确；
- 旧 `codex_cc_tools` 仍存在且未被修改；
- 没有 Claude Code 后端或第三个状态工具。

- [ ] **Step 5：真实 App 代表性调用**

至少从真实 Codex 宿主调用：

1. `external_review(llm: "kimi-k3")`
2. `external_review(llm: "ark-coding-plan")` 或 `external_review(llm: "gemini-3.5-flash")`
3. 一个在隔离临时仓库中的 `external_delegate(llm: "kimi-k3")`
4. 一个可取消的长任务，确认取消后无 Kimi/Pi 残留进程

调用失败不切换模型；记录原始逻辑 LLM、实际模型、route、状态和脱敏诊断。

- [ ] **Step 6：失败时只用官方回滚**

若宿主门禁失败，运行：

```powershell
codex plugin remove codex-external-agents@codex-external-agents-local
codex plugin marketplace remove codex-external-agents-local
```

然后用 `codex plugin list` 验证移除。不得手工恢复 TOML。若回滚也异常，停止并报告，不尝试自定义文件修复。

- [ ] **Step 7：记录真实宿主证据并提交**

`docs/release/real-host-acceptance.md` 记录：

- 明确授权来源；
- 官方命令与结果摘要；
- 工具发现；
- 代表性调用；
- 取消与进程回收；
- 旧工具共存；
- 最终保留安装或已回滚状态；
- 明确说明尚未移除 cc tools、尚未公共发布。

Run:

```powershell
git diff --check
npm run smoke:release
```

Commit:

```powershell
git add docs/release/real-host-acceptance.md AGENTS.md
git commit -m "docs: record real codex plugin acceptance"
```

## Task 10：最终外部审阅、回归与阶段总结

**Files:**

- Modify: implementation files identified by review
- Modify: tests paired with each behavior fix
- Modify: `AGENTS.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/release/real-host-acceptance.md` if task 9 ran

- [ ] **Step 1：运行完整确定性验证**

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated
node dist/cli.js --version
node dist/cli.js --help
node dist/mcp.js --help
git diff --check
```

Expected: 全部通过。

- [ ] **Step 2：检查结构与禁止项**

```powershell
rg -n "proxy-11808|kimi-k2\\.7|ark-agent-glm-5\\.2|ark-agent-doubao-seed-2\\.0-pro" src test scripts
rg -n "installCodexConfig|cutoverCodexConfig|restoreCodexConfigBackup|getDefaultCodexConfigPath" src test scripts
rg -n "claude|anthropic|codex_cc_tools" src plugins
rg -n "D:\\\\Codes|C:\\\\Users\\\\Administrator|node_modules" plugins/codex-external-agents/runtime
```

Expected:

- 前两条无匹配；
- 第三条无运行时代码匹配；若 manifest 描述或注释出现，逐项证明不构成后端；
- 第四条无匹配。

- [ ] **Step 3：用两个外部来源审阅完整 diff**

调用路径与任务 8 相同：优先使用当前会话工具面，否则从已构建 bundle 启动临时 stdio MCP 客户端；不使用 cc tools。

按顺序调用：

1. Kimi K3：安全边界、MCP 契约、插件可移植性、Windows 进程与代理；
2. Ark Coding Plan：模型注册表、Pi 配置、门禁证据、官方安装/回滚和文档一致性。

每次都要求只读、给出文件/行证据、区分阻断项与建议项。Codex 逐项复核，不直接转发结论。

- [ ] **Step 4：对有效发现按 TDD 修复**

每个行为问题：

1. 写最小失败测试；
2. 运行确认失败；
3. 写最小修复；
4. 运行目标测试与完整回归；
5. 更新对应文档事实。

纯文档问题直接修订并运行 `git diff --check` 与 release smoke。

- [ ] **Step 5：再次运行完整验证**

重复任务 10 Step 1 和 Step 2。若改动影响真实模型路由或插件宿主行为，重跑受影响的精确 smoke 或真实宿主门禁；不得用确定性测试替代。

- [ ] **Step 6：更新阶段完成状态**

`AGENTS.md` 和 `docs/release/checklist.md` 必须分别说明：

- 更大目标推进到哪一层；
- 本轮实际完成了什么；
- 五项十门禁是否全部 passed；
- 隔离官方安装是否 passed；
- 真实 App 门禁是否执行/通过/回滚；
- 旧 cc tools 仍未移除；
- 尚缺的后续工作与触发条件。

- [ ] **Step 7：提交最终修订**

先用 `git status --short` 核对范围，只暂存任务 10 实际修改且逐项复核过的文件，再提交：

```powershell
git commit -m "chore: finalize official plugin integration"
```

若没有任何修订，不创建空提交。

## 完成判定

只有以下条件全部满足，才能称为“官方插件集成完成”：

- 五项逻辑 LLM 注册表与固定路由正确；
- 两项 Agent Plan 共享并发池为 1；
- 只有 Gemini 子进程使用 10808，其他子进程直连；
- `external_review` / `external_delegate` 是唯一公开工具，`llm` 必填；
- 插件 bundle 自包含且从官方缓存副本运行；
- 隔离官方 install/list/remove/marketplace lifecycle 已取证；
- 五项 LLM 的 review/delegate 十个真实门禁全部通过；
- 真实 Codex App 工具发现、代表调用、取消和进程回收通过；
- 活动配置只由获得逐次许可后的官方机制触碰；
- 旧 cc tools 保持共存，Claude Code 未被调用或修改；
- 未执行 npm 或公共插件发布。

如果任务 8 后尚未获得真实安装授权，正确阶段结论是“实现、隔离取证与真实模型门禁完成，等待真实官方安装许可”，不能声称真实宿主集成完成。
