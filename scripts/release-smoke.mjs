import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";

import {
  assertAllowedPackFiles,
  assertNoSensitiveContent,
  assertPackageLocalLinks,
  resolvePackInspectionPath,
} from "../dist/release-assurance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const cliPath = path.join(dist, "cli.js");
const mcpPath = path.join(dist, "mcp.js");
const marketplacePath = path.join(
  root,
  ".agents",
  "plugins",
  "marketplace.json",
);
const pluginRoot = path.join(root, "plugins", "codex-external-agents");
const pluginManifestPath = path.join(
  pluginRoot,
  ".codex-plugin",
  "plugin.json",
);
const pluginMcpPath = path.join(pluginRoot, ".mcp.json");
const pluginBundlePath = path.join(
  pluginRoot,
  "runtime",
  "codex-external-agents-mcp.mjs",
);
const exactPluginFiles = [
  ".agents/plugins/marketplace.json",
  "plugins/codex-external-agents/.codex-plugin/plugin.json",
  "plugins/codex-external-agents/.mcp.json",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
];
const exactLogicalLlms = [
  "ark-agent-deepseek-v4-flash",
  "ark-agent-plan",
  "ark-coding-plan",
  "kimi-k3",
];
const retainedHistoricalPackageSources = [
  "docs/smoke/pi-gemini.md",
  "docs/smoke/evidence",
];
const reviewPackageSources = [
  "docs/release/four-llm-qualification-result-review.html",
  "docs/release/four-llm-qualification-authorization-review.html",
  "docs/release/real-plugin-install-review.md",
  "docs/release/plugin-isolated-state.md",
  "docs/superpowers/plans/2026-07-27-authorized-four-llm-qualification-and-convergence.md",
];
const worktreeMarker = `${path.sep}.worktrees${path.sep}`;
const worktreeMarkerIndex = root
  .toLocaleLowerCase("en-US")
  .indexOf(worktreeMarker.toLocaleLowerCase("en-US"));
const forbiddenDevelopmentPaths = [
  root,
  os.homedir(),
  ...(worktreeMarkerIndex < 0
    ? []
    : [root.slice(0, worktreeMarkerIndex)]),
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? run(process.execPath, [npmExecPath, ...args])
    : run("npm", args);
}

function checkNpmNameAvailability() {
  const npmExecPath = process.env.npm_execpath;
  const result = npmExecPath
    ? spawnSync(
        process.execPath,
        [npmExecPath, "view", "codex-agent-tools", "name", "version", "--json"],
        { cwd: root, encoding: "utf8", windowsHide: true },
      )
    : spawnSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["view", "codex-agent-tools", "name", "version", "--json"],
        { cwd: root, encoding: "utf8", windowsHide: true },
      );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 0) {
    throw new Error("npm package name codex-agent-tools is already registered");
  }
  if (!/E404|Not Found/iu.test(output)) {
    throw new Error("Unable to verify npm package name availability");
  }
}

function releaseSecrets(environment) {
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/iu.test(name) &&
        typeof value === "string" &&
        value.length >= 8,
    )
    .map(([, value]) => value);
}

function requireObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function samePath(left, right) {
  return (
    path.resolve(left).localeCompare(path.resolve(right), undefined, {
      sensitivity: process.platform === "win32" ? "accent" : "variant",
    }) === 0
  );
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

function childEnvironment(overrides) {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      ...overrides,
    }).filter(([, value]) => typeof value === "string"),
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function checkMcpContract(serverPath, cwd) {
  const client = new Client({ name: "release-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    if (
      JSON.stringify(names) !==
      JSON.stringify(["external_delegate", "external_review"])
    ) {
      throw new Error(`Unexpected MCP tools: ${names.join(", ")}`);
    }
    for (const tool of listed.tools) {
      if (!tool.inputSchema.required?.includes("llm")) {
        throw new Error(`${tool.name} does not require llm`);
      }
    }
    const review = listed.tools.find((tool) => tool.name === "external_review");
    const delegate = listed.tools.find(
      (tool) => tool.name === "external_delegate",
    );
    if (
      review?.annotations?.readOnlyHint !== true ||
      review.annotations.destructiveHint !== false
    ) {
      throw new Error("external_review annotations are unsafe");
    }
    if (
      delegate?.annotations?.readOnlyHint !== false ||
      delegate.annotations.destructiveHint !== true
    ) {
      throw new Error("external_delegate annotations are unsafe");
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function checkDoctorJson() {
  const output = run(process.execPath, [cliPath, "doctor", "--json"]);
  const report = JSON.parse(output);
  const publicTools = report.checks?.find(
    (check) => check.name === "Public MCP tools",
  );
  if (publicTools?.detail !== "external_review, external_delegate") {
    throw new Error("doctor JSON does not report the public tool contract");
  }
  const logicalLlms =
    report.checks?.filter((check) => check.name.startsWith("LLM ")) ?? [];
  const actualLogicalLlms = logicalLlms
    .map((check) => check.name.slice("LLM ".length))
    .sort();
  if (
    JSON.stringify(actualLogicalLlms) !==
    JSON.stringify(exactLogicalLlms)
  ) {
    throw new Error(
      `doctor JSON reported unexpected logical LLMs: ${actualLogicalLlms.join(", ")}`,
    );
  }

  const deprecatedConfig = spawnSync(
    process.execPath,
    [cliPath, "doctor", "--config", "forbidden-config.toml"],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (
    deprecatedConfig.status === 0 ||
    !/unknown option ['"]--config['"]/iu.test(
      `${deprecatedConfig.stdout ?? ""}\n${deprecatedConfig.stderr ?? ""}`,
    )
  ) {
    throw new Error("doctor unexpectedly accepts the removed --config option");
  }
}

async function checkPluginArtifact() {
  const [packageManifest, pluginManifest, marketplace, mcpManifest] =
    await Promise.all([
      readJson(path.join(root, "package.json")),
      readJson(pluginManifestPath),
      readJson(marketplacePath),
      readJson(pluginMcpPath),
    ]);

  if (packageManifest.version !== pluginManifest.version) {
    throw new Error("package and plugin versions differ");
  }
  if (
    !Array.isArray(packageManifest.files) ||
    ![...retainedHistoricalPackageSources, ...reviewPackageSources].every(
      (entry) => packageManifest.files.includes(entry),
    )
  ) {
    throw new Error("package files omit required review or history documents");
  }

  if (
    marketplace.name !== "codex-external-agents-local" ||
    !Array.isArray(marketplace.plugins) ||
    marketplace.plugins.length !== 1
  ) {
    throw new Error("marketplace must contain exactly the target plugin");
  }
  const marketplacePlugin = requireObject(
    marketplace.plugins[0],
    "marketplace plugin",
  );
  const marketplaceSource = requireObject(
    marketplacePlugin.source,
    "marketplace plugin source",
  );
  if (
    marketplacePlugin.name !== "codex-external-agents" ||
    marketplaceSource.source !== "local" ||
    marketplaceSource.path !== "./plugins/codex-external-agents"
  ) {
    throw new Error("marketplace does not reference the target local plugin");
  }
  const resolvedMarketplaceSource = path.resolve(root, marketplaceSource.path);
  if (
    !samePath(resolvedMarketplaceSource, pluginRoot) ||
    !(await stat(resolvedMarketplaceSource)).isDirectory()
  ) {
    throw new Error("marketplace plugin source is not the expected directory");
  }

  const serverNames = Object.keys(requireObject(mcpManifest, "MCP manifest"));
  if (serverNames.length !== 1 || serverNames[0] !== "codex_external_agents") {
    throw new Error("plugin MCP manifest must contain one target server");
  }
  const server = requireObject(
    mcpManifest.codex_external_agents,
    "codex_external_agents",
  );
  if (
    server.command !== "node" ||
    !Array.isArray(server.args) ||
    server.args.length !== 1 ||
    server.args[0] !== "./runtime/codex-external-agents-mcp.mjs" ||
    path.isAbsolute(server.args[0]) ||
    path.win32.isAbsolute(server.args[0]) ||
    path.posix.isAbsolute(server.args[0])
  ) {
    throw new Error("plugin MCP server must use the one relative bundle path");
  }
  if (!samePath(path.resolve(pluginRoot, server.args[0]), pluginBundlePath)) {
    throw new Error("plugin MCP server resolves outside the expected bundle");
  }
  await access(pluginBundlePath);

  assertNoSensitiveContent(
    [
      {
        name: exactPluginFiles[3],
        content: await readFile(pluginBundlePath, "utf8"),
      },
    ],
    {
      forbiddenPaths: forbiddenDevelopmentPaths,
      secrets: releaseSecrets(process.env),
    },
  );
}

async function checkCodexPluginHelp() {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "codex-agent-tools-release-codex-"),
  );
  const isolatedCodexHome = path.join(temporaryRoot, "codex-home");
  const activeCodexHome = path.resolve(os.homedir(), ".codex");
  const inheritedCodexHome =
    typeof process.env.CODEX_HOME === "string" &&
    process.env.CODEX_HOME.trim() !== ""
      ? path.resolve(process.env.CODEX_HOME)
      : undefined;
  try {
    if (
      !isInside(temporaryRoot, isolatedCodexHome) ||
      samePath(isolatedCodexHome, activeCodexHome) ||
      (inheritedCodexHome !== undefined &&
        samePath(isolatedCodexHome, inheritedCodexHome))
    ) {
      throw new Error("Refusing to run Codex help outside an isolated home");
    }
    await mkdir(isolatedCodexHome, { recursive: true });
    const environment = childEnvironment({ CODEX_HOME: isolatedCodexHome });
    const pluginHelp = await execa("codex", ["plugin", "--help"], {
      cwd: root,
      env: environment,
      reject: true,
      windowsHide: true,
    });
    const marketplaceHelp = await execa(
      "codex",
      ["plugin", "marketplace", "--help"],
      {
        cwd: root,
        env: environment,
        reject: true,
        windowsHide: true,
      },
    );
    if (
      !/Manage Codex plugins/iu.test(pluginHelp.stdout) ||
      !/plugin marketplaces/iu.test(marketplaceHelp.stdout)
    ) {
      throw new Error("Codex plugin help surface is unavailable");
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function checkPackage() {
  const packOutput = runNpm(["pack", "--dry-run", "--json"]);
  const packResult = JSON.parse(packOutput)?.[0];
  if (!packResult || !Array.isArray(packResult.files)) {
    throw new Error("npm pack did not return a file list");
  }
  const fileNames = packResult.files.map((entry) => entry.path);

  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "docs/operations.md",
    "docs/migration-from-codex-cc-tools.md",
    "docs/smoke/pi-gemini.md",
    ...reviewPackageSources,
    "dist/cli.js",
    "dist/mcp.js",
    ...exactPluginFiles,
  ]) {
    if (!fileNames.includes(required)) {
      throw new Error(`Required npm package file is missing: ${required}`);
    }
  }
  const actualPluginFiles = fileNames
    .filter(
      (name) => name.startsWith("plugins/") || name.startsWith(".agents/"),
    )
    .sort();
  if (
    JSON.stringify(actualPluginFiles) !==
    JSON.stringify([...exactPluginFiles].sort())
  ) {
    throw new Error("npm package plugin file set is not exact");
  }

  const textEntries = [];
  const inspectedPackNames = new Set();
  const actualPackFileNames = new Set();
  for (const name of fileNames) {
    let inspectionName = name;
    if (name.includes("***")) {
      const normalized = name.replaceAll("\\", "/");
      const wildcardIndex = normalized.indexOf("***");
      const candidateDirectory = path.posix.dirname(
        normalized.slice(0, wildcardIndex),
      );
      if (candidateDirectory === ".") {
        throw new Error("Unable to resolve redacted npm package path");
      }
      const entries = await readdir(path.join(root, candidateDirectory), {
        recursive: true,
      });
      inspectionName = resolvePackInspectionPath(
        normalized,
        entries.map((entry) =>
          path.posix.join(candidateDirectory, entry.replaceAll("\\", "/")),
        ),
      );
    }
    actualPackFileNames.add(inspectionName);
    if (
      /\.(?:html|js|map|ts|json|md)$/iu.test(inspectionName) ||
      inspectionName === "LICENSE"
    ) {
      textEntries.push({
        name: inspectionName,
        content: await readFile(path.join(root, inspectionName), "utf8"),
      });
      inspectedPackNames.add(name);
    }
  }
  assertAllowedPackFiles([...actualPackFileNames]);
  const retainedHistory = fileNames.filter(
    (name) =>
      name === "docs/smoke/pi-gemini.md" ||
      (name.startsWith("docs/smoke/evidence/") && name.endsWith(".json")),
  );
  const retainedEvidence = retainedHistory.filter((name) =>
    name.startsWith("docs/smoke/evidence/"),
  );
  if (
    !retainedHistory.includes("docs/smoke/pi-gemini.md") ||
    retainedEvidence.length === 0 ||
    retainedHistory.some((name) => !inspectedPackNames.has(name))
  ) {
    throw new Error("Retained history was not fully inspected");
  }
  assertNoSensitiveContent(textEntries, {
    forbiddenPaths: forbiddenDevelopmentPaths,
    secrets: releaseSecrets(process.env),
  });
  const packageLinkEntries = textEntries.filter((entry) =>
    reviewPackageSources.includes(entry.name),
  );
  if (packageLinkEntries.length !== reviewPackageSources.length) {
    throw new Error("Required review package documents were not inspected");
  }
  assertPackageLocalLinks(packageLinkEntries, [...actualPackFileNames]);
}

await Promise.all([access(cliPath), access(mcpPath), access(pluginBundlePath)]);
run(process.execPath, [cliPath, "--version"]);
run(process.execPath, [cliPath, "--help"]);
run(process.execPath, [mcpPath, "--help"]);
run(process.execPath, [pluginBundlePath, "--help"], { cwd: pluginRoot });
await checkMcpContract(pluginBundlePath, pluginRoot);
await checkDoctorJson();
await checkPluginArtifact();
await checkCodexPluginHelp();
await checkPackage();
checkNpmNameAvailability();

process.stdout.write("release smoke passed\n");
