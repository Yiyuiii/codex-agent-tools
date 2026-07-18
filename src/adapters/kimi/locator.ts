import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

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
    throw new Error(`Kimi Code executable not found: checked ${checked.join(", ")}`);
  }

  checked.push("PATH:kimi");
  const fromPath = await pathLookup("kimi");
  if (fromPath !== undefined) {
    return fromPath;
  }

  if (platform === "win32") {
    const fixedPath = path.win32.join(
      homeDirectory,
      ".kimi-code",
      "bin",
      "kimi.exe",
    );
    checked.push(fixedPath);
    if (await fileExists(fixedPath)) {
      return fixedPath;
    }
  }

  throw new Error(`Kimi Code executable not found: checked ${checked.join(", ")}`);
}
