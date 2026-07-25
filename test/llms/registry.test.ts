import { describe, expect, it } from "vitest";

import type { LlmProfile } from "../../src/domain/types.js";
import {
  credentialEnvironmentNames,
  createLlmRegistry,
  resolveLlm,
  supportedLlmIds,
} from "../../src/llms/registry.js";

describe("logical LLM registry", () => {
  it("gives each default Agent Plan profile independent gate objects", () => {
    const primary = resolveLlm("ark-agent-plan");
    const flash = resolveLlm("ark-agent-deepseek-v4-flash");

    expect(primary.capabilities).not.toBe(flash.capabilities);
    expect(primary.qualityGates).not.toBe(flash.qualityGates);
    expect(primary.qualityGates.review).not.toBe(
      flash.qualityGates.review,
    );
    expect(primary.qualityGates.delegate).not.toBe(
      flash.qualityGates.delegate,
    );
  });

  it("returns deeply frozen default profiles that cannot affect another route", () => {
    const primary = resolveLlm("ark-agent-plan");
    const flash = resolveLlm("ark-agent-deepseek-v4-flash");

    expect(Object.isFrozen(primary)).toBe(true);
    expect(Object.isFrozen(primary.capabilities)).toBe(true);
    expect(Object.isFrozen(primary.qualityGates)).toBe(true);
    expect(Object.isFrozen(primary.qualityGates.review)).toBe(true);
    expect(Object.isFrozen(primary.qualityGates.delegate)).toBe(true);
    expect(Object.isFrozen(primary.credentialEnv)).toBe(true);

    expect(() => {
      (primary as { model: string }).model = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      (
        primary.qualityGates.review as {
          status: "pending" | "passed";
        }
      ).status = "passed";
    }).toThrow(TypeError);
    expect(() => {
      (primary.credentialEnv as string[]).push("TAMPERED_KEY");
    }).toThrow(TypeError);

    expect(flash).toMatchObject({
      model: "deepseek-v4-flash",
      qualityGates: {
        review: {
          status: "passed",
          evidence:
            "docs/smoke/ark.md#ark-agent-deepseek-v4-flash-review",
        },
        delegate: {
          status: "passed",
          evidence:
            "docs/smoke/ark.md#ark-agent-deepseek-v4-flash-delegate",
        },
      },
      credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
    });
  });

  it("defensively copies caller profiles before freezing registry state", () => {
    const base = resolveLlm("kimi-k3");
    const source = {
      ...base,
      id: "copy-test",
      capabilities: { review: true, delegate: true },
      qualityGates: {
        review: { status: "passed" as const, evidence: "review-evidence" },
        delegate: {
          status: "passed" as const,
          evidence: "delegate-evidence",
        },
      },
      credentialEnv: ["SOURCE_KEY"],
    } satisfies LlmProfile;
    const registry = createLlmRegistry([source]);

    source.model = "tampered-model";
    source.qualityGates.review.evidence = "tampered-evidence";
    source.credentialEnv.push("TAMPERED_KEY");

    expect(registry.resolve("copy-test")).toMatchObject({
      model: "kimi-code/k3",
      qualityGates: {
        review: { status: "passed", evidence: "review-evidence" },
      },
      credentialEnv: ["SOURCE_KEY"],
    });
    const resolved = registry.resolve("copy-test");
    expect(() => {
      (resolved.capabilities as Record<string, boolean>).review = false;
    }).toThrow(TypeError);
  });

  it("rejects runtime quality-gate states that violate evidence invariants", () => {
    const base = resolveLlm("kimi-k3");
    const invalidProfiles = [
      {
        id: "passed-without-evidence",
        qualityGates: {
          review: { status: "passed" },
          delegate: {
            status: "passed",
            evidence: "delegate-evidence",
          },
        },
        expected: /passed.*non-empty evidence/iu,
      },
      {
        id: "passed-with-blank-evidence",
        qualityGates: {
          review: { status: "passed", evidence: "   " },
          delegate: {
            status: "passed",
            evidence: "delegate-evidence",
          },
        },
        expected: /passed.*non-empty evidence/iu,
      },
      {
        id: "pending-with-evidence",
        qualityGates: {
          review: { status: "pending", evidence: "stale-evidence" },
          delegate: { status: "pending" },
        },
        expected: /pending.*must not include evidence/iu,
      },
    ];

    for (const invalid of invalidProfiles) {
      const profile = {
        ...base,
        id: invalid.id,
        capabilities: { review: true, delegate: true },
        qualityGates: invalid.qualityGates,
        credentialEnv: [...base.credentialEnv],
      } as unknown as LlmProfile;
      expect(() => createLlmRegistry([profile])).toThrow(invalid.expected);
    }
  });

  it("continues to resolve valid passed and pending profiles", () => {
    const registry = createLlmRegistry([
      resolveLlm("kimi-k3"),
      resolveLlm("gemini-3.5-flash"),
    ]);

    expect(registry.resolve("kimi-k3", "review").model).toBe("kimi-code/k3");
    expect(registry.resolve("gemini-3.5-flash").qualityGates).toEqual({
      review: { status: "pending" },
      delegate: { status: "pending" },
    });
    expect(() => registry.resolve("gemini-3.5-flash", "review")).toThrow(
      /disabled pending real smoke/u,
    );
  });

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

  it("keeps both Ark Coding Plan tasks pending after its delegate gate failed", () => {
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
        review: { status: "pending" },
        delegate: { status: "pending" },
      },
    });
    expect(() => resolveLlm("ark-coding-plan", "review")).toThrow(
      /disabled pending real smoke/u,
    );
    expect(() => resolveLlm("ark-coding-plan", "delegate")).toThrow(
      /disabled pending real smoke/u,
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
    "binds qualified %s to the shared Agent Plan route with exact evidence",
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
          review: {
            status: "passed",
            evidence: `docs/smoke/ark.md#${id}-review`,
          },
          delegate: {
            status: "passed",
            evidence: `docs/smoke/ark.md#${id}-delegate`,
          },
        },
      });
      expect(resolveLlm(id, "review").model).toBe(model);
      expect(resolveLlm(id, "delegate").model).toBe(model);
    },
  );

  it("keeps both Gemini tasks pending after its delegate quota gate failed", () => {
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
        review: { status: "pending" },
        delegate: { status: "pending" },
      },
    });
    expect(() => resolveLlm("gemini-3.5-flash", "review")).toThrow(
      /disabled pending real smoke/u,
    );
    expect(() => resolveLlm("gemini-3.5-flash", "delegate")).toThrow(
      /disabled pending real smoke/u,
    );
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
