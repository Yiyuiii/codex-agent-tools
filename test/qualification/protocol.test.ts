import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ACTIVE_QUALIFICATION_CASES,
  ACTIVE_QUALIFICATION_PLAN_ID,
  DIRECT_DEEPSEEK_QUALIFICATION_CASES,
  DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
  LEGACY_QUALIFICATION_CASES,
  LEGACY_QUALIFICATION_PLAN_ID,
  qualificationPlanForEnvelope,
  qualificationSchedule,
  type QualificationPlanId,
} from "../../src/qualification/protocol.js";

type DeepReadonly<T> = {
  readonly [Key in keyof T]: T[Key] extends object
    ? DeepReadonly<T[Key]>
    : T[Key];
};

type TypeEqual<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <
  Value,
>() => Value extends Right ? 1 : 2
  ? (<Value>() => Value extends Right ? 1 : 2) extends <
      Value,
    >() => Value extends Left ? 1 : 2
    ? true
    : false
  : false;

describe("qualification protocol", () => {
  it("freezes the historical ten-case schedule", () => {
    expect(LEGACY_QUALIFICATION_PLAN_ID).toBe("five-llm-v1");
    expect(LEGACY_QUALIFICATION_CASES).toHaveLength(10);
    expect(LEGACY_QUALIFICATION_CASES).toEqual([
      { ordinal: 1, llm: "gemini-3.5-flash", task: "delegate" },
      { ordinal: 2, llm: "gemini-3.5-flash", task: "review" },
      { ordinal: 3, llm: "ark-coding-plan", task: "delegate" },
      { ordinal: 4, llm: "ark-coding-plan", task: "review" },
      { ordinal: 5, llm: "kimi-k3", task: "review" },
      { ordinal: 6, llm: "kimi-k3", task: "delegate" },
      { ordinal: 7, llm: "ark-agent-plan", task: "review" },
      { ordinal: 8, llm: "ark-agent-plan", task: "delegate" },
      {
        ordinal: 9,
        llm: "ark-agent-deepseek-v4-flash",
        task: "review",
      },
      {
        ordinal: 10,
        llm: "ark-agent-deepseek-v4-flash",
        task: "delegate",
      },
    ]);
  });

  it("fixes the active eight-case risk-first schedule", () => {
    expect(ACTIVE_QUALIFICATION_PLAN_ID).toBe("four-llm-v1");
    expect(ACTIVE_QUALIFICATION_CASES).toEqual([
      { ordinal: 1, llm: "ark-coding-plan", task: "delegate" },
      { ordinal: 2, llm: "ark-coding-plan", task: "review" },
      { ordinal: 3, llm: "kimi-k3", task: "review" },
      { ordinal: 4, llm: "kimi-k3", task: "delegate" },
      { ordinal: 5, llm: "ark-agent-plan", task: "review" },
      { ordinal: 6, llm: "ark-agent-plan", task: "delegate" },
      {
        ordinal: 7,
        llm: "ark-agent-deepseek-v4-flash",
        task: "review",
      },
      {
        ordinal: 8,
        llm: "ark-agent-deepseek-v4-flash",
        task: "delegate",
      },
    ]);
  });

  it("freezes the isolated Direct DeepSeek schedule", () => {
    expect(DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID).toBe(
      "direct-deepseek-v1",
    );
    expect(DIRECT_DEEPSEEK_QUALIFICATION_CASES).toEqual([
      { ordinal: 1, llm: "deepseek-v4-flash", task: "review" },
      { ordinal: 2, llm: "deepseek-v4-flash", task: "delegate" },
    ]);
  });

  it("dispatches envelopes without guessing a plan", () => {
    expect(qualificationPlanForEnvelope(1, undefined)).toBe(
      LEGACY_QUALIFICATION_PLAN_ID,
    );
    expect(
      qualificationPlanForEnvelope(2, ACTIVE_QUALIFICATION_PLAN_ID),
    ).toBe(ACTIVE_QUALIFICATION_PLAN_ID);
    expect(
      qualificationPlanForEnvelope(3, ACTIVE_QUALIFICATION_PLAN_ID),
    ).toBe(ACTIVE_QUALIFICATION_PLAN_ID);
    expect(
      qualificationPlanForEnvelope(
        3,
        DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
      ),
    ).toBe(DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID);
    expect(() => qualificationPlanForEnvelope(1, "four-llm-v1")).toThrow();
    expect(() => qualificationPlanForEnvelope(2, undefined)).toThrow();
    expect(() => qualificationPlanForEnvelope(2, "five-llm-v1")).toThrow();
    expect(() =>
      qualificationPlanForEnvelope(
        2,
        DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
      ),
    ).toThrow();
    expect(() => qualificationPlanForEnvelope(3, undefined)).toThrow();
    expect(() => qualificationPlanForEnvelope(3, "five-llm-v1")).toThrow();
    expect(() => qualificationPlanForEnvelope(4, "four-llm-v1")).toThrow();
  });

  it("returns frozen schedules without exposing mutable identities", () => {
    const schedule = qualificationSchedule(
      DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
    );

    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(schedule[0])).toBe(true);
  });

  it("preserves exact deeply readonly active case identities", () => {
    type ActiveCase = (typeof ACTIVE_QUALIFICATION_CASES)[number];
    type DirectDeepSeekCase =
      (typeof DIRECT_DEEPSEEK_QUALIFICATION_CASES)[number];
    type LegacyCase = (typeof LEGACY_QUALIFICATION_CASES)[number];

    expectTypeOf<ActiveCase["llm"]>().toEqualTypeOf<
      | "ark-coding-plan"
      | "kimi-k3"
      | "ark-agent-plan"
      | "ark-agent-deepseek-v4-flash"
    >();
    expectTypeOf<
      TypeEqual<ActiveCase, DeepReadonly<ActiveCase>>
    >().toEqualTypeOf<true>();
    expectTypeOf<DirectDeepSeekCase["llm"]>().toEqualTypeOf<
      "deepseek-v4-flash"
    >();
    expectTypeOf<
      TypeEqual<DirectDeepSeekCase, DeepReadonly<DirectDeepSeekCase>>
    >().toEqualTypeOf<true>();
    expectTypeOf<LegacyCase["llm"]>().toEqualTypeOf<
      | "gemini-3.5-flash"
      | "ark-coding-plan"
      | "kimi-k3"
      | "ark-agent-plan"
      | "ark-agent-deepseek-v4-flash"
    >();
    expectTypeOf<
      TypeEqual<LegacyCase, DeepReadonly<LegacyCase>>
    >().toEqualTypeOf<true>();
  });

  it("selects the exact deeply readonly tuple for each plan", () => {
    const activeSchedule = qualificationSchedule(
      ACTIVE_QUALIFICATION_PLAN_ID,
    );
    const legacySchedule = qualificationSchedule(
      LEGACY_QUALIFICATION_PLAN_ID,
    );
    const directDeepSeekSchedule = qualificationSchedule(
      DIRECT_DEEPSEEK_QUALIFICATION_PLAN_ID,
    );
    type ActiveSelectedCase = (typeof activeSchedule)[number];
    type LegacySelectedCase = (typeof legacySchedule)[number];

    expectTypeOf(activeSchedule).toEqualTypeOf<
      typeof ACTIVE_QUALIFICATION_CASES
    >();
    expectTypeOf(legacySchedule).toEqualTypeOf<
      typeof LEGACY_QUALIFICATION_CASES
    >();
    expectTypeOf(directDeepSeekSchedule).toEqualTypeOf<
      typeof DIRECT_DEEPSEEK_QUALIFICATION_CASES
    >();
    expectTypeOf<
      TypeEqual<ActiveSelectedCase, DeepReadonly<ActiveSelectedCase>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypeEqual<LegacySelectedCase, DeepReadonly<LegacySelectedCase>>
    >().toEqualTypeOf<true>();
  });

  it("returns a safe schedule union for a union plan input", () => {
    const selectSchedule = (planId: QualificationPlanId) =>
      qualificationSchedule(planId);

    expectTypeOf<ReturnType<typeof selectSchedule>>().toEqualTypeOf<
      | typeof ACTIVE_QUALIFICATION_CASES
      | typeof DIRECT_DEEPSEEK_QUALIFICATION_CASES
      | typeof LEGACY_QUALIFICATION_CASES
    >();
  });
});
