import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveWindowsJobHelper,
  resolveWindowsJobHelperForModule,
} from "../../src/runtime/windows-job-helper.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const canonicalArtifact = resolve(
  repositoryRoot,
  "plugins",
  "codex-external-agents",
  "native",
  "win32-x64",
  "codex-agent-job-helper.exe",
);
const executableName = "codex-agent-job-helper.exe";
const temporaryRoots: string[] = [];

async function fixture(layout: "dist" | "plugin") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "cat-helper-resolver-")),
  );
  temporaryRoots.push(root);
  const pluginRoot = join(root, "plugins", "codex-external-agents");
  const artifactRoot = join(pluginRoot, "native", "win32-x64");
  const executablePath = join(artifactRoot, executableName);
  const manifestPath = `${executablePath}.sha256`;
  const modulePath =
    layout === "dist"
      ? join(root, "dist", "mcp.js")
      : join(pluginRoot, "runtime", "codex-external-agents-mcp.mjs");
  await mkdir(dirname(modulePath), { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(modulePath, "// fixture\n", "utf8");
  await copyFile(canonicalArtifact, executablePath);
  const bytes = await readFile(executablePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, `${digest}  ${executableName}\n`, "utf8");
  return {
    root,
    artifactRoot,
    executablePath,
    manifestPath,
    modulePath,
    digest,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows job helper resolver", () => {
  it.each(["dist", "plugin"] as const)(
    "resolves and verifies the canonical helper from the %s layout",
    async (layout) => {
      const value = await fixture(layout);
      await expect(
        resolveWindowsJobHelperForModule(
          pathToFileURL(value.modulePath).href,
          "win32",
          "x64",
        ),
      ).resolves.toEqual({
        executablePath: value.executablePath,
        sha256: value.digest,
      });
    },
  );

  it("keeps production resolution bound to its own module URL", async () => {
    expect(resolveWindowsJobHelper).toHaveLength(0);
    await expect(resolveWindowsJobHelper()).rejects.toThrow(
      "Windows job helper artifact validation failed.",
    );
  });

  it.each([
    "missing",
    "bad-manifest",
    "hash-drift",
    "non-x64",
    "extra-artifact",
  ] as const)(
    "fails closed for %s without exposing paths or hashes",
    async (kind) => {
      const value = await fixture("dist");
      if (kind === "missing") {
        await rm(value.executablePath);
      } else if (kind === "bad-manifest") {
        await writeFile(
          value.manifestPath,
          `${value.digest.toUpperCase()}  ${executableName}\n`,
        );
      } else if (kind === "hash-drift") {
        const bytes = await readFile(value.executablePath);
        const last = bytes.length - 1;
        bytes[last] = (bytes[last] ?? 0) ^ 1;
        await writeFile(value.executablePath, bytes);
      } else if (kind === "non-x64") {
        const bytes = await readFile(value.executablePath);
        const peOffset = bytes.readUInt32LE(0x3c);
        bytes.writeUInt16LE(0x014c, peOffset + 4);
        await writeFile(value.executablePath, bytes);
        const digest = createHash("sha256").update(bytes).digest("hex");
        await writeFile(value.manifestPath, `${digest}  ${executableName}\n`);
      } else {
        await writeFile(
          join(value.artifactRoot, "duplicate.exe"),
          "not a helper",
        );
      }

      let failure: unknown;
      try {
        await resolveWindowsJobHelperForModule(
          pathToFileURL(value.modulePath).href,
          "win32",
          "x64",
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "Windows job helper artifact validation failed.",
      );
      expect((failure as Error).message).not.toContain(value.root);
      expect((failure as Error).message).not.toContain(value.digest);
    },
  );

  it("rejects a reparse point in the canonical artifact path", async () => {
    const value = await fixture("dist");
    const realNative = join(value.root, "real-native");
    await mkdir(realNative);
    await copyFile(value.executablePath, join(realNative, executableName));
    await copyFile(
      value.manifestPath,
      join(realNative, `${executableName}.sha256`),
    );
    await rm(join(value.root, "plugins", "codex-external-agents", "native"), {
      recursive: true,
      force: true,
    });
    await symlink(
      realNative,
      join(value.root, "plugins", "codex-external-agents", "native"),
      "junction",
    );

    await expect(
      resolveWindowsJobHelperForModule(
        pathToFileURL(value.modulePath).href,
        "win32",
        "x64",
      ),
    ).rejects.toThrow("Windows job helper artifact validation failed.");
  });

  it("rejects unrecognized module layouts", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "cat-helper-layout-")),
    );
    temporaryRoots.push(root);
    const modulePath = join(root, "src", "runtime", "helper.js");
    await mkdir(dirname(modulePath), { recursive: true });
    await writeFile(modulePath, "// fixture\n");

    await expect(
      resolveWindowsJobHelperForModule(
        pathToFileURL(modulePath).href,
        "win32",
        "x64",
      ),
    ).rejects.toThrow("Windows job helper artifact validation failed.");
  });
});
