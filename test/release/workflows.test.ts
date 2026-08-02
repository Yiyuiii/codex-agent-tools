import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

function workflow(name: string): string {
  return readFileSync(
    resolve(repositoryRoot, ".github", "workflows", name),
    "utf8",
  ).replaceAll("\r\n", "\n");
}

function packageManifest(): {
  config?: { codexCliVersion?: unknown };
  scripts?: Record<string, string>;
} {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as {
    config?: { codexCliVersion?: unknown };
    scripts?: Record<string, string>;
  };
}

describe("GitHub release workflows", () => {
  it("runs one honest Node 24 CI job on main and next", () => {
    const content = workflow("ci.yml");

    expect(content).toContain("branches: [main, next]");
    expect(content.match(/node-version:/gu)).toHaveLength(1);
    expect(content).toContain("node-version: 24");
    expect(content).not.toContain("matrix:");
    expect(content).not.toContain("fail-fast:");
    expect(content).not.toContain("${{ matrix.node-version }}");
    expect(content).not.toContain("actions/upload-artifact");
    expect(content).not.toContain("CODEX_CLI_VERSION:");
    expect(content).toContain(
      "require('./package.json').config.codexCliVersion",
    );
    expect(content).toContain(
      'npm install --global "@openai/codex@${codex_cli_version}"',
    );
    expect(content).toContain(
      'test "$(codex --version)" = "codex-cli ${codex_cli_version}"',
    );
    expect(content).toContain("npm ci");
    expect(content.match(/npm run gate:offline/gu)).toHaveLength(1);
    expect(content).not.toContain("npm run typecheck");
    expect(content).not.toContain("npm test");
    expect(content).not.toContain("npm run smoke:release");
  });

  it("publishes prereleases from next and stable releases from main through OIDC", () => {
    const content = workflow("release.yml");

    expect(content).toContain('tags:\n      - "v*"');
    expect(content).toContain("id-token: write");
    expect(content).toContain("Verify tag ref");
    expect(content).toContain(
      'if [[ "$GITHUB_REF" != refs/tags/v* ]]; then',
    );
    expect(content).not.toContain("CODEX_CLI_VERSION:");
    expect(content.match(/node-version:/gu)).toHaveLength(1);
    expect(content).toContain("node-version: 24");
    expect(content).not.toContain("matrix:");
    expect(content).toContain(
      "require('./package.json').config.codexCliVersion",
    );
    expect(content).toContain(
      'npm install --global "@openai/codex@${codex_cli_version}"',
    );
    expect(content).toContain(
      'test "$(codex --version)" = "codex-cli ${codex_cli_version}"',
    );
    expect(content).toContain("npm_tag=next");
    expect(content).toContain("required_branch=origin/next");
    expect(content).toContain("npm_tag=latest");
    expect(content).toContain("required_branch=origin/main");
    expect(content).toContain("package.json version");
    expect(content).toContain("git merge-base --is-ancestor");
    expect(content).toContain(".release-validation/v${tag_version}.md");
    for (const marker of [
      "Doctor: pass",
      "Local-Npm-Smoke: pass",
      "MCP-Smoke: pass",
      "Plugin-Isolated: pass",
      "Capability-Index: pass",
      "Release-Review: pass",
      "RC: v",
    ]) {
      expect(content).toContain(marker);
    }
    expect(content.match(/npm run gate:offline/gu)).toHaveLength(1);
    expect(content).not.toContain("npm run typecheck");
    expect(content).not.toContain("npm test");
    expect(content).not.toContain("npm run smoke:release");
    expect(content).not.toContain("actions/upload-artifact");
    expect(content).not.toContain("npm-pack-dry-run.json");
    expect(content).not.toContain("npm pack --dry-run");
    expect(content).toContain(
      'npm view "codex-agent-tools@${version}" version',
    );
    expect(content).toContain(
      'npm view "codex-agent-tools@${npm_tag}" version',
    );
    expect(content.match(/npm view /gu)).toHaveLength(3);
    const existingCheck = content.slice(
      content.indexOf("- name: Check whether the version already exists"),
      content.indexOf("- name: Publish package through npm OIDC"),
    );
    expect(existingCheck).not.toContain("2>/dev/null || true");
    expect(existingCheck).toContain('view_status="$?"');
    expect(existingCheck).toContain(
      "npm (error|ERR!)[[:space:]]+code[[:space:]]+E404",
    );
    expect(existingCheck).toContain(
      "Unable to determine whether the package version already exists",
    );
    expect(existingCheck).not.toContain(
      'echo "${view_output}"',
    );
    expect(content).toContain(
      'npm publish --ignore-scripts --tag "${{ steps.channel.outputs.npm_tag }}" --access public --registry=https://registry.npmjs.org/',
    );
    expect(content).toContain("Waiting for npm registry propagation");
    expect(content).toContain('echo "- CI runtime: Node 24"');
    expect(content).not.toContain("CI matrix: Node 20/22/24");
    expect(content).toContain("Create or update GitHub Release");
  });

  it("keeps one pinned Codex CLI source and one deterministic offline gate", () => {
    const manifest = packageManifest();
    const version = manifest.config?.codexCliVersion;
    const scripts = manifest.scripts ?? {};

    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(scripts["test:deterministic"]).toBe(
      "vitest run --maxWorkers=1",
    );
    expect(scripts["smoke:release:built"]).toBe(
      "node scripts/release-smoke.mjs",
    );
    expect(scripts["gate:offline"]).toBe(
      "npm run build && npm run typecheck && npm run test:deterministic && npm run smoke:release:built",
    );
    expect(scripts["smoke:release"]).toBe(
      "npm run build && npm run smoke:release:built",
    );
    expect(scripts.prepublishOnly).toBe("npm run gate:offline");
    expect(scripts["gate:offline"]).not.toMatch(
      /native:verify|acceptance:|smoke:kimi|smoke:ark|qualify:/u,
    );
  });

  it("keeps release smoke deterministic and offline", () => {
    const content = readFileSync(
      resolve(repositoryRoot, "scripts", "release-smoke.mjs"),
      "utf8",
    );

    expect(content).toContain('runNpm(["pack", "--dry-run", "--json"])');
    expect(content.match(/runNpm\(/gu)).toHaveLength(2);
    expect(content).not.toContain("checkNpmNameAvailability");
    expect(content).not.toContain("assertNpmPackageIdentity");
    expect(content).not.toContain('"view"');
    expect(content).not.toMatch(/\bfetch\s*\(/u);
    expect(content).not.toMatch(/npm\s+view|registry\.npmjs\.org/iu);
    expect(content).toContain("verifyReleaseWindowsJobHelperArtifact");
  });
});
