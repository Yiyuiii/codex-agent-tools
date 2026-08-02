import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

import type * as TypeScript from "typescript";

import { resolveWindowsJobHelperForModule } from "../runtime/windows-job-helper.js";

interface CommonMarkNode {
  readonly type: string;
  readonly destination: string | null;
  readonly literal: string | null;
  walker(): CommonMarkWalker;
}

interface CommonMarkWalker {
  next(): CommonMarkWalkerEvent | null;
}

interface CommonMarkWalkerEvent {
  readonly entering: boolean;
  readonly node: CommonMarkNode;
}

interface CommonMarkParser {
  parse(content: string): CommonMarkNode;
}

interface CommonMarkModule {
  readonly Parser: new () => CommonMarkParser;
}

const localRequire = createRequire(import.meta.url);
const commonmark = localRequire("commonmark") as CommonMarkModule;
const ts = localRequire("typescript") as typeof TypeScript;

export interface ReleaseTextEntry {
  name: string;
  content: string;
}

export interface SensitiveContentOptions {
  forbiddenPaths: readonly string[];
  secrets: readonly string[];
}

type PlainRecord = Record<string, unknown>;

function plainRecord(value: unknown): PlainRecord | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as PlainRecord)
    : undefined;
}

export function assertReleasePackageMetadata(options: {
  readonly packageManifest: unknown;
  readonly pluginManifest: unknown;
  readonly runtimeVersion: unknown;
}): void {
  const packageManifest = plainRecord(options.packageManifest);
  const pluginManifest = plainRecord(options.pluginManifest);
  const repository = plainRecord(packageManifest?.repository);
  const bugs = plainRecord(packageManifest?.bugs);
  const publishConfig = plainRecord(packageManifest?.publishConfig);
  const version = packageManifest?.version;

  if (
    packageManifest?.name !== "codex-agent-tools" ||
    repository?.type !== "git" ||
    repository.url !==
      "git+https://github.com/Yiyuiii/codex-agent-tools.git" ||
    packageManifest.homepage !==
      "https://github.com/Yiyuiii/codex-agent-tools#readme" ||
    bugs?.url !== "https://github.com/Yiyuiii/codex-agent-tools/issues" ||
    publishConfig?.access !== "public" ||
    publishConfig.registry !== "https://registry.npmjs.org/"
  ) {
    throw new Error("Package public repository metadata is invalid");
  }
  if (
    typeof version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ||
    pluginManifest?.name !== "codex-external-agents" ||
    pluginManifest.version !== version ||
    options.runtimeVersion !== version
  ) {
    throw new Error("Package, runtime, and plugin release versions differ");
  }
}

const EXACT_PUBLIC_FILES = new Set([
  "LICENSE",
  "README.md",
  "docs/operations.md",
  "docs/migration-from-codex-cc-tools.md",
  "docs/release/checklist.md",
  "docs/release/four-llm-qualification-authorization-review.html",
  "docs/release/four-llm-qualification-execution-runbook.md",
  "docs/release/four-llm-qualification-reauthorization-review.html",
  "docs/release/four-llm-qualification-result-review.html",
  "docs/release/plugin-isolated-state.md",
  "docs/release/qualification-carrier-rehearsal.md",
  "docs/release/real-plugin-install-review.md",
  "docs/superpowers/plans/2026-07-27-authorized-four-llm-qualification-and-convergence.md",
  "docs/superpowers/plans/2026-07-29-capability-scoped-qualification.md",
  "docs/superpowers/specs/2026-07-29-capability-scoped-qualification-design.md",
  "package.json",
]);

const EXACT_PLUGIN_FILES = new Set([
  ".agents/plugins/marketplace.json",
  "plugins/codex-external-agents/.codex-plugin/plugin.json",
  "plugins/codex-external-agents/.mcp.json",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
  "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe",
  "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256",
]);

const PLUGIN_BUNDLE =
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs";

export async function verifyReleaseWindowsJobHelperArtifact(): Promise<void> {
  await resolveWindowsJobHelperForModule(import.meta.url, "win32", "x64");
}

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
    path.win32.isAbsolute(fileName) ||
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

function isAsciiLetter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }
  const code = character.charCodeAt(0);
  return (
    (code >= "A".charCodeAt(0) && code <= "Z".charCodeAt(0)) ||
    (code >= "a".charCodeAt(0) && code <= "z".charCodeAt(0))
  );
}

function isHtmlWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r"
  );
}

function isHtmlAttributeNameCharacter(
  character: string | undefined,
): boolean {
  return (
    character !== undefined &&
    !isHtmlWhitespace(character) &&
    !['"', "'", ">", "/", "=", "<", "`"].includes(character)
  );
}

interface ParsedHtmlTag {
  readonly nextOffset: number;
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly hrefTargets: readonly string[];
}

const HTML_TEXT_ONLY_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

