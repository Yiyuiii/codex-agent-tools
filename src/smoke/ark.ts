import { resolveLlm } from "../llms/registry.js";
import {
  runPiSmoke,
  type PiSmokeDependencies,
  type PiSmokeEvidence,
  type PiSmokeOptions,
  type PiSmokeTask,
} from "./pi.js";

const ARK_LLM_IDS = new Set([
  "ark-coding-plan",
  "ark-agent-plan",
  "ark-agent-deepseek-v4-flash",
]);

export function parseArkSmokeArguments(args: readonly string[]): {
  llm: string;
  task: PiSmokeTask;
} {
  let llm: string | undefined;
  let task: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--llm") {
      llm = args[index + 1];
      index += 1;
    } else if (argument === "--task") {
      task = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown Ark smoke argument: ${argument ?? ""}`);
    }
  }
  if (llm === undefined || llm.trim() === "") {
    throw new Error("Ark smoke requires --llm <logical-id>");
  }
  if (!ARK_LLM_IDS.has(llm)) {
    throw new Error(`Logical llm ${llm} is not an Ark Pi profile`);
  }
  const profile = resolveLlm(llm);
  if (profile.runtime !== "pi-rpc") {
    throw new Error(`Logical llm ${llm} is not an Ark Pi profile`);
  }
  if (task !== "review" && task !== "delegate") {
    throw new Error("Ark smoke requires --task review|delegate");
  }
  return { llm, task };
}

export async function runArkSmoke(
  options: PiSmokeOptions,
  dependencies: PiSmokeDependencies = {},
): Promise<PiSmokeEvidence> {
  if (!ARK_LLM_IDS.has(options.llm)) {
    throw new Error(`Logical llm ${options.llm} is not an Ark Pi profile`);
  }
  return runPiSmoke(options, dependencies);
}
