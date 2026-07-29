import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  CapabilityIndexVerificationResult,
} from "../src/qualification/capability-index.js";

const HELP = "Usage: npm run verify:capabilities\n";
const DEFAULT_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export type CapabilityVerifierCommand =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "verify" }>;

export function parseCapabilityVerifierArguments(
  args: readonly string[],
): CapabilityVerifierCommand {
  if (args.length === 0) return Object.freeze({ kind: "verify" });
  if (args.length === 1 && args[0] === "--help") {
    return Object.freeze({ kind: "help" });
  }
  throw new Error("Invalid capability verifier arguments");
}

async function verifyProduction(options: {
  repositoryRoot: string;
}): Promise<CapabilityIndexVerificationResult> {
  const verifier = await import(
    "../src/qualification/capability-index.js"
  );
  return verifier.verifyCapabilityIndex(options);
}

export interface CapabilityVerifierMainOptions {
  args?: readonly string[];
  repositoryRoot?: string;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  verify?: typeof verifyProduction;
}

export async function main(
  options: CapabilityVerifierMainOptions = {},
): Promise<number> {
  const writeStdout =
    options.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr =
    options.writeStderr ?? ((text: string) => process.stderr.write(text));
  let command: CapabilityVerifierCommand;
  try {
    command = parseCapabilityVerifierArguments(
      options.args ?? process.argv.slice(2),
    );
  } catch {
    writeStderr("Invalid capability verifier arguments\n");
    return 1;
  }
  if (command.kind === "help") {
    writeStdout(HELP);
    return 0;
  }
  try {
    const result = await (options.verify ?? verifyProduction)({
      repositoryRoot: path.resolve(
        options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT,
      ),
    });
    writeStdout(
      `${JSON.stringify({
        verified: result.verified,
        indexPath: result.indexPath,
        entryCount: result.entryCount,
        legacyEntryCount: result.legacyEntryCount,
      })}\n`,
    );
    return 0;
  } catch {
    writeStderr("Capability qualification verification failed\n");
    return 1;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const left = pathToFileURL(path.resolve(entry)).href;
  const right = import.meta.url;
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

if (isDirectExecution()) {
  process.exitCode = await main();
}
