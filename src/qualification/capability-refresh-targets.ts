import type { QualificationCaseIdentity } from "./types.js";

// Generated eligibility metadata for capability-refresh-v1. This list decides
// which already-stale cases are collected; it does not change any case's
// runtime, model binding, prompt, or acceptance contract.
export const CAPABILITY_REFRESH_TARGETS = Object.freeze([
  Object.freeze({ ordinal: 1, llm: "ark-coding-plan", task: "review" }),
  Object.freeze({ ordinal: 2, llm: "kimi-k3", task: "review" }),
  Object.freeze({ ordinal: 3, llm: "kimi-k3", task: "delegate" }),
  Object.freeze({ ordinal: 4, llm: "ark-agent-plan", task: "review" }),
  Object.freeze({ ordinal: 5, llm: "ark-agent-plan", task: "delegate" }),
  Object.freeze({
    ordinal: 6,
    llm: "ark-agent-deepseek-v4-flash",
    task: "review",
  }),
  Object.freeze({
    ordinal: 7,
    llm: "ark-agent-deepseek-v4-flash",
    task: "delegate",
  }),
] as const satisfies readonly QualificationCaseIdentity[]);
