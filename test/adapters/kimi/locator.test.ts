import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { locateKimi } from "../../../src/adapters/kimi/locator.js";

const temporaryRoots: string[] = [];
const windowsIt = it.runIf(process.platform === "win32");

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createExecutable(name = "kimi.exe"): Promise<{
  root: string;
  executable: string;
}> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "kimi-locator-")),
  );
  temporaryRoots.push(root);
  const executable = path.join(root, name);
  await writeFile(executable, "not executed\n");
  return { root, executable };
}

async function expectFixedFailure(
  promise: Promise<unknown>,
  hiddenPath: string,
): Promise<void> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Kimi Code executable could not be verified",
  );
  expect((error as Error).message).not.toContain(hiddenPath);
}

describe("locateKimi", () => {
  it("preserves the POSIX explicit-command string behavior", async () => {
    await expect(
      locateKimi({
        environment: { KIMI_COMMAND: "/opt/kimi/bin/kimi" },
        platform: "linux",
        pathLookup: async () => "/usr/local/bin/kimi",
        fileExists: async (candidate) => candidate === "/opt/kimi/bin/kimi",
      }),
    ).resolves.toBe("/opt/kimi/bin/kimi");
  });

  it("preserves the POSIX PATH string behavior", async () => {
    await expect(
      locateKimi({
        environment: {},
        platform: "linux",
        pathLookup: async () => "/usr/local/bin/kimi",
        fileExists: async () => false,
      }),
    ).resolves.toBe("/usr/local/bin/kimi");
  });

  it("preserves the POSIX checked-location failure", async () => {
    await expect(
      locateKimi({
        environment: {},
        platform: "linux",
        pathLookup: async () => undefined,
        fileExists: async () => false,
      }),
    ).rejects.toThrow("Kimi Code executable not found: checked PATH:kimi");
  });

  windowsIt(
    "accepts a canonical absolute regular kimi.exe from KIMI_COMMAND",
    async () => {
      const fixture = await createExecutable();

      await expect(
        locateKimi({
          environment: { KIMI_COMMAND: fixture.executable },
          platform: "win32",
          pathLookup: async () => {
            throw new Error("explicit path must not fall through");
          },
        }),
      ).resolves.toBe(fixture.executable);
    },
  );

  windowsIt(
    "uses a verified PATH executable before the fixed installation path",
    async () => {
      const fixture = await createExecutable();

      await expect(
        locateKimi({
          environment: {},
          platform: "win32",
          homeDirectory: path.join(fixture.root, "unused-home"),
          pathLookup: async () => fixture.executable,
        }),
      ).resolves.toBe(fixture.executable);
    },
  );

  windowsIt(
    "accepts the verified fixed Windows user installation path",
    async () => {
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "kimi-home-")),
      );
      temporaryRoots.push(root);
      const executable = path.join(root, ".kimi-code", "bin", "kimi.exe");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, "not executed\n");

      await expect(
        locateKimi({
          environment: {},
          platform: "win32",
          homeDirectory: root,
          pathLookup: async () => undefined,
        }),
      ).resolves.toBe(executable);
    },
  );

  windowsIt.each([
    ["relative path", () => "kimi.exe"],
    [
      "noncanonical path",
      (root: string) => `${root}${path.sep}x${path.sep}..${path.sep}kimi.exe`,
    ],
    ["wrong extension", (root: string) => path.join(root, "kimi.cmd")],
    [
      "arbitrary executable name",
      (root: string) => path.join(root, "other.exe"),
    ],
  ])("rejects a %s with one redacted error", async (_name, selectPath) => {
    const fixture = await createExecutable();
    const candidate = selectPath(fixture.root);
    if (
      path.isAbsolute(candidate) &&
      !candidate.includes(`${path.sep}x${path.sep}..`)
    ) {
      await writeFile(candidate, "unused\n");
    }

    await expectFixedFailure(
      locateKimi({
        environment: { KIMI_COMMAND: candidate },
        platform: "win32",
      }),
      fixture.root,
    );
  });

  windowsIt("rejects a directory and a reparse point", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "kimi-reparse-")),
    );
    temporaryRoots.push(root);
    const directory = path.join(root, "kimi.exe");
    await mkdir(directory);
    await expectFixedFailure(
      locateKimi({
        environment: { KIMI_COMMAND: directory },
        platform: "win32",
      }),
      root,
    );

    await rm(directory, { recursive: true });
    const targetDirectory = path.join(root, "target");
    const linkedDirectory = path.join(root, "linked");
    await mkdir(targetDirectory);
    await writeFile(path.join(targetDirectory, "kimi.exe"), "unused\n");
    await symlink(targetDirectory, linkedDirectory, "junction");
    await expectFixedFailure(
      locateKimi({
        environment: {
          KIMI_COMMAND: path.join(linkedDirectory, "kimi.exe"),
        },
        platform: "win32",
      }),
      root,
    );
  });

  windowsIt(
    "rejects unverified PATH results instead of falling back",
    async () => {
      const fixture = await createExecutable("kimi.cmd");
      await expectFixedFailure(
        locateKimi({
          environment: {},
          platform: "win32",
          homeDirectory: path.join(fixture.root, "hidden-home"),
          pathLookup: async () => fixture.executable,
        }),
        fixture.root,
      );
    },
  );

  windowsIt(
    "does not disclose checked locations when discovery fails",
    async () => {
      const hiddenHome = "C:\\Users\\sensitive-user";
      await expectFixedFailure(
        locateKimi({
          environment: {},
          platform: "win32",
          homeDirectory: hiddenHome,
          pathLookup: async () => undefined,
        }),
        hiddenHome,
      );
    },
  );
});
