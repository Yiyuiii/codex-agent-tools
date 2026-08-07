import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertCurrentHostFreezeReceipt,
  assertHostAcceptanceReceipt,
  assertHostStopReleaseDecision,
  buildReleaseNpmViewInvocation,
  computeHostAcceptanceEventSha256,
  computeHostAcceptanceRequestBindingSha256,
  digestReleasePluginArtifactTree,
  parseObserverBuildConfig,
  parseObserverBuildInputsManifest,
  parseNpmViewResponse,
  parseReleaseValidationMarker,
  readStrictReleaseEvidenceFile,
  RELEASE_PLUGIN_ARTIFACT_PATHS,
  type CapabilityFingerprintProjection,
  type ReleaseValidationCore,
  type StableReleaseValidationMarker,
  verifyReleaseValidation,
} from "../../src/release/release-validation.js";

const H64 = "a".repeat(64);
const H40 = "b".repeat(40);
const RUNTIME_COMMIT = "1".repeat(40);
const BETA_COMMIT = "2".repeat(40);
const TAG_COMMIT = "3".repeat(40);
const OBSERVER_PATH =
  "host-acceptance/win32-x64/codex-host-acceptance-observer.exe";
const OBSERVER_MANIFEST_PATH =
  "host-acceptance/observer-build-inputs.v1.json";
const OBSERVER_PROTOCOL_PATH =
  "host-acceptance/protocol/observer-protocol.v1.json";

describe("release npm metadata invocation", () => {
  it("runs the fixed npm CLI through the current Node executable on Windows", () => {
    expect(
      buildReleaseNpmViewInvocation({
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        packageName: "codex-agent-tools",
        packageVersion: "0.1.1-beta.4",
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      trustedScriptPath:
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "view",
        "codex-agent-tools@0.1.1-beta.4",
        "version",
        "dist",
        "--json",
        "--registry=https://registry.npmjs.org/",
      ],
    });
  });

  it("uses npm directly with the same official-registry query on non-Windows hosts", () => {
    expect(
      buildReleaseNpmViewInvocation({
        nodeExecutable: "/usr/local/bin/node",
        packageName: "codex-agent-tools",
        packageVersion: "0.1.1-beta.4",
        platform: "linux",
      }),
    ).toEqual({
      command: "npm",
      trustedScriptPath: null,
      args: [
        "view",
        "codex-agent-tools@0.1.1-beta.4",
        "version",
        "dist",
        "--json",
        "--registry=https://registry.npmjs.org/",
      ],
    });
  });

  it("rejects package identity drift and non-absolute Windows Node paths", () => {
    expect(() =>
      buildReleaseNpmViewInvocation({
        nodeExecutable: "node.exe",
        packageName: "codex-agent-tools",
        packageVersion: "0.1.1-beta.4",
        platform: "win32",
      }),
    ).toThrow("Release validation evidence is invalid");
    expect(() =>
      buildReleaseNpmViewInvocation({
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        packageName: "different-package",
        packageVersion: "0.1.1-beta.4",
        platform: "win32",
      }),
    ).toThrow("Release validation evidence is invalid");
  });
});

type PassedStableMarker = Omit<
  StableReleaseValidationMarker,
  "hostAcceptance"
> & {
  readonly hostAcceptance: Extract<
    StableReleaseValidationMarker["hostAcceptance"],
    { readonly status: "passed" }
  >;
};

type SkippedStableMarker = Omit<
  StableReleaseValidationMarker,
  "hostAcceptance"
> & {
  readonly hostAcceptance: Extract<
    StableReleaseValidationMarker["hostAcceptance"],
    { readonly status: "skipped_by_maintainer" }
  >;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const capabilities: readonly CapabilityFingerprintProjection[] = [
  ["ark-agent-deepseek-v4-flash", "delegate"],
  ["ark-agent-deepseek-v4-flash", "review"],
  ["ark-agent-plan", "delegate"],
  ["ark-agent-plan", "review"],
  ["ark-coding-plan", "delegate"],
  ["ark-coding-plan", "review"],
  ["kimi-k3", "delegate"],
  ["kimi-k3", "review"],
].map(([llm, task], index) => ({
  llm: llm!,
  task: task as "delegate" | "review",
  currentFingerprintSha256: index.toString(16).repeat(64),
}));

function capabilityIndexBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      entries: capabilities.map((entry) => ({
        llm: entry.llm,
        task: entry.task,
        runtimeFingerprintSha256: entry.currentFingerprintSha256,
        source: { kind: "already-verified-by-offline-gate" },
      })),
    }),
  );
}

function core(indexBytes = capabilityIndexBytes()): ReleaseValidationCore {
  return {
    runtimeFrozenCommit: RUNTIME_COMMIT,
    canonicalRuntime: { schemaVersion: 1, digestSha256: H64 },
    windowsJobHelper: {
      path:
        "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe",
      sha256: H64,
    },
    capabilityIndex: {
      path: "docs/smoke/evidence/capabilities.json",
      sha256: sha256(indexBytes),
      entryCount: 8,
    },
    currentHostFreeze: {
      path: `.release-validation/evidence/current-host-${RUNTIME_COMMIT}.json`,
      sha256: H64,
    },
  };
}

function pluginEntries(runtime = Buffer.from("plugin-runtime")) {
  return RELEASE_PLUGIN_ARTIFACT_PATHS.map((artifactPath, index) => ({
    path: artifactPath,
    content:
      artifactPath.endsWith("codex-external-agents-mcp.mjs")
        ? runtime
        : Buffer.from(`plugin-artifact-${index}`),
  }));
}

