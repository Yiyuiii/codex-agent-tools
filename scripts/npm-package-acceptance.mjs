import path from "node:path";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";

import {
  assertDoctorAcceptance,
  assertInstalledCapabilityProjection,
  assertInstalledPackageContract,
  assertNpmRegistryMetadata,
  buildIsolatedNpmEnvironment,
  establishInstalledMcpSession,
  npmAcceptanceReportRelativePath,
  parseNpmPackageAcceptanceArguments,
  PUBLIC_NPM_REGISTRY,
  renderNpmPackageAcceptanceReport,
} from "../dist/npm-package-acceptance.js";
import { cleanupOwnedMcpTransport } from "../dist/plugin-mcp-cleanup.js";
import { verifyCapabilityIndex } from "../dist/capability-qualification.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const { version } = parseNpmPackageAcceptanceArguments(
  process.argv.slice(2),
);
const packageSpec = `codex-agent-tools@${version}`;
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "codex-agent-npm-acceptance-"),
);
const installRoot = path.join(temporaryRoot, "install");
const packageRoot = path.join(
  installRoot,
  "node_modules",
  "codex-agent-tools",
);
const isolatedHome = path.join(temporaryRoot, "codex-home");
const isolatedUserHome = path.join(temporaryRoot, "user-home");
const isolatedLocalAppData = path.join(temporaryRoot, "local-app-data");
const isolatedAppData = path.join(temporaryRoot, "roaming-app-data");
const npmUserConfig = path.join(temporaryRoot, "npm-userconfig");
const npmGlobalConfig = path.join(temporaryRoot, "npm-globalconfig");
const npmCache = path.join(temporaryRoot, "npm-cache");
const fakeRuntimeScript = path.join(temporaryRoot, "fake-runtime.mjs");
const qualificationLockRoot = path.join(
  os.tmpdir(),
  "codex-agent-tools-qualification-locks",
);
const marketplace = "codex-external-agents-local";
const plugin = "codex-external-agents";
const selector = `${plugin}@${marketplace}`;
const repositoryUrl =
  "git+https://github.com/Yiyuiii/codex-agent-tools.git";
const expectedPluginEnvironmentVariables = [
  "ARK_API_KEY",
  "VOLCENGINE_API_KEY",
  "API_KEY_DOUBAO_CODING",
  "OPENAI_API_KEY_DOUBAO",
];
const mcpBaseEnvironmentVariables = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "CODEX_HOME",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
]);
let directClient;
let directTransport;
let cachedClient;
let cachedTransport;

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function samePath(left, right) {
  return (
    path.resolve(left).localeCompare(path.resolve(right), undefined, {
      sensitivity: process.platform === "win32" ? "accent" : "variant",
    }) === 0
  );
}

function isAbsoluteOnAnyPlatform(value) {
  return (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value)
  );
}

function manifestForwardedMcpEnvironment(environment, envVars) {
  const allowed = new Set([...mcpBaseEnvironmentVariables, ...envVars]);
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => allowed.has(name) && typeof value === "string",
    ),
  );
}

function redactedFailure(value) {
  return String(value)
    .replaceAll(temporaryRoot, "<TEMP_ROOT>")
    .replaceAll(repositoryRoot, "<REPOSITORY_ROOT>")
    .slice(0, 2_048);
}

