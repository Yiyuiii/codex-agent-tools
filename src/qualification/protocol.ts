import type { QualificationCaseIdentity } from "./types.js";
import { CAPABILITY_REFRESH_TARGETS } from "./capability-refresh-targets.js";

export const LEGACY_QUALIFICATION_PLAN_ID = "five-llm-v1" as const;
export const ACTIVE_QUALIFICATION_PLAN_ID = "four-llm-v1" as const;
export const DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID =
  "direct-deepseek-v1" as const;
export const CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID =
  "capability-refresh-v1" as const;

export type CurrentQualificationPlanId =
  | typeof ACTIVE_QUALIFICATION_PLAN_ID
  | typeof DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID
  | typeof CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID;

export type QualificationPlanId =
  | typeof LEGACY_QUALIFICATION_PLAN_ID
  | CurrentQualificationPlanId;

type FrozenSchedule<Cases extends readonly QualificationCaseIdentity[]> = {
  readonly [Index in keyof Cases]: Readonly<Cases[Index]>;
};

function frozenSchedule<
  const Cases extends readonly QualificationCaseIdentity[],
>(cases: Cases): FrozenSchedule<Cases> {
  const frozen = Object.freeze(
    cases.map((identity) => Object.freeze({ ...identity })),
  );
  return frozen as unknown as FrozenSchedule<Cases>;
}

export const LEGACY_QUALIFICATION_CASES = frozenSchedule([
  { ordinal: 1, llm: "gemini-3.5-flash", task: "delegate" },
  { ordinal: 2, llm: "gemini-3.5-flash", task: "review" },
  { ordinal: 3, llm: "ark-coding-plan", task: "delegate" },
  { ordinal: 4, llm: "ark-coding-plan", task: "review" },
  { ordinal: 5, llm: "kimi-k3", task: "review" },
  { ordinal: 6, llm: "kimi-k3", task: "delegate" },
  { ordinal: 7, llm: "ark-agent-plan", task: "review" },
  { ordinal: 8, llm: "ark-agent-plan", task: "delegate" },
  { ordinal: 9, llm: "ark-agent-deepseek-v4-flash", task: "review" },
  { ordinal: 10, llm: "ark-agent-deepseek-v4-flash", task: "delegate" },
]);

export const ACTIVE_QUALIFICATION_CASES = frozenSchedule([
  { ordinal: 1, llm: "ark-coding-plan", task: "delegate" },
  { ordinal: 2, llm: "ark-coding-plan", task: "review" },
  { ordinal: 3, llm: "kimi-k3", task: "review" },
  { ordinal: 4, llm: "kimi-k3", task: "delegate" },
  { ordinal: 5, llm: "ark-agent-plan", task: "review" },
  { ordinal: 6, llm: "ark-agent-plan", task: "delegate" },
  { ordinal: 7, llm: "ark-agent-deepseek-v4-flash", task: "review" },
  { ordinal: 8, llm: "ark-agent-deepseek-v4-flash", task: "delegate" },
]);

export const DIRECT_DEEPSEEK_QUALIFICATION_CASES = frozenSchedule([
  { ordinal: 1, llm: "deepseek-v4-flash", task: "review" },
  { ordinal: 2, llm: "deepseek-v4-flash", task: "delegate" },
]);

export const CAPABILITY_REFRESH_QUALIFICATION_CASES = frozenSchedule(
  CAPABILITY_REFRESH_TARGETS,
);

export function qualificationSchedule(
  planId: typeof LEGACY_QUALIFICATION_PLAN_ID,
): typeof LEGACY_QUALIFICATION_CASES;
export function qualificationSchedule(
  planId: typeof ACTIVE_QUALIFICATION_PLAN_ID,
): typeof ACTIVE_QUALIFICATION_CASES;
export function qualificationSchedule(
  planId: typeof DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
): typeof DIRECT_DEEPSEEK_QUALIFICATION_CASES;
export function qualificationSchedule(
  planId: typeof CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID,
): typeof CAPABILITY_REFRESH_QUALIFICATION_CASES;
export function qualificationSchedule(
  planId: QualificationPlanId,
):
  | typeof LEGACY_QUALIFICATION_CASES
  | typeof ACTIVE_QUALIFICATION_CASES
  | typeof DIRECT_DEEPSEEK_QUALIFICATION_CASES
  | typeof CAPABILITY_REFRESH_QUALIFICATION_CASES;
export function qualificationSchedule(
  planId: QualificationPlanId,
):
  | typeof LEGACY_QUALIFICATION_CASES
  | typeof ACTIVE_QUALIFICATION_CASES
  | typeof DIRECT_DEEPSEEK_QUALIFICATION_CASES
  | typeof CAPABILITY_REFRESH_QUALIFICATION_CASES {
  if (planId === LEGACY_QUALIFICATION_PLAN_ID) {
    return LEGACY_QUALIFICATION_CASES;
  }
  if (planId === ACTIVE_QUALIFICATION_PLAN_ID) {
    return ACTIVE_QUALIFICATION_CASES;
  }
  if (planId === DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID) {
    return DIRECT_DEEPSEEK_QUALIFICATION_CASES;
  }
  if (planId === CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID) {
    return CAPABILITY_REFRESH_QUALIFICATION_CASES;
  }
  throw new Error(`Unknown qualification plan: ${String(planId)}`);
}

export function qualificationPlanForEnvelope(
  schemaVersion: unknown,
  recordedPlanId: unknown,
): QualificationPlanId {
  if (schemaVersion === 1 && recordedPlanId === undefined) {
    return LEGACY_QUALIFICATION_PLAN_ID;
  }
  if (
    schemaVersion === 2 &&
    recordedPlanId === ACTIVE_QUALIFICATION_PLAN_ID
  ) {
    return ACTIVE_QUALIFICATION_PLAN_ID;
  }
  if (
    schemaVersion === 3 &&
    (recordedPlanId === ACTIVE_QUALIFICATION_PLAN_ID ||
      recordedPlanId === DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID ||
      recordedPlanId === CAPABILITY_REFRESH_QUALIFICATION_PLAN_ID)
  ) {
    return recordedPlanId;
  }
  throw new Error("Qualification schema and plan identity do not match");
}
