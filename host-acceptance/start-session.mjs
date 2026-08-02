import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "codex-agent-tools";
const FAILURE_MESSAGE = "Host acceptance session is invalid.";
const OBSERVER_FAILURE_MESSAGE = "Host acceptance observer failed.";
const OBSERVER_PATH =
  "host-acceptance/win32-x64/codex-host-acceptance-observer.exe";
const MANIFEST_PATH = "host-acceptance/observer-build-inputs.v1.json";
const BUILD_CONFIG_PATH = "host-acceptance/build.config.json";
const BUILD_ENTRY_PATH = "host-acceptance/build.ps1";
const PROTOCOL_PATH = "host-acceptance/protocol/observer-protocol.v1.json";
const SHARED_TOOLCHAIN_PATH =
  "native/windows-job-helper/toolchain.lock.json";
const SHARED_BUILD_CONFIG_PATH =
  "native/windows-job-helper/build.config.json";
const SHARED_RESTORE_PATH =
  "native/windows-job-helper/restore-toolchain.ps1";
const DESCRIPTOR_RELATIVE_PATH =
  "codex-agent-tools/host-acceptance/session.v1.json";
const MARKETPLACE_NAME = "codex-external-agents-local";
const PLUGIN_NAME = "codex-external-agents";
const PLUGIN_REPOSITORY_PREFIX = `plugins/${PLUGIN_NAME}/`;
const EXPECTED_PHASES = Object.freeze([
  "READY",
  "OLD_HOST_BOUND",
  "OLD_HOST_EXITED",
  "REQUEST_STARTED",
]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const BETA_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/u;
const NPM_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;

export const HOST_ACCEPTANCE_PLUGIN_PATHS = Object.freeze([
  "plugins/codex-external-agents/.codex-plugin/plugin.json",
  "plugins/codex-external-agents/.mcp.json",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
  "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe",
  "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256",
]);

function fixedDelegatePrompt(completionMarkerPath) {
  const quotedMarkerPath = completionMarkerPath.replaceAll("'", "''");
  return [
    "这是 codex-agent-tools 当前宿主真实 Stop 验收。",
    "只在当前 cwd 指向的隔离 delegate-workspace 中工作；不要读取或修改 beta tag checkout、其它仓库、Codex 配置或插件安装树。",
    "请只读、纯推理审计 Windows Job-owned process 的启动、取消与 drain 边界，并形成一份包含失败模式和剩余风险的详细技术说明。",
    "不要安装、升级或发布软件，不要改变任何外部 CLI 的默认或全局限制，也不要创建或修改任何文件。",
    "只有在完成分析草稿后、返回最终答复之前，才把下列命令作为唯一最后一个工具动作执行；这是前述文件禁令的唯一例外。执行后再返回最终答复：",
    `[System.IO.File]::WriteAllBytes('${quotedMarkerPath}', [byte[]]::new(0))`,
  ].join("\n");
}

function fail() {
  throw new Error(FAILURE_MESSAGE);
}

function observerFail() {
  throw new Error(OBSERVER_FAILURE_MESSAGE);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function record(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  return value;
}

function array(value) {
  if (!Array.isArray(value)) fail();
  return value;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail();
}

function exactString(value, expected) {
  if (value !== expected) fail();
  return expected;
}

function matchingString(value, pattern, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !pattern.test(value)
  ) fail();
  return value;
}

function parseJsonBytes(value) {
  try {
    if (!Buffer.isBuffer(value) || value.byteLength === 0 || value.byteLength > MAX_JSON_BYTES) {
      fail();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    return JSON.parse(text);
  } catch {
    return fail();
  }
}

function repositoryRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value)
  ) fail();
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail();
  }
  return value;
}

function fixedWindowsAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    !path.win32.isAbsolute(value) ||
    path.win32.resolve(value) !== value
  ) fail();
  return value;
}

