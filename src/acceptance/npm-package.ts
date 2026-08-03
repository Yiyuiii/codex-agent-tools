import os from "node:os";
import { createHash } from "node:crypto";

import {
  assertReleasePackageMetadata,
  capabilitySourcePathsFromIndex,
} from "../release/assurance.js";
import {
  DOCTOR_CHECK_NAMES,
  DOCTOR_QUALIFIED_LLM_IDS,
} from "../cli/doctor.js";
import {
  assertPublicExternalToolDefinitions,
  PUBLIC_EXTERNAL_TOOL_DEFINITIONS,
} from "../mcp/tools.js";

const PUBLIC_REPOSITORY_URL =
  "git+https://github.com/Yiyuiii/codex-agent-tools.git";
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
export interface NpmPackageAcceptanceArguments {
  readonly version: string;
}

export interface RegistryPackageMetadata {
  readonly integrity: string;
  readonly shasum: string;
}

export interface InstalledPackageContractOptions {
  readonly packageManifest: unknown;
  readonly pluginManifest: unknown;
  readonly expectedVersion: string;
}

export interface InstalledCapabilityProjectionOptions {
  readonly repositoryIndex: Uint8Array;
  readonly installedIndex: Uint8Array;
  readonly readInstalledFile: (
    relativePath: string,
  ) => Promise<Uint8Array>;
}

export interface NpmPackageAcceptanceReportOptions
  extends RegistryPackageMetadata {
  readonly version: string;
  readonly observedAt: string;
  readonly nodeVersion: string;
  readonly npmVersion: string;
}

interface InstalledToolContract {
  readonly name: string;
  readonly inputSchema?: { readonly required?: readonly string[] };
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
  };
}

export interface InstalledMcpClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: readonly InstalledToolContract[] }>;
}

export interface InstalledMcpSession<TClient, TTransport> {
  readonly client: TClient;
  readonly transport: TTransport;
}

export interface IsolatedNpmEnvironmentOptions {
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly isolatedUserHome: string;
  readonly isolatedCodexHome: string;
  readonly isolatedLocalAppData: string;
  readonly isolatedAppData: string;
  readonly temporaryRoot: string;
  readonly npmUserConfig: string;
  readonly npmGlobalConfig: string;
  readonly npmCache: string;
}

const SYSTEM_ENVIRONMENT_ALLOWLIST = new Set([
  "COMSPEC",
  "ComSpec",
  "PATH",
  "Path",
  "PATHEXT",
  "SystemDrive",
  "SYSTEMDRIVE",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
]);

function assertInstalledToolContract(
  tools: readonly InstalledToolContract[],
): void {
  const names = tools.map(({ name }) => name).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(["external_delegate", "external_review"])
  ) {
    throw new Error(`Unexpected MCP tools: ${names.join(", ")}`);
  }
  for (const tool of tools) {
    if (!tool.inputSchema?.required?.includes("llm")) {
      throw new Error(`${tool.name} requires llm`);
    }
  }
  const review = tools.find(({ name }) => name === "external_review");
  const delegate = tools.find(({ name }) => name === "external_delegate");
  if (
    review?.annotations?.readOnlyHint !== true ||
    review.annotations.destructiveHint !== false ||
    delegate?.annotations?.readOnlyHint !== false ||
    delegate.annotations.destructiveHint !== true
  ) {
    throw new Error("Installed MCP tool annotations are unsafe");
  }
}

function acceptanceArgumentError(): Error {
  return new Error("Invalid npm package acceptance arguments");
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid npm package acceptance record");
  }
  return value as Record<string, unknown>;
}

function parseVersion(value: unknown): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw acceptanceArgumentError();
  }
  return value;
}

export function buildIsolatedNpmEnvironment(
  options: IsolatedNpmEnvironmentOptions,
): NodeJS.ProcessEnv {
  const systemEnvironment = Object.fromEntries(
    Object.entries(options.sourceEnvironment).filter(
      ([name, value]) =>
        SYSTEM_ENVIRONMENT_ALLOWLIST.has(name) &&
        typeof value === "string",
    ),
  );
  return Object.freeze({
    ...systemEnvironment,
    HOME: options.isolatedUserHome,
    USERPROFILE: options.isolatedUserHome,
    LOCALAPPDATA: options.isolatedLocalAppData,
    APPDATA: options.isolatedAppData,
    CODEX_HOME: options.isolatedCodexHome,
    TEMP: options.temporaryRoot,
    TMP: options.temporaryRoot,
    TMPDIR: options.temporaryRoot,
    NPM_CONFIG_USERCONFIG: options.npmUserConfig,
    NPM_CONFIG_GLOBALCONFIG: options.npmGlobalConfig,
    NPM_CONFIG_CACHE: options.npmCache,
  });
}

