import path from "node:path";
import { pathToFileURL } from "node:url";

import { runSmokeEntrypoint } from "../dist/smoke-evidence.js";

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
  if (args.includes("--help") || args.includes("-h")) {
    writeStdout(config.usage);
    return 0;
  }

  return runSmokeEntrypoint({
    kind: config.kind,
    args,
    parseArguments: config.parseArguments,
    runSmoke: options.runSmoke ?? config.runSmoke,
    evidenceDirectory:
      options.evidenceDirectory ?? config.evidenceDirectory,
    now: options.now,
    writeStdout,
    writeStderr: options.writeStderr,
  });
}