function parseHtmlTag(
  content: string,
  start: number,
): ParsedHtmlTag | undefined {
  let cursor = start + 1;
  const closing = content[cursor] === "/";
  if (closing) {
    cursor += 1;
  }
  if (!isAsciiLetter(content[cursor])) {
    return undefined;
  }

  const nameStart = cursor;
  cursor += 1;
  while (
    isAsciiLetter(content[cursor]) ||
    /[0-9-]/u.test(content[cursor] ?? "")
  ) {
    cursor += 1;
  }
  const name = content.slice(nameStart, cursor).toLocaleLowerCase("en-US");
  const hrefTargets: string[] = [];

  while (cursor < content.length) {
    while (isHtmlWhitespace(content[cursor])) {
      cursor += 1;
    }
    if (content[cursor] === ">") {
      return {
        nextOffset: cursor + 1,
        name,
        closing,
        selfClosing: false,
        hrefTargets: closing ? [] : hrefTargets,
      };
    }
    if (content[cursor] === "/" && content[cursor + 1] === ">") {
      return {
        nextOffset: cursor + 2,
        name,
        closing,
        selfClosing: true,
        hrefTargets: closing ? [] : hrefTargets,
      };
    }

    const attributeStart = cursor;
    while (isHtmlAttributeNameCharacter(content[cursor])) {
      cursor += 1;
    }
    if (cursor === attributeStart) {
      cursor += 1;
      continue;
    }
    const isHref =
      content
        .slice(attributeStart, cursor)
        .toLocaleLowerCase("en-US") === "href";
    while (isHtmlWhitespace(content[cursor])) {
      cursor += 1;
    }
    if (content[cursor] !== "=") {
      continue;
    }
    cursor += 1;
    while (isHtmlWhitespace(content[cursor])) {
      cursor += 1;
    }

    const quote = content[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < content.length && content[cursor] !== quote) {
        cursor += 1;
      }
      if (cursor >= content.length) {
        return {
          nextOffset: content.length,
          name,
          closing,
          selfClosing: false,
          hrefTargets: [],
        };
      }
      if (isHref) {
        hrefTargets.push(content.slice(valueStart, cursor));
      }
      cursor += 1;
      continue;
    }

    const valueStart = cursor;
    while (
      cursor < content.length &&
      !isHtmlWhitespace(content[cursor]) &&
      !['"', "'", "=", "<", ">", "`"].includes(content[cursor]!)
    ) {
      cursor += 1;
    }
    if (isHref) {
      hrefTargets.push(content.slice(valueStart, cursor));
    }
  }

  return {
    nextOffset: content.length,
    name,
    closing,
    selfClosing: false,
    hrefTargets: [],
  };
}

function matchesHtmlEndTagName(
  content: string,
  candidate: number,
  tagName: string,
): boolean {
  const nameStart = candidate + 2;
  for (let index = 0; index < tagName.length; index += 1) {
    const code = content.charCodeAt(nameStart + index);
    const lowerCode =
      code >= "A".charCodeAt(0) && code <= "Z".charCodeAt(0)
        ? code + ("a".charCodeAt(0) - "A".charCodeAt(0))
        : code;
    if (lowerCode !== tagName.charCodeAt(index)) {
      return false;
    }
  }
  const delimiter = content[nameStart + tagName.length];
  return (
    isHtmlWhitespace(delimiter) ||
    delimiter === "/" ||
    delimiter === ">"
  );
}

function htmlTextOnlyClosingOffset(
  content: string,
  start: number,
  tagName: string,
): number | undefined {
  if (tagName === "plaintext") {
    return undefined;
  }
  let cursor = start;
  while (cursor < content.length) {
    const candidate = content.indexOf("</", cursor);
    if (candidate < 0) {
      return undefined;
    }
    if (!matchesHtmlEndTagName(content, candidate, tagName)) {
      cursor = candidate + 2;
      continue;
    }
    const tag = parseHtmlTag(content, candidate);
    if (tag?.closing === true && tag.name === tagName) {
      return tag.nextOffset;
    }
    cursor = candidate + 2;
  }
  return undefined;
}

function skipHtmlTextOnlyContent(
  content: string,
  start: number,
  tagName: string,
): number {
  return htmlTextOnlyClosingOffset(content, start, tagName) ?? content.length;
}

function htmlLinkTargets(content: string): string[] {
  const targets: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf("<", cursor);
    if (start < 0) {
      break;
    }
    if (content.startsWith("<!--", start)) {
      const commentEnd = content.indexOf("-->", start + 4);
      cursor = commentEnd < 0 ? content.length : commentEnd + 3;
      continue;
    }

    const tag = parseHtmlTag(content, start);
    if (tag === undefined) {
      cursor = start + 1;
      continue;
    }
    targets.push(...tag.hrefTargets);
    cursor = tag.nextOffset;
    if (
      !tag.closing &&
      HTML_TEXT_ONLY_ELEMENTS.has(tag.name)
    ) {
      cursor = skipHtmlTextOnlyContent(content, cursor, tag.name);
    }
  }
  return targets;
}

