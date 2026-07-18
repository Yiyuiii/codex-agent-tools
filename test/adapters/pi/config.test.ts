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
  it("writes deterministic credential-free settings outside the user's Pi directory", async () => {
    const root = await tempRoot();
    const first = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: {},
    });
    const second = await buildIsolatedPiConfig({
      root,
      version: "0.1.0-alpha.1",
      providers: {},
    });

    expect(first).toEqual(second);
    expect(first.agentDir.startsWith(path.resolve(root))).toBe(true);
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
    expect(JSON.parse(await readFile(first.modelsPath, "utf8"))).toEqual({
      providers: {},
    });
    expect(
      `${await readFile(first.settingsPath, "utf8")}${await readFile(first.modelsPath, "utf8")}`,
    ).not.toMatch(/api[_-]?key|secret|token|password/iu);
    expect((await readdir(first.agentDir)).sort()).toEqual([
      "models.json",
      "settings.json",
    ]);
    expect(first.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
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
      buildIsolatedPiConfig({ root, version: "../escape", providers: {} }),
    ).rejects.toThrow(/version/u);
  });
});
