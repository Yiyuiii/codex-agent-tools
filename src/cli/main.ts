#!/usr/bin/env node
import { Command } from "commander";

import { VERSION } from "../version.js";
import { isMainModule } from "../runtime/main-module.js";
import { collectDoctorReport } from "./doctor.js";

export interface DoctorCommandOptions {
  json?: boolean;
  strict?: boolean;
}

export interface CreateProgramDependencies {
  doctor?: (options: DoctorCommandOptions) => Promise<void>;
}

async function runDoctor(options: DoctorCommandOptions): Promise<void> {
  const report = await collectDoctorReport();
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
  const doctor = dependencies.doctor ?? runDoctor;

  program
    .name("codex-agent-tools")
    .description("External LLM review and delegation tools for Codex.")
    .version(VERSION);

  program
    .command("doctor")
    .description(
      "Check external runtimes, routes, credentials, artifacts, and logical LLM gates.",
    )
    .option("--json", "Print machine-readable JSON.")
    .option("--strict", "Exit non-zero when an error diagnostic is present.")
    .action(async (options: { json?: boolean; strict?: boolean }) => {
      const commandOptions: DoctorCommandOptions = {};
      if (options.json !== undefined) commandOptions.json = options.json;
      if (options.strict !== undefined) commandOptions.strict = options.strict;
      await doctor(commandOptions);
    });

  return program;
}

if (isMainModule(import.meta.url)) {
  createProgram().parseAsync(process.argv).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
