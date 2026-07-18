import { describe, expect, it } from "vitest";

import {
  createLlmRegistry,
  resolveLlm,
  supportedLlmIds,
} from "../../src/llms/registry.js";

describe("logical LLM registry", () => {
  it("binds each public Kimi id to one backend and direct route", () => {
    expect(resolveLlm("kimi-k3")).toMatchObject({
      runtime: "kimi-acp",
      model: "kimi-code/k3",
      network: "direct",
    });
    expect(resolveLlm("kimi-k2.7")).toMatchObject({
      runtime: "kimi-acp",
      model: "kimi-code/kimi-for-coding",
      network: "direct",
    });
    expect(resolveLlm("kimi-k2.7-highspeed")).toMatchObject({
      runtime: "kimi-acp",
      model: "kimi-code/kimi-for-coding-highspeed",
      network: "direct",
    });
    expect(supportedLlmIds()).toEqual([
      "gemini-3.5-flash",
      "kimi-k2.7",
      "kimi-k2.7-highspeed",
      "kimi-k3",
    ]);
  });

  it("binds qualified Gemini tasks to Pi Google, direct routing, and ordered credentials", () => {
    expect(resolveLlm("gemini-3.5-flash")).toMatchObject({
      runtime: "pi-rpc",
      provider: "google",
      model: "gemini-3.5-flash",
      network: "direct",
      credentialEnv: [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
      ],
      maxConcurrency: 2,
      capabilities: { review: true, delegate: true },
      qualityGates: {
        review: {
          status: "passed",
          evidence: "docs/smoke/pi-gemini.md#gemini-review",
        },
        delegate: {
          status: "passed",
          evidence: "docs/smoke/pi-gemini.md#gemini-delegate",
        },
      },
    });
    expect(resolveLlm("gemini-3.5-flash", "review").model).toBe(
      "gemini-3.5-flash",
    );
    expect(resolveLlm("gemini-3.5-flash", "delegate").provider).toBe(
      "google",
    );
  });

  it.each(["claude-opus", "codex", "deepseek"])(
    "does not register excluded source %s",
    (id) => {
      expect(() => resolveLlm(id)).toThrow(
        /Supported llms: gemini-3\.5-flash, kimi-k2\.7, kimi-k2\.7-highspeed, kimi-k3/,
      );
    },
  );

  it.each([
    ["kimi-k2.7", "review", "kimi-k27-review"],
    ["kimi-k2.7", "delegate", "kimi-k27-delegate"],
    ["kimi-k2.7-highspeed", "review", "kimi-k27-highspeed-review"],
    ["kimi-k2.7-highspeed", "delegate", "kimi-k27-highspeed-delegate"],
    ["kimi-k3", "review", "kimi-k3-review"],
    ["kimi-k3", "delegate", "kimi-k3-delegate"],
  ] as const)(
    "enables %s %s only with its real-smoke evidence",
    (id, task, anchor) => {
      const profile = resolveLlm(id, task);
      expect(profile.capabilities[task]).toBe(true);
      expect(profile.qualityGates[task]).toEqual({
        status: "passed",
        evidence: `docs/smoke/kimi.md#${anchor}`,
      });
    },
  );

  it("still rejects any task whose independent gate is pending", () => {
    const base = resolveLlm("kimi-k3");

    const registry = createLlmRegistry([
      {
        ...base,
        capabilities: { review: true, delegate: false },
        qualityGates: {
          review: base.qualityGates.review,
          delegate: { status: "pending" },
        },
      },
    ]);

    expect(registry.resolve("kimi-k3", "review").model).toBe("kimi-code/k3");
    expect(() => registry.resolve("kimi-k3", "delegate")).toThrow(
      /disabled pending real smoke/,
    );
  });

  it("rejects duplicate logical ids", () => {
    const profile = resolveLlm("kimi-k3");
    expect(() => createLlmRegistry([profile, profile])).toThrow(
      /Duplicate logical llm id: kimi-k3/,
    );
  });
});