function parseBuildConfig(value) {
  const config = record(value);
  exactKeys(config, ["schemaVersion", "sharedBuildContract", "sourceSets", "artifact"]);
  if (config.schemaVersion !== 1) fail();
  const shared = record(config.sharedBuildContract);
  exactKeys(shared, ["toolchainLockPath", "buildConfigPath", "restoreToolchainPath"]);
  exactString(shared.toolchainLockPath, SHARED_TOOLCHAIN_PATH);
  exactString(shared.buildConfigPath, SHARED_BUILD_CONFIG_PATH);
  exactString(shared.restoreToolchainPath, SHARED_RESTORE_PATH);
  const sourceSets = record(config.sourceSets);
  exactKeys(sourceSets, ["production"]);
  const production = array(sourceSets.production);
  if (production.length === 0) fail();
  const sources = production.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      !/^src\/[A-Za-z0-9][A-Za-z0-9._-]*\.cs$/u.test(entry) ||
      (index > 0 && production[index - 1] >= entry)
    ) fail();
    return `host-acceptance/${entry}`;
  });
  const artifact = record(config.artifact);
  exactKeys(artifact, ["path"]);
  exactString(artifact.path, OBSERVER_PATH);
  return Object.freeze(sources);
}

function parseObserverIdentity(value) {
  const observer = record(value);
  exactKeys(observer, [
    "path",
    "sha256",
    "protocolVersion",
    "buildManifest",
    "protocol",
    "inputsDigestSha256",
  ]);
  if (observer.protocolVersion !== 1) fail();
  const buildManifest = record(observer.buildManifest);
  exactKeys(buildManifest, ["path", "sha256"]);
  const protocol = record(observer.protocol);
  exactKeys(protocol, ["path", "sha256"]);
  return Object.freeze({
    path: exactString(observer.path, OBSERVER_PATH),
    sha256: matchingString(observer.sha256, SHA256_PATTERN, 64),
    protocolVersion: 1,
    buildManifest: Object.freeze({
      path: exactString(buildManifest.path, MANIFEST_PATH),
      sha256: matchingString(buildManifest.sha256, SHA256_PATTERN, 64),
    }),
    protocol: Object.freeze({
      path: exactString(protocol.path, PROTOCOL_PATH),
      sha256: matchingString(protocol.sha256, SHA256_PATTERN, 64),
    }),
    inputsDigestSha256: matchingString(
      observer.inputsDigestSha256,
      SHA256_PATTERN,
      64,
    ),
  });
}

function parseBetaMarker(value, version, tag) {
  const marker = record(value);
  exactKeys(marker, [
    "schemaVersion",
    "kind",
    "package",
    "core",
    "pluginArtifactTree",
    "observerArtifact",
  ]);
  if (marker.schemaVersion !== 1 || marker.kind !== "beta") fail();
  record(marker.core);
  const packageIdentity = record(marker.package);
  exactKeys(packageIdentity, ["name", "version", "tag", "npmChannel"]);
  exactString(packageIdentity.name, PACKAGE_NAME);
  exactString(packageIdentity.version, version);
  exactString(packageIdentity.tag, tag);
  exactString(packageIdentity.npmChannel, "next");
  const plugin = record(marker.pluginArtifactTree);
  exactKeys(plugin, ["schemaVersion", "digestSha256"]);
  if (plugin.schemaVersion !== 1) fail();
  return Object.freeze({
    pluginArtifactTreeDigestSha256: matchingString(
      plugin.digestSha256,
      SHA256_PATTERN,
      64,
    ),
    observerArtifact: parseObserverIdentity(marker.observerArtifact),
  });
}

