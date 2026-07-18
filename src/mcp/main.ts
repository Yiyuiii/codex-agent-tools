#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serveMcp } from "./server.js";

export function mcpUsage(): string {
  return [
    "codex-external-agents-mcp - codex_external_agents stdio MCP server",
    "",
    "Tools: external_review, external_delegate",
    "Transport: stdio",
  ].join("\n");
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${mcpUsage()}\n`);
    return;
  }
  if (args.length > 0) {
    throw new Error(`Unknown MCP argument: ${args[0]}`);
  }
  await serveMcp();
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
