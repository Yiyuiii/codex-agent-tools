import { readFile } from "node:fs/promises";

import { execa } from "execa";

import { locateKimi } from "../adapters/kimi/locator.js";
import { resolveLlm, supportedLlmIds } from "../llms/registry.js";
import { redactText } from "../runtime/redaction.js";
import { getDefaultCodexConfigPath, hasManagedCodexConfig } from "./config.js";

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
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  locateKimiExecutable?: () => Promise<string>;
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

async function readConfig(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function secretValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([name, value]) =>
      /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/iu.test(name) && Boolean(value),
    )
    .map(([, value]) => value!)
    .filter((value) => value.trim() !== "");
}

function limitedDetail(value: string, secrets: readonly string[]): string {
  const redacted = redactText(value.trim(), secrets);
  return redacted.length <= 1_000
    ? redacted
    : `${redacted.slice(0, 1_000)}[TRUNCATED]`;
}

export async function collectDoctorReport(
  options: CollectDoctorOptions = {},
): Promise<DoctorReport> {
  const environment = options.environment ?? process.env;
  const configPath = options.configPath ?? getDefaultCodexConfigPath();
  const locateKimiExecutable = options.locateKimiExecutable ?? (() => locateKimi());
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

  const configText = await readConfig(configPath);
  const registered = hasManagedCodexConfig(configText);
  checks.push({
    name: "MCP registration",
    ok: registered,
    level: registered ? "ok" : "warn",
    detail: registered
      ? `managed codex_external_agents registration at ${configPath}`
      : `not installed at ${configPath}; run codex-agent-tools install`,
  });
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
