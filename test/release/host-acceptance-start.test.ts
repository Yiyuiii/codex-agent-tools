import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HOST_ACCEPTANCE_PLUGIN_PATHS,
  HOST_ACCEPTANCE_REPOSITORY_PLUGIN_PATHS,
  buildHostAcceptanceSession,
  buildNpmViewInvocation,
  consumeObserverLifecycle,
  loadHostAcceptancePluginFiles,
  prepareHostAcceptanceDirectories,
} from "../../host-acceptance/start-session.mjs";

const H40 = "2".repeat(40);
const VERSION = "0.1.1-beta.2";
const TAG = `v${VERSION}`;
const ROOT = "C:\\release\\codex-agent-tools";
const LOCAL_APP_DATA = "C:\\Users\\maintainer\\AppData\\Local";
const USER_PROFILE = "C:\\Users\\maintainer";
const OBSERVER_PATH =
  "host-acceptance/win32-x64/codex-host-acceptance-observer.exe";
const MANIFEST_PATH = "host-acceptance/observer-build-inputs.v1.json";
const PROTOCOL_PATH = "host-acceptance/protocol/observer-protocol.v1.json";

describe("current-host npm metadata invocation", () => {
  it("runs the fixed npm CLI through the current Node executable without a shell shim", () => {
    expect(
      buildNpmViewInvocation(
        "C:\\Program Files\\nodejs\\node.exe",
        VERSION,
      ),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      npmCliPath:
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "view",
        `codex-agent-tools@${VERSION}`,
        "version",
        "dist",
        "--json",
        "--registry=https://registry.npmjs.org/",
      ],
    });
  });
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value: unknown): Buffer {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
}