export function parseNpmPackageAcceptanceArguments(
  args: readonly string[],
): NpmPackageAcceptanceArguments {
  let version: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let candidate: string | undefined;
    if (argument === "--version") {
      candidate = args[index + 1];
      index += 1;
    } else if (argument?.startsWith("--version=")) {
      candidate = argument.slice("--version=".length);
    } else {
      throw acceptanceArgumentError();
    }
    if (version !== undefined || candidate === undefined) {
      throw acceptanceArgumentError();
    }
    version = parseVersion(candidate);
  }
  if (version === undefined) throw acceptanceArgumentError();
  return Object.freeze({ version });
}

export function npmAcceptanceReportRelativePath(version: string): string {
  return `docs/release/${parseVersion(version)}-npm-acceptance.md`;
}

export function assertNpmRegistryMetadata(
  value: unknown,
  expectedVersion: string,
): RegistryPackageMetadata {
  const version = parseVersion(expectedVersion);
  const record = recordOf(value);
  const integrity = record["dist.integrity"];
  const shasum = record["dist.shasum"];
  if (
    record.version !== version ||
    record["repository.url"] !== PUBLIC_REPOSITORY_URL ||
    typeof integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity) ||
    typeof shasum !== "string" ||
    !/^[0-9a-f]{40}$/u.test(shasum)
  ) {
    throw new Error("Public npm registry metadata is invalid");
  }
  return Object.freeze({ integrity, shasum });
}

