import { access, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

const WINDOWS_KIMI_ERROR = "Kimi Code executable could not be verified";

export interface LocateKimiOptions {
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
  if (result.exitCode !== 0) {
    return undefined;
  }
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
      throw new Error(WINDOWS_KIMI_ERROR);
    }
  }
}

async function verifyWindowsKimiExecutable(candidate: string): Promise<string> {
  if (
    candidate.includes("\0") ||
    !path.win32.isAbsolute(candidate) ||
    !isLexicallyCanonicalWindowsPath(candidate) ||
    path.win32.basename(candidate).toLowerCase() !== "kimi.exe"
  ) {
    throw new Error(WINDOWS_KIMI_ERROR);
  }
  await assertNoWindowsReparsePoint(candidate);
  const [canonical, status] = await Promise.all([
    realpath(candidate),
    lstat(candidate),
  ]);
  if (!sameWindowsPath(candidate, canonical) || !status.isFile()) {
    throw new Error(WINDOWS_KIMI_ERROR);
  }
  return canonical;
}

async function locateWindowsKimi(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  pathLookup: (command: string) => Promise<string | undefined>,
): Promise<string> {
  try {
    const explicit = environment.KIMI_COMMAND?.trim();
    if (explicit) {
      return await verifyWindowsKimiExecutable(explicit);
    }

    const fromPath = await pathLookup("kimi");
    if (fromPath !== undefined) {
      return await verifyWindowsKimiExecutable(fromPath);
    }

    return await verifyWindowsKimiExecutable(
      path.win32.join(homeDirectory, ".kimi-code", "bin", "kimi.exe"),
    );
  } catch {
    throw new Error(WINDOWS_KIMI_ERROR);
  }
}

async function locatePosixKimi(
  environment: NodeJS.ProcessEnv,
  pathLookup: (command: string) => Promise<string | undefined>,
  fileExists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const checked: string[] = [];
  const explicit = environment.KIMI_COMMAND?.trim();
  if (explicit) {
    checked.push(explicit);
    if (await fileExists(explicit)) {
      return explicit;
    }
    const locatedExplicit = await pathLookup(explicit);
    if (locatedExplicit !== undefined) {
      return locatedExplicit;
    }
    throw new Error(
      `Kimi Code executable not found: checked ${checked.join(", ")}`,
    );
  }

  checked.push("PATH:kimi");
  const fromPath = await pathLookup("kimi");
  if (fromPath !== undefined) {
    return fromPath;
  }
  throw new Error(
    `Kimi Code executable not found: checked ${checked.join(", ")}`,
  );
}

export async function locateKimi(
  options: LocateKimiOptions = {},
): Promise<string> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const fileExists = options.fileExists ?? defaultFileExists;
  const pathLookup =
    options.pathLookup ??
    ((command: string) => defaultPathLookup(command, platform, environment));

  return platform === "win32"
    ? locateWindowsKimi(environment, homeDirectory, pathLookup)
    : locatePosixKimi(environment, pathLookup, fileExists);
}