async function run(command, args, options = {}) {
  const result = await execa(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env,
    reject: false,
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${options.label ?? command} failed: ${redactedFailure(
        result.stderr || result.stdout || `exit ${String(result.exitCode)}`,
      )}`,
    );
  }
  return result.stdout;
}

function quoteWindowsArgument(value) {
  if (value.includes('"') || /[\r\n]/u.test(value)) {
    throw new Error("Unsafe fake runtime path");
  }
  return `"${value}"`;
}

function quotePosixArgument(value) {
  if (value.includes("'") || /[\r\n]/u.test(value)) {
    throw new Error("Unsafe fake runtime path");
  }
  return `'${value}'`;
}

async function createFakeRuntimes() {
  const source = `#!/usr/bin/env node
const [runtime, ...args] = process.argv.slice(2);
if (runtime === "kimi" && args.length === 1 && args[0] === "--version") {
  process.stdout.write("0.0.0-npm-acceptance-fixture\\n");
  process.exit(0);
}
if (runtime === "kimi" && args.length === 1 && args[0] === "doctor") {
  process.stdout.write("npm acceptance fixture: configuration valid\\n");
  process.exit(0);
}
if (runtime === "pi" && args.length === 1 && args[0] === "--version") {
  process.stdout.write("0.0.0-npm-acceptance-fixture\\n");
  process.exit(0);
}
if (
  runtime === "pi" &&
  JSON.stringify(args) === JSON.stringify(["--offline", "--list-models", "ark"])
) {
  process.stdout.write(
    "ark-agent-plan ark-code-latest\\n" +
    "ark-agent-plan deepseek-v4-flash\\n" +
    "ark-coding-plan ark-code-latest\\n",
  );
  process.exit(0);
}
process.stderr.write("unexpected fake runtime invocation\\n");
process.exit(64);
`;
  await writeFile(fakeRuntimeScript, source, "utf8");
  await chmod(fakeRuntimeScript, 0o755).catch(() => undefined);

  if (process.platform === "win32") {
    const kimi = path.join(temporaryRoot, "fake-kimi.cmd");
    const pi = path.join(temporaryRoot, "fake-pi.cmd");
    await Promise.all([
      writeFile(
        kimi,
        `@echo off\r\n${quoteWindowsArgument(process.execPath)} ${quoteWindowsArgument(fakeRuntimeScript)} kimi %*\r\n`,
        "utf8",
      ),
      writeFile(
        pi,
        `@echo off\r\n${quoteWindowsArgument(process.execPath)} ${quoteWindowsArgument(fakeRuntimeScript)} pi %*\r\n`,
        "utf8",
      ),
    ]);
    return { kimi, pi };
  }

  const kimi = path.join(temporaryRoot, "fake-kimi");
  const pi = path.join(temporaryRoot, "fake-pi");
  await Promise.all([
    writeFile(
      kimi,
      `#!/bin/sh\nexec ${quotePosixArgument(process.execPath)} ${quotePosixArgument(fakeRuntimeScript)} kimi "$@"\n`,
      "utf8",
    ),
    writeFile(
      pi,
      `#!/bin/sh\nexec ${quotePosixArgument(process.execPath)} ${quotePosixArgument(fakeRuntimeScript)} pi "$@"\n`,
      "utf8",
    ),
  ]);
  await Promise.all([chmod(kimi, 0o755), chmod(pi, 0o755)]);
  return { kimi, pi };
}

