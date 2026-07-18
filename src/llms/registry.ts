import type { LlmProfile, TaskKind } from "../domain/types.js";

export interface LlmRegistry {
  ids(): string[];
  resolve(id: string, task?: TaskKind): LlmProfile;
}

const qualifiedTasks = (anchorPrefix: string) =>
  ({
    capabilities: { review: true, delegate: true },
    qualityGates: {
      review: {
        status: "passed",
        evidence: `docs/smoke/kimi.md#${anchorPrefix}-review`,
      },
      delegate: {
        status: "passed",
        evidence: `docs/smoke/kimi.md#${anchorPrefix}-delegate`,
      },
    },
  }) as const;

const DEFAULT_PROFILES: readonly LlmProfile[] = [
  {
    id: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    runtime: "pi-rpc",
    provider: "google",
    model: "gemini-3.5-flash",
    network: "direct",
    credentialEnv: [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ],
    timeoutMs: 600_000,
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
  },
  {
    id: "kimi-k2.7",
    displayName: "Kimi K2.7 Coding",
    runtime: "kimi-acp",
    model: "kimi-code/kimi-for-coding",
    network: "direct",
    credentialEnv: [],
    timeoutMs: 600_000,
    maxConcurrency: 1,
    ...qualifiedTasks("kimi-k27"),
  },
  {
    id: "kimi-k2.7-highspeed",
    displayName: "Kimi K2.7 Coding Highspeed",
    runtime: "kimi-acp",
    model: "kimi-code/kimi-for-coding-highspeed",
    network: "direct",
    credentialEnv: [],
    timeoutMs: 600_000,
    maxConcurrency: 1,
    ...qualifiedTasks("kimi-k27-highspeed"),
  },
  {
    id: "kimi-k3",
    displayName: "Kimi K3",
    runtime: "kimi-acp",
    model: "kimi-code/k3",
    network: "direct",
    credentialEnv: [],
    timeoutMs: 600_000,
    maxConcurrency: 1,
    ...qualifiedTasks("kimi-k3"),
  },
];

export function createLlmRegistry(profiles: readonly LlmProfile[]): LlmRegistry {
  const byId = new Map<string, LlmProfile>();

  for (const profile of profiles) {
    if (byId.has(profile.id)) {
      throw new Error(`Duplicate logical llm id: ${profile.id}`);
    }
    byId.set(profile.id, profile);
  }

  const ids = [...byId.keys()].sort();

  return {
    ids: () => [...ids],
    resolve(id, task) {
      const profile = byId.get(id);
      if (!profile) {
        throw new Error(
          `Unknown logical llm "${id}". Supported llms: ${ids.join(", ")}`,
        );
      }

      if (
        task !== undefined &&
        (!profile.capabilities[task] ||
          profile.qualityGates[task].status !== "passed")
      ) {
        throw new Error(
          `Logical llm "${id}" ${task} is disabled pending real smoke`,
        );
      }

      return profile;
    },
  };
}

const registry = createLlmRegistry(DEFAULT_PROFILES);

export function supportedLlmIds(): string[] {
  return registry.ids();
}

export function resolveLlm(id: string, task?: TaskKind): LlmProfile {
  return registry.resolve(id, task);
}
