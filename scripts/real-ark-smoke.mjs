import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArkSmokeArguments, runArkSmoke } from "../dist/ark-smoke.js";
import {
  isDirectExecution,
  runRealSmokeMain,
} from "./real-smoke-main.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const productionConfig = Object.freeze({
  kind: "ark",
  usage:
    "Usage: npm run smoke:ark -- --llm <ark-logical-id> --task review|delegate\n",
  parseArguments: parseArkSmokeArguments,
  runSmoke: runArkSmoke,
  evidenceDirectory: path.join(root, "docs", "smoke", "evidence"),
});

export function main(options = {}) {
  return runRealSmokeMain(productionConfig, options);
}

if (isDirectExecution(import.meta.url)) {
  process.exitCode = await main();
}
