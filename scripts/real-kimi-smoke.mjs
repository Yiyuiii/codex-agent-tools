import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseKimiSmokeArguments,
  runKimiSmoke,
} from "../dist/kimi-smoke.js";
import {
  isDirectExecution,
  runRealSmokeMain,
} from "./real-smoke-main.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const productionConfig = Object.freeze({
  kind: "kimi",
  usage:
    "Usage: npm run smoke:kimi -- --llm <logical-id> --task review|delegate\n",
  parseArguments: parseKimiSmokeArguments,
  runSmoke: runKimiSmoke,
  evidenceDirectory: path.join(root, "docs", "smoke", "evidence"),
});

export function main(options = {}) {
  return runRealSmokeMain(productionConfig, options);
}

if (isDirectExecution(import.meta.url)) {
  process.exitCode = await main();
}