function parseProtocol(value) {
  const protocol = record(value);
  if (protocol.schemaVersion !== 1 || protocol.protocolVersion !== 1) fail();
  const descriptor = record(protocol.descriptor);
  exactString(descriptor.relativePath, DESCRIPTOR_RELATIVE_PATH);
  if (descriptor.maximumBytes !== 16_384) fail();
  exactString(descriptor.packageName, PACKAGE_NAME);
  const fixedPaths = record(descriptor.fixedPaths);
  exactString(fixedPaths.observerArtifact, OBSERVER_PATH);
  exactString(fixedPaths.buildManifest, MANIFEST_PATH);
  exactString(fixedPaths.protocol, PROTOCOL_PATH);
  exactString(fixedPaths.markerPrefix, ".release-validation/v");
  exactString(fixedPaths.markerSuffix, ".json");
  const hashDomains = record(protocol.hashDomains);
  return Object.freeze({
    maximumBytes: 16_384,
    noncePattern: new RegExp(String(descriptor.noncePattern), "u"),
    pipeNamePattern: new RegExp(String(descriptor.pipeNamePattern), "u"),
    markerIdPattern: new RegExp(String(descriptor.completionMarkerIdPattern), "u"),
    promptDomain: exactString(
      hashDomains.prompt,
      "codex-agent-tools/host-acceptance/prompt/v1",
    ),
    cwdDomain: exactString(hashDomains.cwd, "codex-agent-tools/host-acceptance/cwd/v1"),
    requestInputDomain: exactString(
      hashDomains.requestInput,
      "codex-agent-tools/host-acceptance/request-input/v1",
    ),
    completionMarkerDomain: exactString(
      hashDomains.completionMarker,
      "codex-agent-tools/host-acceptance/completion-marker/v1",
    ),
  });
}

function parseBuildManifest(value, sources, inputFiles, protocolBytes) {
  const manifest = record(value);
  exactKeys(manifest, [
    "schemaVersion",
    "artifactPath",
    "protocol",
    "inputs",
    "inputsDigestSha256",
  ]);
  if (manifest.schemaVersion !== 1) fail();
  exactString(manifest.artifactPath, OBSERVER_PATH);
  const manifestProtocol = record(manifest.protocol);
  exactKeys(manifestProtocol, ["path", "sha256"]);
  exactString(manifestProtocol.path, PROTOCOL_PATH);
  exactString(manifestProtocol.sha256, sha256(protocolBytes));
  const expectedPaths = [
    SHARED_TOOLCHAIN_PATH,
    SHARED_BUILD_CONFIG_PATH,
    SHARED_RESTORE_PATH,
    BUILD_CONFIG_PATH,
    BUILD_ENTRY_PATH,
    PROTOCOL_PATH,
    ...sources,
  ].sort();
  const entries = array(manifest.inputs).map((item, index) => {
    const entry = record(item);
    exactKeys(entry, ["path", "sha256"]);
    const inputPath = repositoryRelativePath(entry.path);
    if (inputPath !== expectedPaths[index]) fail();
    const content = inputFiles.get(inputPath);
    if (!Buffer.isBuffer(content) || sha256(content) !== entry.sha256) fail();
    return Object.freeze({ path: inputPath, sha256: entry.sha256 });
  });
  if (entries.length !== expectedPaths.length) fail();
  const inputsDigestSha256 = sha256(JSON.stringify({ schemaVersion: 1, inputs: entries }));
  exactString(manifest.inputsDigestSha256, inputsDigestSha256);
  return Object.freeze({ inputsDigestSha256 });
}

function parseNpmView(value, version) {
  const npm = record(value);
  exactKeys(npm, ["version", "dist"]);
  exactString(npm.version, version);
  const dist = record(npm.dist);
  return Object.freeze({
    integrity: matchingString(dist.integrity, NPM_INTEGRITY_PATTERN, 256),
    shasum: matchingString(dist.shasum, SHA1_PATTERN, 40),
  });
}

