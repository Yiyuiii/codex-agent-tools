import path from "node:path";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";

import {
  diffSnapshots,
  snapshotDirectory,
} from "../dist/plugin-state-snapshot.js";
import { cleanupOwnedMcpTransport } from "../dist/plugin-mcp-cleanup.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const reportPath = path.join(
  repositoryRoot,
  "docs",
  "release",
  "plugin-isolated-state.md",
);
const marketplace = "codex-external-agents-local";
const plugin = "codex-external-agents";
const selector = `${plugin}@${marketplace}`;
const pluginSourceRoot = path.join(
  repositoryRoot,
  "plugins",
  "codex-external-agents",
);
const pluginBundle = path.join(
  pluginSourceRoot,
  "runtime",
  "codex-external-agents-mcp.mjs",
);
const fakePiScript = path.join(
  repositoryRoot,
  "test",
  "fakes",
  "fake-pi-rpc.mjs",
);
const inheritedProxy = "http://parent-proxy.invalid:9999";
const inheritedAllProxy = "socks5://parent-proxy.invalid:9999";
const credentialSentinel = "isolated-plugin-sentinel";
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "codex-plugin-isolated-acceptance-"),
);
const isolatedHome = path.resolve(temporaryRoot, "codex-home");
const isolatedLocalAppData = path.resolve(temporaryRoot, "local-app-data");
const isolatedAppData = path.resolve(temporaryRoot, "roaming-app-data");
const fixtureRoot = path.resolve(temporaryRoot, "fixture");
const fakePiCommand = path.resolve(temporaryRoot, "fake-pi.cmd");
const activeCodexHome = path.resolve(os.homedir(), ".codex");
const inheritedCodexHome =
  process.env.CODEX_HOME === undefined || process.env.CODEX_HOME.trim() === ""
    ? undefined
    : path.resolve(process.env.CODEX_HOME);
let client;
let transport;

function samePath(left, right) {
  return left.localeCompare(right, undefined, {
    sensitivity: process.platform === "win32" ? "accent" : "variant",
  }) === 0;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertIsolationGate() {
  const checks = {
    insideTemporaryRoot: isInside(temporaryRoot, isolatedHome),
    notActiveCodexHome: !samePath(isolatedHome, activeCodexHome),
    notInheritedCodexHome:
      inheritedCodexHome === undefined ||
      !samePath(isolatedHome, inheritedCodexHome),
  };
  if (!Object.values(checks).every(Boolean)) {
    throw new Error("Refusing to run Codex outside the isolated temporary home");
  }
  return checks;
}

function childEnvironment(overrides = {}) {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      ...overrides,
    }).filter(([, value]) => typeof value === "string"),
  );
}

function redactFailure(value) {
  return String(value)
    .replaceAll(temporaryRoot, "<TEMP_ROOT>")
    .replaceAll(credentialSentinel, "<REDACTED>")
    .replaceAll(inheritedProxy, "<PARENT_PROXY>");
}

async function runCodex(args) {
  const checks = assertIsolationGate();
  process.stdout.write(
    `isolation gate: inside-temp=${checks.insideTemporaryRoot} not-active=${checks.notActiveCodexHome} not-inherited=${checks.notInheritedCodexHome}\n`,
  );
  const result = await execa("codex", args, {
    cwd: repositoryRoot,
    env: childEnvironment({ CODEX_HOME: isolatedHome }),
    reject: false,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `codex ${args.slice(0, 3).join(" ")} failed: ${redactFailure(
        result.stderr || result.stdout || `exit ${String(result.exitCode)}`,
      ).slice(0, 1_024)}`,
    );
  }
  return result.stdout;
}

function findStateFile(snapshot, relativePath) {
  return snapshot.files.find((file) => file.path === relativePath);
}

async function snapshotStep(name, before) {
  const after = await snapshotDirectory(isolatedHome);
  return {
    name,
    snapshot: after,
    diff: diffSnapshots(before, after),
  };
}

