import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArkSmokeArguments, runArkSmoke } from "../dist/ark-smoke.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "Usage: npm run smoke:ark -- --llm <ark-logical-id> --task review|delegate\n",
  );
  process.exit(0);
}

try {
  const options = parseArkSmokeArguments(args);
  const evidence = await runArkSmoke({
    ...options,
    onProgress: (message) => process.stderr.write(`[ark smoke] ${message}\n`),
  });
  const evidenceDirectory = path.join(root, "docs", "smoke", "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const timestamp = evidence.timestamp.replaceAll(":", "-");
  const fileName = `${timestamp}-${evidence.llm}-${evidence.task}-ark.json`;
  const evidencePath = path.join(evidenceDirectory, fileName);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ evidence: `docs/smoke/evidence/${fileName}`, ...evidence }, null, 2)}\n`,
  );
  if (!evidence.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