export function buildNpmViewInvocation(nodeExecutable, version) {
  const command = fixedWindowsAbsolutePath(nodeExecutable);
  const exactVersion = matchingString(version, BETA_VERSION_PATTERN, 128);
  const npmCliPath = path.win32.join(
    path.win32.dirname(command),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return Object.freeze({
    command,
    npmCliPath,
    args: Object.freeze([
      npmCliPath,
      "view",
      `${PACKAGE_NAME}@${exactVersion}`,
      "version",
      "dist",
      "--json",
      "--registry=https://registry.npmjs.org/",
    ]),
  });
}

function pluginTreeDigest(entries) {
  const files = array(entries).map((entry, index) => {
    const item = record(entry);
    exactString(item.path, HOST_ACCEPTANCE_PLUGIN_PATHS[index]);
    if (!Buffer.isBuffer(item.content) || item.content.byteLength === 0) fail();
    return Object.freeze({ path: item.path, sha256: sha256(item.content) });
  });
  if (files.length !== HOST_ACCEPTANCE_PLUGIN_PATHS.length) fail();
  return sha256(JSON.stringify({ schemaVersion: 1, files }));
}

function installedPluginRoot(userProfile, version) {
  return path.win32.join(
    userProfile,
    ".codex",
    "plugins",
    "cache",
    MARKETPLACE_NAME,
    PLUGIN_NAME,
    version,
  );
}

function cacheRelativePluginPath(repositoryPath) {
  if (!repositoryPath.startsWith(PLUGIN_REPOSITORY_PREFIX)) fail();
  return repositoryRelativePath(
    repositoryPath.slice(PLUGIN_REPOSITORY_PREFIX.length),
  );
}

function verifyInstalledPluginFiles(tagFiles, installedFiles, version) {
  if (
    !Array.isArray(installedFiles) ||
    installedFiles.length !== HOST_ACCEPTANCE_PLUGIN_PATHS.length
  ) fail();
  for (let index = 0; index < HOST_ACCEPTANCE_PLUGIN_PATHS.length; index += 1) {
    const tagEntry = record(tagFiles[index]);
    const installedEntry = record(installedFiles[index]);
    const expectedPath = HOST_ACCEPTANCE_PLUGIN_PATHS[index];
    exactString(tagEntry.path, expectedPath);
    exactString(installedEntry.path, expectedPath);
    if (
      !Buffer.isBuffer(tagEntry.content) ||
      !Buffer.isBuffer(installedEntry.content) ||
      !tagEntry.content.equals(installedEntry.content)
    ) fail();
  }
  const pluginManifest = record(parseJsonBytes(installedFiles[0].content));
  exactString(pluginManifest.name, PLUGIN_NAME);
  exactString(pluginManifest.version, version);
  exactString(pluginTreeDigest(installedFiles), pluginTreeDigest(tagFiles));
}

function fieldDigest(domain, value) {
  return sha256(JSON.stringify([domain, value]));
}

export function buildHostAcceptanceSession(input) {
  try {
    const repositoryRoot = fixedWindowsAbsolutePath(input.repositoryRoot);
    const localAppData = fixedWindowsAbsolutePath(input.localAppData);
    const userProfile = fixedWindowsAbsolutePath(input.userProfile);
    if (input.gitStatus !== "") fail();
    const gitHead = matchingString(input.gitHead, COMMIT_PATTERN, 40);
    exactString(input.tagCommit, gitHead);

    const packageManifest = record(parseJsonBytes(input.packageBytes));
    exactString(packageManifest.name, PACKAGE_NAME);
    const version = matchingString(packageManifest.version, BETA_VERSION_PATTERN, 128);
    const tag = `v${version}`;
    const markerPath = `.release-validation/v${version}.json`;
    const marker = parseBetaMarker(parseJsonBytes(input.markerBytes), version, tag);
    const protocol = parseProtocol(parseJsonBytes(input.protocolBytes));
    const sources = parseBuildConfig(parseJsonBytes(input.buildConfigBytes));
    const manifest = parseBuildManifest(
      parseJsonBytes(input.manifestBytes),
      sources,
      input.inputFiles,
      input.protocolBytes,
    );
    const observer = marker.observerArtifact;
    exactString(observer.sha256, sha256(input.observerBytes));
    exactString(observer.buildManifest.sha256, sha256(input.manifestBytes));
    exactString(observer.protocol.sha256, sha256(input.protocolBytes));
    exactString(observer.inputsDigestSha256, manifest.inputsDigestSha256);
    exactString(
      marker.pluginArtifactTreeDigestSha256,
      pluginTreeDigest(input.pluginFiles),
    );
    verifyInstalledPluginFiles(
      input.pluginFiles,
      input.installedPluginFiles,
      version,
    );
    const npm = parseNpmView(input.npmView, version);

    const nonce = matchingString(input.entropy.nonce, protocol.noncePattern, 128);
    const pipeName = matchingString(
      `codex-agent-tools-host-acceptance-${input.entropy.pipeHex}`,
      protocol.pipeNamePattern,
      128,
    );
    const completionMarkerId = matchingString(
      `completion-${input.entropy.markerHex}`,
      protocol.markerIdPattern,
      64,
    );
    const sessionRoot = path.win32.join(
      localAppData,
      "codex-agent-tools",
      "host-acceptance",
      "sessions",
      nonce,
    );
    const delegateWorkspace = path.win32.join(
      sessionRoot,
      "delegate-workspace",
    );
    const completionMarkerPath = path.win32.join(
      sessionRoot,
      "completion-markers",
      `${completionMarkerId}.marker`,
    );
    const prompt = fixedDelegatePrompt(completionMarkerPath);
    const promptSha256 = fieldDigest(protocol.promptDomain, prompt);
    const cwdSha256 = fieldDigest(protocol.cwdDomain, delegateWorkspace);
    const inputIdentitySha256 = sha256(
      JSON.stringify([
        protocol.requestInputDomain,
        "delegate",
        "kimi-k3",
        promptSha256,
        cwdSha256,
        null,
        null,
      ]),
    );
    const completionMarkerIdentitySha256 = sha256(
      JSON.stringify([
        protocol.completionMarkerDomain,
        nonce,
        completionMarkerId,
        inputIdentitySha256,
      ]),
    );
    const descriptor = {
      schemaVersion: 1,
      protocolVersion: 1,
      packageName: PACKAGE_NAME,
      nonce,
      pipeName,
      publicBeta: {
        version,
        tag,
        taggedCommit: gitHead,
        markerPath,
        markerSha256: sha256(input.markerBytes),
        pluginArtifactTreeDigestSha256:
          marker.pluginArtifactTreeDigestSha256,
        observerArtifact: observer,
        npm,
      },
      request: {
        task: "delegate",
        llm: "kimi-k3",
        promptSha256,
        cwdSha256,
        timeoutMs: null,
        sessionIdSha256: null,
        inputIdentitySha256,
        completionMarkerId,
        completionMarkerIdentitySha256,
      },
    };
    const descriptorBytes = Buffer.from(JSON.stringify(descriptor), "utf8");
    if (descriptorBytes.byteLength === 0 || descriptorBytes.byteLength > protocol.maximumBytes) {
      fail();
    }
    return Object.freeze({
      nonce,
      completionMarkerId,
      completionMarkerPath,
      descriptorBytes,
      descriptorPath: path.win32.join(
        localAppData,
        ...DESCRIPTOR_RELATIVE_PATH.split("/"),
      ),
      sessionRoot,
      delegateWorkspace,
      installedPluginRoot: installedPluginRoot(userProfile, version),
      receiptPath: path.win32.join(sessionRoot, "host-acceptance-receipt.v1.json"),
      observerPath: path.win32.join(repositoryRoot, ...OBSERVER_PATH.split("/")),
      request: Object.freeze({
        llm: "kimi-k3",
        prompt,
        cwd: delegateWorkspace,
        timeoutMs: null,
        sessionId: null,
      }),
    });
  } catch {
    return fail();
  }
}

export async function consumeObserverLifecycle(input) {
  let published = false;
  let failed = false;
  let index = 0;
  try {
    for await (const line of input.lines) {
      if (line !== EXPECTED_PHASES[index]) observerFail();
      if (line === "READY") {
        await input.publishDescriptor();
        published = true;
        input.announce(
          "Observer 已就绪。请在当前旧 App 中发起一次普通、无副作用的工具调用，等待下一条提示。",
          line,
        );
      } else if (line === "OLD_HOST_BOUND") {
        input.announce(
          "旧宿主已绑定。现在请从系统托盘完整退出旧 App；不要只关闭窗口。",
          line,
        );
      } else if (line === "OLD_HOST_EXITED") {
        input.announce(
          "旧 App 已完整退出。现在重新打开 App，在新任务中按下方精确参数发起 delegate。",
          line,
        );
      } else if (line === "REQUEST_STARTED") {
        input.announce(
          "目标请求已开始。现在请在 Codex App 中点击 Stop。等待 observer 退出。",
          line,
        );
      }
      index += 1;
    }
    const exitCode = await input.exitCode;
    if (index !== EXPECTED_PHASES.length || exitCode !== 0) observerFail();
  } catch {
    failed = true;
  } finally {
    if (published) {
      try {
        await input.removeDescriptor();
      } catch {
        failed = true;
      }
    }
  }
  if (failed) observerFail();
}

async function requireTrustedFile(repositoryRoot, relativePath, maximumBytes) {
  const normalized = repositoryRelativePath(relativePath);
  const segments = normalized.split("/");
  let cursor = repositoryRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const status = await lstat(cursor);
    if (status.isSymbolicLink()) fail();
  }
  const status = await lstat(cursor);
  if (!status.isFile() || status.size <= 0 || status.size > maximumBytes) fail();
  const resolved = await realpath(cursor);
  if (resolved.toLowerCase() !== cursor.toLowerCase()) fail();
  const content = await readFile(cursor);
  if (content.byteLength !== status.size) fail();
  return content;
}