function assertPluginStatus(output, expectedStatus) {
  const line = output
    .split(/\r?\n/u)
    .find((entry) => entry.includes(selector));
  if (line === undefined) {
    throw new Error(`Official plugin list did not contain ${selector}`);
  }
  const pattern =
    expectedStatus === "installed"
      ? /\sinstalled,\s+enabled\s/iu
      : /\snot installed\s/iu;
  if (!pattern.test(line)) {
    throw new Error(`Official plugin list did not report ${expectedStatus}`);
  }
}

function isAbsoluteOnAnyPlatform(value) {
  return (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value)
  );
}

function requireObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

async function resolveInstalledPluginRoot() {
  const pluginManifest = requireObject(
    JSON.parse(
      await readFile(
        path.join(pluginSourceRoot, ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    ),
    "plugin manifest",
  );
  if (
    typeof pluginManifest.version !== "string" ||
    pluginManifest.version.trim() === ""
  ) {
    throw new Error("Plugin manifest version is missing");
  }
  const installedPluginParent = path.join(
    isolatedHome,
    "plugins",
    "cache",
    marketplace,
    plugin,
  );
  const entries = await readdir(installedPluginParent, {
    withFileTypes: true,
  });
  if (
    entries.length !== 1 ||
    !entries[0].isDirectory() ||
    entries[0].isSymbolicLink() ||
    entries[0].name !== pluginManifest.version
  ) {
    throw new Error(
      "Official plugin cache must contain exactly the manifest-version directory",
    );
  }
  const installedRoot = path.resolve(
    installedPluginParent,
    entries[0].name,
  );
  if (!isInside(isolatedHome, installedRoot)) {
    throw new Error("Installed plugin root escaped the isolated Codex home");
  }
  return {
    root: installedRoot,
    relativePath: path
      .relative(isolatedHome, installedRoot)
      .split(path.sep)
      .join("/"),
  };
}

async function readInstalledMcpServer(installedPluginRoot) {
  const manifest = requireObject(
    JSON.parse(
      await readFile(path.join(installedPluginRoot, ".mcp.json"), "utf8"),
    ),
    "installed MCP manifest",
  );
  let servers;
  if (Object.hasOwn(manifest, "mcp_servers")) {
    if (
      Object.keys(manifest).length !== 1 ||
      typeof manifest.mcp_servers !== "object"
    ) {
      throw new Error("Wrapped MCP manifest contains unsupported fields");
    }
    servers = requireObject(manifest.mcp_servers, "mcp_servers");
  } else {
    servers = manifest;
  }
  if (
    Object.keys(servers).length !== 1 ||
    !Object.hasOwn(servers, "codex_external_agents")
  ) {
    throw new Error(
      "Installed MCP manifest must contain only codex_external_agents",
    );
  }
  const server = requireObject(
    servers.codex_external_agents,
    "codex_external_agents",
  );
  if (
    typeof server.command !== "string" ||
    server.command.trim() === "" ||
    isAbsoluteOnAnyPlatform(server.command)
  ) {
    throw new Error("Installed MCP command must be a relative command name");
  }
  if (
    !Array.isArray(server.args) ||
    !server.args.every(
      (argument) =>
        typeof argument === "string" && !isAbsoluteOnAnyPlatform(argument),
    )
  ) {
    throw new Error("Installed MCP args must all be relative strings");
  }
  return { command: server.command, args: [...server.args] };
}

function assertToolContract(tools) {
  const names = tools.map((tool) => tool.name).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(["external_delegate", "external_review"])
  ) {
    throw new Error(`Unexpected installed MCP tools: ${names.join(", ")}`);
  }
  for (const tool of tools) {
    if (!tool.inputSchema?.required?.includes("llm")) {
      throw new Error(`${tool.name} does not require llm`);
    }
  }
  const review = tools.find((tool) => tool.name === "external_review");
  const delegate = tools.find((tool) => tool.name === "external_delegate");
  if (
    review?.annotations?.readOnlyHint !== true ||
    review.annotations.destructiveHint !== false
  ) {
    throw new Error("external_review annotations are not read-only");
  }
  if (
    delegate?.annotations?.readOnlyHint !== false ||
    delegate.annotations.destructiveHint !== true
  ) {
    throw new Error("external_delegate annotations are not writable");
  }
}

function structuredContent(result) {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  ) {
    throw new Error("Installed MCP result has no structuredContent");
  }
  return result.structuredContent;
}