async function assertNoQualificationLocks() {
  try {
    const entries = await readdir(qualificationLockRoot);
    if (entries.length !== 0) {
      throw new Error("Qualification lock is present");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

async function listInstalledMcpTools(
  command,
  args,
  cwd,
  environment,
  envVars = [],
) {
  const client = new Client({
    name: "codex-agent-tools-npm-acceptance",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: manifestForwardedMcpEnvironment(environment, envVars),
    stderr: "pipe",
  });
  return establishInstalledMcpSession({
    client,
    transport,
    cleanup: cleanupOwnedMcpTransport,
  });
}

function requireObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function installedPluginServer(installedPluginRoot) {
  const manifest = requireObject(
    JSON.parse(
      await readFile(path.join(installedPluginRoot, ".mcp.json"), "utf8"),
    ),
    "installed plugin MCP manifest",
  );
  const servers = Object.hasOwn(manifest, "mcp_servers")
    ? requireObject(manifest.mcp_servers, "mcp_servers")
    : manifest;
  if (
    Object.keys(servers).length !== 1 ||
    !Object.hasOwn(servers, "codex_external_agents")
  ) {
    throw new Error("Installed plugin MCP server set drifted");
  }
  const server = requireObject(
    servers.codex_external_agents,
    "codex_external_agents",
  );
  if (
    typeof server.command !== "string" ||
    server.command.trim() === "" ||
    isAbsoluteOnAnyPlatform(server.command) ||
    !Array.isArray(server.args) ||
    !server.args.every(
      (argument) =>
        typeof argument === "string" && !isAbsoluteOnAnyPlatform(argument),
    )
  ) {
    throw new Error("Installed plugin MCP launch contract is invalid");
  }
  if (server.cwd !== ".") {
    throw new Error(
      "Installed plugin MCP cwd must resolve relative launch paths from the plugin root",
    );
  }
  if (
    JSON.stringify(server.env_vars) !==
      JSON.stringify(expectedPluginEnvironmentVariables) ||
    Object.hasOwn(server, "env")
  ) {
    throw new Error(
      "Installed plugin MCP credential environment contract is invalid",
    );
  }
  return {
    command: server.command,
    args: [...server.args],
    cwd: path.resolve(installedPluginRoot, server.cwd),
    envVars: [...server.env_vars],
  };
}

async function runCodex(args, environment) {
  return run("codex", args, {
    cwd: packageRoot,
    env: environment,
    timeout: 60_000,
    label: `codex ${args.slice(0, 3).join(" ")}`,
  });
}

function assertPluginStatus(output, expectedInstalled) {
  const line = output
    .split(/\r?\n/u)
    .find((entry) => entry.includes(selector));
  if (line === undefined) {
    throw new Error("Official plugin list omitted the target plugin");
  }
  const pattern = expectedInstalled
    ? /\sinstalled,\s+enabled\s/iu
    : /\snot installed\s/iu;
  if (!pattern.test(line)) {
    throw new Error("Official plugin status did not match the expected state");
  }
}

async function officialPluginLifecycle(environment) {
  let marketplaceAdded = false;
  let pluginAdded = false;
  try {
    await runCodex(["plugin", "marketplace", "add", packageRoot], environment);
    marketplaceAdded = true;
    assertPluginStatus(
      await runCodex(
        ["plugin", "list", "--marketplace", marketplace],
        environment,
      ),
      false,
    );

    await runCodex(["plugin", "add", selector], environment);
    pluginAdded = true;
    assertPluginStatus(
      await runCodex(
        ["plugin", "list", "--marketplace", marketplace],
        environment,
      ),
      true,
    );

    const installedPluginParent = path.join(
      isolatedHome,
      "plugins",
      "cache",
      marketplace,
      plugin,
    );
    const versions = await readdir(installedPluginParent, {
      withFileTypes: true,
    });
    if (
      versions.length !== 1 ||
      !versions[0].isDirectory() ||
      versions[0].isSymbolicLink() ||
      versions[0].name !== version
    ) {
      throw new Error("Official plugin cache version is invalid");
    }
    const installedPluginRoot = path.join(
      installedPluginParent,
      versions[0].name,
    );
    if (!inside(isolatedHome, installedPluginRoot)) {
      throw new Error("Official plugin cache escaped the isolated home");
    }
    const server = await installedPluginServer(installedPluginRoot);
    ({ client: cachedClient, transport: cachedTransport } =
      await listInstalledMcpTools(
        server.command,
        server.args,
        server.cwd,
        environment,
        server.envVars,
      ));
    await cleanupOwnedMcpTransport(cachedClient, cachedTransport);
    cachedClient = undefined;
    cachedTransport = undefined;

    await runCodex(["plugin", "remove", selector], environment);
    pluginAdded = false;
    assertPluginStatus(
      await runCodex(
        ["plugin", "list", "--marketplace", marketplace],
        environment,
      ),
      false,
    );
    await runCodex(
      ["plugin", "marketplace", "remove", marketplace],
      environment,
    );
    marketplaceAdded = false;
    const marketplaces = await runCodex(
      ["plugin", "marketplace", "list"],
      environment,
    );
    if (marketplaces.includes(marketplace)) {
      throw new Error("Official marketplace removal did not roll back");
    }
  } finally {
    await cleanupOwnedMcpTransport(cachedClient, cachedTransport).catch(
      () => undefined,
    );
    cachedClient = undefined;
    cachedTransport = undefined;
    if (pluginAdded) {
      await runCodex(["plugin", "remove", selector], environment).catch(
        () => undefined,
      );
    }
    if (marketplaceAdded) {
      await runCodex(
        ["plugin", "marketplace", "remove", marketplace],
        environment,
      ).catch(() => undefined);
    }
  }
}

async function writeReport(report) {
  const relative = npmAcceptanceReportRelativePath(version);
  const target = path.resolve(repositoryRoot, relative);
  const releaseRoot = path.resolve(repositoryRoot, "docs", "release");
  if (!inside(releaseRoot, target)) {
    throw new Error("Acceptance report path escaped docs/release");
  }
  await mkdir(releaseRoot, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, report, "utf8");
  await rename(temporary, target);
  return relative;
}

try {
  if (
    !inside(temporaryRoot, packageRoot) ||
    !inside(temporaryRoot, isolatedHome) ||
    samePath(isolatedHome, path.join(os.homedir(), ".codex")) ||
    (process.env.CODEX_HOME !== undefined &&
      process.env.CODEX_HOME.trim() !== "" &&
      samePath(isolatedHome, process.env.CODEX_HOME))
  ) {
    throw new Error("npm acceptance isolation gate failed");
  }
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(isolatedHome, { recursive: true }),
    mkdir(isolatedUserHome, { recursive: true }),
    mkdir(isolatedLocalAppData, { recursive: true }),
    mkdir(isolatedAppData, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    writeFile(npmUserConfig, "", "utf8"),
    writeFile(npmGlobalConfig, "", "utf8"),
  ]);
  const npmEnvironment = buildIsolatedNpmEnvironment({
    sourceEnvironment: process.env,
    isolatedUserHome,
    isolatedCodexHome: isolatedHome,
    isolatedLocalAppData,
    isolatedAppData,
    temporaryRoot,
    npmUserConfig,
    npmGlobalConfig,
    npmCache,
  });
  await assertNoQualificationLocks();
  await verifyCapabilityIndex({ repositoryRoot });

  const registryOutput = await run(
    npmCommand(),
    [
      "view",
      packageSpec,
      "version",
      "dist.integrity",
      "dist.shasum",
      "repository.url",
      "--json",
      `--registry=${PUBLIC_NPM_REGISTRY}`,
    ],
    {
      cwd: installRoot,
      env: npmEnvironment,
      label: "npm registry identity",
    },
  );
  const registry = assertNpmRegistryMetadata(
    JSON.parse(registryOutput),
    version,
  );
  await run(
    npmCommand(),
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--save=false",
      packageSpec,
      `--registry=${PUBLIC_NPM_REGISTRY}`,
    ],
    {
      cwd: installRoot,
      env: npmEnvironment,
      label: "public npm package installation",
      timeout: 300_000,
    },
  );

  const packageMetadata = await lstat(packageRoot);
  if (
    !packageMetadata.isDirectory() ||
    packageMetadata.isSymbolicLink()
  ) {
    throw new Error("Installed npm package root is invalid");
  }
  const pluginRoot = path.join(
    packageRoot,
    "plugins",
    "codex-external-agents",
  );
  const [packageManifest, pluginManifest] = await Promise.all([
    readFile(path.join(packageRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      "utf8",
    ).then(JSON.parse),
  ]);
  assertInstalledPackageContract({
    packageManifest,
    pluginManifest,
    expectedVersion: version,
  });
  const capabilityIndexPath = path.join(
    "docs",
    "smoke",
    "evidence",
    "capabilities.json",
  );
  await assertInstalledCapabilityProjection({
    repositoryIndex: await readFile(
      path.join(repositoryRoot, capabilityIndexPath),
    ),
    installedIndex: await readFile(path.join(packageRoot, capabilityIndexPath)),
    readInstalledFile: (relativePath) =>
      readFile(path.join(packageRoot, ...relativePath.split("/"))),
  });
  for (const relative of [
    ".agents/plugins/marketplace.json",
    "dist/cli.js",
    "dist/mcp.js",
    "docs/smoke/evidence/capabilities.json",
    "plugins/codex-external-agents/.mcp.json",
    "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe",
    "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256",
    "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
  ]) {
    await access(path.join(packageRoot, ...relative.split("/")));
  }

  const fakeRuntimes = await createFakeRuntimes();
  const isolatedEnvironment = {
    ...npmEnvironment,
    KIMI_COMMAND: fakeRuntimes.kimi,
    PI_COMMAND: fakeRuntimes.pi,
    ARK_API_KEY: "npm-acceptance-coding-fixture",
    OPENAI_API_KEY_DOUBAO: "npm-acceptance-agent-fixture",
  };
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  const cliVersion = (
    await run(process.execPath, [cliPath, "--version"], {
      cwd: packageRoot,
      env: isolatedEnvironment,
      label: "installed CLI version",
    })
  ).trim();
  if (cliVersion !== version) {
    throw new Error("Installed CLI version is invalid");
  }
  const help = await run(process.execPath, [cliPath, "--help"], {
    cwd: packageRoot,
    env: isolatedEnvironment,
    label: "installed CLI help",
  });
  if (
    !help.includes("codex-agent-tools") ||
    !help.includes("doctor")
  ) {
    throw new Error("Installed CLI help contract is invalid");
  }
  const doctor = JSON.parse(
    await run(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: packageRoot,
      env: isolatedEnvironment,
      label: "installed doctor",
    }),
  );
  assertDoctorAcceptance(doctor);

  ({ client: directClient, transport: directTransport } =
    await listInstalledMcpTools(
      process.execPath,
      [path.join(packageRoot, "dist", "mcp.js")],
      packageRoot,
      isolatedEnvironment,
    ));
  await cleanupOwnedMcpTransport(directClient, directTransport);
  directClient = undefined;
  directTransport = undefined;

  await officialPluginLifecycle(isolatedEnvironment);
  await assertNoQualificationLocks();
  const npmVersion = (
    await run(npmCommand(), ["--version"], {
      cwd: installRoot,
      env: npmEnvironment,
      label: "npm version",
    })
  ).trim();
  const report = renderNpmPackageAcceptanceReport({
    version,
    observedAt: new Date().toISOString(),
    integrity: registry.integrity,
    shasum: registry.shasum,
    nodeVersion: process.version,
    npmVersion,
  });
  const relativeReport = await writeReport(report);
  process.stdout.write(
    `public npm package accepted: ${packageSpec}; report=${relativeReport}\n`,
  );
} catch (error) {
  throw new Error(
    redactedFailure(error instanceof Error ? error.message : error),
  );
} finally {
  try {
    await cleanupOwnedMcpTransport(
      directClient,
      directTransport,
    ).catch(() => undefined);
    await cleanupOwnedMcpTransport(
      cachedClient,
      cachedTransport,
    ).catch(() => undefined);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