async function run(command, args, cwd) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    return fail();
  }
}

async function requireExactRegularFile(filePath) {
  const status = await lstat(filePath);
  if (!status.isFile() || status.isSymbolicLink()) fail();
  const resolved = await realpath(filePath);
  if (resolved.toLowerCase() !== filePath.toLowerCase()) fail();
}

async function prepareFromRepository(repositoryRoot, localAppData, userProfile) {
  const packageBytes = await requireTrustedFile(
    repositoryRoot,
    "package.json",
    MAX_JSON_BYTES,
  );
  const packageManifest = record(parseJsonBytes(packageBytes));
  const version = matchingString(packageManifest.version, BETA_VERSION_PATTERN, 128);
  const tag = `v${version}`;
  const gitHead = (await run("git", ["rev-parse", "--verify", "HEAD^{commit}"], repositoryRoot)).trim();
  const tagCommit = (
    await run("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], repositoryRoot)
  ).trim();
  const gitStatus = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repositoryRoot,
  );
  const buildConfigBytes = await requireTrustedFile(
    repositoryRoot,
    BUILD_CONFIG_PATH,
    MAX_JSON_BYTES,
  );
  const sources = parseBuildConfig(parseJsonBytes(buildConfigBytes));
  const expectedInputs = [
    SHARED_TOOLCHAIN_PATH,
    SHARED_BUILD_CONFIG_PATH,
    SHARED_RESTORE_PATH,
    BUILD_CONFIG_PATH,
    BUILD_ENTRY_PATH,
    PROTOCOL_PATH,
    ...sources,
  ];
  const inputFiles = new Map();
  for (const inputPath of expectedInputs) {
    inputFiles.set(
      inputPath,
      await requireTrustedFile(repositoryRoot, inputPath, MAX_JSON_BYTES),
    );
  }
  const protocolBytes = inputFiles.get(PROTOCOL_PATH);
  const markerBytes = await requireTrustedFile(
    repositoryRoot,
    `.release-validation/v${version}.json`,
    MAX_JSON_BYTES,
  );
  const manifestBytes = await requireTrustedFile(
    repositoryRoot,
    MANIFEST_PATH,
    MAX_JSON_BYTES,
  );
  const observerBytes = await requireTrustedFile(
    repositoryRoot,
    OBSERVER_PATH,
    MAX_BINARY_BYTES,
  );
  const pluginFiles = [];
  for (const pluginPath of HOST_ACCEPTANCE_PLUGIN_PATHS) {
    pluginFiles.push({
      path: pluginPath,
      content: await requireTrustedFile(repositoryRoot, pluginPath, MAX_BINARY_BYTES),
    });
  }
  const cacheRoot = installedPluginRoot(userProfile, version);
  const installedPluginFiles = [];
  for (const pluginPath of HOST_ACCEPTANCE_PLUGIN_PATHS) {
    installedPluginFiles.push({
      path: pluginPath,
      content: await requireTrustedFile(
        cacheRoot,
        cacheRelativePluginPath(pluginPath),
        MAX_BINARY_BYTES,
      ),
    });
  }
  const npmInvocation = buildNpmViewInvocation(process.execPath, version);
  await requireExactRegularFile(npmInvocation.npmCliPath);
  const npmOutput = await run(
    npmInvocation.command,
    npmInvocation.args,
    repositoryRoot,
  );
  let npmView;
  try {
    npmView = JSON.parse(npmOutput);
  } catch {
    fail();
  }
  return buildHostAcceptanceSession({
    repositoryRoot,
    localAppData,
    userProfile,
    packageBytes,
    markerBytes,
    buildConfigBytes,
    manifestBytes,
    observerBytes,
    protocolBytes,
    inputFiles,
    pluginFiles,
    installedPluginFiles,
    gitHead,
    tagCommit,
    gitStatus,
    npmView,
    entropy: {
      nonce: randomBytes(32).toString("base64url"),
      pipeHex: randomBytes(24).toString("hex"),
      markerHex: randomBytes(16).toString("hex"),
    },
  });
}

