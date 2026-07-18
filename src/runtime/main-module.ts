import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isMainModule(
  importMetaUrl: string,
  invokedPath: string | undefined = process.argv[1],
): boolean {
  if (invokedPath === undefined) return false;
  try {
    const modulePath = realpathSync.native(fileURLToPath(importMetaUrl));
    const entryPath = realpathSync.native(path.resolve(invokedPath));
    return comparablePath(modulePath) === comparablePath(entryPath);
  } catch {
    return false;
  }
}
