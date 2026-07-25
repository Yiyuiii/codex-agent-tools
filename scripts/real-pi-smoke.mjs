import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePiSmokeArguments,
  runPiSmoke,
} from "../dist/pi-smoke.js";
import {
  isDirectExecution,
  runRealSmokeMain,
} from "./real-smoke-main.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const productionConfig = Object.freeze({
  kind: "pi",
  usage:
    "Usage: npm run smoke:pi -- --llm gemini-3.5-flash --task review|delegate\n",
  parseArguments: parsePiSmokeArguments,
  runSmoke: runPiSmoke,
  evidenceDirectory: path.join(root, "docs", "smoke", "evidence"),
});

export function main(options = {}) {
  return runRealSmokeMain(productionConfig, options);
}

if (isDirectExecution(import.meta.url)) {
  process.exitCode = await main();
}
