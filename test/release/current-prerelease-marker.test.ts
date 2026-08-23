import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  digestReleasePluginArtifactTree,
  RELEASE_PLUGIN_ARTIFACT_PATHS,
} from "../../src/release/release-validation.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

describe("current prerelease marker", () => {
  const packageManifest = readJson("package.json");
  const version = packageManifest.version;
  const markerPath =
    typeof version === "string" && version.includes("-")
      ? `.release-validation/v${version}.json`
      : null;

  it.skipIf(
    markerPath === null ||
      !existsSync(resolve(repositoryRoot, markerPath)),
  )("binds an existing current prerelease marker to the freshly built plugin tree", () => {
    expect(typeof version).toBe("string");
    expect(markerPath).not.toBeNull();
    if (typeof version !== "string" || markerPath === null) return;

    const marker = readJson(markerPath);
    expect(marker).toMatchObject({
      kind: "beta",
      package: {
        name: "codex-agent-tools",
        version,
        tag: `v${version}`,
        npmChannel: "next",
      },
    });
    const tree = marker.pluginArtifactTree as Record<string, unknown>;
    expect(
      digestReleasePluginArtifactTree(
        RELEASE_PLUGIN_ARTIFACT_PATHS.map((relativePath) => ({
          path: relativePath,
          content: readFileSync(resolve(repositoryRoot, relativePath)),
        })),
      ),
    ).toBe(tree.digestSha256);
  });
});
