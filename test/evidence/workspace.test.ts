import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureWorkspace,
  compareWorkspace,
} from "../../src/evidence/workspace.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "codex-agent-evidence-"));
  await execa("git", ["init"], { cwd });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd });
  await execa("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(path.join(cwd, "tracked.txt"), "original", "utf8");
  await execa("git", ["add", "tracked.txt"], { cwd });
  await execa("git", ["commit", "-m", "initial"], { cwd });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("workspace evidence", () => {
  it("detects created, modified, and deleted files from content", async () => {
    await writeFile(path.join(cwd, "delete.txt"), "delete", "utf8");
    await execa("git", ["add", "delete.txt"], { cwd });
    await execa("git", ["commit", "-m", "add delete fixture"], { cwd });
    const before = await captureWorkspace(cwd, { includeGitDiff: true });

    await writeFile(path.join(cwd, "tracked.txt"), "modified", "utf8");
    await writeFile(path.join(cwd, "new.txt"), "new", "utf8");
    await unlink(path.join(cwd, "delete.txt"));
    const after = await captureWorkspace(cwd, { includeGitDiff: true });
    const comparison = compareWorkspace(before, after);

    expect(comparison).toMatchObject({
      created: ["new.txt"],
      modified: ["tracked.txt"],
      deleted: ["delete.txt"],
      filesChanged: ["delete.txt", "new.txt", "tracked.txt"],
    });
    expect(before.kind).toBe("git");
    expect(after.gitStatus).toContain("tracked.txt");
    expect(after.gitDiff).toContain("modified");
    expect(before.fingerprint).not.toBe(after.fingerprint);
  });

  it("ignores .git, node_modules, and dist implementation noise", async () => {
    const before = await captureWorkspace(cwd);
    await writeFile(path.join(cwd, ".git", "bridge-noise"), "x", "utf8");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true }),
    );
    await writeFile(path.join(cwd, "node_modules", "pkg", "x.js"), "x", "utf8");
    const after = await captureWorkspace(cwd);
    expect(compareWorkspace(before, after).filesChanged).toEqual([]);
  });

  it("falls back to a filesystem snapshot outside Git", async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), "codex-agent-plain-"));
    try {
      await writeFile(path.join(plain, "a.txt"), "a", "utf8");
      const before = await captureWorkspace(plain);
      await writeFile(path.join(plain, "a.txt"), "b", "utf8");
      const after = await captureWorkspace(plain);
      expect(before.kind).toBe("filesystem");
      expect(compareWorkspace(before, after).modified).toEqual(["a.txt"]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
