import type { LlmProfile, TaskKind } from "../domain/types.js";

export interface LlmRegistry {
  ids(): string[];
  resolve(id: string, task?: TaskKind): LlmProfile;
}

const qualifiedTasks = (evidenceDocument: string, anchorPrefix: string) =>
  ({
    capabilities: { review: true, delegate: true },
    qualityGates: {
      review: {
        status: "passed",
        evidence: `${evidenceDocument}#${anchorPrefix}-review`,
      },
      delegate: {
        status: "passed",
        evidence: `${evidenceDocument}#${anchorPrefix}-delegate`,
      },
    },
  }) as const;

const DEFAULT_PROFILES: readonly LlmProfile[] = [
  {
    id: "ark-coding-plan",
    displayName: "Ark Coding Plan",
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
    timeoutMs: 900_000,
    maxConcurrency: 1,
    concurrencyKey: "ark-coding-plan",
    ...qualifiedTasks("docs/smoke/ark.md", "ark-coding-plan"),
  },
  {
    id: "ark-agent-glm-5.2",
    displayName: "Ark Agent Plan GLM 5.2",
    runtime: "pi-rpc",
    provider: "ark-agent-plan",
    model: "glm-5.2",
    network: "direct",
    credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
    credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
    timeoutMs: 900_000,
    maxConcurrency: 1,
    concurrencyKey: "ark-agent-plan",
    ...qualifiedTasks("docs/smoke/ark.md", "ark-agent-glm-5.2"),
  },
  {
    id: "ark-agent-doubao-seed-2.0-pro",
    displayName: "Ark Agent Plan Doubao Seed 2.0 Pro",
    runtime: "pi-rpc",
    provider: "ark-agent-plan",
    model: "doubao-seed-2.0-pro",
    network: "direct",
    credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
    credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
    timeoutMs: 900_000,
    maxConcurrency: 1,
    concurrencyKey: "ark-agent-plan",
    ...qualifiedTasks(
      "docs/smoke/ark.md",
      "ark-agent-doubao-seed-2.0-pro",
    ),
  },
  {
    id: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    runtime: "pi-rpc",
    provider: "google",
    model: "gemini-3.5-flash",
    network: "proxy-10808",
    credentialEnv: [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ],
    timeoutMs: 600_000,
    maxConcurrency: 2,
    ...qualifiedTasks("docs/smoke/pi-gemini.md", "gemini"),
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
    ...qualifiedTasks("docs/smoke/kimi.md", "kimi-k27"),
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
    ...qualifiedTasks("docs/smoke/kimi.md", "kimi-k27-highspeed"),
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
    ...qualifiedTasks("docs/smoke/kimi.md", "kimi-k3"),
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

export function credentialEnvironmentNames(): string[] {
  return [
    ...new Set(DEFAULT_PROFILES.flatMap((profile) => profile.credentialEnv)),
  ];
}

export function resolveLlm(id: string, task?: TaskKind): LlmProfile {
  return registry.resolve(id, task);
}
