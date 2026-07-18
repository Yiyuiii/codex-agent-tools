import path from "node:path";

export interface ReleaseTextEntry {
  name: string;
  content: string;
}

export interface SensitiveContentOptions {
  forbiddenPaths: readonly string[];
  secrets: readonly string[];
}

const EXACT_PUBLIC_FILES = new Set([
  "LICENSE",
  "README.md",
  "docs/operations.md",
  "package.json",
]);

function normalizePackPath(fileName: string): string {
  return path.posix.normalize(fileName.replaceAll("\\", "/"));
}

function normalizeForSearch(value: string): string {
  return value.replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

export function assertAllowedPackFiles(fileNames: readonly string[]): void {
  for (const originalName of fileNames) {
    const name = normalizePackPath(originalName);
    const allowed =
      EXACT_PUBLIC_FILES.has(name) ||
      name.startsWith("dist/") ||
      name.startsWith("docs/smoke/");
    if (!allowed || name.startsWith("../")) {
      throw new Error(`Unexpected file in npm package: ${originalName}`);
    }
  }
}

export function assertNoSensitiveContent(
  entries: readonly ReleaseTextEntry[],
  options: SensitiveContentOptions,
): void {
  const forbiddenPaths = options.forbiddenPaths
    .filter((value) => value.trim() !== "")
    .map(normalizeForSearch);
  const secrets = options.secrets.filter((value) => value.trim() !== "");

  for (const entry of entries) {
    const normalizedContent = normalizeForSearch(entry.content);
    if (forbiddenPaths.some((value) => normalizedContent.includes(value))) {
      throw new Error(`Development-machine path found in ${entry.name}`);
    }
    if (secrets.some((value) => entry.content.includes(value))) {
      throw new Error(`Secret value found in ${entry.name}`);
    }
  }
}
