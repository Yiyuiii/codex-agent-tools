import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePiSmokeArguments,
  runPiSmoke,
} from "../dist/pi-smoke.js";
import { runSmokeEntrypoint } from "../dist/smoke-evidence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "Usage: npm run smoke:pi -- --llm gemini-3.5-flash --task review|delegate\n",
  );
  process.exit(0);
}

process.exitCode = await runSmokeEntrypoint({
  kind: "pi",
  args,
  parseArguments: parsePiSmokeArguments,
  runSmoke: runPiSmoke,
  evidenceDirectory: path.join(root, "docs", "smoke", "evidence"),
});
