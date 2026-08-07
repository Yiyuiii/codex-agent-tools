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

function packageScripts(): Record<string, string> {
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  return manifest.scripts ?? {};
}

function packageCodexCliVersion(): unknown {
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as { config?: { codexCliVersion?: unknown } };
  return manifest.config?.codexCliVersion;
}

function expectSingleNode24Job(content: string): void {
  expect(content.match(/node-version:/gu)).toHaveLength(1);
  expect(content).toContain("node-version: 24");
  expect(content).not.toContain("matrix:");
}

describe("GitHub release workflows", () => {
  it("runs the offline gate on Node 24 CI for main and next", () => {
    const content = workflow("ci.yml");

    expect(content).toContain("branches: [main, next]");
    expectSingleNode24Job(content);
    expect(content).toContain("- run: npm run gate:offline");
    expect(content).not.toContain("actions/upload-artifact");
  });

  it("publishes branch-bound tag releases through npm OIDC after validation", () => {
    const content = workflow("release.yml");

    expect(content).toContain('tags:\n      - "v*"');
    expect(content).toContain("id-token: write");
    expectSingleNode24Job(content);

    expect(content).toContain("npm_tag=next");
    expect(content).toContain("required_branch=origin/next");
    expect(content).toContain("npm_tag=latest");
    expect(content).toContain("required_branch=origin/main");

    expect(content).toContain("Verify package version matches tag");
    expect(content).toContain("package_version");
    expect(content).toContain("tag_version");
    expect(content).toContain("Verify tag ancestry");
    expect(content).toContain("git merge-base --is-ancestor");
    expect(content).toContain("Verify release validation evidence");
    expect(content).toContain(".release-validation/v${tag_version}.json");
    expect(content).toContain("node dist/release-validation.js");
    expect(content).toContain(
      '--npm-channel "${{ steps.channel.outputs.npm_tag }}"',
    );

    const gateIndex = content.indexOf("- run: npm run gate:offline");
    const validationIndex = content.indexOf(
      "- name: Verify release validation evidence",
    );
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeLessThan(validationIndex);

    expect(content).toContain("Publish package through npm OIDC");
    expect(content).toContain(
      'npm publish --ignore-scripts --tag "${{ steps.channel.outputs.npm_tag }}" --access public --registry=https://registry.npmjs.org/',
    );
    expect(content).toContain("Verify published package and dist-tag");
    expect(content).toContain('codex-agent-tools@${version}');
    expect(content).toContain('codex-agent-tools@${npm_tag}');

    const existingVersionCheck = content.slice(
      content.indexOf("- name: Check whether the version already exists"),
      content.indexOf("- name: Publish package through npm OIDC"),
    );
    expect(existingVersionCheck).toContain('view_status="$?"');
    expect(existingVersionCheck).toMatch(/elif grep[^\n]+E404/u);
    expect(existingVersionCheck).toContain(
      "Unable to determine whether the package version already exists",
    );
    expect(existingVersionCheck).not.toContain("|| true");

    expect(content).not.toContain("actions/upload-artifact");
    expect(content).not.toMatch(/\bnpm\s+pack(?:\s|$)/u);
    expect(content).toContain("host_stop_status");
    expect(content).toContain("host Stop: passed");
    expect(content).toContain("host Stop: skipped / unverified");
    expect(content).not.toContain("public beta host acceptance: passed");
  });

  it("installs one package-pinned Codex CLI in both workflows", () => {
    const version = packageCodexCliVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);

    for (const content of [workflow("ci.yml"), workflow("release.yml")]) {
      expect(content).toContain(
        "require('./package.json').config.codexCliVersion",
      );
      expect(content).toContain(
        'npm install --global "@openai/codex@${codex_cli_version}"',
      );
      expect(content).toContain(
        'test "$(codex --version)" = "codex-cli ${codex_cli_version}"',
      );
    }
  });

  it("keeps one build pipeline as the deterministic prepublish gate", () => {
    const scripts = packageScripts();

    expect(scripts.build).toBe(
      "npm run build:library && npm run build:plugin",
    );
    expect(scripts["test:deterministic"]).toBe(
      "vitest run --maxWorkers=1",
    );
    expect(scripts["gate:offline"]).toBe(
      "npm run build && npm run typecheck && npm run test:deterministic && npm run smoke:release:built",
    );
    expect(scripts.prepublishOnly).toBe("npm run gate:offline");
  });
});
