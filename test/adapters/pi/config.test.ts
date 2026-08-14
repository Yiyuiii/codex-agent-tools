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

function normalizeCheckoutLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

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
  it.each([
    {
      providerSet: "ark" as const,
      fixture: "expected-ark-models.json",
      configuredModels: {
        "ark-agent-plan": ["ark-code-latest", "deepseek-v4-flash"],
        "ark-coding-plan": ["ark-code-latest"],
      },
    },
    {
      providerSet: "deepseek" as const,
      fixture: "expected-deepseek-models.json",
      configuredModels: { deepseek: ["deepseek-v4-flash"] },
    },
  ])(
    "generates only the approved $providerSet provider set without literal secrets",
    async ({ providerSet, fixture, configuredModels }) => {
      const root = await tempRoot();
      const result = await buildIsolatedPiConfig({
        root,
        version: "0.1.0-alpha.1",
        providers: [providerSet],
      });
      const expected = await readFile(
        path.resolve("test/fixtures/pi", fixture),
        "utf8",
      );
      const actual = await readFile(result.modelsPath, "utf8");

      expect(actual).toBe(normalizeCheckoutLineEndings(expected));
      expect(actual).not.toContain("/v3");
      const configured = Object.fromEntries(
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
      expect(configured).toEqual(configuredModels);
      expect(result.agentDir).toBe(
        path.join(path.resolve(root), "pi", "0.1.0-alpha.1", providerSet),
      );
      expect(actual).not.toMatch(
        /deepseek-v4-pro|deepseek-chat|deepseek-reasoner/u,
      );
      expect(JSON.stringify(configured)).not.toMatch(/claude|codex/iu);
      expect(JSON.stringify(configured)).not.toMatch(
        /glm-5\.2|doubao-seed-2\.0-pro/iu,
      );
      expect(actual).not.toContain("literal-secret");
    },
  );

  it("pins the official DeepSeek Pi compatibility metadata", async () => {
    const root = await tempRoot();
    const result = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: ["deepseek"],
    });
    const actual = await readFile(result.modelsPath, "utf8");
    const deepseek = (
      JSON.parse(actual).providers as Record<string, Record<string, unknown>>
    ).deepseek;
    expect(deepseek).toEqual({
      api: "openai-completions",
      apiKey: "$CODEX_AGENT_DEEPSEEK_KEY",
      baseUrl: "https://api.deepseek.com",
      models: [
        {
          compat: {
            maxTokensField: "max_tokens",
            requiresReasoningContentOnAssistantMessages: true,
            thinkingFormat: "deepseek",
          },
          contextWindow: 1_000_000,
          id: "deepseek-v4-flash",
          input: ["text"],
          maxTokens: 384_000,
          name: "DeepSeek V4 Flash",
          reasoning: true,
          thinkingLevelMap: {
            high: "high",
            low: "low",
            max: "max",
            medium: null,
            minimal: null,
            xhigh: null,
          },
        },
      ],
    });
  });

  it.each(["ark", "deepseek"] as const)(
    "writes deterministic credential-free $providerSet settings outside the user's Pi directory",
    async (providerSet) => {
      const root = await tempRoot();
      const first = await buildIsolatedPiConfig({
        root,
        version: "0.1.0-alpha.1",
        providers: [providerSet],
      });
      const second = await buildIsolatedPiConfig({
        root,
        version: "0.1.0-alpha.1",
        providers: [providerSet],
      });
      const qualificationFirst = await buildIsolatedPiConfig({
        root,
        version: "0.1.0-alpha.1",
        providers: [providerSet],
        qualification: true,
      });
      const qualificationSecond = await buildIsolatedPiConfig({
        root,
        version: "0.1.0-alpha.1",
        providers: [providerSet],
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
      expect(first.environment).toEqual({
        PI_CODING_AGENT_DIR: first.agentDir,
      });
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
        retry: { provider: { maxRetries: 0 } },
        skills: [],
        themes: [],
      });
      const settingsText = await readFile(first.settingsPath, "utf8");
      const modelsText = await readFile(first.modelsPath, "utf8");
      const expectedModels = await readFile(
        path.resolve(
          "test/fixtures/pi",
          providerSet === "ark"
            ? "expected-ark-models.json"
            : "expected-deepseek-models.json",
        ),
        "utf8",
      );
      expect(modelsText).toBe(normalizeCheckoutLineEndings(expectedModels));
      expect(modelsText).not.toMatch(
        /"(?:ARK_API_KEY|VOLCENGINE_API_KEY|OPENAI_API_KEY_DOUBAO|OPENAI_API_KEY_DEEPSEEK)"/u,
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
    },
  );

  it("keeps Ark and DeepSeek in disjoint cache directories", async () => {
    const root = await tempRoot();
    const ark = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: ["ark"],
    });
    const deepseek = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: ["deepseek"],
    });
    expect(ark.agentDir).not.toBe(deepseek.agentDir);
    expect(await readFile(ark.modelsPath, "utf8")).not.toContain(
      "$CODEX_AGENT_DEEPSEEK_KEY",
    );
    expect(await readFile(deepseek.modelsPath, "utf8")).not.toMatch(
      /CODEX_AGENT_ARK_(?:AGENT|CODING)_KEY/u,
    );
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
      buildIsolatedPiConfig({
        root,
        version: "../escape",
        providers: ["ark"],
      }),
    ).rejects.toThrow(/version/u);
  });

  it.each([
    ["combined", ["ark", "deepseek"]],
    ["reversed", ["deepseek", "ark"]],
    ["duplicate", ["deepseek", "deepseek"]],
    ["empty", []],
  ] as const)(
    "rejects a non-canonical provider set: %s",
    async (_label, providers) => {
      const root = await tempRoot();
      await expect(
        buildIsolatedPiConfig({
          root,
          version: "0.1.0-alpha.1",
          // @ts-expect-error Invalid provider sets are intentional runtime probes.
          providers,
        }),
      ).rejects.toThrow(/providers/u);
    },
  );
});
