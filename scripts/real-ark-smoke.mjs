import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArkSmokeArguments, runArkSmoke } from "../dist/ark-smoke.js";
import { runSmokeEntrypoint } from "../dist/smoke-evidence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "Usage: npm run smoke:ark -- --llm <ark-logical-id> --task review|delegate\n",
  );
  process.exit(0);
}

process.exitCode = await runSmokeEntrypoint({
  kind: "ark",
  args,
  parseArguments: parseArkSmokeArguments,
  runSmoke: runArkSmoke,
  evidenceDirectory: path.join(root, "docs", "smoke", "evidence"),
});
