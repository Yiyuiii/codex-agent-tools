import { isBuiltin } from "node:module";
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
  "docs/migration-from-codex-cc-tools.md",
  "docs/release/checklist.md",
  "package.json",
]);

const EXACT_PLUGIN_FILES = new Set([
  ".agents/plugins/marketplace.json",
  "plugins/codex-external-agents/.codex-plugin/plugin.json",
  "plugins/codex-external-agents/.mcp.json",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
]);

const PLUGIN_BUNDLE =
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs";

function normalizePackPath(fileName: string): string {
  return path.posix.normalize(fileName.replaceAll("\\", "/"));
}

function normalizeForSearch(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/\/+/gu, "/")
    .toLocaleLowerCase("en-US");
}

function productionImportSpecifiers(content: string): string[] {
  const patterns = [
    /^\s*import\s+(?:(?:[$A-Z_a-z][$\w]*\s*,\s*)?(?:\{[^};]*\}|\*\s+as\s+[$A-Z_a-z][$\w]*)|[$A-Z_a-z][$\w]*)\s+from\s+["']([^"']+)["']/gmu,
    /^\s*import\s+["']([^"']+)["']/gmu,
    /^\s*export\s+(?:\{[^};]*\}|\*(?:\s+as\s+[$A-Z_a-z][$\w]*)?)\s+from\s+["']([^"']+)["']/gmu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gmu,
    /\b__require\(\s*["']([^"']+)["']\s*\)/gmu,
    /^\s*(?:(?:const|let|var)\s+(?:[$A-Z_a-z][$\w]*|\{[^};\r\n]*\}|\[[^\];\r\n]*\])\s*=\s*)?require\(\s*["']([^"']+)["']\s*\)/gmu,
  ];
  return patterns.flatMap((pattern) =>
    [...content.matchAll(pattern)].map((match) => match[1]!),
  );
}

function assertPluginBundleContent(entry: ReleaseTextEntry): void {
  if (
    normalizeForSearch(entry.content).includes("../dist/mcp.js")
  ) {
    throw new Error(`Development entrypoint reference found in ${entry.name}`);
  }
  if (
    productionImportSpecifiers(entry.content).some(
      (specifier) => !isBuiltin(specifier),
    )
  ) {
    throw new Error(`Non-builtin production import found in ${entry.name}`);
  }
}

export function assertAllowedPackFiles(fileNames: readonly string[]): void {
  for (const originalName of fileNames) {
    const name = normalizePackPath(originalName);
    const containsNodeModules = name
      .split("/")
      .includes("node_modules");
    const allowed =
      EXACT_PUBLIC_FILES.has(name) ||
      EXACT_PLUGIN_FILES.has(name) ||
      name.startsWith("dist/") ||
      name.startsWith("docs/smoke/");
    if (!allowed || containsNodeModules || name.startsWith("../")) {
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
    if (normalizePackPath(entry.name) === PLUGIN_BUNDLE) {
      assertPluginBundleContent(entry);
    }
  }
}