function quoteCmdArgument(value) {
  if (value.includes('"') || /[\r\n]/u.test(value)) {
    throw new Error("Cannot safely quote fake Pi command path");
  }
  return `"${value}"`;
}

async function writeFakePiWrapper() {
  if (process.platform !== "win32") {
    throw new Error("The isolated fake Pi environment gate currently requires Windows");
  }
  const wrapper = [
    "@echo off",
    "if defined HTTPS_PROXY exit /b 91",
    "if defined HTTP_PROXY exit /b 92",
    "if defined ALL_PROXY exit /b 93",
    "if defined all_proxy exit /b 94",
    "if defined https_proxy exit /b 95",
    "if defined http_proxy exit /b 96",
    `if not "%CODEX_AGENT_ARK_AGENT_KEY%"=="${credentialSentinel}" exit /b 97`,
    "if defined OPENAI_API_KEY_DOUBAO exit /b 98",
    `${quoteCmdArgument(process.execPath)} ${quoteCmdArgument(fakePiScript)} %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
  await writeFile(fakePiCommand, wrapper, "utf8");
}

function renderPaths(paths) {
  const stablePaths = [
    ...new Set(
      paths.map((entry) =>
        entry.replace(
          /^tmp\/arg0\/codex-arg0[^/]+\//u,
          "tmp/arg0/<ephemeral>/",
        ),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return stablePaths.length === 0
    ? "无"
    : stablePaths.map((entry) => `\`${entry}\``).join("、");
}

function renderReport({
  codexVersion,
  steps,
  installedRelativePath,
  configStates,
}) {
  const lifecycleSections = steps
    .map(
      (step) => `### ${step.name}

- 新增：${renderPaths(step.diff.added)}
- 变化：${renderPaths(step.diff.changed)}
- 删除：${renderPaths(step.diff.removed)}`,
    )
    .join("\n\n");
  const configLines = configStates
    .map(
      (state) =>
        `- ${state.name}：${state.hashLabel === undefined ? "不存在" : `存在，SHA-256 状态 \`${state.hashLabel}\``}${
          state.changed ? "（相对上一步有变化）" : ""
        }`,
    )
    .join("\n");

  return `# Codex 官方插件隔离状态取证

## 隔离边界

- 本报告由唯一临时根目录下的独立 \`CODEX_HOME\` 生成；脚本逐次调用 Codex 前都会验证其位于该临时根内，且不是继承的 \`CODEX_HOME\` 或用户主目录下的 \`.codex\`。
- 报告只记录相对路径、文件大小所参与的差异判断和 SHA-256，不记录文件正文、凭据值或实际临时绝对路径。
- Codex CLI：\`${codexVersion}\`。

## 官方生命周期状态差异

${lifecycleSections}

## config.toml 状态

官方 marketplace 配置包含调用时间，因此报告用同一次取证内的稳定标签表示原始字节 SHA-256；标签相同即原始 hash 相同，标签变化即原始 hash 变化。

${configLines}

## 已安装副本验收

- 官方安装器接受仓库插件中的直接 server-map \`.mcp.json\`。
- 官方缓存相对位置：\`${installedRelativePath}\`。
- 已安装副本从上述缓存目录作为工作目录启动，MCP initialize/listTools 成功。
- 工具严格为 \`external_review\` 与 \`external_delegate\`；二者输入均要求 \`llm\`。
- \`external_review\` 为只读且非破坏性；\`external_delegate\` 为可写且具破坏性提示。
- pending 的 Gemini review 被已安装 MCP 明确拒绝，没有启动 Pi，也没有返回伪造的结构化成功结果。
- fake Pi 的 Ark Agent Plan DeepSeek V4 Flash review 返回 \`completed\`，实际模型为 \`deepseek-v4-flash\`，且没有文件变化。
- fake Pi 包装器确认 direct 子进程没有继承父 MCP 的 HTTP(S)/ALL proxy；只收到规范化后的 Agent Plan 目标凭据，未收到原始候选变量。Gemini 固定 proxy-10808 的替换规则继续由确定性环境测试与真实 smoke evidence 覆盖。
- 异常清理仅管理本脚本所启动 transport 的 PID，并在关闭 MCP client/transport 前终止其整个进程树。

## 语义回滚

- \`plugin remove\` 后官方列表显示目标插件为未安装。
- \`marketplace remove\` 后官方 marketplace 列表不再包含目标 marketplace。
- 官方 CLI 合法保留空缓存父目录与状态文件；验收以官方列表状态回滚和残留差异可解释为准，不声称字节级完全回滚。

## 结论边界

这不是活动 Codex home，也不构成真实 Codex App 验收。它只证明本机 Codex CLI 在隔离 \`CODEX_HOME\` 中接受、安装、启动并卸载当前插件产物。
`;
}

