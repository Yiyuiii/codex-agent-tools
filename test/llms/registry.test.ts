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
      "kimi-k2.7",
      "kimi-k2.7-highspeed",
      "kimi-k3",
    ]);
  });

  it.each(["claude-opus", "codex", "deepseek"])(
    "does not register excluded source %s",
    (id) => {
      expect(() => resolveLlm(id)).toThrow(
        /Supported llms: kimi-k2\.7, kimi-k2\.7-highspeed, kimi-k3/,
      );
    },
  );

  it("keeps tasks disabled until their independent real smoke passes", () => {
    expect(() => resolveLlm("kimi-k3", "review")).toThrow(
      /disabled pending real smoke/,
    );

    const registry = createLlmRegistry([
      {
        ...resolveLlm("kimi-k3"),
        capabilities: { review: true, delegate: false },
        qualityGates: {
          review: { status: "passed", evidence: "docs/smoke/kimi.md#k3-review" },
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
