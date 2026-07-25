import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

import type * as TypeScript from "typescript";

const ts = createRequire(import.meta.url)(
  "typescript",
) as typeof TypeScript;

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

interface ParsedSourceFile extends TypeScript.SourceFile {
  readonly parseDiagnostics?: readonly TypeScript.Diagnostic[];
}

function literalModuleSpecifier(
  node: TypeScript.Expression | undefined,
  entryName: string,
): string {
  if (
    node !== undefined &&
    (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  throw new Error(
    `Non-literal production import found in ${entryName}`,
  );
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
      specifiers.push(
        literalModuleSpecifier(node.moduleSpecifier, entry.name),
      );
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined
    ) {
      specifiers.push(
        literalModuleSpecifier(node.moduleSpecifier, entry.name),
      );
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "require" ||
          node.expression.text === "__require");
      if (isDynamicImport || isRequire) {
        specifiers.push(
          literalModuleSpecifier(node.arguments[0], entry.name),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function assertPluginBundleContent(entry: ReleaseTextEntry): void {
  if (
    normalizeForSearch(entry.content).includes("../dist/mcp.js")
  ) {
    throw new Error(`Development entrypoint reference found in ${entry.name}`);
  }
  if (
    productionImportSpecifiers(entry).some(
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
