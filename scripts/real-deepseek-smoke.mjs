import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseDeepSeekSmokeArguments,
  runDeepSeekSmoke,
} from "../dist/deepseek-smoke.js";
import { isDirectExecution, runRealSmokeMain } from "./real-smoke-main.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const productionConfig = Object.freeze({
  // The shared entrypoint treats Ark and Direct DeepSeek as isolated Pi evidence;
  // the distinct kind also gives Direct DeepSeek evidence an unambiguous suffix.
  kind: "deepseek",
  usage:
    "Usage: npm run smoke:deepseek -- --llm deepseek-v4-flash --task review|delegate\n",
  parseArguments: parseDeepSeekSmokeArguments,
  runSmoke: runDeepSeekSmoke,
  evidenceDirectory: path.join(root, "docs", "smoke", "evidence"),
});

export function main(options = {}) {
  return runRealSmokeMain(productionConfig, options);
}

if (isDirectExecution(import.meta.url)) {
  process.exitCode = await main();
}
