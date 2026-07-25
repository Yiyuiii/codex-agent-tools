import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lstatState = vi.hoisted(() => ({
  mock: vi.fn(),
  real: undefined as
    | typeof import("node:fs/promises").lstat
    | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  lstatState.real = actual.lstat;
  return { ...actual, lstat: lstatState.mock };
});

import { snapshotDirectory } from "../../src/plugin/state-snapshot.js";

const temporaryRoots: string[] = [];

async function realLstat(...args: unknown[]): Promise<unknown> {
  if (lstatState.real === undefined) {
    throw new Error("Real lstat was not initialized");
  }
  return Reflect.apply(lstatState.real, undefined, args);
}

beforeEach(() => {
  lstatState.mock.mockImplementation(realLstat);
});

afterEach(async () => {
  lstatState.mock.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

describe("snapshotDirectory disappearing entries", () => {
  it("propagates ENOENT when the first nested file disappears after the root exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-snapshot-race-"));
    temporaryRoots.push(root);
    const disappearingFile = resolve(root, "disappearing.txt");
    await writeFile(disappearingFile, "present during readdir", "utf8");
    lstatState.mock.mockImplementation(async (...args: unknown[]) => {
      if (resolve(String(args[0])) === disappearingFile) {
        throw Object.assign(new Error("nested entry disappeared"), {
          code: "ENOENT",
        });
      }
      return realLstat(...args);
    });

    await expect(snapshotDirectory(root)).rejects.toMatchObject({
      code: "ENOENT",
      message: "nested entry disappeared",
    });
  });
});
