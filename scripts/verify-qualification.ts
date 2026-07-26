import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  QualificationVerificationMode,
  QualificationVerificationResult,
} from "../src/qualification/verifier.js";

const HELP = `Usage: npm run verify:qualification -- --mode frozen-candidate --manifest <batch-manifest>
       npm run verify:qualification -- --mode immutable-evidence --manifest <batch-manifest>
       npm run verify:qualification -- --help
`;
const DEFAULT_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export type QualificationVerifierCommand =
  | Readonly<{ kind: "help" }>
  | Readonly<{
      kind: "verify";
      mode: QualificationVerificationMode;
      manifestPath: string;
    }>;

function safeManifestPath(value: string): boolean {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return (
    segments.every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/u.test(segment),
    ) &&
    normalized.startsWith("docs/smoke/evidence/batches/") &&
    normalized.endsWith("/manifest.json")
  );
}

export function parseQualificationVerifierArguments(
  args: readonly string[],
): QualificationVerifierCommand {
  if (args.length === 1 && args[0] === "--help") {
    return Object.freeze({ kind: "help" });
  }
  if (
    args.length === 4 &&
    args[0] === "--mode" &&
    (args[1] === "frozen-candidate" || args[1] === "immutable-evidence") &&
    args[2] === "--manifest" &&
    typeof args[3] === "string" &&
    safeManifestPath(args[3])
  ) {
    return Object.freeze({
      kind: "verify",
      mode: args[1],
      manifestPath: args[3].replaceAll("\\", "/"),
    });
  }
  throw new Error("Invalid qualification verifier arguments");
}

async function verifyProduction(options: {
  repositoryRoot: string;
  manifestPath: string;
  mode: QualificationVerificationMode;
}): Promise<QualificationVerificationResult> {
  const [verifier, preflight] = await Promise.all([
    import("../src/qualification/verifier.js"),
    import("../src/qualification/preflight.js"),
  ]);
  return verifier.verifyQualification(options, {
    assertFrozenCandidate: (input) =>
      preflight.assertQualificationFrozenCandidate(input),
    collectCurrentCandidate: (repositoryRoot) =>
      preflight.collectQualificationCurrentSnapshot({ repositoryRoot }),
  });
}

export interface QualificationVerifierMainOptions {
  args?: readonly string[];
  repositoryRoot?: string;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  verify?: typeof verifyProduction;
}

function serializeVerificationResult(
  result: QualificationVerificationResult,
): string {
  return JSON.stringify({
    verified: result.verified,
    mode: result.mode,
    batchId: result.batchId,
    qualificationPlanId: result.qualificationPlanId,
    status: result.status,
    promotionEligible: result.promotionEligible,
  });
}

export async function main(
  options: QualificationVerifierMainOptions = {},
): Promise<number> {
  const writeStdout =
    options.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr =
    options.writeStderr ?? ((text: string) => process.stderr.write(text));
  let command: QualificationVerifierCommand;
  try {
    command = parseQualificationVerifierArguments(
      options.args ?? process.argv.slice(2),
    );
  } catch {
    writeStderr("Invalid qualification verifier arguments\n");
    return 1;
  }
  if (command.kind === "help") {
    writeStdout(HELP);
    return 0;
  }
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT,
  );
  try {
    const result = await (options.verify ?? verifyProduction)({
      repositoryRoot,
      manifestPath: path.resolve(repositoryRoot, command.manifestPath),
      mode: command.mode,
    });
    writeStdout(`${serializeVerificationResult(result)}\n`);
    return 0;
  } catch {
    writeStderr("Qualification verification failed\n");
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
