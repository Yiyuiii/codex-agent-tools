import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build, type Options } from "tsup";
import { describe, expect, it } from "vitest";

import pluginBuildConfig from "../../tsup.plugin.config.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pluginRoot = resolve(
  repositoryRoot,
  "plugins/codex-external-agents",
);

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

function readProjectText(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function markdownSection(source: string, heading: string): string {
  const headingStart = source.indexOf(`${heading}\n`);
  if (headingStart < 0) {
    throw new Error(`Missing Markdown section: ${heading}`);
  }
  const bodyStart = headingStart + heading.length + 1;
  const nextHeading = source.indexOf("\n## ", bodyStart);
  return source.slice(
    bodyStart,
    nextHeading < 0 ? source.length : nextHeading,
  );
}

describe("Codex plugin artifact", () => {
  it("declares the single repository-local marketplace entry", () => {
    const marketplace = readJson(".agents/plugins/marketplace.json");

    expect(marketplace).toEqual({
      name: "codex-external-agents-local",
      interface: {
        displayName: "Codex External Agents Local",
      },
      plugins: [
        {
          name: "codex-external-agents",
          source: {
            source: "local",
            path: "./plugins/codex-external-agents",
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Productivity",
        },
      ],
    });

    const [plugin] = marketplace.plugins as [
      Record<string, unknown>,
    ];
    expect((plugin.policy as Record<string, unknown>).products).toBeUndefined();
  });

  it("keeps the plugin manifest aligned with the package and folder", () => {
    const packageManifest = readJson("package.json");
    const pluginManifest = readJson(
      "plugins/codex-external-agents/.codex-plugin/plugin.json",
    );

    expect(pluginManifest).toMatchObject({
      name: "codex-external-agents",
      version: packageManifest.version,
      description:
        "Use explicitly selected external LLMs for review and delegated coding tasks.",
      author: {
        name: "codex-agent-tools maintainers",
      },
      license: "MIT",
      mcpServers: "./.mcp.json",
      interface: {
        displayName: "Codex External Agents",
        shortDescription:
          "Review and delegate with explicitly selected external LLMs",
        longDescription:
          "Use explicitly selected local Kimi and Pi-backed LLMs for Codex review and delegated coding tasks.",
        developerName: "codex-agent-tools maintainers",
        category: "Productivity",
        capabilities: ["Interactive", "Write"],
      },
    });
    expect(pluginManifest.name).toBe(basename(pluginRoot));
    expect(pluginManifest).not.toHaveProperty("skills");
    expect(pluginManifest).not.toHaveProperty("hooks");
    expect(pluginManifest).not.toHaveProperty("apps");
    expect(JSON.stringify(pluginManifest)).not.toContain("TODO");

    const defaultPrompt = (
      pluginManifest.interface as Record<string, unknown>
    ).defaultPrompt;

    expect(Array.isArray(defaultPrompt)).toBe(true);
    if (!Array.isArray(defaultPrompt)) return;
    expect(defaultPrompt.length).toBeGreaterThanOrEqual(1);
    expect(defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const prompt of defaultPrompt) {
      expect(typeof prompt).toBe("string");
      if (typeof prompt !== "string") continue;
      expect(prompt.trim().length).toBeGreaterThan(0);
      expect(prompt.length).toBeLessThanOrEqual(128);
    }
  });

  it("starts exactly one MCP server through the bundled relative path", () => {
    const mcpManifest = readJson(
      "plugins/codex-external-agents/.mcp.json",
    );

    expect(mcpManifest).toEqual({
      codex_external_agents: {
        command: "node",
        args: ["./runtime/codex-external-agents-mcp.mjs"],
        cwd: ".",
        env_vars: [
          "ARK_API_KEY",
          "VOLCENGINE_API_KEY",
          "API_KEY_DOUBAO_CODING",
          "OPENAI_API_KEY_DOUBAO",
        ],
      },
    });
    expect(mcpManifest.codex_external_agents).not.toHaveProperty("env");
    expect(JSON.stringify(mcpManifest)).not.toMatch(/[A-Za-z]:[\\/]/u);
  });

  it("makes public npm acceptance reject launch paths absolute on either platform", () => {
    const acceptanceScript = readFileSync(
      resolve(repositoryRoot, "scripts/npm-package-acceptance.mjs"),
      "utf8",
    );

    expect(acceptanceScript).toContain(
      "function isAbsoluteOnAnyPlatform(value)",
    );
    expect(acceptanceScript).toContain(
      "isAbsoluteOnAnyPlatform(server.command)",
    );
    expect(acceptanceScript).toContain(
      "!isAbsoluteOnAnyPlatform(argument)",
    );
    expect(acceptanceScript).toContain("path.win32.isAbsolute(value)");
    expect(acceptanceScript).toContain("path.posix.isAbsolute(value)");
  });

  it("builds the MCP entry as a self-contained plugin runtime", () => {
    const buildConfig = readFileSync(
      resolve(repositoryRoot, "tsup.plugin.config.ts"),
      "utf8",
    );

    expect(buildConfig).toMatch(
      /entry:\s*\{\s*"codex-external-agents-mcp":\s*"src\/mcp\/main\.ts",?\s*\}/u,
    );
    expect(buildConfig).toContain(
      'outDir: "plugins/codex-external-agents/runtime"',
    );
    expect(buildConfig).toContain('format: ["esm"]');
    expect(buildConfig).toContain(
      'outExtension: () => ({ js: ".mjs" })',
    );
    expect(buildConfig).toContain('platform: "node"');
    expect(buildConfig).toContain('target: "node20"');
    expect(buildConfig).toContain("bundle: true");
    expect(buildConfig).toContain("noExternal: [/.*/u]");
    expect(buildConfig).toContain("splitting: false");
    expect(buildConfig).toContain("dts: false");
    expect(buildConfig).toContain("sourcemap: false");
    expect(buildConfig).toContain("clean: true");
  });

  it("runs library then plugin builds and ignores only the runtime directory", () => {
    const packageManifest = readJson("package.json");
    const scripts = packageManifest.scripts as Record<string, string>;
    const packageFiles = packageManifest.files as string[];
    const gitignoreLines = readFileSync(
      resolve(repositoryRoot, ".gitignore"),
      "utf8",
    )
      .split(/\r?\n/u)
      .filter(Boolean);

    expect(scripts["build:library"]).toBe("tsup");
    expect(scripts["build:plugin"]).toBe(
      "tsup --config tsup.plugin.config.ts",
    );
    expect(scripts.build).toBe(
      "npm run build:library && npm run build:plugin",
    );
    expect(scripts).not.toHaveProperty("smoke:pi");
    expect(packageFiles).toEqual(
      expect.arrayContaining([
        "docs/smoke/pi-gemini.md",
        "docs/smoke/evidence",
      ]),
    );
    expect(gitignoreLines).toContain(
      "plugins/codex-external-agents/runtime/",
    );
    expect(dirname(pluginRoot)).toBe(
      resolve(repositoryRoot, "plugins"),
    );
  });

  it("pins release smoke to the exact four active logical LLMs and retained history", () => {
    const releaseSmoke = readFileSync(
      resolve(repositoryRoot, "scripts/release-smoke.mjs"),
      "utf8",
    );

    expect(releaseSmoke).toContain('"ark-agent-deepseek-v4-flash"');
    expect(releaseSmoke).toContain('"ark-agent-plan"');
    expect(releaseSmoke).toContain('"ark-coding-plan"');
    expect(releaseSmoke).toContain('"kimi-k3"');
    expect(releaseSmoke).toContain('"docs/smoke/pi-gemini.md"');
    expect(releaseSmoke).toContain('"docs/smoke/evidence"');
    expect(releaseSmoke).not.toContain("expected 5");
  });

  it("packages the approved lifecycle design and plan through the release gate", () => {
    const packageManifest = readJson("package.json");
    const packageFiles = packageManifest.files as string[];
    const releaseSmoke = readProjectText("scripts/release-smoke.mjs");
    const lifecycleSources = [
      "docs/superpowers/specs/2026-07-31-stdio-lifecycle-and-native-execution-budget-design.md",
      "docs/superpowers/plans/2026-07-31-stdio-lifecycle-and-native-execution-budget.md",
    ];

    for (const source of lifecycleSources) {
      expect(packageFiles.filter((entry) => entry === source)).toEqual([
        source,
      ]);
      expect(releaseSmoke).toContain(`"${source}"`);
    }
    expect(releaseSmoke).toMatch(
      /const requiredLifecyclePackageSources = \[[\s\S]*?\];/u,
    );
    expect(releaseSmoke).toMatch(
      /\.\.\.requiredLifecyclePackageSources,[\s\S]*?assertCapabilitySourcesPackaged/u,
    );
    expect(releaseSmoke).toMatch(
      /await verifyCapabilityIndex\(\{[\s\S]*?repositoryRoot: root,[\s\S]*?\}\);[\s\S]*?await checkPackage/u,
    );
  });

  it("documents optional native execution budgets and owned stdio shutdown", () => {
    for (const relativePath of ["README.md", "docs/operations.md"]) {
      const contract = markdownSection(
        readProjectText(relativePath),
        "## 执行预算与取消合同",
      );

      expect(contract).toMatch(
        /`timeoutMs` 是调用方为单次请求显式设置的可选值/u,
      );
      expect(contract).toMatch(
        /省略时，Kimi 与 Pi 都不设置模型执行 deadline/u,
      );
      expect(contract).toMatch(
        /不存在 profile 级的 600 秒或 900 秒执行上限/u,
      );
      expect(contract).toMatch(
        /stdio 的 end、close、error 与 SIGINT、SIGTERM/u,
      );
      expect(contract).toMatch(
        /SDK abort handlers 取消在途请求[\s\S]*等待 owned 子进程树/u,
      );
      expect(contract).toMatch(
        /Pi 生产路径的原生 retry 策略保持不变/u,
      );
    }

    const readmeContract = markdownSection(
      readProjectText("README.md"),
      "## 执行预算与取消合同",
    );
    expect(readmeContract).toMatch(
      /幂等 session shutdown[\s\S]*`server\.close\(\)`[\s\S]*SDK abort handlers[\s\S]*owned 子进程树与 tracker drain[\s\S]*session 结束/u,
    );
  });

  it("keeps the stale capability index staged while evidence stays immutable", () => {
    const readme = readProjectText("README.md");
    const checklist = readProjectText("docs/release/checklist.md");
    const runbook = readProjectText(
      "docs/release/four-llm-qualification-execution-runbook.md",
    );
    const ark = readProjectText("docs/smoke/ark.md");
    const agentMemory = readProjectText("AGENTS.md");
    const activePlan = readProjectText(
      "docs/superpowers/plans/2026-07-31-stdio-lifecycle-and-native-execution-budget.md",
    );

    for (const source of [
      readme,
      checklist,
      runbook,
      ark,
      agentMemory,
      activePlan,
    ]) {
      expect(source).toMatch(
        /当前源码变更已使八项能力指纹 stale/u,
      );
      expect(source).toMatch(
        /Task 7(?:\/8|[\s\S]*Task 8)[\s\S]*Task 9 新证据形成前[\s\S]*`?capabilities\.json`?[\s\S]*保持原样/u,
      );
      expect(source).toMatch(
        /Task 9[\s\S]*8\/8 passed[\s\S]*更新同一[\s\S]*(?:`?capabilities\.json`?|索引)/u,
      );
      expect(source).toMatch(
        /历史 batch manifest 与 case evidence\s*永久不可变/u,
      );
    }

    for (const source of [checklist, runbook]) {
      expect(source).toMatch(
        /`npm run verify:capabilities`[\s\S]*退出码 1/u,
      );
      expect(source).toMatch(
        /registry[\s\S]*旧 passed[\s\S]*不构成发布权威/u,
      );
    }

    const releaseDocuments = [
      readme,
      checklist,
      readProjectText("docs/release/real-host-acceptance.md"),
      agentMemory,
    ];
    const releaseOrderDocuments = [...releaseDocuments, activePlan];

    for (const source of releaseOrderDocuments) {
      expect(source).toMatch(
        /Task 9[\s\S]*8\/8[\s\S]*verifier green[\s\S]*Task 10[\s\S]*GitHub Actions[\s\S]*beta\.2[\s\S]*npm next[\s\S]*Task 11[\s\S]*公开 npm[\s\S]*官方插件[\s\S]*完整 App 重启[\s\S]*真实 Stop[\s\S]*Task 12[\s\S]*stable/u,
      );
    }

    for (const source of releaseDocuments) {
      expect(source).toMatch(
        /Task 9 未通过前不得发布 beta\.2；Task 11 未通过前不得发布 stable/u,
      );
      expect(source).not.toMatch(
        /Task 11 未通过前不得发布 beta\.2/u,
      );
    }

    const activePlanTask7 = markdownSection(
      activePlan,
      "## Task 7：同步有效文档、发布门禁与 stale 能力状态",
    );
    expect(activePlanTask7).toMatch(
      /Task 9 取得 8\/8 passed 并使 verifier green 后，Task 10 通过 GitHub Actions 先把 beta\.2 发布到 npm next；Task 11 再做公开 npm\/官方插件\/完整 App 重启\/真实 Stop；Task 11 只阻断 stable，Task 12 才发布 stable/u,
    );
    expect(activePlanTask7).toMatch(
      /当前源码变更已使八项能力指纹 stale；Task 7\/8 与 Task 9 新证据形成前，`capabilities\.json` 保持原样；Task 9 在新批次 8\/8 passed 后更新同一索引；历史 batch manifest 与 case evidence 永久不可变/u,
    );

    const hostAcceptance = releaseDocuments[2] ?? "";
    expect(hostAcceptance).toMatch(
      /下一人工节点[\s\S]*beta\.2 已发布到 npm next 并完成官方插件升级后[\s\S]*完整重启/u,
    );

    expect(checklist).toMatch(/最近复核：2026-07-31/u);
    expect(checklist).toMatch(
      /当前证据分支：`codex\/stdio-lifecycle-and-native-budget`/u,
    );
    expect(readme).toMatch(
      /`0\.1\.1-beta\.1`[\s\S]*已发布到 npm `next`[\s\S]*已安装/u,
    );
    expect(readme).not.toMatch(
      /`0\.1\.1-beta\.1` 候选[\s\S]*正在完成发布门禁/u,
    );
  });

  it("keeps current smoke guidance aligned with native budgets and Pi retry", () => {
    const kimi = readProjectText("docs/smoke/kimi.md");
    const pi = readProjectText("docs/smoke/pi-gemini.md");
    const ark = readProjectText("docs/smoke/ark.md");

    expect(kimi).toMatch(
      /省略 `timeoutMs`[\s\S]*Kimi Code 原生执行预算/u,
    );
    expect(kimi).toMatch(
      /宿主取消[\s\S]*完整 owned ACP 进程树/u,
    );
    expect(pi).toMatch(
      /Pi 生产路径的原生 retry 策略未在本轮关闭/u,
    );
    expect(pi).toMatch(
      /省略 `timeoutMs`[\s\S]*不设置模型执行 deadline/u,
    );
    expect(ark).toMatch(
      /省略 `timeoutMs`[\s\S]*不设置模型执行 deadline/u,
    );
    expect(ark).toMatch(
      /当前源码变更已使八项能力指纹 stale/u,
    );
  });

  it("builds and runs the bundled MCP entry without repository dependencies", async () => {
    const temporaryRoot = await mkdtemp(
      resolve(tmpdir(), "codex-plugin-artifact-"),
    );
    const buildRoot = resolve(temporaryRoot, "build");
    const isolatedRoot = resolve(temporaryRoot, "isolated");
    const isolatedBundle = resolve(
      isolatedRoot,
      "codex-external-agents-mcp.mjs",
    );
    const client = new Client({
      name: "plugin-artifact-test",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [isolatedBundle],
      cwd: isolatedRoot,
      stderr: "pipe",
    });

    try {
      const config = pluginBuildConfig;
      if (typeof config === "function" || Array.isArray(config)) {
        throw new TypeError(
          "Expected a single static plugin build configuration.",
        );
      }
      await build({
        ...(config as Options),
        outDir: buildRoot,
        config: false,
      });

      const builtBundle = resolve(
        buildRoot,
        "codex-external-agents-mcp.mjs",
      );
      await mkdir(isolatedRoot, { recursive: true });
      await copyFile(builtBundle, isolatedBundle);
      expect(existsSync(resolve(temporaryRoot, "node_modules"))).toBe(false);

      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "external_delegate",
        "external_review",
      ]);

      const output = execFileSync(
        process.execPath,
        [isolatedBundle, "--help"],
        { cwd: isolatedRoot, encoding: "utf8" },
      );
      const bundle = readFileSync(isolatedBundle, "utf8");
      const staticImports = [
        ...bundle.matchAll(
          /^import\s+(?:[^;]+?\s+from\s+)?["']([^"']+)["'];/gmu,
        ),
      ].map((match) => match[1]!);

      expect(output).toContain(
        "codex-external-agents-mcp - codex_external_agents stdio MCP server",
      );
      expect(output).toContain(
        "Tools: external_review, external_delegate",
      );
      expect(staticImports.length).toBeGreaterThan(0);
      expect(
        [...new Set(staticImports)].filter(
          (specifier) => !isBuiltin(specifier),
        ),
      ).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
