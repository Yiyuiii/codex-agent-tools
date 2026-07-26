import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildIsolatedPiConfig,
  getDefaultPiConfigRoot,
} from "../../../src/adapters/pi/config.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pi-config-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("isolated Pi configuration", () => {
  it("generates the approved Ark providers without literal secrets", async () => {
    const root = await tempRoot();
    const result = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: ["ark"],
    });
    const expected = await readFile(
      path.resolve("test/fixtures/pi/expected-ark-models.json"),
      "utf8",
    );
    const actual = await readFile(result.modelsPath, "utf8");

    expect(actual).toBe(expected);
    expect(actual).not.toContain("/v3");
    const configuredModels = Object.fromEntries(
      Object.entries(
        JSON.parse(actual).providers as Record<
          string,
          { models: Array<{ id: string }> }
        >,
      ).map(([provider, config]) => [
        provider,
        config.models.map((model) => model.id),
      ]),
    );
    expect(configuredModels).toEqual({
      "ark-agent-plan": ["ark-code-latest", "deepseek-v4-flash"],
      "ark-coding-plan": ["ark-code-latest"],
    });
    expect(JSON.stringify(configuredModels)).not.toMatch(/claude|codex/iu);
    expect(JSON.stringify(configuredModels)).not.toMatch(
      /glm-5\.2|doubao-seed-2\.0-pro/iu,
    );
    expect(actual).not.toContain("literal-secret");
  });

  it("writes deterministic credential-free settings outside the user's Pi directory", async () => {
    const root = await tempRoot();
    const first = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: ["ark"],
    });
    const second = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: ["ark"],
    });
    const qualificationFirst = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: ["ark"],
      qualification: true,
    });
    const qualificationSecond = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: ["ark"],
      qualification: true,
    });

    expect(first).toEqual(second);
    expect(qualificationFirst).toEqual(qualificationSecond);
    expect(qualificationFirst.agentDir).not.toBe(first.agentDir);
    expect(first.agentDir.startsWith(path.resolve(root))).toBe(true);
    expect(qualificationFirst.agentDir.startsWith(path.resolve(root))).toBe(
      true,
    );
    expect(first.agentDir).not.toContain(`${path.sep}.pi${path.sep}agent`);
    expect(first.environment).toEqual({ PI_CODING_AGENT_DIR: first.agentDir });
    expect(JSON.parse(await readFile(first.settingsPath, "utf8"))).toEqual({
      defaultProjectTrust: "never",
      enableAnalytics: false,
      enableInstallTelemetry: false,
      extensions: [],
      packages: [],
      prompts: [],
      quietStartup: true,
      skills: [],
      themes: [],
    });
    expect(
      JSON.parse(await readFile(qualificationFirst.settingsPath, "utf8")),
    ).toEqual({
      defaultProjectTrust: "never",
      enableAnalytics: false,
      enableInstallTelemetry: false,
      extensions: [],
      packages: [],
      prompts: [],
      quietStartup: true,
      retry: {
        provider: {
          maxRetries: 0,
        },
      },
      skills: [],
      themes: [],
    });
    const settingsText = await readFile(first.settingsPath, "utf8");
    const modelsText = await readFile(first.modelsPath, "utf8");
    const expectedModels = await readFile(
      path.resolve("test/fixtures/pi/expected-ark-models.json"),
      "utf8",
    );
    expect(modelsText).toBe(expectedModels);
    expect(modelsText).not.toMatch(
      /"(?:ARK_API_KEY|VOLCENGINE_API_KEY|OPENAI_API_KEY_DOUBAO)"/u,
    );
    expect(modelsText).not.toMatch(/secret|password/iu);
    expect((await readdir(first.agentDir)).sort()).toEqual([
      "models.json",
      "settings.json",
    ]);
    expect(first.contentSha256).toBe(
      createHash("sha256")
        .update(settingsText)
        .update("\0")
        .update(modelsText)
        .digest("hex"),
    );
    expect(qualificationFirst.contentSha256).not.toBe(first.contentSha256);
  });

  it("uses an application-owned cache root", () => {
    expect(
      getDefaultPiConfigRoot(
        { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
        "win32",
        "C:\\Users\\test",
      ),
    ).toBe("C:\\Users\\test\\AppData\\Local\\codex-agent-tools");
    expect(
      getDefaultPiConfigRoot(
        { XDG_CACHE_HOME: "/cache" },
        "linux",
        "/home/test",
      ),
    ).toBe("/cache/codex-agent-tools");
  });

  it("rejects a version that could escape the cache root", async () => {
    const root = await tempRoot();
    await expect(
      buildIsolatedPiConfig({ root, version: "../escape", providers: ["ark"] }),
    ).rejects.toThrow(/version/u);
  });
});