async function ensureDirectory(pathname) {
  await mkdir(pathname, { recursive: true });
  const status = await lstat(pathname);
  if (!status.isDirectory() || status.isSymbolicLink()) fail();
  const resolved = await realpath(pathname);
  if (resolved.toLowerCase() !== pathname.toLowerCase()) fail();
}

async function requireAbsent(pathname) {
  try {
    await lstat(pathname);
    fail();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function prepareHostAcceptanceDirectories(plan) {
  await ensureDirectory(path.dirname(plan.descriptorPath));
  await requireAbsent(plan.sessionRoot);
  await ensureDirectory(path.join(plan.sessionRoot, "completion-markers"));
  await ensureDirectory(plan.delegateWorkspace);
  await requireAbsent(plan.descriptorPath);
  await requireAbsent(plan.receiptPath);
}

async function publishDescriptorAtomic(plan) {
  const temporary = path.join(
    path.dirname(plan.descriptorPath),
    `.session.v1.${plan.nonce}.tmp`,
  );
  await requireAbsent(temporary);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(plan.descriptorBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, plan.descriptorPath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function removeExactDescriptor(plan) {
  let current;
  try {
    current = await readFile(plan.descriptorPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (sha256(current) !== sha256(plan.descriptorBytes)) observerFail();
  await unlink(plan.descriptorPath);
}

async function* strictLines(stream) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    while (true) {
      const lineEnd = pending.indexOf("\n");
      if (lineEnd < 0) break;
      const raw = pending.slice(0, lineEnd);
      pending = pending.slice(lineEnd + 1);
      yield raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    }
  }
  pending += decoder.decode();
  if (pending !== "") observerFail();
}

function spawnObserver(plan, repositoryRoot) {
  const child = spawn(plan.observerPath, [], {
    cwd: repositoryRoot,
    shell: false,
    windowsHide: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exitCode = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code === null) reject(new Error(OBSERVER_FAILURE_MESSAGE));
      else resolve(code);
    });
  });
  void exitCode.catch(() => undefined);
  let stdinFailed = false;
  child.stdin.on("error", () => {
    stdinFailed = true;
  });
  let stderrBytes = 0;
  let stderrFailed = false;
  const stderrDone = new Promise((resolve) => {
    child.stderr.once("close", resolve);
  });
  child.stderr.on("error", () => {
    stderrFailed = true;
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 1024) child.stderr.destroy();
  });
  child.stdin.end(plan.descriptorBytes);
  return {
    child,
    lines: strictLines(child.stdout),
    exitCode,
    async requireCleanStdio() {
      await stderrDone;
      if (stdinFailed || stderrFailed || stderrBytes !== 0) observerFail();
    },
  };
}

