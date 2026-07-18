import { describe, expect, it } from "vitest";

import {
  externalDelegateInputSchema,
  externalReviewInputSchema,
} from "../../src/tasks/schemas.js";

describe("public input schemas", () => {
  it("requires llm for both tools", () => {
    expect(
      externalReviewInputSchema.safeParse({
        task: "review_diff",
        prompt: "Review the diff",
        cwd: process.cwd(),
      }).success,
    ).toBe(false);
    expect(
      externalDelegateInputSchema.safeParse({
        prompt: "Implement the change",
        cwd: process.cwd(),
      }).success,
    ).toBe(false);
  });

  it("requires an absolute existing directory", () => {
    expect(
      externalDelegateInputSchema.safeParse({
        llm: "kimi-k3",
        prompt: "x",
        cwd: ".",
      }).success,
    ).toBe(false);
    expect(
      externalDelegateInputSchema.safeParse({
        llm: "kimi-k3",
        prompt: "x",
        cwd: `${process.cwd()}-does-not-exist`,
      }).success,
    ).toBe(false);
  });

  it.each(["backend", "provider", "model", "tools", "effort", "proxy"])(
    "rejects caller override %s",
    (field) => {
      const result = externalDelegateInputSchema.safeParse({
        llm: "kimi-k3",
        prompt: "x",
        cwd: process.cwd(),
        [field]: "forbidden",
      });
      expect(result.success).toBe(false);
    },
  );

  it("accepts the approved review shape and rejects unknown review tasks", () => {
    expect(
      externalReviewInputSchema.safeParse({
        llm: "kimi-k3",
        task: "adversarial_review",
        prompt: "Challenge this plan",
        cwd: process.cwd(),
        includeGitDiff: true,
        includeUntracked: true,
        context: "Focus on lifecycle risks",
        acceptanceCriteria: ["No orphan process"],
        timeoutMs: 60_000,
      }).success,
    ).toBe(true);
    expect(
      externalReviewInputSchema.safeParse({
        llm: "kimi-k3",
        task: "research",
        prompt: "x",
        cwd: process.cwd(),
      }).success,
    ).toBe(false);
  });

  it("accepts an optional delegate session id and enforces the global timeout range", () => {
    expect(
      externalDelegateInputSchema.safeParse({
        llm: "kimi-k3",
        prompt: "Continue",
        cwd: process.cwd(),
        sessionId: "session-1",
        timeoutMs: 900_000,
      }).success,
    ).toBe(true);
    expect(
      externalDelegateInputSchema.safeParse({
        llm: "kimi-k3",
        prompt: "Continue",
        cwd: process.cwd(),
        timeoutMs: 999,
      }).success,
    ).toBe(false);
  });
});
