import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import {
  buildIsolatedPiConfig,
  type BuildIsolatedPiConfigOptions,
  type IsolatedPiConfig,
} from "../adapters/pi/config.js";
import {
  locatePi,
  locatePiInvocation,
  type PiInvocation,
} from "../adapters/pi/locator.js";
import { resolveLlm } from "../llms/registry.js";
import {
  assertPublicExternalToolDefinitions,
  PUBLIC_EXTERNAL_TOOL_DEFINITIONS,
} from "../mcp/tools.js";
import { buildChildEnvironment } from "../runtime/environment.js";
import { redactText } from "../runtime/redaction.js";
import {
  resolveWindowsJobHelper as resolveDefaultWindowsJobHelper,
  type ResolvedWindowsJobHelper,
} from "../runtime/windows-job-helper.js";
import { VERSION } from "../version.js";

export const DOCTOR_QUALIFIED_LLM_IDS = Object.freeze([
  "deepseek-v4-flash",
] as const);

export const DOCTOR_LLM_IDS = DOCTOR_QUALIFIED_LLM_IDS;

export const DOCTOR_CHECK_NAMES = Object.freeze([
  "Host runtime",
  "Pi executable",
  "Pi isolated config",
  "Pi models",
  "Windows native helper",
  "DeepSeek authentication",
  "Public MCP tools",
  ...DOCTOR_LLM_IDS.map((id) => `LLM ${id}` as const),
] as const);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  level: "ok" | "warn" | "error";
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface CommandResult {
  ok: boolean;
  output: string;
}

export interface WindowsJobHelperProbeRequest {
  readonly executablePath: string;
  readonly args: readonly ["--probe-v1"];
  readonly environment: NodeJS.ProcessEnv;
  readonly extendEnv: false;
}

export interface CollectDoctorOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly osRelease?: () => string;
  readonly nodeVersion?: string;
  readonly libuvVersion?: string;
  readonly locatePiExecutable?: () => Promise<string>;
  readonly locatePiInvocation?: () => Promise<PiInvocation>;
  readonly buildPiConfig?: (
    options: BuildIsolatedPiConfigOptions,
  ) => Promise<IsolatedPiConfig>;
  readonly resolveWindowsJobHelper?: () => Promise<ResolvedWindowsJobHelper>;
  readonly runWindowsJobHelperProbe?: (
    request: WindowsJobHelperProbeRequest,
  ) => Promise<CommandResult>;
}

async function defaultRunWindowsJobHelperProbe(
  request: WindowsJobHelperProbeRequest,
): Promise<CommandResult> {
  const result = await execa(request.executablePath, [...request.args], {
    env: request.environment,
    extendEnv: request.extendEnv,
    reject: false,
    timeout: 30_000,
    windowsHide: true,
  });
  return {
    ok: result.exitCode === 0,
    output: [result.stdout, result.stderr]
      .filter((value) => value.trim() !== "")
      .join("\n"),
  };
}

function secretValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(
      ([name, value]) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/iu.test(name) && Boolean(value),
    )
    .map(([, value]) => value!)
    .filter((value) => value.trim() !== "");
}

function selectedCredentialName(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): string | undefined {
  for (const name of names) {
    const matches = Object.entries(environment).filter(
      ([key, value]) =>
        key.toUpperCase() === name.toUpperCase() && value?.trim() !== "",
    );
    if (matches.length > 1) {
      throw new Error("ambiguous credential environment");
    }
    if (matches.length === 1) return matches[0]![0];
  }
  return undefined;
}

function limitedDetail(value: string, secrets: readonly string[]): string {
  const redacted = redactText(value.trim(), secrets);
  return redacted.length <= 1_000
    ? redacted
    : `${redacted.slice(0, 1_000)}[TRUNCATED]`;
}

function executableName(executable: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.win32.basename(executable)
    : path.posix.basename(executable);
}

function assertLocatedExecutable(executable: string): void {
  if (executable.trim() === "" || executable.includes("\0")) {
    throw new Error("static executable locator returned an invalid path");
  }
}