function assertEveryStepRendered(report, steps) {
  for (const step of steps) {
    if (!report.includes(`### ${step.name}\n`)) {
      throw new Error(`Generated report omitted lifecycle step: ${step.name}`);
    }
  }
}

try {
  await lstat(pluginBundle);
  await lstat(fakePiScript);
  assertIsolationGate();
  await mkdir(isolatedHome, { recursive: true });
  await mkdir(isolatedLocalAppData, { recursive: true });
  await mkdir(isolatedAppData, { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(
    path.join(fixtureRoot, "README.md"),
    "# Isolated plugin acceptance fixture\n",
    "utf8",
  );
  await writeFakePiWrapper();

  const codexVersion = (await runCodex(["--version"])).trim();
  let previous = await snapshotDirectory(isolatedHome);
  const steps = [];

  await runCodex(["plugin", "marketplace", "add", repositoryRoot]);
  let step = await snapshotStep("marketplace add", previous);
  steps.push(step);
  previous = step.snapshot;

  const beforeInstallList = await runCodex([
    "plugin",
    "list",
    "--marketplace",
    marketplace,
  ]);
  assertPluginStatus(beforeInstallList, "not installed");
  step = await snapshotStep("plugin list before install", previous);
  steps.push(step);
  previous = step.snapshot;

  await runCodex(["plugin", "add", selector]);
  step = await snapshotStep("plugin add", previous);
  steps.push(step);
  previous = step.snapshot;

  const installedList = await runCodex([
    "plugin",
    "list",
    "--marketplace",
    marketplace,
  ]);
  assertPluginStatus(installedList, "installed");
  step = await snapshotStep("plugin list after install", previous);
  steps.push(step);
  previous = step.snapshot;

  const installed = await resolveInstalledPluginRoot();
  const server = await readInstalledMcpServer(installed.root);
  await writeFakePiWrapper();
  client = new Client({
    name: "codex-plugin-isolated-acceptance",
    version: "1.0.0",
  });
  transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: installed.root,
    env: childEnvironment({
      CODEX_HOME: isolatedHome,
      LOCALAPPDATA: isolatedLocalAppData,
      APPDATA: isolatedAppData,
      PI_COMMAND: fakePiCommand,
      OPENAI_API_KEY_DOUBAO: credentialSentinel,
      HTTPS_PROXY: inheritedProxy,
      HTTP_PROXY: inheritedProxy,
      ALL_PROXY: inheritedAllProxy,
    }),
    stderr: "pipe",
  });
  await client.connect(transport);
  const listed = await client.listTools();
  assertToolContract(listed.tools);
  const pendingResult = await client.callTool({
    name: "external_review",
    arguments: {
      llm: "gemini-3.5-flash",
      task: "review_doc",
      prompt: "Review README.md without modifying files.",
      cwd: fixtureRoot,
    },
  });
  if (
    pendingResult.isError !== true ||
    pendingResult.structuredContent !== undefined ||
    !Array.isArray(pendingResult.content) ||
    !pendingResult.content.some(
      (entry) =>
        entry.type === "text" &&
        typeof entry.text === "string" &&
        entry.text.includes("disabled pending real smoke"),
    )
  ) {
    throw new Error("Installed MCP did not reject the pending Gemini review");
  }
  const toolResult = structuredContent(
    await client.callTool(
      {
        name: "external_review",
        arguments: {
          llm: "ark-agent-deepseek-v4-flash",
          task: "review_doc",
          prompt: "Review README.md without modifying files.",
          cwd: fixtureRoot,
        },
      },
      undefined,
      {
        timeout: 30_000,
        maxTotalTimeout: 30_000,
        resetTimeoutOnProgress: true,
      },
    ),
  );
  if (
    toolResult.status !== "completed" ||
    toolResult.actualModel !== "deepseek-v4-flash" ||
    !Array.isArray(toolResult.filesChanged) ||
    toolResult.filesChanged.length !== 0
  ) {
    const diagnostics = Array.isArray(toolResult.diagnostics)
      ? toolResult.diagnostics
          .filter((entry) => typeof entry === "string")
          .slice(0, 2)
          .join(" | ")
          .slice(0, 512)
      : "";
    throw new Error(
      `Installed MCP fake Pi review did not meet the acceptance gate: status=${String(
        toolResult.status,
      )} model=${String(toolResult.actualModel)} diagnostics=${diagnostics}`,
    );
  }
  await client.close();
  client = undefined;
  await transport.close().catch(() => undefined);
  transport = undefined;

  await runCodex(["plugin", "remove", selector]);
  step = await snapshotStep("plugin remove", previous);
  steps.push(step);
  previous = step.snapshot;

  const removedList = await runCodex([
    "plugin",
    "list",
    "--marketplace",
    marketplace,
  ]);
  assertPluginStatus(removedList, "not installed");
  step = await snapshotStep("plugin list after remove", previous);
  steps.push(step);
  previous = step.snapshot;

  await runCodex(["plugin", "marketplace", "remove", marketplace]);
  step = await snapshotStep("marketplace remove", previous);
  steps.push(step);
  previous = step.snapshot;

  const marketplaceList = await runCodex(["plugin", "marketplace", "list"]);
  if (marketplaceList.includes(marketplace)) {
    throw new Error("Official marketplace list retained the removed marketplace");
  }
  step = await snapshotStep("marketplace list after remove", previous);
  steps.push(step);

  let previousConfigHash;
  const configHashLabels = new Map();
  const configStates = steps.map((entry) => {
    const config = findStateFile(entry.snapshot, "config.toml");
    if (
      config !== undefined &&
      !configHashLabels.has(config.sha256)
    ) {
      configHashLabels.set(config.sha256, `H${configHashLabels.size + 1}`);
    }
    const state = {
      name: entry.name,
      hashLabel:
        config === undefined
          ? undefined
          : configHashLabels.get(config.sha256),
      changed:
        config !== undefined &&
        previousConfigHash !== undefined &&
        config.sha256 !== previousConfigHash,
    };
    previousConfigHash = config?.sha256;
    return state;
  });
  const report = renderReport({
    codexVersion,
    steps,
    installedRelativePath: installed.relativePath,
    configStates,
  });
  assertEveryStepRendered(report, steps);
  for (const forbidden of [
    temporaryRoot,
    credentialSentinel,
    inheritedProxy,
    inheritedAllProxy,
  ]) {
    if (report.includes(forbidden)) {
      throw new Error("Generated report contains isolated runtime details");
    }
  }
  await writeFile(reportPath, report, "utf8");
  process.stdout.write(
    "isolated plugin lifecycle accepted; report updated at docs/release/plugin-isolated-state.md\n",
  );
} catch (error) {
  throw new Error(redactFailure(error instanceof Error ? error.message : error));
} finally {
  try {
    await cleanupOwnedMcpTransport(client, transport);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
