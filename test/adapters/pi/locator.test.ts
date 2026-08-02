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

import {
  locatePi,
  locatePiInvocation,
  type PiInvocation,
} from "../../../src/adapters/pi/locator.js";

const temporaryRoots: string[] = [];
const windowsIt = it.runIf(process.platform === "win32");

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

interface PiFixture {
  root: string;
  shim: string;
  packageRoot: string;
  cli: string;
  manifest: Record<string, unknown>;
}

async function createPiFixture(): Promise<PiFixture> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "pi-locator-")),
  );
  temporaryRoots.push(root);
  const npmRoot = path.join(root, "npm");
  const packageRoot = path.join(
    npmRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const shim = path.join(npmRoot, "pi.cmd");
  const cli = path.join(packageRoot, "dist", "cli.js");
  const manifest: Record<string, unknown> = {
    name: "@earendil-works/pi-coding-agent",
    version: "0.80.10",
    bin: { pi: "dist/cli.js" },
    engines: { node: ">=22.19.0" },
  };
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(
    shim,
    "@echo this text is intentionally never parsed or executed\r\n",
  );
  await writeFile(cli, "process.stdout.write('unused');\n");
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest),
  );
  return { root, shim, packageRoot, cli, manifest };
}

async function writeManifest(fixture: PiFixture): Promise<void> {
  await writeFile(
    path.join(fixture.packageRoot, "package.json"),
    JSON.stringify(fixture.manifest),
  );
}

async function expectFixedFailure(
  promise: Promise<unknown>,
  hiddenPath: string,
): Promise<void> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Pi installation could not be verified",
  );
  expect((error as Error).message).not.toContain(hiddenPath);
}

describe("locatePi", () => {
  it("preserves the POSIX explicit-command string behavior", async () => {
    await expect(
      locatePi({
        environment: { PI_COMMAND: "/opt/pi/bin/pi" },
        platform: "linux",
        homeDirectory: "/home/test",
        pathLookup: async () => "/usr/local/bin/pi",
        fileExists: async (candidate) => candidate === "/opt/pi/bin/pi",
      }),
    ).resolves.toBe("/opt/pi/bin/pi");
  });

  it("preserves the POSIX PATH string behavior", async () => {
    await expect(
      locatePi({
        environment: {},
        platform: "linux",
        pathLookup: async (command) =>
          command === "pi" ? "/usr/local/bin/pi" : undefined,
        fileExists: async () => false,
      }),
    ).resolves.toBe("/usr/local/bin/pi");
  });

  it("preserves the POSIX checked-location failure", async () => {
    await expect(
      locatePi({
        environment: {},
        platform: "linux",
        pathLookup: async () => undefined,
        fileExists: async () => false,
      }),
    ).rejects.toThrow("Pi executable not found: checked PATH:pi");
  });

  windowsIt(
    "returns a verified Windows Node invocation without reading shim text",
    async () => {
      const fixture = await createPiFixture();
      const canonicalCli = await realpath(fixture.cli);

      const invocation: PiInvocation = await locatePiInvocation({
        environment: { PI_COMMAND: fixture.shim },
        platform: "win32",
        pathLookup: async () => {
          throw new Error("explicit anchor must not fall through to PATH");
        },
      });

      expect(invocation).toEqual({
        executable: process.execPath,
        argvPrefix: [canonicalCli],
        identity: {
          packageName: "@earendil-works/pi-coding-agent",
          packageVersion: "0.80.10",
          nodeEngine: ">=22.19.0",
        },
      });
      expect(Object.isFrozen(invocation)).toBe(true);
      expect(Object.isFrozen(invocation.argvPrefix)).toBe(true);
      expect(Object.isFrozen(invocation.identity)).toBe(true);
    },
  );

  windowsIt(
    "uses a verified PATH shim before the Windows npm fallback",
    async () => {
      const fixture = await createPiFixture();

      await expect(
        locatePiInvocation({
          environment: { APPDATA: path.join(fixture.root, "unused") },
          platform: "win32",
          pathLookup: async (command) =>
            command === "pi.cmd" ? fixture.shim : undefined,
        }),
      ).resolves.toMatchObject({
        executable: process.execPath,
        identity: { packageVersion: "0.80.10" },
      });
    },
  );

  windowsIt("supports the known Windows global npm fallback", async () => {
    const fixture = await createPiFixture();

    await expect(
      locatePiInvocation({
        environment: { APPDATA: fixture.root },
        platform: "win32",
        homeDirectory: path.join(fixture.root, "home"),
        pathLookup: async () => undefined,
      }),
    ).resolves.toMatchObject({
      executable: process.execPath,
      identity: { packageName: "@earendil-works/pi-coding-agent" },
    });
  });

  windowsIt.each([
    ["relative anchor", () => "pi.cmd"],
    [
      "noncanonical anchor",
      (fixture: PiFixture) =>
        `${fixture.root}${path.sep}x${path.sep}..${path.sep}npm${path.sep}pi.cmd`,
    ],
    [
      "arbitrary executable",
      (fixture: PiFixture) => path.join(path.dirname(fixture.shim), "pi.exe"),
    ],
    [
      "arbitrary script",
      (fixture: PiFixture) =>
        path.join(path.dirname(fixture.shim), "custom.cmd"),
    ],
  ])("rejects a %s with one redacted error", async (_name, selectAnchor) => {
    const fixture = await createPiFixture();
    const anchor = selectAnchor(fixture);
    if (
      path.isAbsolute(anchor) &&
      !anchor.includes(`${path.sep}x${path.sep}..`)
    ) {
      await writeFile(anchor, "unused\n");
    }

    await expectFixedFailure(
      locatePiInvocation({
        environment: { PI_COMMAND: anchor },
        platform: "win32",
      }),
      fixture.root,
    );
  });

  windowsIt(
    "rejects a reparse point anywhere in the package path",
    async () => {
      const fixture = await createPiFixture();
      const realPackage = path.join(fixture.root, "real-package");
      const packageParent = path.dirname(fixture.packageRoot);
      await mkdir(path.dirname(realPackage), { recursive: true });
      await rm(fixture.packageRoot, { recursive: true });
      await mkdir(path.join(realPackage, "dist"), { recursive: true });
      await writeFile(path.join(realPackage, "dist", "cli.js"), "unused\n");
      await writeFile(
        path.join(realPackage, "package.json"),
        JSON.stringify(fixture.manifest),
      );
      await mkdir(packageParent, { recursive: true });
      await symlink(realPackage, fixture.packageRoot, "junction");

      await expectFixedFailure(
        locatePiInvocation({
          environment: { PI_COMMAND: fixture.shim },
          platform: "win32",
        }),
        fixture.root,
      );
    },
  );

  windowsIt.each([
    ["package name", { name: "untrusted-package" }],
    ["package version", { version: "v0.80" }],
    ["bin.pi", { bin: { pi: "dist/other.js" } }],
    ["engine syntax", { engines: { node: "^24.0.0" } }],
    ["unsatisfied engine", { engines: { node: ">=999.0.0" } }],
  ])("rejects invalid %s metadata", async (_name, replacement) => {
    const fixture = await createPiFixture();
    Object.assign(fixture.manifest, replacement);
    await writeManifest(fixture);

    await expectFixedFailure(
      locatePiInvocation({
        environment: { PI_COMMAND: fixture.shim },
        platform: "win32",
      }),
      fixture.root,
    );
  });

  windowsIt(
    "does not disclose checked locations when discovery fails",
    async () => {
      const hiddenHome = "C:\\Users\\sensitive-user";
      await expectFixedFailure(
        locatePiInvocation({
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
