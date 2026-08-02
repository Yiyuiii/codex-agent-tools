import type { NetworkPolicy } from "../domain/types.js";
import { resolveCredential } from "./credentials.js";

export interface ChildEnvironmentPolicy {
  network: NetworkPolicy;
  credentialEnv: readonly string[];
  credentialTargetEnv?: string;
}

const BASE_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "TERM",
  "COLORTERM",
  "LANG",
] as const;

const WINDOWS_IDENTITY_ENVIRONMENT_KEYS = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "USERDOMAIN",
  "USERNAME",
] as const;

const INVALID_CHILD_ENVIRONMENT = "Invalid child environment";
const PI_CODING_AGENT_DIRECTORY_ENV = "PI_CODING_AGENT_DIR";

interface SelectedCredential {
  sourceName: string;
  value: string;
}

function normalizedEnvironmentName(name: string): string {
  return name.toUpperCase();
}

function environmentNameKey(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? normalizedEnvironmentName(name) : name;
}

function lookupEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    const exact = environment[name];
    if (exact !== undefined) {
      return exact;
    }
    const matchedKey = Object.keys(environment).find(
      (key) =>
        normalizedEnvironmentName(key) === normalizedEnvironmentName(name),
    );
    return matchedKey === undefined ? undefined : environment[matchedKey];
  }
  const normalizedName = normalizedEnvironmentName(name);
  const matchedKeys = Object.keys(environment).filter(
    (key) => normalizedEnvironmentName(key) === normalizedName,
  );
  if (matchedKeys.length > 1) {
    throw new Error(INVALID_CHILD_ENVIRONMENT);
  }
  return matchedKeys.length === 0 ? undefined : environment[matchedKeys[0]!];
}

function assertCredentialNamespace(
  policy: ChildEnvironmentPolicy,
  baseEnvironmentKeys: readonly string[],
  platform: NodeJS.Platform,
): void {
  if (platform !== "win32") {
    return;
  }
  const baseNames = new Set(
    baseEnvironmentKeys.map((name) => environmentNameKey(name, platform)),
  );
  const credentialNames = new Set<string>();

  for (const sourceName of policy.credentialEnv) {
    const normalizedSource = environmentNameKey(sourceName, platform);
    if (
      baseNames.has(normalizedSource) ||
      credentialNames.has(normalizedSource)
    ) {
      throw new Error(INVALID_CHILD_ENVIRONMENT);
    }
    credentialNames.add(normalizedSource);
  }

  if (
    policy.credentialTargetEnv !== undefined &&
    baseNames.has(environmentNameKey(policy.credentialTargetEnv, platform))
  ) {
    throw new Error(INVALID_CHILD_ENVIRONMENT);
  }
}

function selectCredential(
  sourceNames: readonly string[],
  parentEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): SelectedCredential | undefined {
  for (const sourceName of sourceNames) {
    const value = lookupEnvironmentValue(
      parentEnvironment,
      sourceName,
      platform,
    );
    if (value !== undefined && value.trim() !== "") {
      return { sourceName, value };
    }
  }
  return undefined;
}

function assertPiRuntimeNamespace(
  policy: ChildEnvironmentPolicy,
  platform: NodeJS.Platform,
): void {
  const runtimeName = environmentNameKey(
    PI_CODING_AGENT_DIRECTORY_ENV,
    platform,
  );
  const conflictsWithRuntime = (name: string): boolean =>
    environmentNameKey(name, platform) === runtimeName;

  if (
    policy.credentialEnv.some(conflictsWithRuntime) ||
    (policy.credentialTargetEnv !== undefined &&
      conflictsWithRuntime(policy.credentialTargetEnv))
  ) {
    throw new Error(INVALID_CHILD_ENVIRONMENT);
  }
}

export function buildChildEnvironment(
  policy: ChildEnvironmentPolicy,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const baseEnvironmentKeys: readonly string[] =
    platform === "win32"
      ? [...BASE_ENVIRONMENT_KEYS, ...WINDOWS_IDENTITY_ENVIRONMENT_KEYS]
      : BASE_ENVIRONMENT_KEYS;
  assertCredentialNamespace(policy, baseEnvironmentKeys, platform);
  const childEnvironment: NodeJS.ProcessEnv = {};
  const outputNames = new Set<string>();

  const setEnvironmentValue = (name: string, value: string): void => {
    const normalizedName = environmentNameKey(name, platform);
    if (platform === "win32") {
      if (outputNames.has(normalizedName)) {
        throw new Error(INVALID_CHILD_ENVIRONMENT);
      }
      outputNames.add(normalizedName);
    }
    childEnvironment[name] = value;
  };

  for (const name of baseEnvironmentKeys) {
    const value = lookupEnvironmentValue(parentEnvironment, name, platform);
    if (value !== undefined && value.trim() !== "") {
      setEnvironmentValue(name, value);
    }
  }

  const selectedCredential = selectCredential(
    policy.credentialEnv,
    parentEnvironment,
    platform,
  );
  if (policy.credentialTargetEnv !== undefined) {
    const credential =
      selectedCredential ??
      resolveCredential(policy.credentialEnv, policy.credentialTargetEnv, {});
    setEnvironmentValue(policy.credentialTargetEnv, credential.value);
  } else if (selectedCredential !== undefined) {
    setEnvironmentValue(
      selectedCredential.sourceName,
      selectedCredential.value,
    );
  }

  return childEnvironment;
}

export function buildPiChildEnvironment(
  policy: ChildEnvironmentPolicy,
  piCodingAgentDir: string,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (piCodingAgentDir.trim() === "" || piCodingAgentDir.includes("\0")) {
    throw new Error(INVALID_CHILD_ENVIRONMENT);
  }
  assertPiRuntimeNamespace(policy, platform);

  const childEnvironment = buildChildEnvironment(
    policy,
    parentEnvironment,
    platform,
  );
  childEnvironment[PI_CODING_AGENT_DIRECTORY_ENV] = piCodingAgentDir;
  return childEnvironment;
}
