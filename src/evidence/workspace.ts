import { createHash } from "node:crypto";
import { opendir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);
const MAX_GIT_EVIDENCE_CHARS = 200_000;

interface FileEvidence {
  kind: "file" | "symlink";
  hash: string;
}

export interface WorkspaceSnapshot {
  kind: "git" | "filesystem";
  cwd: string;
  fingerprint: string;
  entries: ReadonlyMap<string, FileEvidence>;
  gitStatus: string;
  gitDiff: string;
}

export interface WorkspaceComparison {
  created: string[];
  modified: string[];
  deleted: string[];
  filesChanged: string[];
}

export interface CaptureWorkspaceOptions {
  includeGitDiff?: boolean;
  includeUntracked?: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function collectEntries(
  root: string,
  current: string,
  output: Map<string, FileEvidence>,
): Promise<void> {
  const directory = await opendir(current);
  for await (const entry of directory) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const absolute = path.join(current, entry.name);
    const relative = normalizeRelativePath(path.relative(root, absolute));
    if (entry.isDirectory()) {
      await collectEntries(root, absolute, output);
    } else if (entry.isSymbolicLink()) {
      output.set(relative, { kind: "symlink", hash: sha256(await readlink(absolute)) });
    } else if (entry.isFile()) {
      output.set(relative, { kind: "file", hash: sha256(await readFile(absolute)) });
    }
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string }> {
  const result = await execa("git", [...args], {
    cwd,
    reject: false,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { ok: result.exitCode === 0, stdout: result.stdout };
}

function limitEvidence(value: string): string {
  if (value.length <= MAX_GIT_EVIDENCE_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_GIT_EVIDENCE_CHARS)}\n[TRUNCATED]`;
}

export async function captureWorkspace(
  cwd: string,
  options: CaptureWorkspaceOptions = {},
): Promise<WorkspaceSnapshot> {
  const root = await realpath(cwd);
  const entries = new Map<string, FileEvidence>();
  await collectEntries(root, root, entries);

  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  const kind =
    inside.ok && inside.stdout.trim() === "true" ? "git" : "filesystem";
  let gitStatus = "";
  let fullGitDiff = "";
  if (kind === "git") {
    const untracked = options.includeUntracked === false ? "no" : "all";
    const [status, worktreeDiff, stagedDiff] = await Promise.all([
      runGit(root, [
        "status",
        "--porcelain=v1",
        "-z",
        `--untracked-files=${untracked}`,
      ]),
      runGit(root, ["diff", "--no-ext-diff", "--binary"]),
      runGit(root, ["diff", "--cached", "--no-ext-diff", "--binary"]),
    ]);
    gitStatus = status.stdout;
    fullGitDiff = [worktreeDiff.stdout, stagedDiff.stdout]
      .filter((value) => value !== "")
      .join("\n");
  }

  const serializedEntries = [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, evidence]) => `${name}\0${evidence.kind}\0${evidence.hash}`)
    .join("\n");
  const fingerprint = sha256(
    `${kind}\n${serializedEntries}\n${sha256(gitStatus)}\n${sha256(fullGitDiff)}`,
  );

  return {
    kind,
    cwd: root,
    fingerprint,
    entries,
    gitStatus: limitEvidence(gitStatus),
    gitDiff: options.includeGitDiff ? limitEvidence(fullGitDiff) : "",
  };
}

export function compareWorkspace(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceComparison {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [name, afterEvidence] of after.entries) {
    const beforeEvidence = before.entries.get(name);
    if (beforeEvidence === undefined) {
      created.push(name);
    } else if (
      beforeEvidence.kind !== afterEvidence.kind ||
      beforeEvidence.hash !== afterEvidence.hash
    ) {
      modified.push(name);
    }
  }
  for (const name of before.entries.keys()) {
    if (!after.entries.has(name)) {
      deleted.push(name);
    }
  }

  created.sort();
  modified.sort();
  deleted.sort();
  return {
    created,
    modified,
    deleted,
    filesChanged: [...created, ...modified, ...deleted].sort(),
  };
}
