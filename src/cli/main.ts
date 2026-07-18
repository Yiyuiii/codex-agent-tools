#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Command } from "commander";

import { VERSION } from "../version.js";
import {
  getDefaultCodexConfigPath,
  installCodexConfig,
  uninstallCodexConfig,
} from "./config.js";
import { collectDoctorReport } from "./doctor.js";

export interface InstallCommandOptions {
  configPath?: string;
}

export interface DoctorCommandOptions {
  configPath?: string;
  json?: boolean;
  strict?: boolean;
}

export interface CreateProgramDependencies {
  install?: (options: InstallCommandOptions) => Promise<void>;
  uninstall?: (options: InstallCommandOptions) => Promise<void>;
  doctor?: (options: DoctorCommandOptions) => Promise<void>;
}

function bundledMcpPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp.js");
}

async function runInstall(options: InstallCommandOptions): Promise<void> {
  const configPath = options.configPath ?? getDefaultCodexConfigPath();
  const result = await installCodexConfig(configPath, {
    nodePath: process.execPath,
    mcpPath: bundledMcpPath(),
  });
  process.stdout.write(
    `${result.changed ? "installed" : "already installed"}: ${result.configPath}\n`,
  );
}

async function runUninstall(options: InstallCommandOptions): Promise<void> {
  const configPath = options.configPath ?? getDefaultCodexConfigPath();
  const result = await uninstallCodexConfig(configPath);
  process.stdout.write(
    `${result.changed ? "uninstalled" : "not installed"}: ${result.configPath}\n`,
  );
}

async function runDoctor(options: DoctorCommandOptions): Promise<void> {
  const report = await collectDoctorReport(
    options.configPath === undefined ? {} : { configPath: options.configPath },
  );
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("codex-agent-tools doctor\n\n");
    for (const check of report.checks) {
      const marker = check.level === "ok" ? "[ok]" : check.level === "warn" ? "[warn]" : "[!!]";
      process.stdout.write(`${marker} ${check.name}: ${check.detail}\n`);
    }
  }
  if (options.strict === true && !report.ok) process.exitCode = 1;
}

export function createProgram(
  dependencies: CreateProgramDependencies = {},
): Command {
  const program = new Command();
  const install = dependencies.install ?? runInstall;
  const uninstall = dependencies.uninstall ?? runUninstall;
  const doctor = dependencies.doctor ?? runDoctor;

  program
    .name("codex-agent-tools")
    .description("External LLM review and delegation tools for Codex.")
    .version(VERSION);

  program
    .command("install")
    .description("Install the managed codex_external_agents MCP registration.")
    .option("--config <path>", "Codex config path; defaults to ~/.codex/config.toml.")
    .action(async (options: { config?: string }) => {
      await install(
        options.config === undefined ? {} : { configPath: options.config },
      );
    });

  program
    .command("uninstall")
    .description("Remove only the managed codex_external_agents MCP registration.")
    .option("--config <path>", "Codex config path; defaults to ~/.codex/config.toml.")
    .action(async (options: { config?: string }) => {
      await uninstall(
        options.config === undefined ? {} : { configPath: options.config },
      );
    });

  program
    .command("doctor")
    .description("Check Kimi, MCP ownership, routes, and logical LLM gates.")
    .option("--config <path>", "Codex config path; defaults to ~/.codex/config.toml.")
    .option("--json", "Print machine-readable JSON.")
    .option("--strict", "Exit non-zero when an error diagnostic is present.")
    .action(async (options: { config?: string; json?: boolean; strict?: boolean }) => {
      const commandOptions: DoctorCommandOptions = {};
      if (options.config !== undefined) commandOptions.configPath = options.config;
      if (options.json !== undefined) commandOptions.json = options.json;
      if (options.strict !== undefined) commandOptions.strict = options.strict;
      await doctor(commandOptions);
    });

  return program;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  createProgram().parseAsync(process.argv).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