function fixture() {
  const packageBytes = bytes({ name: "codex-agent-tools", version: VERSION });
  const protocol = {
    schemaVersion: 1,
    protocolVersion: 1,
    descriptor: {
      relativePath: "codex-agent-tools/host-acceptance/session.v1.json",
      maximumBytes: 16384,
      packageName: "codex-agent-tools",
      noncePattern: "^[A-Za-z0-9_-]{43,128}$",
      pipeNamePattern:
        "^codex-agent-tools-host-acceptance-[a-f0-9]{32,64}$",
      completionMarkerIdPattern: "^[a-z0-9][a-z0-9_-]{15,63}$",
      publicBetaVersionPattern:
        "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$",
      sha256Pattern: "^[a-f0-9]{64}$",
      sha1Pattern: "^[a-f0-9]{40}$",
      commitPattern: "^[a-f0-9]{40}$",
      npmIntegrityPattern: "^sha512-[A-Za-z0-9+/]{86}==$",
      llmPattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
      minimumTimeoutMs: 1000,
      fixedPaths: {
        observerArtifact: OBSERVER_PATH,
        buildManifest: MANIFEST_PATH,
        protocol: PROTOCOL_PATH,
        markerPrefix: ".release-validation/v",
        markerSuffix: ".json",
      },
      topLevelKeys: [
        "schemaVersion",
        "protocolVersion",
        "packageName",
        "nonce",
        "pipeName",
        "publicBeta",
        "request",
      ],
      publicBetaKeys: [
        "version",
        "tag",
        "taggedCommit",
        "markerPath",
        "markerSha256",
        "pluginArtifactTreeDigestSha256",
        "observerArtifact",
        "npm",
      ],
      observerArtifactKeys: [
        "path",
        "sha256",
        "protocolVersion",
        "buildManifest",
        "protocol",
        "inputsDigestSha256",
      ],
      artifactIdentityKeys: ["path", "sha256"],
      npmKeys: ["integrity", "shasum"],
      requestKeys: [
        "task",
        "llm",
        "promptSha256",
        "cwdSha256",
        "timeoutMs",
        "sessionIdSha256",
        "inputIdentitySha256",
        "completionMarkerId",
        "completionMarkerIdentitySha256",
      ],
    },
    hashDomains: {
      prompt: "codex-agent-tools/host-acceptance/prompt/v1",
      cwd: "codex-agent-tools/host-acceptance/cwd/v1",
      sessionId: "codex-agent-tools/host-acceptance/session-id/v1",
      requestInput: "codex-agent-tools/host-acceptance/request-input/v1",
      completionMarker: "codex-agent-tools/host-acceptance/completion-marker/v1",
    },
  };
  const protocolBytes = bytes(protocol);
  const buildConfig = {
    schemaVersion: 1,
    sharedBuildContract: {
      toolchainLockPath: "native/windows-job-helper/toolchain.lock.json",
      buildConfigPath: "native/windows-job-helper/build.config.json",
      restoreToolchainPath:
        "native/windows-job-helper/restore-toolchain.ps1",
    },
    sourceSets: { production: ["src/Program.cs", "src/StrictJson.cs"] },
    artifact: { path: OBSERVER_PATH },
  };
  const buildConfigBytes = bytes(buildConfig);
  const inputFiles = new Map<string, Buffer>([
    ["host-acceptance/build.config.json", buildConfigBytes],
    ["host-acceptance/build.ps1", bytes("build")],
    [PROTOCOL_PATH, protocolBytes],
    ["host-acceptance/src/Program.cs", bytes("program")],
    ["host-acceptance/src/StrictJson.cs", bytes("strict-json")],
    ["native/windows-job-helper/build.config.json", bytes("shared-build")],
    ["native/windows-job-helper/restore-toolchain.ps1", bytes("restore")],
    ["native/windows-job-helper/toolchain.lock.json", bytes("lock")],
  ]);
  const inputs = [...inputFiles]
    .map(([path, content]) => ({ path, sha256: sha256(content) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1,
    artifactPath: OBSERVER_PATH,
    protocol: { path: PROTOCOL_PATH, sha256: sha256(protocolBytes) },
    inputs,
    inputsDigestSha256: sha256(JSON.stringify({ schemaVersion: 1, inputs })),
  };
  const manifestBytes = bytes(manifest);
  const observerBytes = bytes("observer-binary");
  const installedPluginFiles = HOST_ACCEPTANCE_PLUGIN_PATHS.map((path, index) => ({
    path,
    content: bytes(`plugin-${index}`),
  }));
  installedPluginFiles[0]!.content = bytes({
    name: "codex-external-agents",
    version: VERSION,
  });
  const repositoryPluginFiles = HOST_ACCEPTANCE_REPOSITORY_PLUGIN_PATHS.map(
    (repositoryPath) => {
      const installed = installedPluginFiles.find(
        ({ path }) => path === repositoryPath,
      );
      if (installed === undefined) throw new Error("invalid fixture");
      return { path: repositoryPath, content: Buffer.from(installed.content) };
    },
  );
  const pluginDigest = sha256(
    JSON.stringify({
      schemaVersion: 1,
      files: installedPluginFiles.map(({ path, content }) => ({
        path,
        sha256: sha256(content),
      })),
    }),
  );
  const marker = {
    schemaVersion: 1,
    kind: "beta",
    package: {
      name: "codex-agent-tools",
      version: VERSION,
      tag: TAG,
      npmChannel: "next",
    },
    core: { observerValidatesThisStrictly: true },
    pluginArtifactTree: { schemaVersion: 1, digestSha256: pluginDigest },
    observerArtifact: {
      path: OBSERVER_PATH,
      sha256: sha256(observerBytes),
      protocolVersion: 1,
      buildManifest: { path: MANIFEST_PATH, sha256: sha256(manifestBytes) },
      protocol: { path: PROTOCOL_PATH, sha256: sha256(protocolBytes) },
      inputsDigestSha256: manifest.inputsDigestSha256,
    },
  };
  const markerBytes = bytes(marker);
  return {
    repositoryRoot: ROOT,
    localAppData: LOCAL_APP_DATA,
    userProfile: USER_PROFILE,
    packageBytes,
    markerBytes,
    buildConfigBytes,
    manifestBytes,
    observerBytes,
    protocolBytes,
    inputFiles,
    repositoryPluginFiles,
    installedPluginFiles,
    gitHead: H40,
    tagCommit: H40,
    gitStatus: "",
    npmView: {
      version: VERSION,
      dist: {
        integrity: `sha512-${"A".repeat(86)}==`,
        shasum: "b".repeat(40),
        tarball: "https://registry.npmjs.org/redacted.tgz",
      },
    },
    entropy: {
      nonce: "A".repeat(43),
      pipeHex: "c".repeat(48),
      markerHex: "d".repeat(32),
    },
  };
}

function refreshPluginMarker(value: ReturnType<typeof fixture>): void {
  const marker = JSON.parse(value.markerBytes.toString("utf8"));
  marker.pluginArtifactTree.digestSha256 = sha256(
    JSON.stringify({
      schemaVersion: 1,
      files: value.installedPluginFiles.map(({ path, content }) => ({
        path,
        sha256: sha256(content),
      })),
    }),
  );
  value.markerBytes = bytes(marker);
}

function replacePluginManifest(
  value: ReturnType<typeof fixture>,
  manifest: unknown,
): void {
  const content = bytes(manifest);
  value.installedPluginFiles[0]!.content = content;
  value.repositoryPluginFiles[0]!.content = Buffer.from(content);
  refreshPluginMarker(value);
}

describe("current-host acceptance session preparation", () => {
  it("uses only tracked plugin files from the tag and binds generated runtime from the installed cache", () => {
    expect(HOST_ACCEPTANCE_REPOSITORY_PLUGIN_PATHS).toEqual([
      "plugins/codex-external-agents/.codex-plugin/plugin.json",
      "plugins/codex-external-agents/.mcp.json",
      "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe",
      "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe.sha256",
    ]);
    expect(HOST_ACCEPTANCE_REPOSITORY_PLUGIN_PATHS).not.toContain(
      "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
    );
    expect(() => buildHostAcceptanceSession(fixture())).not.toThrow();
  });

  it("binds the exact beta tag, public npm, observer provenance and fixed delegate input", () => {
    const plan = buildHostAcceptanceSession(fixture());
    const descriptor = JSON.parse(plan.descriptorBytes.toString("utf8"));

    expect(plan.observerPath).toBe(`${ROOT}\\${OBSERVER_PATH.replaceAll("/", "\\")}`);
    expect(plan.descriptorPath).toBe(
      `${LOCAL_APP_DATA}\\codex-agent-tools\\host-acceptance\\session.v1.json`,
    );
    expect(plan.request).toMatchObject({
      llm: "kimi-k3",
      cwd: `${plan.sessionRoot}\\delegate-workspace`,
      timeoutMs: null,
      sessionId: null,
    });
    expect(plan.request.prompt).toContain("只读");
    expect(plan.request.prompt).toContain(plan.completionMarkerId);
    expect(plan.request.prompt).toContain(plan.completionMarkerPath);
    expect(plan.request.prompt).toContain("唯一最后一个工具动作");
    expect(plan.request.prompt).not.toContain("持续运行");
    expect(plan.request.prompt).not.toContain(ROOT);
    expect(plan.delegateWorkspace).toBe(plan.request.cwd);
    expect(plan.installedPluginRoot).toBe(
      `${USER_PROFILE}\\.codex\\plugins\\cache\\codex-external-agents-local\\codex-external-agents\\${VERSION}`,
    );
    expect(descriptor.publicBeta).toMatchObject({
      version: VERSION,
      tag: TAG,
      taggedCommit: H40,
      markerSha256: sha256(fixture().markerBytes),
      npm: {
        integrity: fixture().npmView.dist.integrity,
        shasum: fixture().npmView.dist.shasum,
      },
    });
    expect(descriptor.request).toMatchObject({
      task: "delegate",
      llm: "kimi-k3",
      timeoutMs: null,
      sessionIdSha256: null,
      completionMarkerId: plan.completionMarkerId,
    });
    expect(descriptor.request.promptSha256).toBe(
      sha256(
        JSON.stringify([
          "codex-agent-tools/host-acceptance/prompt/v1",
          plan.request.prompt,
        ]),
      ),
    );
    const expectedCwdSha256 = sha256(
      JSON.stringify([
        "codex-agent-tools/host-acceptance/cwd/v1",
        plan.delegateWorkspace,
      ]),
    );
    expect(descriptor.request.cwdSha256).toBe(expectedCwdSha256);
    const expectedInputIdentitySha256 = sha256(
      JSON.stringify([
        "codex-agent-tools/host-acceptance/request-input/v1",
        "delegate",
        "kimi-k3",
        descriptor.request.promptSha256,
        expectedCwdSha256,
        null,
        null,
      ]),
    );
    expect(descriptor.request.inputIdentitySha256).toBe(
      expectedInputIdentitySha256,
    );
    expect(descriptor.request.completionMarkerIdentitySha256).toBe(
      sha256(
        JSON.stringify([
          "codex-agent-tools/host-acceptance/completion-marker/v1",
          plan.nonce,
          plan.completionMarkerId,
          expectedInputIdentitySha256,
        ]),
      ),
    );
    expect(plan.descriptorBytes.byteLength).toBeLessThanOrEqual(16_384);
    expect(plan.receiptPath).toContain(`${plan.nonce}\\host-acceptance-receipt.v1.json`);
  });

  it.each([
    ["dirty checkout", (value: ReturnType<typeof fixture>) => (value.gitStatus = " M package.json")],
    ["tag mismatch", (value: ReturnType<typeof fixture>) => (value.tagCommit = "3".repeat(40))],
    ["npm version mismatch", (value: ReturnType<typeof fixture>) => (value.npmView.version = "0.1.1-beta.3")],
    ["observer drift", (value: ReturnType<typeof fixture>) => (value.observerBytes = bytes("drift"))],
    ["manifest input drift", (value: ReturnType<typeof fixture>) => value.inputFiles.set("host-acceptance/build.ps1", bytes("drift"))],
    ["tracked plugin drift", (value: ReturnType<typeof fixture>) => value.repositoryPluginFiles[0]!.content.fill(0x44, 0, 1)],
    ["installed cache runtime drift", (value: ReturnType<typeof fixture>) => value.installedPluginFiles[2]!.content.fill(0xff, 0, 1)],
    ["installed cache tracked-file drift", (value: ReturnType<typeof fixture>) => value.installedPluginFiles[0]!.content.fill(0xff, 0, 1)],
    ["installed cache missing file", (value: ReturnType<typeof fixture>) => value.installedPluginFiles.pop()],
    ["installed cache reordered files", (value: ReturnType<typeof fixture>) => value.installedPluginFiles.reverse()],
    ["marker plugin digest drift", (value: ReturnType<typeof fixture>) => {
      const marker = JSON.parse(value.markerBytes.toString("utf8"));
      marker.pluginArtifactTree.digestSha256 = "f".repeat(64);
      value.markerBytes = bytes(marker);
    }],
    ["installed plugin name mismatch", (value: ReturnType<typeof fixture>) => replacePluginManifest(value, {
      name: "codex-external-agentz",
      version: VERSION,
    })],
    ["installed plugin version mismatch", (value: ReturnType<typeof fixture>) => replacePluginManifest(value, {
      name: "codex-external-agents",
      version: "0.1.1-beta.9",
    })],
  ])("fails closed on %s", (_label, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => buildHostAcceptanceSession(value)).toThrow(
      "Host acceptance session is invalid.",
    );
  });
});

describe("host-acceptance plugin file loading", () => {
  it("does not require the generated runtime to exist in the clean tag checkout", async () => {
    const temporary = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "host-acceptance-plugin-files-")),
    );
    const repositoryRoot = path.join(temporary, "repository");
    const installedRoot = path.join(temporary, "installed");
    try {
      await mkdir(repositoryRoot);
      await mkdir(installedRoot);
      for (const [index, pluginPath] of HOST_ACCEPTANCE_PLUGIN_PATHS.entries()) {
        const relative = pluginPath.replace(
          "plugins/codex-external-agents/",
          "",
        );
        const installedPath = path.join(installedRoot, ...relative.split("/"));
        await mkdir(path.dirname(installedPath), { recursive: true });
        await writeFile(installedPath, bytes(`installed-${index}`));
      }
      for (const pluginPath of HOST_ACCEPTANCE_REPOSITORY_PLUGIN_PATHS) {
        const relative = pluginPath.replace(
          "plugins/codex-external-agents/",
          "",
        );
        const sourcePath = path.join(repositoryRoot, ...pluginPath.split("/"));
        const installedPath = path.join(installedRoot, ...relative.split("/"));
        await mkdir(path.dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, await readFile(installedPath));
      }

      const loaded = await loadHostAcceptancePluginFiles(
        repositoryRoot,
        installedRoot,
      );
      expect(loaded.repositoryPluginFiles.map(({ path }) => path)).toEqual(
        HOST_ACCEPTANCE_REPOSITORY_PLUGIN_PATHS,
      );
      expect(loaded.installedPluginFiles.map(({ path }) => path)).toEqual(
        HOST_ACCEPTANCE_PLUGIN_PATHS,
      );
      await expect(
        lstat(
          path.join(
            repositoryRoot,
            "plugins",
            "codex-external-agents",
            "runtime",
            "codex-external-agents-mcp.mjs",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const runtimeRelative = path.join(
        "runtime",
        "codex-external-agents-mcp.mjs",
      );
      await rm(path.join(installedRoot, runtimeRelative));
      await expect(
        loadHostAcceptancePluginFiles(repositoryRoot, installedRoot),
      ).rejects.toThrow("Host acceptance session is invalid.");

      const outsideRuntime = path.join(temporary, "outside-runtime");
      await mkdir(outsideRuntime);
      await writeFile(
        path.join(outsideRuntime, "codex-external-agents-mcp.mjs"),
        bytes("outside-runtime"),
      );
      await rm(path.join(installedRoot, "runtime"), {
        recursive: true,
        force: true,
      });
      await symlink(
        outsideRuntime,
        path.join(installedRoot, "runtime"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        loadHostAcceptancePluginFiles(repositoryRoot, installedRoot),
      ).rejects.toThrow("Host acceptance session is invalid.");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

describe("isolated delegate workspace", () => {
  it("creates a fresh workspace and completion-marker directory outside the tag checkout", async () => {
    const temporary = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "host-acceptance-start-")),
    );
    try {
      const descriptorPath = path.join(
        temporary,
        "descriptor",
        "session.v1.json",
      );
      const sessionRoot = path.join(temporary, "sessions", "nonce");
      const delegateWorkspace = path.join(
        sessionRoot,
        "delegate-workspace",
      );
      const plan = {
        ...buildHostAcceptanceSession(fixture()),
        descriptorPath,
        sessionRoot,
        delegateWorkspace,
        receiptPath: path.join(
          sessionRoot,
          "host-acceptance-receipt.v1.json",
        ),
      };

      await prepareHostAcceptanceDirectories(plan);
      expect((await lstat(delegateWorkspace)).isDirectory()).toBe(true);
      expect(
        (
          await lstat(path.join(sessionRoot, "completion-markers"))
        ).isDirectory(),
      ).toBe(true);
      await expect(prepareHostAcceptanceDirectories(plan)).rejects.toThrow();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "rejects a reparse-point session parent",
    async () => {
      const temporary = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "host-acceptance-reparse-")),
      );
      try {
        const target = path.join(temporary, "target");
        const linkedSessions = path.join(temporary, "sessions");
        await mkdir(target);
        await symlink(target, linkedSessions, "junction");
        const sessionRoot = path.join(linkedSessions, "nonce");
        const plan = {
          ...buildHostAcceptanceSession(fixture()),
          descriptorPath: path.join(
            temporary,
            "descriptor",
            "session.v1.json",
          ),
          sessionRoot,
          delegateWorkspace: path.join(
            sessionRoot,
            "delegate-workspace",
          ),
          receiptPath: path.join(
            sessionRoot,
            "host-acceptance-receipt.v1.json",
          ),
        };

        await expect(prepareHostAcceptanceDirectories(plan)).rejects.toThrow();
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
});

describe("observer action gates", () => {
  it("publishes only after READY, prints fixed actions, then removes the descriptor", async () => {
    const actions: string[] = [];
    await consumeObserverLifecycle({
      lines: (async function* () {
        yield "READY";
        yield "OLD_HOST_BOUND";
        yield "OLD_HOST_EXITED";
        yield "REQUEST_STARTED";
      })(),
      exitCode: Promise.resolve(0),
      publishDescriptor: async () => actions.push("publish"),
      removeDescriptor: async () => actions.push("remove"),
      announce: (message) => actions.push(message),
    });

    expect(actions[0]).toBe("publish");
    expect(actions).toEqual(expect.arrayContaining([
      expect.stringContaining("旧 App"),
      expect.stringContaining("完整退出"),
      expect.stringContaining("重新打开"),
      expect.stringContaining("点击 Stop"),
    ]));
    expect(actions.at(-1)).toBe("remove");
  });

  it.each([
    [["OLD_HOST_BOUND"], 1],
    [["READY", "REQUEST_STARTED"], 1],
    [["READY", "OLD_HOST_BOUND", "OLD_HOST_EXITED", "REQUEST_STARTED", "PASS"], 0],
    [["READY", "OLD_HOST_BOUND", "OLD_HOST_EXITED", "REQUEST_STARTED"], 1],
  ])("fails closed for invalid phase/exit sequences", async (lines, exitCode) => {
    const remove = vi.fn(async () => undefined);
    await expect(
      consumeObserverLifecycle({
        lines: (async function* () {
          yield* lines;
        })(),
        exitCode: Promise.resolve(exitCode),
        publishDescriptor: async () => undefined,
        removeDescriptor: remove,
        announce: () => undefined,
      }),
    ).rejects.toThrow("Host acceptance observer failed.");
    if (lines[0] === "READY") expect(remove).toHaveBeenCalledOnce();
  });

  it("removes the exact descriptor when a post-READY instruction fails", async () => {
    const remove = vi.fn(async () => undefined);
    await expect(
      consumeObserverLifecycle({
        lines: (async function* () {
          yield "READY";
          yield "OLD_HOST_BOUND";
        })(),
        exitCode: Promise.resolve(1),
        publishDescriptor: async () => undefined,
        removeDescriptor: remove,
        announce: () => {
          throw new Error("closed output");
        },
      }),
    ).rejects.toThrow("Host acceptance observer failed.");
    expect(remove).toHaveBeenCalledOnce();
  });
});