export function assertInstalledPackageContract(
  options: InstalledPackageContractOptions,
): void {
  const expectedVersion = parseVersion(options.expectedVersion);
  try {
    assertReleasePackageMetadata({
      packageManifest: options.packageManifest,
      pluginManifest: options.pluginManifest,
      runtimeVersion: expectedVersion,
    });
    if (recordOf(options.packageManifest).version !== expectedVersion) {
      throw new Error("version mismatch");
    }
  } catch {
    throw new Error("Installed package contract is invalid");
  }
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseJsonBytes(content: Uint8Array): unknown {
  return JSON.parse(Buffer.from(content).toString("utf8"));
}

export async function assertInstalledCapabilityProjection(
  options: InstalledCapabilityProjectionOptions,
): Promise<{ readonly sourcePaths: readonly string[] }> {
  try {
    if (
      !Buffer.from(options.repositoryIndex).equals(
        Buffer.from(options.installedIndex),
      )
    ) {
      throw new Error("index mismatch");
    }
    const index = recordOf(parseJsonBytes(options.installedIndex));
    const sourcePaths = capabilitySourcePathsFromIndex(index);
    const contents = new Map<string, Uint8Array>();
    const readSource = async (relativePath: string): Promise<Uint8Array> => {
      let content = contents.get(relativePath);
      if (content === undefined) {
        content = await options.readInstalledFile(relativePath);
        contents.set(relativePath, content);
      }
      return content;
    };
    if (!Array.isArray(index.entries)) throw new Error("missing entries");
    for (const entryValue of index.entries) {
      const entry = recordOf(entryValue);
      if (
        typeof entry.llm !== "string" ||
        (entry.task !== "review" && entry.task !== "delegate")
      ) {
        throw new Error("invalid capability identity");
      }
      const source = recordOf(entry.source);
      if (
        typeof source.evidencePath !== "string" ||
        typeof source.evidenceSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(source.evidenceSha256)
      ) {
        throw new Error("invalid evidence reference");
      }
      const evidence = await readSource(source.evidencePath);
      if (sha256(evidence) !== source.evidenceSha256) {
        throw new Error("evidence hash mismatch");
      }
      if (source.kind === "legacy-standalone") continue;
      if (
        source.kind !== "batch-case" ||
        typeof source.manifestPath !== "string" ||
        typeof source.manifestSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(source.manifestSha256)
      ) {
        throw new Error("invalid manifest reference");
      }
      const manifestBytes = await readSource(source.manifestPath);
      if (sha256(manifestBytes) !== source.manifestSha256) {
        throw new Error("manifest hash mismatch");
      }
      const manifest = recordOf(parseJsonBytes(manifestBytes));
      if (!Array.isArray(manifest.cases)) {
        throw new Error("manifest cases missing");
      }
      const matchingCases = manifest.cases
        .map(recordOf)
        .filter(
          (candidate) =>
            candidate.llm === entry.llm && candidate.task === entry.task,
        );
      const matchingCase = matchingCases[0];
      const reference = recordOf(matchingCase?.evidence);
      if (
        matchingCases.length !== 1 ||
        matchingCase?.result !== "passed" ||
        reference.path !== source.evidencePath ||
        reference.sha256 !== source.evidenceSha256
      ) {
        throw new Error("manifest capability mismatch");
      }
    }
    return Object.freeze({ sourcePaths });
  } catch {
    throw new Error("Installed capability projection is invalid");
  }
}

export function assertDoctorAcceptance(value: unknown): void {
  try {
    const report = recordOf(value);
    if (report.ok !== true || !Array.isArray(report.checks)) {
      throw new Error("doctor failed");
    }
    const checks = report.checks.map((value) => recordOf(value));
    const names = checks.map(({ name }) => name);
    if (
      names.length !== DOCTOR_CHECK_NAMES.length ||
      new Set(names).size !== names.length ||
      JSON.stringify([...names].sort()) !==
        JSON.stringify([...DOCTOR_CHECK_NAMES].sort())
    ) {
      throw new Error("doctor check set drifted");
    }
    for (const check of checks) {
      if (typeof check.detail !== "string") {
        throw new Error("doctor check failed");
      }
      if (check.name === "Windows native helper") {
        const validNativeCheck =
          process.platform === "win32"
            ? check.ok === true && check.level === "ok"
            : check.ok === true &&
              check.level === "warn" &&
              check.detail === `not applicable on ${process.platform}`;
        if (!validNativeCheck) throw new Error("doctor check failed");
      } else if (check.ok !== true || check.level !== "ok") {
        throw new Error("doctor check failed");
      }
    }
    const hostRuntime = checks.find(({ name }) => name === "Host runtime");
    const expectedHostRuntime = `platform=${process.platform}; arch=${process.arch}; os=${os.release()}; node=${process.versions.node}; libuv=${process.versions.uv}`;
    if (hostRuntime?.detail !== expectedHostRuntime) {
      throw new Error("doctor host runtime drifted");
    }
    assertPublicExternalToolDefinitions();
    const publicTools = checks.find(
      ({ name }) => name === "Public MCP tools",
    );
    if (
      publicTools?.detail !==
      PUBLIC_EXTERNAL_TOOL_DEFINITIONS.map(({ name }) => name).join(", ")
    ) {
      throw new Error("public tool surface drifted");
    }
    for (const llm of DOCTOR_QUALIFIED_LLM_IDS) {
      const check = checks.find(({ name }) => name === `LLM ${llm}`);
      if (
        typeof check?.detail !== "string" ||
        !/route=direct; review=passed; delegate=passed$/u.test(check.detail)
      ) {
        throw new Error("qualified llm surface drifted");
      }
    }
  } catch {
    throw new Error("Installed doctor acceptance is invalid");
  }
}

export async function establishInstalledMcpSession<
  TClient extends InstalledMcpClient,
  TTransport,
>(options: {
  readonly client: TClient;
  readonly transport: TTransport;
  readonly cleanup: (
    client: TClient,
    transport: TTransport,
  ) => Promise<void>;
}): Promise<InstalledMcpSession<TClient, TTransport>> {
  try {
    await options.client.connect(options.transport);
    const listed = await options.client.listTools();
    assertInstalledToolContract(listed.tools);
    return Object.freeze({
      client: options.client,
      transport: options.transport,
    });
  } catch (error) {
    await options.cleanup(options.client, options.transport).catch(
      () => undefined,
    );
    throw error;
  }
}

export function renderNpmPackageAcceptanceReport(
  options: NpmPackageAcceptanceReportOptions,
): string {
  const version = parseVersion(options.version);
  const registry = assertNpmRegistryMetadata(
    {
      version,
      "dist.integrity": options.integrity,
      "dist.shasum": options.shasum,
      "repository.url": PUBLIC_REPOSITORY_URL,
    },
    version,
  );
  if (
    new Date(options.observedAt).toISOString() !== options.observedAt ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+/u.test(options.nodeVersion) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+/u.test(options.npmVersion)
  ) {
    throw new Error("Invalid npm package acceptance report metadata");
  }

  return `# codex-agent-tools ${version} 公共 npm 隔离验收

## 制品身份

- 验收时间：\`${options.observedAt}\`
- 公共包：\`codex-agent-tools@${version}\`
- npm integrity：\`${registry.integrity}\`
- npm shasum：\`${registry.shasum}\`
- Node.js：\`${options.nodeVersion}\`
- npm：\`${options.npmVersion}\`

## 机器门禁

Doctor: pass
Local-Npm-Smoke: pass
MCP-Smoke: pass
Plugin-Isolated: pass
Capability-Index: pass
Owned-MCP-Cleanup: pass

## 验收边界

- 包从公共 npm registry 按精确版本安装到一次性临时目录，安装时禁用 lifecycle scripts。
- CLI version/help 与不启动 Kimi/Pi target 的 doctor 全绿；doctor 的 Pi 配置只写入临时应用数据目录。
- 已安装包的 stdio MCP 与官方插件缓存副本都只暴露 \`external_review\`、\`external_delegate\`，且 \`llm\` 必填和读写注解正确。
- 官方插件只在一次性临时 Codex home 中完成 marketplace add、plugin add/list、缓存副本 MCP 启动、plugin remove 与 marketplace remove；活动 Codex home 未读取或修改。
- 本次验收创建的 MCP transport 均已显式关闭，隔离目录由 finally 删除；不扫描或约束用户的其它 Kimi/Pi 进程。
- 资格锁：\`absent\`。
- 真实模型调用：\`0\`。
`;
}