function assertPiInvocation(invocation: PiInvocation): void {
  if (
    invocation.executable !== process.execPath ||
    invocation.argvPrefix.length !== 1 ||
    invocation.argvPrefix[0].trim() === "" ||
    invocation.argvPrefix[0].includes("\0") ||
    invocation.identity.packageName !== "@earendil-works/pi-coding-agent" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(
      invocation.identity.packageVersion,
    ) ||
    !/^>=(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(
      invocation.identity.nodeEngine,
    )
  ) {
    throw new Error("Pi installation could not be verified");
  }
}

function nodeMajor(version: string): number | undefined {
  const match = /^v?(0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.exec(
    version,
  );
  if (match === null) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

const EXPECTED_PI_PROVIDERS = new Map([
  [
    "deepseek",
    {
      api: "openai-completions",
      apiKey: "$CODEX_AGENT_DEEPSEEK_KEY",
      baseUrl: "https://api.deepseek.com",
      models: ["deepseek-v4-flash"],
    },
  ],
] as const);

async function validatePiConfig(
  config: IsolatedPiConfig,
): Promise<void> {
  const [settingsText, modelsText] = await Promise.all([
    readFile(config.settingsPath, "utf8"),
    readFile(config.modelsPath, "utf8"),
  ]);
  const calculatedHash = createHash("sha256")
    .update(settingsText)
    .update("\0")
    .update(modelsText)
    .digest("hex");
  if (calculatedHash !== config.contentSha256) {
    throw new Error("isolated Pi configuration hash mismatch");
  }

  const root = JSON.parse(modelsText) as {
    providers?: Record<
      string,
      {
        api?: unknown;
        apiKey?: unknown;
        baseUrl?: unknown;
        models?: Array<{ id?: unknown }>;
      }
    >;
  };
  const providers = root.providers ?? {};
  const expectedProviderNames = ["deepseek"] as const;
  if (
    JSON.stringify(Object.keys(providers).sort()) !==
    JSON.stringify([...expectedProviderNames].sort())
  ) {
    throw new Error("isolated Pi provider set mismatch");
  }

  for (const providerName of expectedProviderNames) {
    const expected = EXPECTED_PI_PROVIDERS.get(providerName);
    if (expected === undefined) {
      throw new Error("isolated Pi expected provider is invalid");
    }
    const provider = providers[providerName];
    if (
      provider?.api !== expected.api ||
      provider.apiKey !== expected.apiKey ||
      provider.baseUrl !== expected.baseUrl
    ) {
      throw new Error(
        `isolated Pi ${providerName} endpoint or protocol mismatch`,
      );
    }
    const actualModels = (provider.models ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
    if (
      JSON.stringify(actualModels) !==
      JSON.stringify([...expected.models].sort())
    ) {
      throw new Error(`isolated Pi ${providerName} model set mismatch`);
    }
  }
}

export async function collectDoctorReport(
  options: CollectDoctorOptions = {},
): Promise<DoctorReport> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const release = options.osRelease?.() ?? os.release();
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const libuvVersion = options.libuvVersion ?? process.versions.uv;
  const locatePiExecutable =
    options.locatePiExecutable ?? (() => locatePi({ environment, platform }));
  const locateStrictPiInvocation =
    options.locatePiInvocation ??
    (() => locatePiInvocation({ environment, platform }));
  const buildPiConfig = options.buildPiConfig ?? buildIsolatedPiConfig;
  const resolveWindowsJobHelper =
    options.resolveWindowsJobHelper ?? resolveDefaultWindowsJobHelper;
  const runWindowsJobHelperProbe =
    options.runWindowsJobHelperProbe ?? defaultRunWindowsJobHelperProbe;
  const secrets = secretValues(environment);
  const checks: DoctorCheck[] = [];

  const major = nodeMajor(nodeVersion);
  const validHost =
    major !== undefined &&
    release.trim() !== "" &&
    libuvVersion.trim() !== "" &&
    (platform !== "win32" || (architecture === "x64" && major >= 24));
  checks.push({
    name: "Host runtime",
    ok: validHost,
    level: validHost ? "ok" : "error",
    detail: limitedDetail(
      validHost
        ? `platform=${platform}; arch=${architecture}; os=${release}; node=${nodeVersion}; libuv=${libuvVersion}`
        : `unsupported host: platform=${platform}; arch=${architecture}; os=${release}; node=${nodeVersion}; libuv=${libuvVersion}`,
      secrets,
    ),
  });

  try {
    if (platform === "win32") {
      const invocation = await locateStrictPiInvocation();
      assertPiInvocation(invocation);
      checks.push({
        name: "Pi executable",
        ok: true,
        level: "ok",
        detail: `strict locator passed; package=${invocation.identity.packageName}@${invocation.identity.packageVersion}; node=${invocation.identity.nodeEngine}`,
      });
    } else {
      const executable = await locatePiExecutable();
      assertLocatedExecutable(executable);
      checks.push({
        name: "Pi executable",
        ok: true,
        level: "ok",
        detail: `static locator passed; executable=${executableName(executable, platform)}`,
      });
    }
  } catch (error) {
    checks.push({
      name: "Pi executable",
      ok: false,
      level: "error",
      detail: limitedDetail(
        error instanceof Error ? error.message : String(error),
        secrets,
      ),
    });
  }

  let piConfig: IsolatedPiConfig | undefined;
  try {
    piConfig = await buildPiConfig({
      version: VERSION,
      providers: ["deepseek"],
    });
    checks.push({
      name: "Pi isolated config",
      ok: true,
      level: "ok",
      detail: `generated; deepseekSha256=${piConfig.contentSha256.slice(0, 12)}`,
    });
  } catch (error) {
    checks.push({
      name: "Pi isolated config",
      ok: false,
      level: "error",
      detail: limitedDetail(
        error instanceof Error ? error.message : String(error),
        secrets,
      ),
    });
  }

  if (piConfig === undefined) {
    checks.push({
      name: "Pi models",
      ok: false,
      level: "error",
      detail: "isolated Pi configuration unavailable",
    });
  } else {
    try {
      await validatePiConfig(piConfig);
      checks.push({
        name: "Pi models",
        ok: true,
        level: "ok",
        detail: "static route passed; providers=1; models=1",
      });
    } catch (error) {
      checks.push({
        name: "Pi models",
        ok: false,
        level: "error",
        detail: limitedDetail(
          error instanceof Error ? error.message : String(error),
          secrets,
        ),
      });
    }
  }

  if (platform !== "win32") {
    checks.push({
      name: "Windows native helper",
      ok: true,
      level: "warn",
      detail: `not applicable on ${platform}`,
    });
  } else if (!validHost) {
    checks.push({
      name: "Windows native helper",
      ok: false,
      level: "error",
      detail: "requires win32-x64 with Node.js >=24",
    });
  } else {
    let helper: ResolvedWindowsJobHelper | undefined;
    try {
      helper = await resolveWindowsJobHelper();
      if (
        path.win32.basename(helper.executablePath).toLowerCase() !==
          "codex-agent-job-helper.exe" ||
        !/^[0-9a-f]{64}$/u.test(helper.sha256)
      ) {
        throw new Error("invalid helper identity");
      }
    } catch {
      checks.push({
        name: "Windows native helper",
        ok: false,
        level: "error",
        detail: "Windows job helper artifact validation failed",
      });
    }
    if (helper !== undefined) {
      try {
        const probe = await runWindowsJobHelperProbe({
          executablePath: helper.executablePath,
          args: ["--probe-v1"],
          environment: buildChildEnvironment(
            { network: "direct", credentialEnv: [] },
            environment,
            platform,
          ),
          extendEnv: false,
        });
        if (!probe.ok) {
          throw new Error("probe failed");
        }
        checks.push({
          name: "Windows native helper",
          ok: true,
          level: "ok",
          detail: `managed-x64; sha256=${helper.sha256.slice(0, 12)}; probe-v1=passed`,
        });
      } catch {
        checks.push({
          name: "Windows native helper",
          ok: false,
          level: "error",
          detail: "Windows job helper probe failed",
        });
      }
    }
  }

  for (const [name, id] of [
    ["DeepSeek authentication", "deepseek-v4-flash"],
  ] as const) {
    const profile = resolveLlm(id);
    try {
      const sourceName = selectedCredentialName(
        profile.credentialEnv,
        environment,
      );
      const targetName = profile.credentialTargetEnv;
      const ok = sourceName !== undefined && targetName !== undefined;
      checks.push({
        name,
        ok,
        level: ok ? "ok" : "error",
        detail: ok
          ? `credential environment: ${sourceName} -> ${targetName}`
          : `missing credential environment; checked ${profile.credentialEnv.join(", ")}`,
      });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        level: "error",
        detail: limitedDetail(
          error instanceof Error ? error.message : String(error),
          secrets,
        ),
      });
    }
  }

  try {
    assertPublicExternalToolDefinitions();
    checks.push({
      name: "Public MCP tools",
      ok: true,
      level: "ok",
      detail: PUBLIC_EXTERNAL_TOOL_DEFINITIONS.map(({ name }) => name).join(
        ", ",
      ),
    });
  } catch {
    checks.push({
      name: "Public MCP tools",
      ok: false,
      level: "error",
      detail: "Public MCP tool definitions are invalid",
    });
  }

  for (const id of DOCTOR_LLM_IDS) {
    const profile = resolveLlm(id);
    const review = profile.qualityGates.review.status;
    const delegate = profile.qualityGates.delegate.status;
    const enabled =
      profile.capabilities.review &&
      profile.capabilities.delegate &&
      review === "passed" &&
      delegate === "passed";
    checks.push({
      name: `LLM ${id}`,
      ok: enabled,
      level: enabled ? "ok" : "warn",
      detail: `${profile.model} via ${profile.runtime}; route=${profile.network}; review=${review}; delegate=${delegate}`,
    });
  }

  return {
    ok: !checks.some((check) => check.level === "error"),
    checks,
  };
}
