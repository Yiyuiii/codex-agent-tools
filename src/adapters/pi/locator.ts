import { access, lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_BIN_PATH = "dist/cli.js";
const WINDOWS_PI_ERROR = "Pi installation could not be verified";
const EXACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const ENGINE_PATTERN = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const WINDOWS_PI_SHIMS = new Set(["pi", "pi.cmd", "pi.ps1"]);

export interface PiInvocationIdentity {
  readonly packageName: typeof PI_PACKAGE_NAME;
  readonly packageVersion: string;
  readonly nodeEngine: string;
}

export interface PiInvocation {
  readonly executable: string;
  readonly argvPrefix: readonly [string];
  readonly identity: PiInvocationIdentity;
}

export interface LocatePiOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  pathLookup?: (command: string) => Promise<string | undefined>;
  fileExists?: (candidate: string) => Promise<boolean>;
}

async function defaultFileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function defaultPathLookup(
  command: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const locator = platform === "win32" ? "where.exe" : "which";
  const result = await execa(locator, [command], {
    env: environment,
    reject: false,
    windowsHide: true,
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");
}

function sameWindowsPath(left: string, right: string): boolean {
  return (
    path.win32.normalize(left).toLowerCase() ===
    path.win32.normalize(right).toLowerCase()
  );
}

function isLexicallyCanonicalWindowsPath(candidate: string): boolean {
  return (
    candidate.toLowerCase() === path.win32.normalize(candidate).toLowerCase()
  );
}

async function assertNoWindowsReparsePoint(candidate: string): Promise<void> {
  const parsed = path.win32.parse(candidate);
  let current = parsed.root;
  for (const segment of candidate
    .slice(parsed.root.length)
    .split(/[\\/]/u)
    .filter(Boolean)) {
    current = path.win32.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(WINDOWS_PI_ERROR);
    }
  }
}

async function verifyCanonicalWindowsPath(
  candidate: string,
  kind: "directory" | "file",
): Promise<string> {
  if (
    candidate.includes("\0") ||
    !path.win32.isAbsolute(candidate) ||
    !isLexicallyCanonicalWindowsPath(candidate)
  ) {
    throw new Error(WINDOWS_PI_ERROR);
  }
  await assertNoWindowsReparsePoint(candidate);
  const [canonical, status] = await Promise.all([
    realpath(candidate),
    lstat(candidate),
  ]);
  if (
    !sameWindowsPath(candidate, canonical) ||
    (kind === "directory" ? !status.isDirectory() : !status.isFile())
  ) {
    throw new Error(WINDOWS_PI_ERROR);
  }
  return canonical;
}

function parseExactVersion(value: string, pattern: RegExp): readonly number[] {
  const match = pattern.exec(value);
  if (match === null) throw new Error(WINDOWS_PI_ERROR);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(WINDOWS_PI_ERROR);
  }
  return parts;
}

function assertNodeEngineSatisfied(engine: string): void {
  const required = parseExactVersion(engine, ENGINE_PATTERN);
  const current = parseExactVersion(
    process.versions.node,
    EXACT_VERSION_PATTERN,
  );
  for (let index = 0; index < 3; index += 1) {
    const actualPart = current[index]!;
    const requiredPart = required[index]!;
    if (actualPart > requiredPart) return;
    if (actualPart < requiredPart) throw new Error(WINDOWS_PI_ERROR);
  }
}

