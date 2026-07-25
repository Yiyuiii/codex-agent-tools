import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { execa } from "execa";

import { locateKimi } from "../adapters/kimi/locator.js";
import {
  buildIsolatedPiConfig,
  type IsolatedPiConfig,
} from "../adapters/pi/config.js";
import { locatePi } from "../adapters/pi/locator.js";
import { resolveLlm, supportedLlmIds } from "../llms/registry.js";
import { buildChildEnvironment } from "../runtime/environment.js";
import { redactText } from "../runtime/redaction.js";
import { VERSION } from "../version.js";

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

export interface CollectDoctorOptions {
  environment?: NodeJS.ProcessEnv;
  locateKimiExecutable?: () => Promise<string>;
  locatePiExecutable?: () => Promise<string>;
  buildPiConfig?: () => Promise<IsolatedPiConfig>;
  runCommand?: (
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<CommandResult>;
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await execa(command, [...args], {
    env: environment,
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
    .filter(([name, value]) =>
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
    const entry = Object.entries(environment).find(
      ([key, value]) => key.toUpperCase() === name.toUpperCase() && value?.trim(),
    );
    if (entry !== undefined) return name;
  }
  return undefined;
}

function limitedDetail(value: string, secrets: readonly string[]): string {
  const redacted = redactText(value.trim(), secrets);
  return redacted.length <= 1_000
    ? redacted
    : `${redacted.slice(0, 1_000)}[TRUNCATED]`;
}

const EXPECTED_ARK_MODELS = new Map([
  ["ark-agent-plan", ["doubao-seed-2.0-pro", "glm-5.2"]],
  ["ark-coding-plan", ["ark-code-latest"]],
]);

async function validateArkPiConfig(config: IsolatedPiConfig): Promise<void> {
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
  if (JSON.stringify(Object.keys(providers).sort()) !== JSON.stringify([...EXPECTED_ARK_MODELS.keys()].sort())) {
    throw new Error("isolated Pi Ark provider set mismatch");
  }

  for (const [providerName, expectedModels] of EXPECTED_ARK_MODELS) {
    const provider = providers[providerName];
    const expectedBaseUrl =
      providerName === "ark-coding-plan"
        ? "https://ark.cn-beijing.volces.com/api/coding"
        : "https://ark.cn-beijing.volces.com/api/plan";
    const expectedKey =
      providerName === "ark-coding-plan"
        ? "$CODEX_AGENT_ARK_CODING_KEY"
        : "$CODEX_AGENT_ARK_AGENT_KEY";
    if (
      provider?.api !== "anthropic-messages" ||
      provider.apiKey !== expectedKey ||
      provider.baseUrl !== expectedBaseUrl
    ) {
      throw new Error(`isolated Pi ${providerName} endpoint or protocol mismatch`);
    }
    const actualModels = (provider.models ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
    if (JSON.stringify(actualModels) !== JSON.stringify([...expectedModels].sort())) {
      throw new Error(`isolated Pi ${providerName} model set mismatch`);
    }
  }
}

function validateArkModelListing(output: string): void {
  const listed = output
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([provider]) => EXPECTED_ARK_MODELS.has(provider ?? ""))
    .map(([provider, model]) => `${provider}/${model}`)
    .sort();
  const expected = [...EXPECTED_ARK_MODELS.entries()]
    .flatMap(([provider, models]) => models.map((model) => `${provider}/${model}`))
    .sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    throw new Error("Pi model listing does not match the approved Ark model set");
  }
}

export async function collectDoctorReport(
  options: CollectDoctorOptions = {},
): Promise<DoctorReport> {
  const environment = options.environment ?? process.env;
  const locateKimiExecutable = options.locateKimiExecutable ?? (() => locateKimi());
  const locatePiExecutable = options.locatePiExecutable ?? (() => locatePi());
  const buildPiConfig =
    options.buildPiConfig ??
    (() => buildIsolatedPiConfig({ version: VERSION, providers: ["ark"] }));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const secrets = secretValues(environment);
  const checks: DoctorCheck[] = [];

  let kimiExecutable: string | undefined;
  try {
    kimiExecutable = await locateKimiExecutable();
    checks.push({
      name: "Kimi executable",
      ok: true,
      level: "ok",
      detail: kimiExecutable,
    });
  } catch (error) {
    checks.push({
      name: "Kimi executable",
      ok: false,
      level: "error",
      detail: limitedDetail(
        error instanceof Error ? error.message : String(error),
        secrets,
      ),
    });
  }

  if (kimiExecutable !== undefined) {
    const [version, doctor] = await Promise.all([
      runCommand(kimiExecutable, ["--version"], environment),
      runCommand(kimiExecutable, ["doctor"], environment),
    ]);
    checks.push({
      name: "Kimi version",
      ok: version.ok,
      level: version.ok ? "ok" : "error",
      detail: limitedDetail(version.output || "version check failed", secrets),
    });
    checks.push({
      name: "Kimi authentication",
      ok: doctor.ok,
      level: doctor.ok ? "ok" : "error",
      detail: limitedDetail(doctor.output || "kimi doctor failed", secrets),
    });
  }

  let piExecutable: string | undefined;
  try {
    piExecutable = await locatePiExecutable();
    checks.push({
      name: "Pi executable",
      ok: true,
      level: "ok",
      detail: piExecutable,
    });
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

  if (piExecutable !== undefined) {
    const version = await runCommand(piExecutable, ["--version"], environment);
    checks.push({
      name: "Pi version",
      ok: version.ok,
      level: version.ok ? "ok" : "error",
      detail: limitedDetail(version.output || "version check failed", secrets),
    });
  }

  let piConfig: IsolatedPiConfig | undefined;
  try {
    piConfig = await buildPiConfig();
    checks.push({
      name: "Pi isolated config",
      ok: true,
      level: "ok",
      detail: `${piConfig.agentDir}; sha256=${piConfig.contentSha256.slice(0, 12)}`,
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

  if (piExecutable !== undefined && piConfig !== undefined) {
    try {
      await validateArkPiConfig(piConfig);
      const listEnvironment = {
        ...buildChildEnvironment(
          { network: "direct", credentialEnv: [] },
          environment,
        ),
        ...piConfig.environment,
        CODEX_AGENT_ARK_CODING_KEY: "doctor-config-check",
        CODEX_AGENT_ARK_AGENT_KEY: "doctor-config-check",
      };
      const listing = await runCommand(
        piExecutable,
        ["--offline", "--list-models", "ark"],
        listEnvironment,
      );
      if (!listing.ok) {
        throw new Error(listing.output || "Pi model listing failed");
      }
      validateArkModelListing(listing.output);
      checks.push({
        name: "Ark Pi models",
        ok: true,
        level: "ok",
        detail: `ark.cn-beijing.volces.com; models=3; sha256=${piConfig.contentSha256.slice(0, 12)}`,
      });
    } catch (error) {
      checks.push({
        name: "Ark Pi models",
        ok: false,
        level: "error",
        detail: limitedDetail(
          error instanceof Error ? error.message : String(error),
          secrets,
        ),
      });
    }
  }

  const gemini = resolveLlm("gemini-3.5-flash");
  const geminiCredential = selectedCredentialName(
    gemini.credentialEnv,
    environment,
  );
  checks.push({
    name: "Gemini authentication",
    ok: geminiCredential !== undefined,
    level: geminiCredential === undefined ? "error" : "ok",
    detail:
      geminiCredential === undefined
        ? `missing credential environment; checked ${gemini.credentialEnv.join(", ")}`
        : `credential environment: ${geminiCredential}`,
  });

  for (const [name, id] of [
    ["Ark Coding authentication", "ark-coding-plan"],
    ["Ark Agent authentication", "ark-agent-glm-5.2"],
  ] as const) {
    const profile = resolveLlm(id);
    const sourceName = selectedCredentialName(profile.credentialEnv, environment);
    const targetName = profile.credentialTargetEnv;
    checks.push({
      name,
      ok: sourceName !== undefined && targetName !== undefined,
      level:
        sourceName !== undefined && targetName !== undefined ? "ok" : "error",
      detail:
        sourceName === undefined || targetName === undefined
          ? `missing credential environment; checked ${profile.credentialEnv.join(", ")}`
          : `credential environment: ${sourceName} -> ${targetName}`,
    });
  }

  checks.push({
    name: "Public MCP tools",
    ok: true,
    level: "ok",
    detail: "external_review, external_delegate",
  });

  for (const id of supportedLlmIds()) {
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
