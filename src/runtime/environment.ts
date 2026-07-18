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

function lookupEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const direct = environment[name];
  if (direct !== undefined) {
    return direct;
  }

  const matchedKey = Object.keys(environment).find(
    (key) => key.toUpperCase() === name.toUpperCase(),
  );
  return matchedKey === undefined ? undefined : environment[matchedKey];
}

export function buildChildEnvironment(
  policy: ChildEnvironmentPolicy,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};

  for (const name of BASE_ENVIRONMENT_KEYS) {
    const value = lookupEnvironmentValue(parentEnvironment, name);
    if (value !== undefined && value.trim() !== "") {
      childEnvironment[name] = value;
    }
  }

  if (policy.credentialTargetEnv !== undefined) {
    const credential = resolveCredential(
      policy.credentialEnv,
      policy.credentialTargetEnv,
      parentEnvironment,
    );
    childEnvironment[credential.targetName] = credential.value;
  } else {
    for (const name of policy.credentialEnv) {
      const value = lookupEnvironmentValue(parentEnvironment, name);
      if (value !== undefined && value.trim() !== "") {
        childEnvironment[name] = value;
        break;
      }
    }
  }

  if (policy.network !== "direct") {
    const port = policy.network === "proxy-10808" ? 10808 : 11808;
    const proxy = `http://127.0.0.1:${port}`;
    childEnvironment.HTTP_PROXY = proxy;
    childEnvironment.HTTPS_PROXY = proxy;
    childEnvironment.http_proxy = proxy;
    childEnvironment.https_proxy = proxy;
  }

  return childEnvironment;
}