function observerFixture(artifactBytes = Buffer.from("observer-v1")) {
  const buildConfig = {
    schemaVersion: 1,
    sharedBuildContract: {
      toolchainLockPath: "native/windows-job-helper/toolchain.lock.json",
      buildConfigPath: "native/windows-job-helper/build.config.json",
      restoreToolchainPath: "native/windows-job-helper/restore-toolchain.ps1",
    },
    sourceSets: {
      production: ["src/Program.cs", "src/WindowsObserver.cs"],
    },
    artifact: { path: OBSERVER_PATH },
  };
  const inputFiles = new Map<string, Buffer>([
    ["host-acceptance/build.config.json", Buffer.from(JSON.stringify(buildConfig))],
    ["host-acceptance/build.ps1", Buffer.from("build-entry")],
    [OBSERVER_PROTOCOL_PATH, Buffer.from("protocol-v1")],
    ["host-acceptance/src/Program.cs", Buffer.from("class Program {}")],
    ["host-acceptance/src/WindowsObserver.cs", Buffer.from("class WindowsObserver {}")],
    ["native/windows-job-helper/build.config.json", Buffer.from("shared-build-contract")],
    ["native/windows-job-helper/restore-toolchain.ps1", Buffer.from("shared-toolchain-restore")],
    ["native/windows-job-helper/toolchain.lock.json", Buffer.from("toolchain")],
  ]);
  const inputs = [...inputFiles]
    .map(([inputPath, bytes]) => ({ path: inputPath, sha256: sha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const inputsDigestSha256 = sha256(
    JSON.stringify({ schemaVersion: 1, inputs }),
  );
  const manifest = {
    schemaVersion: 1,
    artifactPath: OBSERVER_PATH,
    protocol: {
      path: OBSERVER_PROTOCOL_PATH as typeof OBSERVER_PROTOCOL_PATH,
      sha256: sha256(inputFiles.get(OBSERVER_PROTOCOL_PATH)!),
    },
    inputs,
    inputsDigestSha256,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return {
    artifactBytes,
    buildConfig,
    inputFiles,
    manifest,
    manifestBytes,
    identity: {
      path: OBSERVER_PATH as typeof OBSERVER_PATH,
      sha256: sha256(artifactBytes),
      protocolVersion: 1 as const,
      buildManifest: {
        path: OBSERVER_MANIFEST_PATH as typeof OBSERVER_MANIFEST_PATH,
        sha256: sha256(manifestBytes),
      },
      protocol: manifest.protocol,
      inputsDigestSha256,
    },
  };
}

function observerArtifact(bytes = Buffer.from("observer-v1")) {
  return observerFixture(bytes).identity;
}

function betaMarker(targetCore = core(), artifacts = pluginEntries()) {
  return {
    schemaVersion: 1 as const,
    kind: "beta" as const,
    package: {
      name: "codex-agent-tools" as const,
      version: "0.1.1-beta.1",
      tag: "v0.1.1-beta.1",
      npmChannel: "next" as const,
    },
    core: targetCore,
    pluginArtifactTree: {
      schemaVersion: 1 as const,
      digestSha256: digestReleasePluginArtifactTree(artifacts),
    },
    observerArtifact: observerArtifact(),
  };
}

function stableMarker(targetCore = core()): PassedStableMarker {
  const beta = betaMarker(targetCore);
  return {
    schemaVersion: 2,
    kind: "stable",
    package: {
      name: "codex-agent-tools",
      version: "0.1.1",
      tag: "v0.1.1",
      npmChannel: "latest",
    },
    core: targetCore,
    publicBeta: {
      version: "0.1.1-beta.1",
      tag: "v0.1.1-beta.1",
      taggedCommit: BETA_COMMIT,
      markerPath: ".release-validation/v0.1.1-beta.1.json",
      markerSha256: H64,
      pluginArtifactTreeDigestSha256:
        beta.pluginArtifactTree.digestSha256,
      observerArtifact: beta.observerArtifact,
      npm: {
        integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
        shasum: H40,
      },
    },
    hostAcceptance: {
      status: "passed",
      receipt: {
        path:
          ".release-validation/evidence/v0.1.1-beta.1-host-acceptance.json",
        sha256: H64,
        sessionNonceSha256: H64,
      },
    },
  };
}

function skippedStableMarker(targetCore = core()): SkippedStableMarker {
  const passed = stableMarker(targetCore);
  return {
    ...passed,
    publicBeta: {
      ...passed.publicBeta,
      version: "0.1.1-beta.4",
      tag: "v0.1.1-beta.4",
      markerPath: ".release-validation/v0.1.1-beta.4.json",
    },
    hostAcceptance: {
      status: "skipped_by_maintainer",
      risk: "host_stop_unverified",
      decision: {
        path: ".release-validation/evidence/v0.1.1-host-stop-decision.json",
        sha256: H64,
      },
    },
  };
}

function hostStopDecision(marker: StableReleaseValidationMarker) {
  return {
    schemaVersion: 1,
    kind: "host-stop-release-decision",
    package: marker.package,
    publicBeta: marker.publicBeta,
    decision: "skipped_by_maintainer",
    risk: "host_stop_unverified",
    reason: "interactive_host_stop_not_completed",
    decidedAt: "2026-08-07T09:00:00.000Z",
  };
}

function freezeReceipt(
  targetCore: ReleaseValidationCore,
  staleCount = 8,
  projection: readonly CapabilityFingerprintProjection[] = capabilities,
  observer = observerArtifact(),
) {
  return {
    schemaVersion: 1,
    kind: "current-host-freeze",
    runtimeFrozenCommit: targetCore.runtimeFrozenCommit,
    canonicalRuntimeDigestSha256: targetCore.canonicalRuntime.digestSha256,
    windowsJobHelperSha256: targetCore.windowsJobHelper.sha256,
    observerArtifact: observer,
    capabilities: projection,
    hostObservation: {
      platform: "win32",
      architecture: "x64",
      windowsVersion: "10.0.19045",
      nodeVersion: "24.14.1",
      libuvVersion: "1.51.0",
      npmVersion: "11.11.0",
      dotNetFrameworkRelease: "528040",
    },
    checks: {
      nativePreflight: "passed",
      nativeVerify: "passed",
      observerVerify: "passed",
      capabilityEvidenceValidCount: 8,
      prequalificationStaleCount: staleCount,
      realModelCalls: 0,
      activeConfigAccesses: 0,
      activePluginChanges: 0,
      publishes: 0,
    },
  };
}

function hostReceipt(marker: StableReleaseValidationMarker) {
  const nonce = "release-session-nonce-0123456789abcdef";
  const nonceSha256 = sha256(nonce);
  const descriptorSha256 = sha256("host-acceptance-session-descriptor-v1");
  const identities = {
    oldChatGpt: "4".repeat(64),
    oldAppServer: "5".repeat(64),
    oldKernelPeerMcp: "9".repeat(64),
    newChatGpt: "6".repeat(64),
    newAppServer: "7".repeat(64),
    newKernelPeerMcp: "c".repeat(64),
  };
  const correlationSha256 = "8".repeat(64);
  const completionMarkerIdentitySha256 = sha256(
    `completion:${nonceSha256}:${correlationSha256}`,
  );
  const bindingSha256 = computeHostAcceptanceRequestBindingSha256({
    sessionNonceSha256: nonceSha256,
    newChatGptIdentitySha256: identities.newChatGpt,
    newAppServerIdentitySha256: identities.newAppServer,
    newKernelPeerMcpIdentitySha256: identities.newKernelPeerMcp,
    requestCorrelationSha256: correlationSha256,
    completionMarkerIdentitySha256,
    sessionDescriptorSha256: descriptorSha256,
  });
  const at = (second: number) =>
    `2026-08-02T01:00:${second.toString().padStart(2, "0")}.000Z`;
  const event = (
    name: string,
    second: number,
    previousSha256: string,
    outcome: string,
    extra: Record<string, unknown> = {},
  ) => ({
    observed: true,
    at: at(second),
    previousSha256,
    eventSha256: computeHostAcceptanceEventSha256(
      name,
      at(second),
      previousSha256,
      outcome,
    ),
    ...extra,
  });
  const started = event(
    "request-started",
    7,
    bindingSha256,
    `bound:${completionMarkerIdentitySha256}:${descriptorSha256}`,
    { completionMarkerIdentitySha256, sessionDescriptorSha256: descriptorSha256 },
  );
  const sdkAbort = event("sdk-abort", 8, started.eventSha256, "true");
  const ownedProcessExit = event(
    "owned-process-exit",
    9,
    sdkAbort.eventSha256,
    "cancelled",
    { completion: "cancelled" },
  );
  const ownershipDrained = event(
    "ownership-drained",
    9,
    ownedProcessExit.eventSha256,
    "true",
  );
  const handlerCancelled = event(
    "handler-cancelled",
    10,
    ownershipDrained.eventSha256,
    "cancelled",
    { outcome: "cancelled" },
  );
  const inFlightRemoved = event(
    "in-flight-removed",
    10,
    handlerCancelled.eventSha256,
    "true",
  );
  const completionMarkerChecked = event(
    "completion-marker-checked",
    11,
    inFlightRemoved.eventSha256,
    `absent:${completionMarkerIdentitySha256}`,
    { absent: true, completionMarkerIdentitySha256 },
  );
  return {
    schemaVersion: 1,
    kind: "host-acceptance",
    beta: {
      version: marker.publicBeta.version,
      tag: marker.publicBeta.tag,
      taggedCommit: marker.publicBeta.taggedCommit,
      npm: marker.publicBeta.npm,
    },
    pluginArtifactTreeDigestSha256:
      marker.publicBeta.pluginArtifactTreeDigestSha256,
    core: marker.core,
    observerArtifact: marker.publicBeta.observerArtifact,
    session: { nonce, nonceSha256, descriptorSha256 },
    oldHost: {
      chatGpt: {
        identitySha256: identities.oldChatGpt,
        createdAt: at(0),
        exitedAt: at(3),
      },
      appServer: {
        identitySha256: identities.oldAppServer,
        createdAt: at(1),
        exitedAt: at(5),
      },
      kernelPeerMcp: {
        identitySha256: identities.oldKernelPeerMcp,
        createdAt: at(1),
        exitedAt: at(4),
      },
    },
    newHost: {
      chatGpt: { identitySha256: identities.newChatGpt, createdAt: at(6) },
      appServer: {
        identitySha256: identities.newAppServer,
        createdAt: at(6),
      },
      kernelPeerMcp: {
        identitySha256: identities.newKernelPeerMcp,
        createdAt: at(7),
      },
    },
    request: {
      correlationSha256,
      completionMarkerIdentitySha256,
      bindingSha256,
      started,
      sdkAbort,
      ownedProcessExit,
      ownershipDrained,
      handlerCancelled,
      inFlightRemoved,
      completionMarkerChecked,
    },
    result: "passed",
  };
}

function canonicalIdentity() {
  return {
    digestSha256: H64,
    serialized: "{}",
    manifest: { helperArtifact: { sha256: H64 } },
  } as never;
}

describe("strict release validation marker", () => {
  it("accepts exact beta and both stable host-decision states bound to workflow context", () => {
    expect(
      parseReleaseValidationMarker(betaMarker(), {
        packageVersion: "0.1.1-beta.1",
        tag: "v0.1.1-beta.1",
        npmChannel: "next",
      }).kind,
    ).toBe("beta");
    expect(
      parseReleaseValidationMarker(stableMarker(), {
        packageVersion: "0.1.1",
        tag: "v0.1.1",
        npmChannel: "latest",
      }).kind,
    ).toBe("stable");
    const skipped = parseReleaseValidationMarker(skippedStableMarker(), {
      packageVersion: "0.1.1",
      tag: "v0.1.1",
      npmChannel: "latest",
    });
    expect(skipped).toMatchObject({
      kind: "stable",
      schemaVersion: 2,
      hostAcceptance: {
        status: "skipped_by_maintainer",
        risk: "host_stop_unverified",
      },
    });
  });

  it.each([
    [
      "passed state with skip decision fields",
      () => ({
        ...stableMarker(),
        hostAcceptance: {
          ...stableMarker().hostAcceptance,
          risk: "host_stop_unverified",
        },
      }),
    ],
    [
      "skipped state with receipt fields",
      () => ({
        ...skippedStableMarker(),
        hostAcceptance: {
          ...skippedStableMarker().hostAcceptance,
          receipt: stableMarker().hostAcceptance.receipt,
        },
      }),
    ],
    [
      "unknown skip risk",
      () => ({
        ...skippedStableMarker(),
        hostAcceptance: {
          ...skippedStableMarker().hostAcceptance,
          risk: "generic_release_waiver",
        },
      }),
    ],
    [
      "legacy stable schema",
      () => ({ ...stableMarker(), schemaVersion: 1 }),
    ],
    [
      "skip bound to another beta",
      () => ({
        ...skippedStableMarker(),
        publicBeta: {
          ...skippedStableMarker().publicBeta,
          version: "0.1.1-beta.3",
          tag: "v0.1.1-beta.3",
          markerPath: ".release-validation/v0.1.1-beta.3.json",
        },
      }),
    ],
    [
      "skip generalized to a later stable",
      () => ({
        ...skippedStableMarker(),
        package: {
          ...skippedStableMarker().package,
          version: "0.1.2",
          tag: "v0.1.2",
        },
        publicBeta: {
          ...skippedStableMarker().publicBeta,
          version: "0.1.2-beta.4",
          tag: "v0.1.2-beta.4",
          markerPath: ".release-validation/v0.1.2-beta.4.json",
        },
        hostAcceptance: {
          ...skippedStableMarker().hostAcceptance,
          decision: {
            ...skippedStableMarker().hostAcceptance.decision,
            path: ".release-validation/evidence/v0.1.2-host-stop-decision.json",
          },
        },
      }),
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = mutate();
    expect(() =>
      parseReleaseValidationMarker(value, {
        packageVersion: value.package.version,
        tag: value.package.tag,
        npmChannel: "latest",
      }),
    ).toThrow("Release validation evidence is invalid");
  });

  it.each([
    ["extra field", () => ({ ...betaMarker(), pass: true })],
    ["missing field", () => {
      const value = { ...betaMarker() } as Record<string, unknown>;
      delete value.core;
      return value;
    }],
    ["wrong channel", () => ({
      ...betaMarker(),
      package: { ...betaMarker().package, npmChannel: "latest" },
    })],
    ["wrong observer path", () => ({
      ...betaMarker(),
      observerArtifact: { ...betaMarker().observerArtifact, path: "observer.exe" },
    })],
  ])("rejects %s", (_name, mutate) => {
    expect(() =>
      parseReleaseValidationMarker(mutate(), {
        packageVersion: "0.1.1-beta.1",
        tag: "v0.1.1-beta.1",
        npmChannel: "next",
      }),
    ).toThrow("Release validation evidence is invalid");
  });

  it("rejects proxies, getters, symbols, and sparse arrays", () => {
    expect(() =>
      parseReleaseValidationMarker(new Proxy(betaMarker(), {}), {
        packageVersion: "0.1.1-beta.1",
        tag: "v0.1.1-beta.1",
        npmChannel: "next",
      }),
    ).toThrow();
    const getter = { ...betaMarker() } as Record<string, unknown>;
    Object.defineProperty(getter, "kind", {
      enumerable: true,
      get: () => "beta",
    });
    expect(() =>
      parseReleaseValidationMarker(getter, {
        packageVersion: "0.1.1-beta.1",
        tag: "v0.1.1-beta.1",
        npmChannel: "next",
      }),
    ).toThrow();
    const symbol = betaMarker() as Record<PropertyKey, unknown>;
    symbol[Symbol("unsafe")] = true;
    expect(() =>
      parseReleaseValidationMarker(symbol, {
        packageVersion: "0.1.1-beta.1",
        tag: "v0.1.1-beta.1",
        npmChannel: "next",
      }),
    ).toThrow();
  });

  it("parses the exact npm view version and nested dist identity", () => {
    const npm = stableMarker().publicBeta.npm;
    expect(
      parseNpmViewResponse(
        {
          version: "0.1.1-beta.1",
          dist: { ...npm, tarball: "https://registry.invalid/redacted.tgz" },
        },
        "0.1.1-beta.1",
      ),
    ).toEqual(npm);
    expect(() =>
      parseNpmViewResponse(
        { version: "0.1.1-beta.2", dist: npm },
        "0.1.1-beta.1",
      ),
    ).toThrow();
  });

  it("binds exact ordered plugin entries and rejects entry extras", () => {
    const entries = pluginEntries();
    expect(
      digestReleasePluginArtifactTree(
        entries.map((entry, index) =>
          index === 2 ? { ...entry, content: Buffer.from("changed") } : entry,
        ),
      ),
    ).not.toBe(digestReleasePluginArtifactTree(entries));
    expect(() => digestReleasePluginArtifactTree([...entries].reverse())).toThrow();
    expect(() =>
      digestReleasePluginArtifactTree(
        entries.map((entry, index) =>
          index === 0 ? { ...entry, extra: true } : entry,
        ),
      ),
    ).toThrow();
  });

  it("accepts only the fixed sorted observer build-input manifest contract", () => {
    const fixture = observerFixture();
    expect(
      parseObserverBuildInputsManifest(fixture.manifest, fixture.buildConfig),
    ).toMatchObject({
      artifactPath: OBSERVER_PATH,
      inputsDigestSha256: fixture.identity.inputsDigestSha256,
    });
    const reversed = {
      ...fixture.manifest,
      inputs: [...fixture.manifest.inputs].reverse(),
      inputsDigestSha256: sha256(
        JSON.stringify({
          schemaVersion: 1,
          inputs: [...fixture.manifest.inputs].reverse(),
        }),
      ),
    };
    expect(() =>
      parseObserverBuildInputsManifest(reversed, fixture.buildConfig),
    ).toThrow();
    const forbiddenInputs = fixture.manifest.inputs.map((entry, index) =>
        index === 0 ? { ...entry, path: "docs/not-a-build-input.md" } : entry,
      );
    const forbidden = {
      ...fixture.manifest,
      inputs: forbiddenInputs,
      inputsDigestSha256: sha256(
        JSON.stringify({ schemaVersion: 1, inputs: forbiddenInputs }),
      ),
    };
    expect(() =>
      parseObserverBuildInputsManifest(forbidden, fixture.buildConfig),
    ).toThrow();
    for (const requiredSharedInput of [
      "native/windows-job-helper/build.config.json",
      "native/windows-job-helper/restore-toolchain.ps1",
    ]) {
      const incompleteInputs = fixture.manifest.inputs.filter(
        (entry) => entry.path !== requiredSharedInput,
      );
      expect(() =>
        parseObserverBuildInputsManifest(
          {
            ...fixture.manifest,
            inputs: incompleteInputs,
            inputsDigestSha256: sha256(
              JSON.stringify({ schemaVersion: 1, inputs: incompleteInputs }),
            ),
          },
          fixture.buildConfig,
        ),
      ).toThrow();
    }
  });

  it("derives the complete observer source list only from strict build config", () => {
    const fixture = observerFixture();
    expect(parseObserverBuildConfig(fixture.buildConfig).sourcePaths).toEqual([
      "host-acceptance/src/Program.cs",
      "host-acceptance/src/WindowsObserver.cs",
    ]);
    for (const invalidConfig of [
      {
        ...fixture.buildConfig,
        sourceSets: {
          production: ["src/Program.cs", "src/Program.cs"],
        },
      },
      {
        ...fixture.buildConfig,
        sourceSets: { production: ["../outside.cs"] },
      },
      {
        ...fixture.buildConfig,
        sourceSets: {
          ...fixture.buildConfig.sourceSets,
          tests: ["src/Test.cs"],
        },
      },
      { ...fixture.buildConfig, compilerArguments: ["/unsafe+"] },
    ]) {
      expect(() => parseObserverBuildConfig(invalidConfig)).toThrow();
    }

    for (const sourceMutation of [
      fixture.manifest.inputs.filter(
        (entry) => entry.path !== "host-acceptance/src/WindowsObserver.cs",
      ),
      [
        ...fixture.manifest.inputs,
        { path: "host-acceptance/src/Extra.cs", sha256: H64 },
      ].sort((left, right) => left.path.localeCompare(right.path)),
    ]) {
      expect(() =>
        parseObserverBuildInputsManifest(
          {
            ...fixture.manifest,
            inputs: sourceMutation,
            inputsDigestSha256: sha256(
              JSON.stringify({ schemaVersion: 1, inputs: sourceMutation }),
            ),
          },
          fixture.buildConfig,
        ),
      ).toThrow();
    }
  });
});

describe("release receipts", () => {
  it("binds all eight capability fingerprints and requires all eight to be stale", () => {
    expect(
      assertCurrentHostFreezeReceipt(
        freezeReceipt(core(), 8),
        core(),
        capabilities,
        observerArtifact(),
      )
        .checks.prequalificationStaleCount,
    ).toBe(8);
    for (const staleCount of [0, 7, 9, 1.5]) {
      expect(() =>
        assertCurrentHostFreezeReceipt(
          freezeReceipt(core(), staleCount),
          core(),
          capabilities,
          observerArtifact(),
        ),
      ).toThrow();
    }
    const drift = capabilities.map((entry, index) =>
      index === 0 ? { ...entry, currentFingerprintSha256: "f".repeat(64) } : entry,
    );
    expect(() =>
      assertCurrentHostFreezeReceipt(
        freezeReceipt(core(), 8, drift),
        core(),
        capabilities,
        observerArtifact(),
      ),
    ).toThrow();

    const expectedObserver = observerArtifact();
    for (const driftObserver of [
      { ...expectedObserver, sha256: H64 },
      {
        ...expectedObserver,
        buildManifest: { ...expectedObserver.buildManifest, sha256: H64 },
      },
      {
        ...expectedObserver,
        protocol: { ...expectedObserver.protocol, sha256: H64 },
      },
      { ...expectedObserver, inputsDigestSha256: H64 },
    ]) {
      expect(() =>
        assertCurrentHostFreezeReceipt(
          freezeReceipt(core(), 8, capabilities, driftObserver),
          core(),
          capabilities,
          expectedObserver,
        ),
      ).toThrow();
    }
  });

  it("requires full restart then new-host request Stop with an intact event hash chain", () => {
    const draft = stableMarker();
    const receipt = hostReceipt(draft);
    const marker = {
      ...draft,
      hostAcceptance: {
        ...draft.hostAcceptance,
        receipt: {
          ...draft.hostAcceptance.receipt,
          sessionNonceSha256: receipt.session.nonceSha256,
        },
      },
    };
    expect(assertHostAcceptanceReceipt(receipt, marker).result).toBe("passed");
    const cases = [
      {
        ...receipt,
        pluginArtifactTreeDigestSha256: H64,
      },
      {
        ...receipt,
        session: {
          ...receipt.session,
          descriptorSha256: H64,
        },
      },
      {
        ...receipt,
        request: {
          ...receipt.request,
          ownedProcessExit: {
            ...receipt.request.ownedProcessExit,
            completion: "sessionShutdown",
          },
        },
      },
      {
        ...receipt,
        request: {
          ...receipt.request,
          completionMarkerIdentitySha256: H64,
        },
      },
      {
        ...receipt,
        request: {
          ...receipt.request,
          started: {
            ...receipt.request.started,
            completionMarkerIdentitySha256: H64,
          },
        },
      },
      {
        ...receipt,
        newHost: {
          ...receipt.newHost,
          appServer: {
            ...receipt.newHost.appServer,
            identitySha256: "9".repeat(64),
          },
        },
      },
      {
        ...receipt,
        newHost: {
          ...receipt.newHost,
          kernelPeerMcp: {
            ...receipt.newHost.kernelPeerMcp,
            identitySha256: "d".repeat(64),
          },
        },
      },
      {
        ...receipt,
        request: {
          ...receipt.request,
          sdkAbort: { ...receipt.request.sdkAbort, eventSha256: H64 },
        },
      },
      {
        ...receipt,
        request: {
          ...receipt.request,
          completionMarkerChecked: {
            ...receipt.request.completionMarkerChecked,
            absent: false,
          },
        },
      },
      {
        ...receipt,
        request: {
          ...receipt.request,
          completionMarkerChecked: {
            ...receipt.request.completionMarkerChecked,
            completionMarkerIdentitySha256: H64,
          },
        },
      },
      {
        ...receipt,
        oldHost: {
          ...receipt.oldHost,
          chatGpt: {
            ...receipt.oldHost.chatGpt,
            exitedAt: receipt.newHost.chatGpt.createdAt,
          },
        },
      },
    ];
    for (const invalid of cases) {
      expect(() => assertHostAcceptanceReceipt(invalid, marker)).toThrow();
    }
  });

  it("binds the maintainer skip decision to the exact stable and public beta identities", () => {
    const marker = skippedStableMarker();
    const decision = hostStopDecision(marker);
    expect(assertHostStopReleaseDecision(decision, marker)).toMatchObject({
      decision: "skipped_by_maintainer",
      risk: "host_stop_unverified",
      reason: "interactive_host_stop_not_completed",
    });
    const invalid = [
      { ...decision, extra: true },
      { ...decision, risk: "generic_release_waiver" },
      { ...decision, decision: "passed" },
      {
        ...decision,
        package: { ...decision.package, version: "0.1.2" },
      },
      {
        ...decision,
        publicBeta: {
          ...decision.publicBeta,
          markerSha256: "f".repeat(64),
        },
      },
      {
        ...decision,
        publicBeta: {
          ...decision.publicBeta,
          pluginArtifactTreeDigestSha256: H64,
        },
      },
      {
        ...decision,
        publicBeta: {
          ...decision.publicBeta,
          npm: { ...decision.publicBeta.npm, shasum: "c".repeat(40) },
        },
      },
      {
        ...decision,
        publicBeta: {
          ...decision.publicBeta,
          observerArtifact: {
            ...decision.publicBeta.observerArtifact,
            sha256: H64,
          },
        },
      },
    ];
    for (const value of invalid) {
      expect(() => assertHostStopReleaseDecision(value, marker)).toThrow(
        "Release validation evidence is invalid",
      );
    }
    expect(() =>
      assertHostStopReleaseDecision(new Proxy(decision, {}), marker),
    ).toThrow("Release validation evidence is invalid");
  });
});

describe("release validation verifier", () => {
  it("verifies beta core, current capability projection, plugin tree, and frozen observer", async () => {
    const indexBytes = capabilityIndexBytes();
    const artifacts = pluginEntries();
    const observer = observerFixture();
    const draftCore = core(indexBytes);
    const freezeBytes = Buffer.from(JSON.stringify(freezeReceipt(draftCore)));
    const finalCore = {
      ...draftCore,
      currentHostFreeze: {
        ...draftCore.currentHostFreeze,
        sha256: sha256(freezeBytes),
      },
    };
    const marker = betaMarker(finalCore, artifacts);
    const files = new Map<string, Buffer>([
      ["package.json", Buffer.from(JSON.stringify({ name: "codex-agent-tools", version: "0.1.1-beta.1" }))],
      [".release-validation/v0.1.1-beta.1.json", Buffer.from(JSON.stringify(marker))],
      ["docs/smoke/evidence/capabilities.json", indexBytes],
      [finalCore.currentHostFreeze.path, freezeBytes],
      [OBSERVER_PATH, observer.artifactBytes],
      [OBSERVER_MANIFEST_PATH, observer.manifestBytes],
      ...[...observer.inputFiles].map(
        ([inputPath, bytes]) => [inputPath, bytes] as const,
      ),
      ...artifacts.map((entry) => [entry.path, entry.content] as const),
    ]);
    await expect(
      verifyReleaseValidation(
        {
          repositoryRoot: "virtual",
          packageVersion: "0.1.1-beta.1",
          tag: "v0.1.1-beta.1",
          taggedCommit: TAG_COMMIT,
          npmChannel: "next",
        },
        {
          readRepositoryFile: async (_root, file) => files.get(file)!,
          collectCanonicalIdentity: async () => canonicalIdentity(),
          resolveGitTagCommit: async () => TAG_COMMIT,
          isGitAncestor: async (_root, ancestor, descendant) =>
            ancestor === RUNTIME_COMMIT && descendant === TAG_COMMIT,
        },
      ),
    ).resolves.toMatchObject({ kind: "beta" });
  });

  it("promotes beta-bound artifacts without requiring the stable commit's plugin tree", async () => {
    const indexBytes = capabilityIndexBytes();
    const artifacts = pluginEntries();
    const observer = observerFixture();
    const draftCore = core(indexBytes);
    const freezeBytes = Buffer.from(JSON.stringify(freezeReceipt(draftCore)));
    const finalCore = {
      ...draftCore,
      currentHostFreeze: {
        ...draftCore.currentHostFreeze,
        sha256: sha256(freezeBytes),
      },
    };
    const beta = betaMarker(finalCore, artifacts);
    const betaBytes = Buffer.from(JSON.stringify(beta));
    const draftStable = stableMarker(finalCore);
    const publicBeta = {
      ...draftStable.publicBeta,
      markerSha256: sha256(betaBytes),
      pluginArtifactTreeDigestSha256: beta.pluginArtifactTree.digestSha256,
      observerArtifact: beta.observerArtifact,
    };
    const preMarker = { ...draftStable, publicBeta };
    const receipt = hostReceipt(preMarker);
    const hostBytes = Buffer.from(JSON.stringify(receipt));
    const stable = {
      ...preMarker,
      hostAcceptance: {
        ...preMarker.hostAcceptance,
        receipt: {
          ...preMarker.hostAcceptance.receipt,
          sha256: sha256(hostBytes),
          sessionNonceSha256: receipt.session.nonceSha256,
        },
      },
    };
    const files = new Map<string, Buffer>([
      ["package.json", Buffer.from(JSON.stringify({ name: "codex-agent-tools", version: "0.1.1" }))],
      [".release-validation/v0.1.1.json", Buffer.from(JSON.stringify(stable))],
      ["docs/smoke/evidence/capabilities.json", indexBytes],
      [finalCore.currentHostFreeze.path, freezeBytes],
      [stable.hostAcceptance.receipt.path, hostBytes],
      // Deliberately no current plugin or observer artifacts: stable is bound to beta bytes.
    ]);
    const gitFiles = new Map<string, Buffer>([
      [`${BETA_COMMIT}:package.json`, Buffer.from(JSON.stringify({ name: "codex-agent-tools", version: "0.1.1-beta.1" }))],
      [`${BETA_COMMIT}:${publicBeta.markerPath}`, betaBytes],
      [`${BETA_COMMIT}:${OBSERVER_PATH}`, observer.artifactBytes],
      [`${BETA_COMMIT}:${OBSERVER_MANIFEST_PATH}`, observer.manifestBytes],
      ...[...observer.inputFiles].map(
        ([inputPath, bytes]) =>
          [`${BETA_COMMIT}:${inputPath}`, bytes] as const,
      ),
      // The generated plugin runtime is intentionally not committed. Stable
      // promotion uses the immutable beta marker and live npm dist identity;
      // host acceptance proves byte equality between tag-built and installed
      // plugin files instead of reconstructing that tree from Git.
    ]);
    const dependencies = {
      readRepositoryFile: async (_root: string, file: string) => files.get(file)!,
      collectCanonicalIdentity: async () => canonicalIdentity(),
      resolveGitTagCommit: async (_root: string, tag: string) =>
        tag === publicBeta.tag ? BETA_COMMIT : TAG_COMMIT,
      isGitAncestor: async (_root: string, ancestor: string, descendant: string) =>
        (ancestor === RUNTIME_COMMIT &&
          (descendant === BETA_COMMIT || descendant === TAG_COMMIT)) ||
        (ancestor === BETA_COMMIT && descendant === TAG_COMMIT),
      readGitFile: async (_root: string, target: string, file: string) =>
        gitFiles.get(`${target}:${file}`)!,
      lookupNpmDist: async () => publicBeta.npm,
    };
    await expect(
      verifyReleaseValidation(
        {
          repositoryRoot: "virtual",
          packageVersion: "0.1.1",
          tag: "v0.1.1",
          taggedCommit: TAG_COMMIT,
          npmChannel: "latest",
        },
        dependencies,
      ),
    ).resolves.toMatchObject({ kind: "stable" });
    const mismatchedStable = {
      ...stable,
      publicBeta: {
        ...stable.publicBeta,
        pluginArtifactTreeDigestSha256: H64,
      },
    };
    await expect(
      verifyReleaseValidation(
        {
          repositoryRoot: "virtual",
          packageVersion: "0.1.1",
          tag: "v0.1.1",
          taggedCommit: TAG_COMMIT,
          npmChannel: "latest",
        },
        {
          ...dependencies,
          readRepositoryFile: async (root, file) =>
            file === ".release-validation/v0.1.1.json"
              ? Buffer.from(JSON.stringify(mismatchedStable))
              : dependencies.readRepositoryFile(root, file),
        },
      ),
    ).rejects.toThrow("Release validation evidence is invalid");
    await expect(
      verifyReleaseValidation(
        {
          repositoryRoot: "virtual",
          packageVersion: "0.1.1",
          tag: "v0.1.1",
          taggedCommit: TAG_COMMIT,
          npmChannel: "latest",
        },
        {
          ...dependencies,
          isGitAncestor: async (_root, ancestor, descendant) =>
            descendant === TAG_COMMIT &&
            (ancestor === RUNTIME_COMMIT || ancestor === BETA_COMMIT),
        },
      ),
    ).rejects.toThrow("Release validation evidence is invalid");
    await expect(
      verifyReleaseValidation(
        {
          repositoryRoot: "virtual",
          packageVersion: "0.1.1",
          tag: "v0.1.1",
          taggedCommit: TAG_COMMIT,
          npmChannel: "latest",
        },
        {
          ...dependencies,
          readGitFile: async (root, target, file) =>
            file === OBSERVER_PATH
              ? Buffer.from("tampered observer")
              : dependencies.readGitFile(root, target, file),
        },
      ),
    ).rejects.toThrow("Release validation evidence is invalid");
  });

  it("verifies an exact maintainer skip decision without reading or implying a receipt", async () => {
    const indexBytes = capabilityIndexBytes();
    const artifacts = pluginEntries();
    const observer = observerFixture();
    const draftCore = core(indexBytes);
    const freezeBytes = Buffer.from(JSON.stringify(freezeReceipt(draftCore)));
    const finalCore = {
      ...draftCore,
      currentHostFreeze: {
        ...draftCore.currentHostFreeze,
        sha256: sha256(freezeBytes),
      },
    };
    const betaDraft = betaMarker(finalCore, artifacts);
    const beta = {
      ...betaDraft,
      package: {
        ...betaDraft.package,
        version: "0.1.1-beta.4",
        tag: "v0.1.1-beta.4",
      },
    };
    const betaBytes = Buffer.from(JSON.stringify(beta));
    const draftStable = skippedStableMarker(finalCore);
    const publicBeta = {
      ...draftStable.publicBeta,
      markerSha256: sha256(betaBytes),
      pluginArtifactTreeDigestSha256: beta.pluginArtifactTree.digestSha256,
      observerArtifact: beta.observerArtifact,
    };
    const preMarker = { ...draftStable, publicBeta };
    const decisionBytes = Buffer.from(
      JSON.stringify(hostStopDecision(preMarker)),
    );
    const stable = {
      ...preMarker,
      hostAcceptance: {
        ...preMarker.hostAcceptance,
        decision: {
          ...preMarker.hostAcceptance.decision,
          sha256: sha256(decisionBytes),
        },
      },
    };
    const files = new Map<string, Buffer>([
      [
        "package.json",
        Buffer.from(
          JSON.stringify({ name: "codex-agent-tools", version: "0.1.1" }),
        ),
      ],
      [
        ".release-validation/v0.1.1.json",
        Buffer.from(JSON.stringify(stable)),
      ],
      ["docs/smoke/evidence/capabilities.json", indexBytes],
      [finalCore.currentHostFreeze.path, freezeBytes],
      [stable.hostAcceptance.decision.path, decisionBytes],
    ]);
    const gitFiles = new Map<string, Buffer>([
      [
        `${BETA_COMMIT}:package.json`,
        Buffer.from(
          JSON.stringify({
            name: "codex-agent-tools",
            version: "0.1.1-beta.4",
          }),
        ),
      ],
      [`${BETA_COMMIT}:${publicBeta.markerPath}`, betaBytes],
      [`${BETA_COMMIT}:${OBSERVER_PATH}`, observer.artifactBytes],
      [`${BETA_COMMIT}:${OBSERVER_MANIFEST_PATH}`, observer.manifestBytes],
      ...[...observer.inputFiles].map(
        ([inputPath, bytes]) =>
          [`${BETA_COMMIT}:${inputPath}`, bytes] as const,
      ),
    ]);
    const repositoryReads: string[] = [];
    const dependencies = {
      readRepositoryFile: async (_root: string, file: string) => {
        repositoryReads.push(file);
        const bytes = files.get(file);
        if (bytes === undefined) throw new Error(`unexpected read: ${file}`);
        return bytes;
      },
      collectCanonicalIdentity: async () => canonicalIdentity(),
      resolveGitTagCommit: async (_root: string, tag: string) =>
        tag === publicBeta.tag ? BETA_COMMIT : TAG_COMMIT,
      isGitAncestor: async (
        _root: string,
        ancestor: string,
        descendant: string,
      ) =>
        (ancestor === RUNTIME_COMMIT &&
          (descendant === BETA_COMMIT || descendant === TAG_COMMIT)) ||
        (ancestor === BETA_COMMIT && descendant === TAG_COMMIT),
      readGitFile: async (_root: string, target: string, file: string) => {
        const bytes = gitFiles.get(`${target}:${file}`);
        if (bytes === undefined) throw new Error(`unexpected git read: ${file}`);
        return bytes;
      },
      lookupNpmDist: async () => publicBeta.npm,
    };

    await expect(
      verifyReleaseValidation(
        {
          repositoryRoot: "virtual",
          packageVersion: "0.1.1",
          tag: "v0.1.1",
          taggedCommit: TAG_COMMIT,
          npmChannel: "latest",
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      kind: "stable",
      hostAcceptance: {
        status: "skipped_by_maintainer",
        risk: "host_stop_unverified",
      },
    });
    expect(repositoryReads).toContain(stable.hostAcceptance.decision.path);
    expect(repositoryReads).not.toContain(
      ".release-validation/evidence/v0.1.1-beta.1-host-acceptance.json",
    );

    const invalidDecision = {
      ...hostStopDecision(preMarker),
      reason: "generic_skip",
    };
    await expect(
      verifyReleaseValidation(
        {
          repositoryRoot: "virtual",
          packageVersion: "0.1.1",
          tag: "v0.1.1",
          taggedCommit: TAG_COMMIT,
          npmChannel: "latest",
        },
        {
          ...dependencies,
          readRepositoryFile: async (root, file) =>
            file === stable.hostAcceptance.decision.path
              ? Buffer.from(JSON.stringify(invalidDecision))
              : dependencies.readRepositoryFile(root, file),
        },
      ),
    ).rejects.toThrow("Release validation evidence is invalid");
  });
});

describe("evidence file safety", () => {
  it("allows only the fixed plugin runtime above 1 MiB and caps it at 4 MiB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "release-validation-size-"));
    try {
      const runtimePath = path.join(root, ...RELEASE_PLUGIN_ARTIFACT_PATHS[2].split("/"));
      await mkdir(path.dirname(runtimePath), { recursive: true });
      const largeRuntime = Buffer.alloc(1024 * 1024 + 1, 7);
      await writeFile(runtimePath, largeRuntime);
      await expect(
        readStrictReleaseEvidenceFile(root, RELEASE_PLUGIN_ARTIFACT_PATHS[2]),
      ).resolves.toHaveLength(largeRuntime.length);

      const ordinaryPath = path.join(root, "evidence.json");
      await writeFile(ordinaryPath, largeRuntime);
      await expect(
        readStrictReleaseEvidenceFile(root, "evidence.json"),
      ).rejects.toThrow("Release validation evidence is invalid");

      await writeFile(runtimePath, Buffer.alloc(4 * 1024 * 1024 + 1));
      await expect(
        readStrictReleaseEvidenceFile(root, RELEASE_PLUGIN_ARTIFACT_PATHS[2]),
      ).rejects.toThrow("Release validation evidence is invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on unsafe and reparse evidence paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "release-validation-path-"));
    try {
      const target = path.join(root, "target");
      await mkdir(target);
      await writeFile(path.join(target, "outside.json"), "{}");
      await symlink(
        target,
        path.join(root, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        readStrictReleaseEvidenceFile(root, "../outside.json"),
      ).rejects.toThrow("Release validation evidence is invalid");
      await expect(
        readStrictReleaseEvidenceFile(root, "linked/outside.json"),
      ).rejects.toThrow("Release validation evidence is invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
