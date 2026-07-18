import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface BuildIsolatedPiConfigOptions {
  root?: string;
  version: string;
  providers?: readonly "ark"[];
}

export interface IsolatedPiConfig {
  agentDir: string;
  settingsPath: string;
  modelsPath: string;
  environment: { PI_CODING_AGENT_DIR: string };
  contentSha256: string;
}

const ARK_PROVIDERS = {
  "ark-coding-plan": {
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    api: "anthropic-messages",
    apiKey: "$CODEX_AGENT_ARK_CODING_KEY",
    models: [
      {
        id: "ark-code-latest",
        name: "Ark Coding Plan",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 32_000,
      },
    ],
  },
  "ark-agent-plan": {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    api: "anthropic-messages",
    apiKey: "$CODEX_AGENT_ARK_AGENT_KEY",
    models: [
      {
        id: "glm-5.2",
        name: "GLM 5.2 Agent Plan",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 32_000,
      },
      {
        id: "doubao-seed-2.0-pro",
        name: "Doubao Seed 2.0 Pro Agent Plan",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 32_000,
      },
    ],
  },
} as const;

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJson(entry)]),
  );
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(stableJson(value), null, 2)}\n`;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  if ((await readIfExists(filePath)) === content) return;
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function getDefaultPiConfigRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  if (platform === "win32") {
    const localAppData =
      environment.LOCALAPPDATA?.trim() ||
      path.win32.join(homeDirectory, "AppData", "Local");
    return path.win32.join(localAppData, "codex-agent-tools");
  }
  const cacheRoot =
    environment.XDG_CACHE_HOME?.trim() || path.posix.join(homeDirectory, ".cache");
  return path.posix.join(cacheRoot, "codex-agent-tools");
}

export async function buildIsolatedPiConfig(
  options: BuildIsolatedPiConfigOptions,
): Promise<IsolatedPiConfig> {
  if (!/^[0-9A-Za-z._-]+$/u.test(options.version)) {
    throw new Error("Pi config version must contain only safe path characters");
  }
  const providerSets = options.providers ?? ["ark"];
  if (providerSets.length !== 1 || providerSets[0] !== "ark") {
    throw new Error('Pi config providers must be exactly ["ark"]');
  }
  const root = path.resolve(options.root ?? getDefaultPiConfigRoot());
  const agentDir = path.join(root, "pi", options.version);
  const settingsPath = path.join(agentDir, "settings.json");
  const modelsPath = path.join(agentDir, "models.json");
  const settings = jsonText({
    defaultProjectTrust: "never",
    enableAnalytics: false,
    enableInstallTelemetry: false,
    extensions: [],
    packages: [],
    prompts: [],
    quietStartup: true,
    skills: [],
    themes: [],
  });
  const models = jsonText({ providers: ARK_PROVIDERS });

  await mkdir(agentDir, { recursive: true });
  await atomicWrite(settingsPath, settings);
  await atomicWrite(modelsPath, models);

  return {
    agentDir,
    settingsPath,
    modelsPath,
    environment: { PI_CODING_AGENT_DIR: agentDir },
    contentSha256: createHash("sha256")
      .update(settings)
      .update("\0")
      .update(models)
      .digest("hex"),
  };
}