async function verifyPiAnchor(anchor: string): Promise<PiInvocation> {
  if (!WINDOWS_PI_SHIMS.has(path.win32.basename(anchor).toLowerCase())) {
    throw new Error(WINDOWS_PI_ERROR);
  }
  const canonicalAnchor = await verifyCanonicalWindowsPath(anchor, "file");
  const anchorDirectory = path.win32.dirname(canonicalAnchor);
  const modulesRoot =
    path.win32.basename(anchorDirectory).toLowerCase() === ".bin"
      ? path.win32.dirname(anchorDirectory)
      : path.win32.join(anchorDirectory, "node_modules");
  const packageRoot = await verifyCanonicalWindowsPath(
    path.win32.join(modulesRoot, "@earendil-works", "pi-coding-agent"),
    "directory",
  );
  const packageJsonPath = await verifyCanonicalWindowsPath(
    path.win32.join(packageRoot, "package.json"),
    "file",
  );
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
    bin?: { pi?: unknown };
    engines?: { node?: unknown };
  };
  if (
    manifest.name !== PI_PACKAGE_NAME ||
    typeof manifest.version !== "string" ||
    typeof manifest.bin?.pi !== "string" ||
    manifest.bin.pi !== PI_BIN_PATH ||
    typeof manifest.engines?.node !== "string"
  ) {
    throw new Error(WINDOWS_PI_ERROR);
  }
  parseExactVersion(manifest.version, EXACT_VERSION_PATTERN);
  assertNodeEngineSatisfied(manifest.engines.node);

  const unresolvedCli = path.win32.resolve(packageRoot, manifest.bin.pi);
  const cli = await verifyCanonicalWindowsPath(unresolvedCli, "file");

  const identity = Object.freeze({
    packageName: PI_PACKAGE_NAME,
    packageVersion: manifest.version,
    nodeEngine: manifest.engines.node,
  });
  return Object.freeze({
    executable: process.execPath,
    argvPrefix: Object.freeze([cli]) as readonly [string],
    identity,
  });
}

export async function locatePiInvocation(
  options: LocatePiOptions = {},
): Promise<PiInvocation> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const pathLookup =
    options.pathLookup ??
    ((command: string) => defaultPathLookup(command, platform, environment));

  try {
    if (platform !== "win32") throw new Error(WINDOWS_PI_ERROR);
    const explicit = environment.PI_COMMAND?.trim();
    if (explicit) return await verifyPiAnchor(explicit);

    for (const command of ["pi.cmd", "pi"] as const) {
      const located = await pathLookup(command);
      if (located !== undefined) return await verifyPiAnchor(located);
    }
    const appData =
      environment.APPDATA?.trim() ||
      path.win32.join(homeDirectory, "AppData", "Roaming");
    return await verifyPiAnchor(path.win32.join(appData, "npm", "pi.cmd"));
  } catch {
    throw new Error(WINDOWS_PI_ERROR);
  }
}

/**
 * Legacy string locator retained only while the Task 6 consumers migrate to
 * locatePiInvocation. Its POSIX behavior remains unchanged.
 */
export async function locatePi(options: LocatePiOptions = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const fileExists = options.fileExists ?? defaultFileExists;
  const pathLookup =
    options.pathLookup ??
    ((command: string) => defaultPathLookup(command, platform, environment));
  const checked: string[] = [];

  const explicit = environment.PI_COMMAND?.trim();
  if (explicit) {
    checked.push(explicit);
    if (await fileExists(explicit)) return explicit;
    const located = await pathLookup(explicit);
    if (located !== undefined) return located;
    throw new Error(
      platform === "win32"
        ? WINDOWS_PI_ERROR
        : `Pi executable not found: checked ${checked.join(", ")}`,
    );
  }

  const commands = platform === "win32" ? ["pi.cmd", "pi"] : ["pi"];
  for (const command of commands) {
    checked.push(`PATH:${command}`);
    const located = await pathLookup(command);
    if (located !== undefined) return located;
  }

  if (platform === "win32") {
    const appData =
      environment.APPDATA?.trim() ||
      path.win32.join(homeDirectory, "AppData", "Roaming");
    const candidate = path.win32.join(appData, "npm", "pi.cmd");
    checked.push(candidate);
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error(
    platform === "win32"
      ? WINDOWS_PI_ERROR
      : `Pi executable not found: checked ${checked.join(", ")}`,
  );
}
