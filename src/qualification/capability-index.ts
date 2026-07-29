import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type {
  LlmProfile,
  RuntimeKind,
  TaskKind,
} from "../domain/types.js";
import { resolveLlm } from "../llms/registry.js";

const MAX_RUNTIME_INPUT_BYTES = 4 * 1024 * 1024;

const SHARED_RUNTIME_INPUT_ROOTS = Object.freeze([
  "package-lock.json",
  "src/adapters/adapter.ts",
  "src/mcp",
  "src/runtime",
  "src/tasks",
  "src/qualification",
  "src/smoke/evidence.ts",
  "src/smoke/command-observation.ts",
  "src/smoke/result-file-evidence.ts",
  "tsup.plugin.config.ts",
] as const);

const PI_RUNTIME_INPUT_ROOTS = Object.freeze([
  ...SHARED_RUNTIME_INPUT_ROOTS,
  "scripts/real-ark-smoke.mjs",
  "scripts/real-smoke-main.mjs",
  "src/adapters/pi",
  "src/smoke/ark.ts",
  "src/smoke/pi.ts",
  "src/smoke/pi-write-command-observation.ts",
] as const);

const KIMI_RUNTIME_INPUT_ROOTS = Object.freeze([
  ...SHARED_RUNTIME_INPUT_ROOTS,
  "scripts/real-kimi-smoke.mjs",
  "scripts/real-smoke-main.mjs",
  "src/adapters/kimi",
  "src/smoke/kimi.ts",
] as const);

export interface CapabilityRuntimeInput {
  readonly path: string;
  readonly content: string;
}

export interface CapabilityFingerprintProfile {
  readonly id: string;
  readonly runtime: RuntimeKind;
  readonly provider?: string;
  readonly model: string;
  readonly network: "direct";
  readonly credentialEnv: readonly string[];
  readonly credentialTargetEnv?: string;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly concurrencyKey?: string;
}

export interface CapabilityFingerprintSnapshot {
  readonly llm: string;
  readonly task: TaskKind;
  readonly profile: CapabilityFingerprintProfile;
  readonly inputs: readonly CapabilityRuntimeInput[];
}

function capabilityInputError(): Error {
  return new Error("Capability runtime inputs are invalid");
}

function normalizedRelativePath(value: string): string {
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\0")
  ) {
    throw capabilityInputError();
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw capabilityInputError();
  }
  return segments.join("/");
}

function resolvedRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
): string {
  const root = path.resolve(repositoryRoot);
  const normalized = normalizedRelativePath(relativePath);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw capabilityInputError();
  }
  return resolved;
}

function normalizeText(content: string): string {
  if (content.includes("\0")) throw capabilityInputError();
  return content.replace(/\r\n?/gu, "\n");
}

async function collectPath(
  repositoryRoot: string,
  relativePath: string,
  collected: Map<string, CapabilityRuntimeInput>,
): Promise<void> {
  const normalized = normalizedRelativePath(relativePath);
  const absolute = resolvedRepositoryPath(repositoryRoot, normalized);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch {
    throw capabilityInputError();
  }
  if (metadata.isSymbolicLink()) throw capabilityInputError();
  if (metadata.isDirectory()) {
    let names: string[];
    try {
      names = await readdir(absolute);
    } catch {
      throw capabilityInputError();
    }
    names.sort((left, right) => left.localeCompare(right, "en"));
    for (const name of names) {
      await collectPath(
        repositoryRoot,
        `${normalized}/${name}`,
        collected,
      );
    }
    return;
  }
  if (!metadata.isFile() || metadata.size > MAX_RUNTIME_INPUT_BYTES) {
    throw capabilityInputError();
  }
  let raw: Buffer;
  try {
    raw = await readFile(absolute);
  } catch {
    throw capabilityInputError();
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw capabilityInputError();
  }
  if (collected.has(normalized)) throw capabilityInputError();
  collected.set(
    normalized,
    Object.freeze({ path: normalized, content: normalizeText(content) }),
  );
}

export function capabilityRuntimeInputRoots(
  runtime: RuntimeKind,
): readonly string[] {
  return runtime === "pi-rpc"
    ? PI_RUNTIME_INPUT_ROOTS
    : KIMI_RUNTIME_INPUT_ROOTS;
}

export async function collectCapabilityRuntimeInputs(options: {
  repositoryRoot: string;
  roots: readonly string[];
}): Promise<readonly CapabilityRuntimeInput[]> {
  const collected = new Map<string, CapabilityRuntimeInput>();
  for (const root of options.roots) {
    await collectPath(options.repositoryRoot, root, collected);
  }
  return Object.freeze(
    [...collected.values()].sort((left, right) =>
      left.path.localeCompare(right.path, "en"),
    ),
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedFingerprintProfile(
  profile: CapabilityFingerprintProfile,
): Record<string, unknown> {
  return {
    id: profile.id,
    runtime: profile.runtime,
    provider: profile.provider ?? null,
    model: profile.model,
    network: profile.network,
    credentialEnv: [...profile.credentialEnv],
    credentialTargetEnv: profile.credentialTargetEnv ?? null,
    timeoutMs: profile.timeoutMs,
    maxConcurrency: profile.maxConcurrency,
    concurrencyKey: profile.concurrencyKey ?? null,
  };
}

export function fingerprintCapabilitySnapshot(
  snapshot: CapabilityFingerprintSnapshot,
): string {
  const inputs = [...snapshot.inputs]
    .map((input) => ({
      path: normalizedRelativePath(input.path),
      sha256: sha256(normalizeText(input.content)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (
    inputs.some(
      (input, index) =>
        index > 0 && input.path === inputs[index - 1]?.path,
    )
  ) {
    throw capabilityInputError();
  }
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      llm: snapshot.llm,
      task: snapshot.task,
      profile: normalizedFingerprintProfile(snapshot.profile),
      inputs,
    }),
  );
}

function fingerprintProfile(profile: LlmProfile): CapabilityFingerprintProfile {
  return Object.freeze({
    id: profile.id,
    runtime: profile.runtime,
    ...(profile.provider === undefined
      ? {}
      : { provider: profile.provider }),
    model: profile.model,
    network: profile.network,
    credentialEnv: Object.freeze([...profile.credentialEnv]),
    ...(profile.credentialTargetEnv === undefined
      ? {}
      : { credentialTargetEnv: profile.credentialTargetEnv }),
    timeoutMs: profile.timeoutMs,
    maxConcurrency: profile.maxConcurrency,
    ...(profile.concurrencyKey === undefined
      ? {}
      : { concurrencyKey: profile.concurrencyKey }),
  });
}

export async function computeCapabilityRuntimeFingerprint(options: {
  repositoryRoot: string;
  llm: string;
  task: TaskKind;
}): Promise<string> {
  const profile = resolveLlm(options.llm);
  if (!profile.capabilities[options.task]) throw capabilityInputError();
  const inputs = await collectCapabilityRuntimeInputs({
    repositoryRoot: options.repositoryRoot,
    roots: capabilityRuntimeInputRoots(profile.runtime),
  });
  return fingerprintCapabilitySnapshot({
    llm: options.llm,
    task: options.task,
    profile: fingerprintProfile(profile),
    inputs,
  });
}
