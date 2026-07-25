import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface StateFile {
  path: string;
  size: number;
  sha256: string;
}

export interface StateSnapshot {
  files: StateFile[];
}

export interface StateDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

function relativeStatePath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

export async function snapshotDirectory(root: string): Promise<StateSnapshot> {
  const absoluteRoot = resolve(root);
  const files: StateFile[] = [];

  async function visit(path: string): Promise<void> {
    const metadata = await lstat(path);
    const statePath = relativeStatePath(absoluteRoot, path);

    if (metadata.isSymbolicLink()) {
      throw new Error(`Symbolic link is not allowed in state snapshot: ${statePath}`);
    }

    if (metadata.isDirectory()) {
      const entries = await readdir(path);
      entries.sort((left, right) => left.localeCompare(right));
      for (const entry of entries) {
        await visit(resolve(path, entry));
      }
      return;
    }

    if (!metadata.isFile()) {
      throw new Error(`Unsupported filesystem entry in state snapshot: ${statePath}`);
    }

    const bytes = await readFile(path);
    files.push({
      path: statePath,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  try {
    await visit(absoluteRoot);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      files.length === 0
    ) {
      return { files: [] };
    }
    throw error;
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files };
}

export function diffSnapshots(
  before: StateSnapshot,
  after: StateSnapshot,
): StateDiff {
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [path, file] of afterFiles) {
    const previous = beforeFiles.get(path);
    if (previous === undefined) {
      added.push(path);
    } else if (
      previous.size !== file.size ||
      previous.sha256 !== file.sha256
    ) {
      changed.push(path);
    }
  }

  for (const path of beforeFiles.keys()) {
    if (!afterFiles.has(path)) {
      removed.push(path);
    }
  }

  added.sort((left, right) => left.localeCompare(right));
  changed.sort((left, right) => left.localeCompare(right));
  removed.sort((left, right) => left.localeCompare(right));
  return { added, changed, removed };
}
