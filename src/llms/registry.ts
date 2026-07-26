import type {
  LlmProfile,
  QualityGate,
  TaskKind,
} from "../domain/types.js";

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

const pendingTasks = () =>
  ({
    capabilities: { review: true, delegate: true },
    qualityGates: {
      review: { status: "pending" },
      delegate: { status: "pending" },
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
    ...pendingTasks(),
  },
  {
    id: "ark-agent-plan",
    displayName: "Ark Agent Plan",
    runtime: "pi-rpc",
    provider: "ark-agent-plan",
    model: "ark-code-latest",
    network: "direct",
    credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
    credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
    timeoutMs: 900_000,
    maxConcurrency: 1,
    concurrencyKey: "ark-agent-plan",
    ...qualifiedTasks("docs/smoke/ark.md", "ark-agent-plan"),
  },
  {
    id: "ark-agent-deepseek-v4-flash",
    displayName: "Ark Agent Plan DeepSeek V4 Flash",
    runtime: "pi-rpc",
    provider: "ark-agent-plan",
    model: "deepseek-v4-flash",
    network: "direct",
    credentialEnv: ["OPENAI_API_KEY_DOUBAO"],
    credentialTargetEnv: "CODEX_AGENT_ARK_AGENT_KEY",
    timeoutMs: 900_000,
    maxConcurrency: 1,
    concurrencyKey: "ark-agent-plan",
    ...qualifiedTasks(
      "docs/smoke/ark.md",
      "ark-agent-deepseek-v4-flash",
    ),
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
    byId.set(profile.id, immutableProfile(profile));
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

function immutableQualityGate(
  profileId: string,
  task: TaskKind,
  gate: QualityGate,
): QualityGate {
  if (typeof gate !== "object" || gate === null) {
    throw new Error(`Logical llm "${profileId}" ${task} quality gate is invalid`);
  }
  const record = gate as {
    status?: unknown;
    evidence?: unknown;
  };
  if (record.status === "passed") {
    if (
      typeof record.evidence !== "string" ||
      record.evidence.trim() === ""
    ) {
      throw new Error(
        `Logical llm "${profileId}" ${task} passed quality gate requires non-empty evidence`,
      );
    }
    return Object.freeze({
      status: "passed",
      evidence: record.evidence,
    });
  }
  if (record.status === "pending") {
    if ("evidence" in record) {
      throw new Error(
        `Logical llm "${profileId}" ${task} pending quality gate must not include evidence`,
      );
    }
    return Object.freeze({ status: "pending" });
  }
  throw new Error(`Logical llm "${profileId}" ${task} quality gate is invalid`);
}

function immutableProfile(profile: LlmProfile): LlmProfile {
  const capabilities = Object.freeze({
    review: profile.capabilities.review,
    delegate: profile.capabilities.delegate,
  });
  const qualityGates = Object.freeze({
    review: immutableQualityGate(
      profile.id,
      "review",
      profile.qualityGates.review,
    ),
    delegate: immutableQualityGate(
      profile.id,
      "delegate",
      profile.qualityGates.delegate,
    ),
  });
  const credentialEnv = Object.freeze([...profile.credentialEnv]);

  return Object.freeze({
    ...profile,
    capabilities,
    qualityGates,
    credentialEnv,
  });
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
