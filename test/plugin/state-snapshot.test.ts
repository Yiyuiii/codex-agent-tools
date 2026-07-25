import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  diffSnapshots,
  snapshotDirectory,
  type StateSnapshot,
} from "../../src/plugin/state-snapshot.js";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-plugin-state-snapshot-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

describe("snapshotDirectory", () => {
  it("records nested files as sorted relative paths with byte hashes", async () => {
    const root = await createTemporaryRoot();
    await mkdir(join(root, "plugins", "cache"), { recursive: true });
    await writeFile(join(root, "plugins", "cache", "item.json"), "{}\n");
    await writeFile(join(root, "config.toml"), "base");

    await expect(snapshotDirectory(root)).resolves.toEqual({
      files: [
        {
          path: "config.toml",
          size: 4,
          sha256: createHash("sha256").update("base").digest("hex"),
        },
        {
          path: "plugins/cache/item.json",
          size: 3,
          sha256: createHash("sha256").update("{}\n").digest("hex"),
        },
      ],
    });
  });

  it("hashes raw bytes instead of decoded text", async () => {
    const root = await createTemporaryRoot();
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41]);
    await writeFile(join(root, "binary.bin"), bytes);

    await expect(snapshotDirectory(root)).resolves.toEqual({
      files: [
        {
          path: "binary.bin",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    });
  });

  it("returns an empty snapshot for a missing root", async () => {
    const root = await createTemporaryRoot();
    const missing = join(root, "not-created");

    await expect(snapshotDirectory(missing)).resolves.toEqual({ files: [] });
  });

  it("rejects symbolic links instead of traversing them", async () => {
    const root = await createTemporaryRoot();
    const outside = await createTemporaryRoot();
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "escape"), "junction");

    await expect(snapshotDirectory(root)).rejects.toThrow(
      /symbolic link.*escape/i,
    );
  });
});

describe("diffSnapshots", () => {
  it("sorts added, changed, and removed paths", () => {
    const before: StateSnapshot = {
      files: [
        { path: "old-state", size: 1, sha256: "old" },
        { path: "config.toml", size: 4, sha256: "before" },
        { path: "same", size: 2, sha256: "same" },
      ],
    };
    const after: StateSnapshot = {
      files: [
        { path: "same", size: 2, sha256: "same" },
        { path: "plugins/cache/new.json", size: 3, sha256: "new" },
        { path: "config.toml", size: 4, sha256: "after" },
      ],
    };

    expect(diffSnapshots(before, after)).toEqual({
      added: ["plugins/cache/new.json"],
      changed: ["config.toml"],
      removed: ["old-state"],
    });
  });

  it("treats size-only changes as changed", () => {
    expect(
      diffSnapshots(
        { files: [{ path: "state", size: 1, sha256: "same" }] },
        { files: [{ path: "state", size: 2, sha256: "same" }] },
      ),
    ).toEqual({ added: [], changed: ["state"], removed: [] });
  });
});
