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

describe("GitHub release workflows", () => {
  it("runs the deterministic matrix on main and next across supported Node versions", () => {
    const content = workflow("ci.yml");

    expect(content).toContain("branches: [main, next]");
    expect(content).toContain("node-version: [20, 22, 24]");
    expect(content).toContain("fail-fast: false");
    expect(content).toContain("CODEX_CLI_VERSION: 0.146.0");
    expect(content).toContain(
      'npm install --global "@openai/codex@${CODEX_CLI_VERSION}"',
    );
    expect(content).toContain(
      'test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}"',
    );
    expect(content).toContain("npm ci");
    expect(content).toContain("npm run typecheck");
    expect(content).toContain("npm test -- --maxWorkers=1");
    expect(content).toContain("npm run smoke:release");
  });

  it("publishes prereleases from next and stable releases from main through OIDC", () => {
    const content = workflow("release.yml");

    expect(content).toContain('tags:\n      - "v*"');
    expect(content).toContain("id-token: write");
    expect(content).toContain("Verify tag ref");
    expect(content).toContain(
      'if [[ "$GITHUB_REF" != refs/tags/v* ]]; then',
    );
    expect(content).toContain("CODEX_CLI_VERSION: 0.146.0");
    expect(content).toContain(
      'npm install --global "@openai/codex@${CODEX_CLI_VERSION}"',
    );
    expect(content).toContain(
      'test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}"',
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
    expect(content).toContain("npm test -- --maxWorkers=1");
    expect(content).toContain("npm run smoke:release");
    expect(content).toContain(
      'npm publish --ignore-scripts --tag "${{ steps.channel.outputs.npm_tag }}" --access public',
    );
    expect(content).toContain("Waiting for npm registry propagation");
    expect(content).toContain("Create or update GitHub Release");
  });
});
