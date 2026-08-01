import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTABLE_NAME = "codex-agent-job-helper.exe";
const MANIFEST_NAME = `${EXECUTABLE_NAME}.sha256`;
const FAILURE_MESSAGE = "Windows job helper artifact validation failed.";

export interface ResolvedWindowsJobHelper {
  readonly executablePath: string;
  readonly sha256: string;
}

function fail(): never {
  throw new Error(FAILURE_MESSAGE);
}

function samePath(left: string, right: string): boolean {
  return (
    path.resolve(left).localeCompare(path.resolve(right), "en-US", {
      sensitivity: "accent",
    }) === 0
  );
}

async function assertNoReparseExistingPath(candidate: string): Promise<void> {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep)) {
    if (segment === "") continue;
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) fail();
  }
  const canonical = await realpath(absolute);
  if (!samePath(canonical, absolute)) fail();
}

function resolvePluginRoot(modulePath: string): string {
  const moduleDirectory = path.dirname(modulePath);
  if (path.basename(moduleDirectory).toLowerCase() === "dist") {
    return path.join(
      path.dirname(moduleDirectory),
      "plugins",
      "codex-external-agents",
    );
  }

  const pluginRoot = path.dirname(moduleDirectory);
  if (
    path.basename(moduleDirectory).toLowerCase() === "runtime" &&
    path.basename(pluginRoot).toLowerCase() === "codex-external-agents" &&
    path.basename(path.dirname(pluginRoot)).toLowerCase() === "plugins"
  ) {
    return pluginRoot;
  }
  return fail();
}

function assertX64ManagedPe(bytes: Buffer): void {
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") fail();
  const peOffset = bytes.readUInt32LE(0x3c);
  const optionalHeader = peOffset + 24;
  if (
    peOffset > bytes.length - 24 ||
    bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0" ||
    bytes.readUInt16LE(peOffset + 4) !== 0x8664 ||
    bytes.readUInt16LE(optionalHeader) !== 0x20b
  ) {
    fail();
  }

  const optionalHeaderBytes = bytes.readUInt16LE(peOffset + 20);
  const dataDirectories = optionalHeader + 112;
  const clrDirectory = dataDirectories + 14 * 8;
  if (
    optionalHeaderBytes < 112 + 15 * 8 ||
    clrDirectory > bytes.length - 8 ||
    bytes.readUInt32LE(optionalHeader + 108) < 15 ||
    bytes.readUInt32LE(clrDirectory) === 0 ||
    bytes.readUInt32LE(clrDirectory + 4) === 0
  ) {
    fail();
  }
}

/** @internal Tests inject only the loaded module identity, never an artifact path. */
export async function resolveWindowsJobHelperForModule(
  moduleUrl: string,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): Promise<ResolvedWindowsJobHelper> {
  try {
    if (platform !== "win32" || architecture !== "x64") fail();
    const modulePath = fileURLToPath(moduleUrl);
    const pluginRoot = resolvePluginRoot(modulePath);
    const artifactRoot = path.join(pluginRoot, "native", "win32-x64");
    const executablePath = path.join(artifactRoot, EXECUTABLE_NAME);
    const manifestPath = path.join(artifactRoot, MANIFEST_NAME);

    await assertNoReparseExistingPath(pluginRoot);
    await assertNoReparseExistingPath(artifactRoot);
    await assertNoReparseExistingPath(executablePath);
    await assertNoReparseExistingPath(manifestPath);

    const entries = (await readdir(artifactRoot)).sort();
    if (
      entries.length !== 2 ||
      entries[0] !== EXECUTABLE_NAME ||
      entries[1] !== MANIFEST_NAME
    ) {
      fail();
    }

    const [bytes, manifest] = await Promise.all([
      readFile(executablePath),
      readFile(manifestPath, "utf8"),
    ]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (manifest !== `${digest}  ${EXECUTABLE_NAME}\n`) fail();
    assertX64ManagedPe(bytes);
    return Object.freeze({ executablePath, sha256: digest });
  } catch {
    return fail();
  }
}

export async function resolveWindowsJobHelper(): Promise<ResolvedWindowsJobHelper> {
  return resolveWindowsJobHelperForModule(import.meta.url);
}
