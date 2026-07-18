import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

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
    throw new Error(`Pi executable not found: checked ${checked.join(", ")}`);
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

  throw new Error(`Pi executable not found: checked ${checked.join(", ")}`);
}
