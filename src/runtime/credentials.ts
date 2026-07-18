export interface ResolvedCredential {
  sourceName: string;
  targetName: string;
  value: string;
}

function lookupEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const direct = environment[name];
  if (direct !== undefined) return direct;
  const matchedKey = Object.keys(environment).find(
    (key) => key.toUpperCase() === name.toUpperCase(),
  );
  return matchedKey === undefined ? undefined : environment[matchedKey];
}

export function resolveCredential(
  sourceNames: readonly string[],
  targetName: string,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): ResolvedCredential {
  for (const sourceName of sourceNames) {
    const value = lookupEnvironmentValue(parentEnvironment, sourceName);
    if (value !== undefined && value.trim() !== "") {
      return { sourceName, targetName, value };
    }
  }

  throw new Error(`Missing credential: ${sourceNames.join(" or ")}`);
}
