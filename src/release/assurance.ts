import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

import type * as TypeScript from "typescript";

const ts = createRequire(import.meta.url)("typescript") as typeof TypeScript;

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
  "docs/release/four-llm-qualification-authorization-review.html",
  "docs/release/four-llm-qualification-reauthorization-review.html",
  "docs/release/four-llm-qualification-result-review.html",
  "docs/release/plugin-isolated-state.md",
  "docs/release/real-plugin-install-review.md",
  "docs/superpowers/plans/2026-07-27-authorized-four-llm-qualification-and-convergence.md",
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

function assertSafePackPath(fileName: string): string {
  const normalized = normalizePackPath(fileName);
  if (
    normalized.length === 0 ||
    normalized.length > 1_024 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe npm package path: ${fileName}`);
  }
  return normalized;
}

export function resolvePackInspectionPath(
  packPath: string,
  localCandidates: readonly string[],
): string {
  const normalizedPackPath = assertSafePackPath(packPath);
  if (!normalizedPackPath.includes("***")) {
    return normalizedPackPath;
  }
  if (normalizedPackPath.replaceAll("***", "").includes("*")) {
    throw new Error(`Unsafe npm package path: ${packPath}`);
  }
  const pattern = new RegExp(
    `^${normalizedPackPath
      .replace(/[|\\{}()[\]^$+?.]/gu, "\\$&")
      .replaceAll("***", "[^/]+")}$`,
    "u",
  );
  const matches = [
    ...new Set(
      localCandidates.map((candidate) => assertSafePackPath(candidate)),
    ),
  ].filter((candidate) => pattern.test(candidate));
  if (matches.length !== 1) {
    throw new Error(`Unable to resolve redacted npm package path: ${packPath}`);
  }
  return matches[0]!;
}

export async function resolveAllowedPackInspectionPaths(
  fileNames: readonly string[],
  listCandidates: (
    candidateDirectory: string,
  ) => Promise<readonly string[]>,
): Promise<string[]> {
  assertAllowedPackFiles(fileNames);
  const prepared = fileNames.map((fileName) => {
    const normalized = assertSafePackPath(fileName);
    const redactionCount = normalized.split("***").length - 1;
    if (redactionCount === 0) {
      if (normalized.includes("*")) {
        throw new Error(`Unsafe npm package path: ${fileName}`);
      }
      return { normalized };
    }
    if (
      redactionCount !== 1 ||
      normalized.replace("***", "").includes("*")
    ) {
      throw new Error(`Unsafe npm package path: ${fileName}`);
    }
    const candidateDirectory = path.posix.dirname(
      normalized.slice(0, normalized.indexOf("***")),
    );
    if (
      candidateDirectory === "." ||
      candidateDirectory === ".." ||
      candidateDirectory.startsWith("../") ||
      path.posix.isAbsolute(candidateDirectory)
    ) {
      throw new Error("Unable to resolve redacted npm package path");
    }
    return { normalized, candidateDirectory };
  });

  const resolved: string[] = [];
  for (const entry of prepared) {
    if (entry.candidateDirectory === undefined) {
      resolved.push(entry.normalized);
      continue;
    }
    resolved.push(
      resolvePackInspectionPath(
        entry.normalized,
        await listCandidates(entry.candidateDirectory),
      ),
    );
  }
  assertAllowedPackFiles(resolved);
  return resolved;
}

function documentLinkTargets(entry: ReleaseTextEntry): string[] {
  const targets: string[] = [];
  if (entry.name.toLocaleLowerCase("en-US").endsWith(".html")) {
    const htmlLink = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
    for (const match of entry.content.matchAll(htmlLink)) {
      targets.push(match[1] ?? match[2] ?? "");
    }
  } else if (entry.name.toLocaleLowerCase("en-US").endsWith(".md")) {
    const markdownLink =
      /!?\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/gu;
    for (const match of entry.content.matchAll(markdownLink)) {
      targets.push(match[1] ?? match[2] ?? "");
    }
  }
  return targets;
}

function resolveLocalPackageLink(
  sourceName: string,
  rawTarget: string,
): string | undefined {
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return undefined;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed)?.[1];
  if (scheme !== undefined) {
    if (["http", "https", "mailto"].includes(scheme.toLowerCase())) {
      return undefined;
    }
    throw new Error(`Unsafe package link in ${sourceName}`);
  }
  if (
    trimmed === "" ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\")
  ) {
    throw new Error(`Unsafe package link in ${sourceName}`);
  }
  const withoutQueryOrFragment = trimmed.split(/[?#]/u, 1)[0] ?? "";
  if (withoutQueryOrFragment === "") {
    throw new Error(`Unsafe package link in ${sourceName}`);
  }
  const resolved = normalizePackPath(
    path.posix.join(path.posix.dirname(sourceName), withoutQueryOrFragment),
  );
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    path.posix.isAbsolute(resolved)
  ) {
    throw new Error(`Local package link escapes the package in ${sourceName}`);
  }
  return resolved;
}

export function assertPackageLocalLinks(
  entries: readonly ReleaseTextEntry[],
  packageFiles: readonly string[],
): void {
  const availableFiles = new Set(
    packageFiles.map((fileName) => assertSafePackPath(fileName)),
  );
  for (const entry of entries) {
    const sourceName = assertSafePackPath(entry.name);
    for (const rawTarget of documentLinkTargets(entry)) {
      const target = resolveLocalPackageLink(sourceName, rawTarget);
      if (target !== undefined && !availableFiles.has(target)) {
        throw new Error(
          `Local package link target is missing for ${sourceName}`,
        );
      }
    }
  }
}

function isPackageDocument(fileName: string): boolean {
  const lowerCaseName = fileName.toLocaleLowerCase("en-US");
  return lowerCaseName.endsWith(".md") || lowerCaseName.endsWith(".html");
}

function assertRedactedSafePackPath(fileName: string): string {
  try {
    return assertSafePackPath(fileName);
  } catch {
    throw new Error("Unsafe npm package path");
  }
}

export function assertPackageDocumentLinkClosure(
  entries: readonly ReleaseTextEntry[],
  packageFiles: readonly string[],
): void {
  const normalizedPackageFiles = packageFiles.map((fileName) =>
    assertRedactedSafePackPath(fileName),
  );
  const entriesByName = new Map<string, ReleaseTextEntry>();
  for (const entry of entries) {
    const normalizedName = assertRedactedSafePackPath(entry.name);
    if (entriesByName.has(normalizedName)) {
      throw new Error(
        `Package entry was inspected more than once: ${normalizedName}`,
      );
    }
    entriesByName.set(normalizedName, {
      name: normalizedName,
      content: entry.content,
    });
  }

  const documentEntries = [
    ...new Set(normalizedPackageFiles.filter(isPackageDocument)),
  ].map((documentName) => {
    const entry = entriesByName.get(documentName);
    if (entry === undefined) {
      throw new Error(`Package document was not inspected: ${documentName}`);
    }
    return entry;
  });
  assertPackageLocalLinks(documentEntries, normalizedPackageFiles);
}

function normalizeForSearch(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/\/+/gu, "/")
    .toLocaleLowerCase("en-US");
}

interface ParsedSourceFile extends TypeScript.SourceFile {
  readonly parseDiagnostics?: readonly TypeScript.Diagnostic[];
}

function literalModuleSpecifier(
  node: TypeScript.Expression | undefined,
  entryName: string,
): string {
  if (
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  throw new Error(`Non-literal production import found in ${entryName}`);
}

// This compiler-AST check is release-only and is not reachable from the
// plugin MCP entrypoint, so TypeScript is never added to the plugin runtime.
function productionImportSpecifiers(entry: ReleaseTextEntry): string[] {
  let sourceFile: ParsedSourceFile;
  try {
    sourceFile = ts.createSourceFile(
      entry.name,
      entry.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ) as ParsedSourceFile;
  } catch {
    throw new Error(`Unable to parse plugin bundle ${entry.name}`);
  }
  if ((sourceFile.parseDiagnostics?.length ?? 0) > 0) {
    throw new Error(`Unable to parse plugin bundle ${entry.name}`);
  }

  const specifiers: string[] = [];
  const visit = (node: TypeScript.Node): void => {
    if (ts.isImportDeclaration(node)) {
      specifiers.push(literalModuleSpecifier(node.moduleSpecifier, entry.name));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined
    ) {
      specifiers.push(literalModuleSpecifier(node.moduleSpecifier, entry.name));
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "require" ||
          node.expression.text === "__require");
      if (isDynamicImport || isRequire) {
        specifiers.push(literalModuleSpecifier(node.arguments[0], entry.name));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function assertPluginBundleContent(entry: ReleaseTextEntry): void {
  if (normalizeForSearch(entry.content).includes("../dist/mcp.js")) {
    throw new Error(`Development entrypoint reference found in ${entry.name}`);
  }
  if (
    productionImportSpecifiers(entry).some((specifier) => !isBuiltin(specifier))
  ) {
    throw new Error(`Non-builtin production import found in ${entry.name}`);
  }
}

export function assertAllowedPackFiles(fileNames: readonly string[]): void {
  for (const originalName of fileNames) {
    const name = assertSafePackPath(originalName);
    const containsNodeModules = name.split("/").includes("node_modules");
    const allowed =
      EXACT_PUBLIC_FILES.has(name) ||
      EXACT_PLUGIN_FILES.has(name) ||
      name.startsWith("dist/") ||
      name.startsWith("docs/smoke/");
    if (!allowed || containsNodeModules) {
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
