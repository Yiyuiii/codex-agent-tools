import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseKimiSmokeArguments,
  runKimiSmoke,
} from "../dist/kimi-smoke.js";
import { runSmokeEntrypoint } from "../dist/smoke-evidence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "Usage: npm run smoke:kimi -- --llm <logical-id> --task review|delegate\n",
  );
  process.exit(0);
}

process.exitCode = await runSmokeEntrypoint({
  kind: "kimi",
  args,
  parseArguments: parseKimiSmokeArguments,
  runSmoke: runKimiSmoke,
  evidenceDirectory: path.join(root, "docs", "smoke", "evidence"),
});
