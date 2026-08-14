import { resolveLlm } from "../llms/registry.js";
import {
  runPiSmoke,
  type PiSmokeDependencies,
  type PiSmokeEvidence,
  type PiSmokeOptions,
  type PiSmokeTask,
} from "./pi.js";

const DEEPSEEK_LLM_ID = "deepseek-v4-flash";

export function parseDeepSeekSmokeArguments(args: readonly string[]): {
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
      throw new Error(`Unknown DeepSeek smoke argument: ${argument ?? ""}`);
    }
  }
  if (llm === undefined || llm.trim() === "") {
    throw new Error("DeepSeek smoke requires --llm <logical-id>");
  }
  if (llm !== DEEPSEEK_LLM_ID) {
    throw new Error(
      `Logical llm ${llm} is not the direct DeepSeek Pi profile`,
    );
  }
  const profile = resolveLlm(llm);
  if (profile.runtime !== "pi-rpc" || profile.provider !== "deepseek") {
    throw new Error(
      `Logical llm ${llm} is not the direct DeepSeek Pi profile`,
    );
  }
  if (task !== "review" && task !== "delegate") {
    throw new Error("DeepSeek smoke requires --task review|delegate");
  }
  return { llm, task };
}

export async function runDeepSeekSmoke(
  options: PiSmokeOptions,
  dependencies: PiSmokeDependencies = {},
): Promise<PiSmokeEvidence> {
  if (options.llm !== DEEPSEEK_LLM_ID) {
    throw new Error(
      `Logical llm ${options.llm} is not the direct DeepSeek Pi profile`,
    );
  }
  return runPiSmoke(options, dependencies);
}