function printRequest(plan) {
  process.stdout.write(
    `${JSON.stringify(
      {
        tool: "external_delegate",
        arguments: {
          llm: plan.request.llm,
          prompt: plan.request.prompt,
          cwd: plan.request.cwd,
        },
        descriptorBinding: { timeoutMs: null, sessionId: null },
        instruction: "timeoutMs 与 sessionId 均不要传入；不要改写 prompt 或 cwd。",
      },
      null,
      2,
    )}\n`,
  );
}

function printOldHostReview(plan) {
  process.stdout.write(
    `${JSON.stringify(
      {
        tool: "external_review",
        arguments: {
          llm: "kimi-k3",
          task: "review_doc",
          prompt:
            "请只读审阅这句话是否清晰：当前公开 beta 插件宿主握手正在进行。不要修改任何文件。",
          cwd: plan.request.cwd,
          includeGitDiff: false,
          includeUntracked: false,
        },
        instruction: "这是旧 App 的普通只读握手调用；不要传 timeoutMs。",
      },
      null,
      2,
    )}\n`,
  );
}

async function terminateHeldObserver(observer) {
  try {
    observer.child.kill();
  } catch {
    // The retained ChildProcess remains the only termination authority.
  }
  await observer.exitCode.catch(() => undefined);
}

