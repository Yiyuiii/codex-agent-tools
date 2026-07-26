import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  normalizeSmokeQualificationContext,
  runSmokeEntrypoint,
} from "../dist/smoke-evidence.js";

export function isDirectExecution(
  moduleUrl,
  entryPath = process.argv[1],
) {
  if (entryPath === undefined) return false;
  const entryUrl = pathToFileURL(path.resolve(entryPath)).href;
  return process.platform === "win32"
    ? entryUrl.toLowerCase() === moduleUrl.toLowerCase()
    : entryUrl === moduleUrl;
}

export async function runRealSmokeMain(config, options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const writeStdout =
    options.writeStdout ?? ((text) => process.stdout.write(text));
  const writeStderr =
    options.writeStderr ?? ((text) => process.stderr.write(text));
  if (args.includes("--help") || args.includes("-h")) {
    writeStdout(config.usage);
    return 0;
  }

  let qualificationContext = options.qualificationContext;
  try {
    const normalized = normalizeSmokeQualificationContext(
      qualificationContext,
    );
    qualificationContext = normalized;
    if (
      normalized !== null &&
      options.evidenceDirectory === undefined
    ) {
      writeStderr(
        "Smoke qualification evidence directory is required.\n",
      );
      return 1;
    }
  } catch {
    // The shared entrypoint emits the fixed invalid-context failure.
  }

  return runSmokeEntrypoint({
    kind: config.kind,
    args,
    parseArguments: config.parseArguments,
    runSmoke: options.runSmoke ?? config.runSmoke,
    evidenceDirectory:
      options.evidenceDirectory ?? config.evidenceDirectory,
    qualificationContext,
    now: options.now,
    writeStdout,
    writeStderr,
  });
}