function firstHtmlTextOnlyTag(content: string): ParsedHtmlTag | undefined {
  const start = content.indexOf("<");
  if (start < 0) {
    return undefined;
  }
  const tag = parseHtmlTag(content, start);
  return tag !== undefined && HTML_TEXT_ONLY_ELEMENTS.has(tag.name)
    ? tag
    : undefined;
}

function markdownLinkTargets(
  content: string,
  sourceName: string,
): string[] {
  try {
    const targets: string[] = [];
    let openTextOnlyElement: string | undefined;
    const walker = new commonmark.Parser().parse(content).walker();
    for (
      let event = walker.next();
      event !== null;
      event = walker.next()
    ) {
      if (!event.entering) {
        continue;
      }
      const node = event.node;
      if (node.type === "link" || node.type === "image") {
        if (openTextOnlyElement !== undefined) {
          continue;
        }
        if (typeof node.destination !== "string") {
          throw new Error("CommonMark link destination is unavailable");
        }
        targets.push(node.destination);
      } else if (
        node.type === "html_inline" ||
        node.type === "html_block"
      ) {
        if (typeof node.literal !== "string") {
          throw new Error("CommonMark HTML literal is unavailable");
        }
        const textOnlyTag = firstHtmlTextOnlyTag(node.literal);
        if (openTextOnlyElement !== undefined) {
          if (
            openTextOnlyElement !== "plaintext" &&
            textOnlyTag?.closing === true &&
            textOnlyTag.name === openTextOnlyElement
          ) {
            openTextOnlyElement = undefined;
          }
          continue;
        }
        targets.push(...htmlLinkTargets(node.literal));
        if (
          textOnlyTag !== undefined &&
          !textOnlyTag.closing &&
          htmlTextOnlyClosingOffset(
            node.literal,
            textOnlyTag.nextOffset,
            textOnlyTag.name,
          ) === undefined
        ) {
          openTextOnlyElement = textOnlyTag.name;
        }
      }
    }
    return targets;
  } catch {
    throw new Error(`Unable to parse package Markdown in ${sourceName}`);
  }
}

function documentLinkTargets(
  entry: ReleaseTextEntry,
  sourceName: string,
): string[] {
  const lowerCaseName = entry.name.toLocaleLowerCase("en-US");
  if (lowerCaseName.endsWith(".html")) {
    return htmlLinkTargets(entry.content);
  }
  if (!lowerCaseName.endsWith(".md")) {
    return [];
  }
  return markdownLinkTargets(entry.content, sourceName);
}

function resolveLocalPackageLink(
  sourceName: string,
  rawTarget: string,
): string | undefined {
  const trimmed = rawTarget.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("?") ||
    trimmed.startsWith("//")
  ) {
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
    for (const rawTarget of documentLinkTargets(entry, sourceName)) {
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

export function assertCapabilitySourcesPackaged(
  fileNames: readonly string[],
  verification: Readonly<{
    indexPath: string;
    sourcePaths: readonly string[];
  }>,
): void {
  const packaged = new Set(fileNames.map(assertSafePackPath));
  const required = [
    verification.indexPath,
    ...verification.sourcePaths,
  ].map(assertSafePackPath);
  for (const sourcePath of required) {
    if (!packaged.has(sourcePath)) {
      throw new Error(
        `Capability qualification source is missing from npm package: ${sourcePath}`,
      );
    }
  }
}

function capabilitySourcePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Capability qualification index is invalid");
  }
  const normalized = assertSafePackPath(value);
  if (
    normalized !== value.replaceAll("\\", "/") ||
    !normalized.startsWith("docs/smoke/evidence/") ||
    !normalized.endsWith(".json")
  ) {
    throw new Error("Capability qualification index is invalid");
  }
  return normalized;
}

export function capabilitySourcePathsFromIndex(
  value: unknown,
): readonly string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Capability qualification index is invalid");
  }
  const index = value as Record<string, unknown>;
  if (index.schemaVersion !== 1 || !Array.isArray(index.entries)) {
    throw new Error("Capability qualification index is invalid");
  }
  const sourcePaths: string[] = [];
  for (const entryValue of index.entries) {
    if (
      typeof entryValue !== "object" ||
      entryValue === null ||
      Array.isArray(entryValue)
    ) {
      throw new Error("Capability qualification index is invalid");
    }
    const source = (entryValue as Record<string, unknown>).source;
    if (
      typeof source !== "object" ||
      source === null ||
      Array.isArray(source)
    ) {
      throw new Error("Capability qualification index is invalid");
    }
    const sourceRecord = source as Record<string, unknown>;
    if (sourceRecord.kind === "batch-case") {
      sourcePaths.push(
        capabilitySourcePath(sourceRecord.manifestPath),
        capabilitySourcePath(sourceRecord.evidencePath),
      );
    } else if (sourceRecord.kind === "legacy-standalone") {
      sourcePaths.push(capabilitySourcePath(sourceRecord.evidencePath));
    } else {
      throw new Error("Capability qualification index is invalid");
    }
  }
  return Object.freeze(
    [...new Set(sourcePaths)].sort((left, right) =>
      left.localeCompare(right, "en"),
    ),
  );
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
