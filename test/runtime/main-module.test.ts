import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isMainModule } from "../../src/runtime/main-module.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ESM main-module detection", () => {
  it("recognizes an npm-link style directory junction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-main-module-"));
    roots.push(root);
    const realDirectory = path.join(root, "real");
    const linkedDirectory = path.join(root, "linked");
    await mkdir(realDirectory);
    const entry = path.join(realDirectory, "cli.js");
    await writeFile(entry, "", "utf8");
    await symlink(realDirectory, linkedDirectory, "junction");

    expect(
      isMainModule(pathToFileURL(entry).href, path.join(linkedDirectory, "cli.js")),
    ).toBe(true);
  });

  it("rejects a genuinely different entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-main-module-"));
    roots.push(root);
    const first = path.join(root, "first.js");
    const second = path.join(root, "second.js");
    await writeFile(first, "", "utf8");
    await writeFile(second, "", "utf8");
    expect(isMainModule(pathToFileURL(first).href, second)).toBe(false);
  });
});
