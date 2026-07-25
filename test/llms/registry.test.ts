import { describe, expect, it } from "vitest";

import {
  credentialEnvironmentNames,
  createLlmRegistry,
  resolveLlm,
  supportedLlmIds,
} from "../../src/llms/registry.js";

describe("logical LLM registry", () => {
  it("exposes exactly the five approved logical LLMs", () => {
    expect(resolveLlm("kimi-k3")).toMatchObject({
      runtime: "kimi-acp",
      model: "kimi-code/k3",
      network: "direct",
    });
    expect(supportedLlmIds()).toEqual([
      "ark-agent-deepseek-v4-flash",
      "ark-agent-plan",
      "ark-coding-plan",
      "gemini-3.5-flash",
      "kimi-k3",
    ]);
  });

  it("keeps the qualified Ark Coding Plan route and evidence", () => {
    const profile = resolveLlm("ark-coding-plan");
    expect(profile).toMatchObject({
      runtime: "pi-rpc",
      provider: "ark-coding-plan",
      model: "ark-code-latest",
      network: "direct",
      credentialEnv: [
        "ARK_API_KEY",
        "VOLCENGINE_API_KEY",
        "API_KEY_DOUBAO_CODING",
      ],
      credentialTargetEnv: "CODEX_AGENT_ARK_CODING_KEY",
      concurrencyKey: "ark-coding-plan",
      timeoutMs: 900_000,
      maxConcurrency: 1,
      capabilities: { review: true, delegate: true },
      qualityGates: {
        review: {
          status: "passed",
          evidence: "docs/smoke/ark.md#ark-coding-plan-review",
        },
        delegate: {
          status: "passed",
          evidence: "docs/smoke/ark.md#ark-coding-plan-delegate",
        },
      },
    });
    expect(resolveLlm("ark-coding-plan", "review").model).toBe(
      "ark-code-latest",
    );
    expect(resolveLlm("ark-coding-plan", "delegate").model).toBe(
      "ark-code-latest",
    );
  });

  it.each([
    [
      "ark-agent-plan",
      "ark-agent-plan",
      "ark-code-latest",
    ],
    [
      "ark-agent-deepseek-v4-flash",
      "ark-agent-plan",
      "deepseek-v4-flash",
    ],
  ] as const)(
    "binds pending %s to the shared Agent Plan route without reusing old evidence",
    (id, provider, model) => {
      const profile = resolveLlm(id);
      expect(profile).toMatchObject({
        runtime: "pi-rpc",
        provider,
        model,
        network: "direct",
        credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
        credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
        concurrencyKey: "ark-agent-plan",
        timeoutMs: 900_000,
        maxConcurrency: 1,
        capabilities: { review: true, delegate: true },
        qualityGates: {
          review: { status: "pending" },
          delegate: { status: "pending" },
        },
      });
      expect(profile.qualityGates.review.evidence).toBeUndefined();
      expect(profile.qualityGates.delegate.evidence).toBeUndefined();
      expect(() => resolveLlm(id, "review")).toThrow(
        /disabled pending real smoke/u,
      );
      expect(() => resolveLlm(id, "delegate")).toThrow(
        /disabled pending real smoke/u,
      );
    },
  );

  it("binds qualified Gemini tasks to Pi Google, fixed 10808 routing, and ordered credentials", () => {
    expect(resolveLlm("gemini-3.5-flash")).toMatchObject({
      runtime: "pi-rpc",
      provider: "google",
      model: "gemini-3.5-flash",
      network: "proxy-10808",
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
    expect(resolveLlm("gemini-3.5-flash", "review").model).toBe("gemini-3.5-flash");
    expect(resolveLlm("gemini-3.5-flash", "delegate").model).toBe("gemini-3.5-flash");
  });

  it("derives the complete MCP credential allowlist from logical profiles", () => {
    expect(credentialEnvironmentNames()).toEqual([
      "ARK_API_KEY",
      "VOLCENGINE_API_KEY",
      "API_KEY_DOUBAO_CODING",
      "OPENAI_API_KEY_DOUBAO",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ]);
  });

  it.each(["claude-opus", "codex", "deepseek"])(
    "does not register excluded source %s",
    (id) => {
      expect(() => resolveLlm(id)).toThrow(
        /Supported llms: ark-agent-deepseek-v4-flash, ark-agent-plan, ark-coding-plan, gemini-3\.5-flash, kimi-k3/u,
      );
    },
  );

  it.each([
    "kimi-k2.7",
    "kimi-k2.7-highspeed",
    "ark-agent-glm-5.2",
    "ark-agent-doubao-seed-2.0-pro",
  ])("rejects removed public id %s", (id) => {
    expect(() => resolveLlm(id)).toThrow(/Unknown logical llm/u);
  });

  it.each([
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