async function main() {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.versions.node.split(".")[0] !== "24" ||
    process.argv.length !== 2
  ) fail();
  const localAppData = fixedWindowsAbsolutePath(process.env.LOCALAPPDATA);
  const userProfile = fixedWindowsAbsolutePath(process.env.USERPROFILE);
  const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
  const root = await realpath(path.join(repositoryRoot, ".."));
  const current = await realpath(process.cwd());
  if (root.toLowerCase() !== current.toLowerCase()) fail();
  const plan = await prepareFromRepository(root, localAppData, userProfile);
  await prepareHostAcceptanceDirectories(plan);
  const observer = spawnObserver(plan, root);
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    try {
      observer.child.kill();
    } catch {
      // The normal lifecycle path will still await the retained child handle.
    }
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    try {
      await consumeObserverLifecycle({
        lines: observer.lines,
        exitCode: observer.exitCode,
        publishDescriptor: () => publishDescriptorAtomic(plan),
        removeDescriptor: () => removeExactDescriptor(plan),
        announce: (message, phase) => {
          process.stdout.write(`${message}\n`);
          if (phase === "READY") printOldHostReview(plan);
          if (phase === "OLD_HOST_EXITED") printRequest(plan);
        },
      });
      await observer.requireCleanStdio();
    } catch (error) {
      await terminateHeldObserver(observer);
      throw error;
    }
    if (interrupted) observerFail();
    process.stdout.write(
      `Observer 已以退出码 0 结束，并由其独占写入 receipt：${plan.receiptPath}\n`,
    );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (process.argv[1] !== undefined) {
  const entry = await realpath(process.argv[1]).catch(() => "");
  const self = await realpath(fileURLToPath(import.meta.url));
  if (entry.toLowerCase() === self.toLowerCase()) {
    try {
      await main();
    } catch {
      process.stderr.write("host-acceptance: failed\n");
      process.exitCode = 1;
    }
  }
}
