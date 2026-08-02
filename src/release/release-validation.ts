import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, types as nodeUtilTypes } from "node:util";

import { parseStrictJsonBytes } from "../runtime/strict-json.js";
import { collectCanonicalRuntimeInputIdentity } from "./canonical-runtime-inputs.js";

const execFileAsync = promisify(execFile);
const FAILURE_MESSAGE = "Release validation evidence is invalid.";
const PACKAGE_NAME = "codex-agent-tools";
const CAPABILITY_INDEX_PATH = "docs/smoke/evidence/capabilities.json";
const HELPER_PATH =
  "plugins/codex-external-agents/native/win32-x64/codex-agent-job-helper.exe";
const PLUGIN_RUNTIME_PATH =
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs";
const OBSERVER_ARTIFACT_PATH =
  "host-acceptance/win32-x64/codex-host-acceptance-observer.exe";
const OBSERVER_BUILD_MANIFEST_PATH =
  "host-acceptance/observer-build-inputs.v1.json";
const OBSERVER_BUILD_CONFIG_PATH = "host-acceptance/build.config.json";
const OBSERVER_BUILD_ENTRY_PATH = "host-acceptance/build.ps1";
const OBSERVER_PROTOCOL_PATH =
  "host-acceptance/protocol/observer-protocol.v1.json";
const SHARED_TOOLCHAIN_LOCK_PATH =
  "native/windows-job-helper/toolchain.lock.json";
const SHARED_BUILD_CONFIG_PATH =
  "native/windows-job-helper/build.config.json";
const SHARED_RESTORE_TOOLCHAIN_PATH =
  "native/windows-job-helper/restore-toolchain.ps1";
export const RELEASE_PLUGIN_ARTIFACT_PATHS = Object.freeze([
  "plugins/codex-external-agents/.codex-plugin/plugin.json",
  "plugins/codex-external-agents/.mcp.json",
  PLUGIN_RUNTIME_PATH,
  HELPER_PATH,
  `${HELPER_PATH}.sha256`,
] as const);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_JSON_EVIDENCE_BYTES = 1024 * 1024;
const MAX_FIXED_BINARY_EVIDENCE_BYTES = 4 * 1024 * 1024;
const PRERELEASE_VERSION_SOURCE =
  "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*";

type PlainRecord = Record<string, unknown>;
export type ReleaseChannel = "next" | "latest";

export interface ReleaseValidationCore {
  readonly runtimeFrozenCommit: string;
  readonly canonicalRuntime: Readonly<{
    schemaVersion: 1;
    digestSha256: string;
  }>;
  readonly windowsJobHelper: Readonly<{
    path: typeof HELPER_PATH;
    sha256: string;
  }>;
  readonly capabilityIndex: Readonly<{
    path: typeof CAPABILITY_INDEX_PATH;
    sha256: string;
    entryCount: 8;
  }>;
  readonly currentHostFreeze: Readonly<{
    path: string;
    sha256: string;
  }>;
}

interface ReleasePackageIdentity {
  readonly name: typeof PACKAGE_NAME;
  readonly version: string;
  readonly tag: string;
  readonly npmChannel: ReleaseChannel;
}

export interface BetaReleaseValidationMarker {
  readonly schemaVersion: 1;
  readonly kind: "beta";
  readonly package: ReleasePackageIdentity & { readonly npmChannel: "next" };
  readonly core: ReleaseValidationCore;
  readonly pluginArtifactTree: Readonly<{
    schemaVersion: 1;
    digestSha256: string;
  }>;
  readonly observerArtifact: Readonly<{
    path: typeof OBSERVER_ARTIFACT_PATH;
    sha256: string;
    protocolVersion: 1;
    buildManifest: Readonly<{
      path: typeof OBSERVER_BUILD_MANIFEST_PATH;
      sha256: string;
    }>;
    protocol: Readonly<{
      path: typeof OBSERVER_PROTOCOL_PATH;
      sha256: string;
    }>;
    inputsDigestSha256: string;
  }>;
}

export interface NpmDistIdentity {
  readonly integrity: string;
  readonly shasum: string;
}

export interface PublicBetaIdentity {
  readonly version: string;
  readonly tag: string;
  readonly taggedCommit: string;
  readonly markerPath: string;
  readonly markerSha256: string;
  readonly pluginArtifactTreeDigestSha256: string;
  readonly observerArtifact: Readonly<{
    path: typeof OBSERVER_ARTIFACT_PATH;
    sha256: string;
    protocolVersion: 1;
    buildManifest: Readonly<{
      path: typeof OBSERVER_BUILD_MANIFEST_PATH;
      sha256: string;
    }>;
    protocol: Readonly<{
      path: typeof OBSERVER_PROTOCOL_PATH;
      sha256: string;
    }>;
    inputsDigestSha256: string;
  }>;
  readonly npm: NpmDistIdentity;
}

export interface StableReleaseValidationMarker {
  readonly schemaVersion: 1;
  readonly kind: "stable";
  readonly package: ReleasePackageIdentity & { readonly npmChannel: "latest" };
  readonly core: ReleaseValidationCore;
  readonly publicBeta: PublicBetaIdentity;
  readonly hostAcceptance: Readonly<{
    path: string;
    sha256: string;
    sessionNonceSha256: string;
  }>;
}

export type ReleaseValidationMarker =
  | BetaReleaseValidationMarker
  | StableReleaseValidationMarker;

export interface ReleaseMarkerContext {
  readonly packageVersion: string;
  readonly tag: string;
  readonly npmChannel: ReleaseChannel;
  readonly expectedCanonicalRuntimeDigestSha256?: string;
}

function fail(): never {
  throw new Error(FAILURE_MESSAGE);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function plainRecord(value: unknown): PlainRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined,
    )
  ) {
    return fail();
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function exactKeys(record: PlainRecord, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail();
  }
}

function strictArray(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = value.length;
  if (Object.keys(descriptors).length !== length + 1) fail();
  const copied: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      fail();
    }
    copied.push(descriptor.value);
  }
  return Object.freeze(copied);
}

function stringValue(value: unknown, maxLength = 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    return fail();
  }
  return value;
}

function exactString<const Expected extends string>(
  value: unknown,
  expected: Expected,
): Expected {
  if (value !== expected) fail();
  return expected;
}

function digest(value: unknown, pattern = SHA256_PATTERN): string {
  const candidate = stringValue(value, 256);
  if (!pattern.test(candidate)) fail();
  return candidate;
}

function version(value: unknown): string {
  const candidate = stringValue(value, 128);
  if (!VERSION_PATTERN.test(candidate)) fail();
  return candidate;
}

function commit(value: unknown): string {
  return digest(value, COMMIT_PATTERN);
}

function controlledEvidencePath(
  value: unknown,
  suffix: "host-acceptance",
): string {
  const candidate = stringValue(value, 256);
  const pattern = new RegExp(
    `^\\.release-validation/evidence/v${PRERELEASE_VERSION_SOURCE}-${suffix}\\.json$`,
    "u",
  );
  if (!pattern.test(candidate)) fail();
  return candidate;
}

function currentHostFreezePath(value: unknown, runtimeCommit: string): string {
  return exactString(
    value,
    `.release-validation/evidence/current-host-${runtimeCommit}.json`,
  );
}

function parseReleasePackage(
  value: unknown,
  context: ReleaseMarkerContext,
): ReleasePackageIdentity {
  const record = plainRecord(value);
  exactKeys(record, ["name", "version", "tag", "npmChannel"]);
  const packageVersion = version(record.version);
  const tag = stringValue(record.tag, 130);
  if (
    record.name !== PACKAGE_NAME ||
    packageVersion !== context.packageVersion ||
    tag !== context.tag ||
    tag !== `v${packageVersion}` ||
    record.npmChannel !== context.npmChannel ||
    (packageVersion.includes("-") ? "next" : "latest") !==
      context.npmChannel
  ) {
    fail();
  }
  return Object.freeze({
    name: PACKAGE_NAME,
    version: packageVersion,
    tag,
    npmChannel: context.npmChannel,
  });
}

function parseCore(
  value: unknown,
  expectedCanonicalDigest?: string,
): ReleaseValidationCore {
  const record = plainRecord(value);
  exactKeys(record, [
    "runtimeFrozenCommit",
    "canonicalRuntime",
    "windowsJobHelper",
    "capabilityIndex",
    "currentHostFreeze",
  ]);
  const canonical = plainRecord(record.canonicalRuntime);
  exactKeys(canonical, ["schemaVersion", "digestSha256"]);
  const canonicalDigest = digest(canonical.digestSha256);
  if (
    canonical.schemaVersion !== 1 ||
    (expectedCanonicalDigest !== undefined &&
      canonicalDigest !== expectedCanonicalDigest)
  ) {
    fail();
  }
  const helper = plainRecord(record.windowsJobHelper);
  exactKeys(helper, ["path", "sha256"]);
  exactString(helper.path, HELPER_PATH);
  const capabilityIndex = plainRecord(record.capabilityIndex);
  exactKeys(capabilityIndex, ["path", "sha256", "entryCount"]);
  exactString(capabilityIndex.path, CAPABILITY_INDEX_PATH);
  if (capabilityIndex.entryCount !== 8) fail();
  const freeze = plainRecord(record.currentHostFreeze);
  exactKeys(freeze, ["path", "sha256"]);
  const runtimeFrozenCommit = commit(record.runtimeFrozenCommit);
  return Object.freeze({
    runtimeFrozenCommit,
    canonicalRuntime: Object.freeze({
      schemaVersion: 1,
      digestSha256: canonicalDigest,
    }),
    windowsJobHelper: Object.freeze({
      path: HELPER_PATH,
      sha256: digest(helper.sha256),
    }),
    capabilityIndex: Object.freeze({
      path: CAPABILITY_INDEX_PATH,
      sha256: digest(capabilityIndex.sha256),
      entryCount: 8,
    }),
    currentHostFreeze: Object.freeze({
      path: currentHostFreezePath(freeze.path, runtimeFrozenCommit),
      sha256: digest(freeze.sha256),
    }),
  });
}

function parsePluginArtifactTree(value: unknown): Readonly<{
  schemaVersion: 1;
  digestSha256: string;
}> {
  const record = plainRecord(value);
  exactKeys(record, ["schemaVersion", "digestSha256"]);
  if (record.schemaVersion !== 1) fail();
  return Object.freeze({
    schemaVersion: 1,
    digestSha256: digest(record.digestSha256),
  });
}

export interface ObserverBuildInput {
  readonly path: string;
  readonly sha256: string;
}

export interface ObserverBuildInputsManifest {
  readonly schemaVersion: 1;
  readonly artifactPath: typeof OBSERVER_ARTIFACT_PATH;
  readonly protocol: Readonly<{
    path: typeof OBSERVER_PROTOCOL_PATH;
    sha256: string;
  }>;
  readonly inputs: readonly ObserverBuildInput[];
  readonly inputsDigestSha256: string;
}

export interface ObserverBuildConfig {
  readonly schemaVersion: 1;
  readonly sourcePaths: readonly string[];
  readonly artifactPath: typeof OBSERVER_ARTIFACT_PATH;
}

export function parseObserverBuildConfig(value: unknown): ObserverBuildConfig {
  try {
    const record = plainRecord(value);
    exactKeys(record, [
      "schemaVersion",
      "sharedBuildContract",
      "sourceSets",
      "artifact",
    ]);
    if (record.schemaVersion !== 1) fail();
    const shared = plainRecord(record.sharedBuildContract);
    exactKeys(shared, [
      "toolchainLockPath",
      "buildConfigPath",
      "restoreToolchainPath",
    ]);
    exactString(shared.toolchainLockPath, SHARED_TOOLCHAIN_LOCK_PATH);
    exactString(shared.buildConfigPath, SHARED_BUILD_CONFIG_PATH);
    exactString(
      shared.restoreToolchainPath,
      SHARED_RESTORE_TOOLCHAIN_PATH,
    );
    const sourceSets = plainRecord(record.sourceSets);
    exactKeys(sourceSets, ["production"]);
    const production = strictArray(sourceSets.production);
    if (production.length === 0) fail();
    const sourcePaths = Object.freeze(
      production.map((source, index) => {
        const relativeSource = stringValue(source, 256);
        if (
          !/^src\/[A-Za-z0-9][A-Za-z0-9._-]*\.cs$/u.test(relativeSource) ||
          (index > 0 && (production[index - 1] as string) >= relativeSource)
        ) fail();
        return `host-acceptance/${relativeSource}`;
      }),
    );
    const artifact = plainRecord(record.artifact);
    exactKeys(artifact, ["path"]);
    return Object.freeze({
      schemaVersion: 1,
      sourcePaths,
      artifactPath: exactString(artifact.path, OBSERVER_ARTIFACT_PATH),
    });
  } catch {
    return fail();
  }
}

function digestObserverBuildInputs(
  inputs: readonly ObserverBuildInput[],
): string {
  return sha256(JSON.stringify({ schemaVersion: 1, inputs }));
}

function allowedObserverBuildInputPath(inputPath: string): boolean {
  return (
    inputPath === SHARED_TOOLCHAIN_LOCK_PATH ||
    inputPath === SHARED_BUILD_CONFIG_PATH ||
    inputPath === SHARED_RESTORE_TOOLCHAIN_PATH ||
    inputPath === OBSERVER_BUILD_CONFIG_PATH ||
    inputPath === OBSERVER_BUILD_ENTRY_PATH ||
    inputPath === OBSERVER_PROTOCOL_PATH ||
    /^host-acceptance\/src\/[A-Za-z0-9][A-Za-z0-9._-]*\.cs$/u.test(
      inputPath,
    )
  );
}

export function parseObserverBuildInputsManifest(
  value: unknown,
  buildConfigValue: unknown,
): ObserverBuildInputsManifest {
  try {
    const buildConfig = parseObserverBuildConfig(buildConfigValue);
    const record = plainRecord(value);
    exactKeys(record, [
      "schemaVersion",
      "artifactPath",
      "protocol",
      "inputs",
      "inputsDigestSha256",
    ]);
    if (record.schemaVersion !== 1) fail();
    const protocol = plainRecord(record.protocol);
    exactKeys(protocol, ["path", "sha256"]);
    const protocolSha256 = digest(protocol.sha256);
    const rawInputs = strictArray(record.inputs);
    const inputs = Object.freeze(
      rawInputs.map((entry) => {
        const input = plainRecord(entry);
        exactKeys(input, ["path", "sha256"]);
        const inputPath = normalizeRepositoryRelativePath(
          stringValue(input.path, 256),
        );
        if (!allowedObserverBuildInputPath(inputPath)) fail();
        return Object.freeze({
          path: inputPath,
          sha256: digest(input.sha256),
        });
      }),
    );
    const expectedInputPaths = [
      SHARED_TOOLCHAIN_LOCK_PATH,
      SHARED_BUILD_CONFIG_PATH,
      SHARED_RESTORE_TOOLCHAIN_PATH,
      OBSERVER_BUILD_CONFIG_PATH,
      OBSERVER_BUILD_ENTRY_PATH,
      OBSERVER_PROTOCOL_PATH,
      ...buildConfig.sourcePaths,
    ].sort();
    if (
      inputs.length !== expectedInputPaths.length ||
      inputs.some(
        (entry, index) =>
          entry.path !== expectedInputPaths[index] ||
          (index > 0 && inputs[index - 1]!.path >= entry.path),
      ) ||
      inputs.find((entry) => entry.path === OBSERVER_PROTOCOL_PATH)?.sha256 !==
        protocolSha256
    ) fail();
    const inputsDigestSha256 = digest(record.inputsDigestSha256);
    if (inputsDigestSha256 !== digestObserverBuildInputs(inputs)) fail();
    return Object.freeze({
      schemaVersion: 1,
      artifactPath: exactString(record.artifactPath, OBSERVER_ARTIFACT_PATH),
      protocol: Object.freeze({
        path: exactString(protocol.path, OBSERVER_PROTOCOL_PATH),
        sha256: protocolSha256,
      }),
      inputs,
      inputsDigestSha256,
    });
  } catch {
    return fail();
  }
}

function parseObserverArtifact(value: unknown): Readonly<{
  path: typeof OBSERVER_ARTIFACT_PATH;
  sha256: string;
  protocolVersion: 1;
  buildManifest: Readonly<{
    path: typeof OBSERVER_BUILD_MANIFEST_PATH;
    sha256: string;
  }>;
  protocol: Readonly<{
    path: typeof OBSERVER_PROTOCOL_PATH;
    sha256: string;
  }>;
  inputsDigestSha256: string;
}> {
  const record = plainRecord(value);
  exactKeys(record, [
    "path",
    "sha256",
    "protocolVersion",
    "buildManifest",
    "protocol",
    "inputsDigestSha256",
  ]);
  if (record.protocolVersion !== 1) fail();
  const buildManifest = plainRecord(record.buildManifest);
  exactKeys(buildManifest, ["path", "sha256"]);
  const protocol = plainRecord(record.protocol);
  exactKeys(protocol, ["path", "sha256"]);
  return Object.freeze({
    path: exactString(record.path, OBSERVER_ARTIFACT_PATH),
    sha256: digest(record.sha256),
    protocolVersion: 1,
    buildManifest: Object.freeze({
      path: exactString(buildManifest.path, OBSERVER_BUILD_MANIFEST_PATH),
      sha256: digest(buildManifest.sha256),
    }),
    protocol: Object.freeze({
      path: exactString(protocol.path, OBSERVER_PROTOCOL_PATH),
      sha256: digest(protocol.sha256),
    }),
    inputsDigestSha256: digest(record.inputsDigestSha256),
  });
}

function parseNpmDist(value: unknown): NpmDistIdentity {
  const record = plainRecord(value);
  exactKeys(record, ["integrity", "shasum"]);
  const integrity = stringValue(record.integrity, 256);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) fail();
  return Object.freeze({
    integrity,
    shasum: digest(record.shasum, SHA1_PATTERN),
  });
}

function parsePublicBeta(value: unknown): PublicBetaIdentity {
  const record = plainRecord(value);
  exactKeys(record, [
    "version",
    "tag",
    "taggedCommit",
    "markerPath",
    "markerSha256",
    "pluginArtifactTreeDigestSha256",
    "observerArtifact",
    "npm",
  ]);
  const betaVersion = version(record.version);
  if (!betaVersion.includes("-")) fail();
  const tag = exactString(record.tag, `v${betaVersion}`);
  const markerPath = exactString(
    record.markerPath,
    `.release-validation/v${betaVersion}.json`,
  );
  return Object.freeze({
    version: betaVersion,
    tag,
    taggedCommit: commit(record.taggedCommit),
    markerPath,
    markerSha256: digest(record.markerSha256),
    pluginArtifactTreeDigestSha256: digest(
      record.pluginArtifactTreeDigestSha256,
    ),
    observerArtifact: parseObserverArtifact(record.observerArtifact),
    npm: parseNpmDist(record.npm),
  });
}

export function parseReleaseValidationMarker(
  value: unknown,
  context: ReleaseMarkerContext,
): ReleaseValidationMarker {
  try {
    version(context.packageVersion);
    exactString(context.tag, `v${context.packageVersion}`);
    if (context.npmChannel !== "next" && context.npmChannel !== "latest") {
      fail();
    }
    if (
      context.expectedCanonicalRuntimeDigestSha256 !== undefined &&
      !SHA256_PATTERN.test(context.expectedCanonicalRuntimeDigestSha256)
    ) {
      fail();
    }
    const record = plainRecord(value);
    if (record.kind === "beta") {
      exactKeys(record, [
        "schemaVersion",
        "kind",
        "package",
        "core",
        "pluginArtifactTree",
        "observerArtifact",
      ]);
      if (record.schemaVersion !== 1 || context.npmChannel !== "next") fail();
      return Object.freeze({
        schemaVersion: 1,
        kind: "beta",
        package: parseReleasePackage(record.package, context) as
          BetaReleaseValidationMarker["package"],
        core: parseCore(
          record.core,
          context.expectedCanonicalRuntimeDigestSha256,
        ),
        pluginArtifactTree: parsePluginArtifactTree(
          record.pluginArtifactTree,
        ),
        observerArtifact: parseObserverArtifact(record.observerArtifact),
      });
    }
    if (record.kind !== "stable") fail();
    exactKeys(record, [
      "schemaVersion",
      "kind",
      "package",
      "core",
      "publicBeta",
      "hostAcceptance",
    ]);
    if (record.schemaVersion !== 1 || context.npmChannel !== "latest") fail();
    const publicBeta = parsePublicBeta(record.publicBeta);
    if (
      publicBeta.version.split("-", 1)[0] !== context.packageVersion
    ) {
      fail();
    }
    const core = parseCore(
      record.core,
      context.expectedCanonicalRuntimeDigestSha256,
    );
    const host = plainRecord(record.hostAcceptance);
    exactKeys(host, ["path", "sha256", "sessionNonceSha256"]);
    const hostPath = controlledEvidencePath(host.path, "host-acceptance");
    if (
      hostPath !==
      `.release-validation/evidence/v${publicBeta.version}-host-acceptance.json`
    ) {
      fail();
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: "stable",
      package: parseReleasePackage(record.package, context) as
        StableReleaseValidationMarker["package"],
      core,
      publicBeta,
      hostAcceptance: Object.freeze({
        path: hostPath,
        sha256: digest(host.sha256),
        sessionNonceSha256: digest(host.sessionNonceSha256),
      }),
    });
  } catch {
    return fail();
  }
}

export interface CapabilityFingerprintProjection {
  readonly llm: string;
  readonly task: "delegate" | "review";
  readonly currentFingerprintSha256: string;
}

const CAPABILITY_IDENTITIES = Object.freeze([
  "ark-agent-deepseek-v4-flash/delegate",
  "ark-agent-deepseek-v4-flash/review",
  "ark-agent-plan/delegate",
  "ark-agent-plan/review",
  "ark-coding-plan/delegate",
  "ark-coding-plan/review",
  "kimi-k3/delegate",
  "kimi-k3/review",
] as const);

function parseCapabilityProjection(
  value: unknown,
): readonly CapabilityFingerprintProjection[] {
  const values = strictArray(value);
  if (values.length !== CAPABILITY_IDENTITIES.length) fail();
  const seen = new Set<string>();
  return Object.freeze(
    values.map((entry, index) => {
      const record = plainRecord(entry);
      exactKeys(record, ["llm", "task", "currentFingerprintSha256"]);
      const llm = stringValue(record.llm, 128);
      if (record.task !== "delegate" && record.task !== "review") fail();
      const identity = `${llm}/${record.task}`;
      if (identity !== CAPABILITY_IDENTITIES[index] || seen.has(identity)) fail();
      seen.add(identity);
      return Object.freeze({
        llm,
        task: record.task,
        currentFingerprintSha256: digest(record.currentFingerprintSha256),
      });
    }),
  );
}

export interface CurrentHostFreezeReceipt {
  readonly schemaVersion: 1;
  readonly kind: "current-host-freeze";
  readonly runtimeFrozenCommit: string;
  readonly canonicalRuntimeDigestSha256: string;
  readonly windowsJobHelperSha256: string;
  readonly observerArtifact: BetaReleaseValidationMarker["observerArtifact"];
  readonly capabilities: readonly CapabilityFingerprintProjection[];
  readonly hostObservation: Readonly<{
    platform: string;
    architecture: string;
    windowsVersion: string;
    nodeVersion: string;
    libuvVersion: string;
    npmVersion: string;
    dotNetFrameworkRelease: string;
  }>;
  readonly checks: Readonly<{
    deterministicTests: "passed";
    nativePreflight: "passed";
    nativeVerify: "passed";
    observerVerify: "passed";
    pluginIsolated: "passed";
    packageDryRun: "passed";
    capabilityEvidenceValidCount: 8;
    prequalificationStaleCount: number;
    realModelCalls: 0;
    activeConfigAccesses: 0;
    activePluginChanges: 0;
    publishes: 0;
  }>;
}

export function assertCurrentHostFreezeReceipt(
  value: unknown,
  core: ReleaseValidationCore,
  currentCapabilities: readonly CapabilityFingerprintProjection[],
  expectedObserverArtifact: BetaReleaseValidationMarker["observerArtifact"],
): CurrentHostFreezeReceipt {
  try {
    const record = plainRecord(value);
    exactKeys(record, [
      "schemaVersion",
      "kind",
      "runtimeFrozenCommit",
      "canonicalRuntimeDigestSha256",
      "windowsJobHelperSha256",
      "observerArtifact",
      "capabilities",
      "hostObservation",
      "checks",
    ]);
    if (record.schemaVersion !== 1 || record.kind !== "current-host-freeze") {
      fail();
    }
    const capabilities = parseCapabilityProjection(record.capabilities);
    const expectedCapabilities = parseCapabilityProjection(currentCapabilities);
    if (!sameJson(capabilities, expectedCapabilities)) fail();
    const observerArtifact = parseObserverArtifact(record.observerArtifact);
    const expectedObserver = parseObserverArtifact(expectedObserverArtifact);
    if (!sameJson(observerArtifact, expectedObserver)) fail();
    const host = plainRecord(record.hostObservation);
    const hostKeys = [
      "platform",
      "architecture",
      "windowsVersion",
      "nodeVersion",
      "libuvVersion",
      "npmVersion",
      "dotNetFrameworkRelease",
    ] as const;
    exactKeys(host, hostKeys);
    const observed = Object.fromEntries(
      hostKeys.map((key) => [key, stringValue(host[key], 128)]),
    ) as unknown as CurrentHostFreezeReceipt["hostObservation"];
    if (observed.platform !== "win32" || observed.architecture !== "x64") {
      fail();
    }
    const checks = plainRecord(record.checks);
    exactKeys(checks, [
      "deterministicTests",
      "nativePreflight",
      "nativeVerify",
      "observerVerify",
      "pluginIsolated",
      "packageDryRun",
      "capabilityEvidenceValidCount",
      "prequalificationStaleCount",
      "realModelCalls",
      "activeConfigAccesses",
      "activePluginChanges",
      "publishes",
    ]);
    if (
      checks.deterministicTests !== "passed" ||
      checks.nativePreflight !== "passed" ||
      checks.nativeVerify !== "passed" ||
      checks.observerVerify !== "passed" ||
      checks.pluginIsolated !== "passed" ||
      checks.packageDryRun !== "passed" ||
      checks.capabilityEvidenceValidCount !== 8 ||
      !Number.isInteger(checks.prequalificationStaleCount) ||
      (checks.prequalificationStaleCount as number) < 0 ||
      (checks.prequalificationStaleCount as number) > 8 ||
      checks.realModelCalls !== 0 ||
      checks.activeConfigAccesses !== 0 ||
      checks.activePluginChanges !== 0 ||
      checks.publishes !== 0 ||
      record.runtimeFrozenCommit !== core.runtimeFrozenCommit ||
      record.canonicalRuntimeDigestSha256 !==
        core.canonicalRuntime.digestSha256 ||
      record.windowsJobHelperSha256 !== core.windowsJobHelper.sha256
    ) {
      fail();
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: "current-host-freeze",
      runtimeFrozenCommit: core.runtimeFrozenCommit,
      canonicalRuntimeDigestSha256: core.canonicalRuntime.digestSha256,
      windowsJobHelperSha256: core.windowsJobHelper.sha256,
      observerArtifact,
      capabilities,
      hostObservation: Object.freeze(observed),
      checks: Object.freeze({
        deterministicTests: "passed",
        nativePreflight: "passed",
        nativeVerify: "passed",
        observerVerify: "passed",
        pluginIsolated: "passed",
        packageDryRun: "passed",
        capabilityEvidenceValidCount: 8,
        prequalificationStaleCount:
          checks.prequalificationStaleCount as number,
        realModelCalls: 0,
        activeConfigAccesses: 0,
        activePluginChanges: 0,
        publishes: 0,
      }),
    });
  } catch {
    return fail();
  }
}

interface HostProcessIdentity {
  readonly identitySha256: string;
  readonly createdAt: string;
}

interface ExitedHostProcessIdentity extends HostProcessIdentity {
  readonly exitedAt: string;
}

interface HostAcceptanceEvent {
  readonly observed: true;
  readonly at: string;
  readonly previousSha256: string;
  readonly eventSha256: string;
}

export interface HostAcceptanceReceipt {
  readonly schemaVersion: 1;
  readonly kind: "host-acceptance";
  readonly beta: PublicBetaIdentity;
  readonly pluginArtifactTreeDigestSha256: string;
  readonly core: ReleaseValidationCore;
  readonly observerArtifact: PublicBetaIdentity["observerArtifact"];
  readonly session: Readonly<{
    nonce: string;
    nonceSha256: string;
    descriptorSha256: string;
  }>;
  readonly oldHost: Readonly<{
    chatGpt: ExitedHostProcessIdentity;
    appServer: ExitedHostProcessIdentity;
    kernelPeerMcp: ExitedHostProcessIdentity;
  }>;
  readonly newHost: Readonly<{
    chatGpt: HostProcessIdentity;
    appServer: HostProcessIdentity;
    kernelPeerMcp: HostProcessIdentity;
  }>;
  readonly request: Readonly<{
    correlationSha256: string;
    completionMarkerIdentitySha256: string;
    bindingSha256: string;
    started: HostAcceptanceEvent & {
      readonly completionMarkerIdentitySha256: string;
      readonly sessionDescriptorSha256: string;
    };
    sdkAbort: HostAcceptanceEvent;
    ownedProcessExit: HostAcceptanceEvent & { readonly completion: "cancelled" };
    ownershipDrained: HostAcceptanceEvent;
    handlerCancelled: HostAcceptanceEvent & { readonly outcome: "cancelled" };
    inFlightRemoved: HostAcceptanceEvent;
    completionMarkerChecked: HostAcceptanceEvent & {
      readonly absent: true;
      readonly completionMarkerIdentitySha256: string;
    };
  }>;
  readonly result: "passed";
}

function timestamp(value: unknown): string {
  const candidate = stringValue(value, 64);
  if (
    !ISO_TIMESTAMP_PATTERN.test(candidate) ||
    new Date(candidate).toISOString() !== candidate
  ) {
    fail();
  }
  return candidate;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function computeHostAcceptanceRequestBindingSha256(input: Readonly<{
  sessionNonceSha256: string;
  newChatGptIdentitySha256: string;
  newAppServerIdentitySha256: string;
  newKernelPeerMcpIdentitySha256: string;
  requestCorrelationSha256: string;
  completionMarkerIdentitySha256: string;
  sessionDescriptorSha256: string;
}>): string {
  return sha256(
    JSON.stringify([
      "host-acceptance-request-binding-v1",
      input.sessionNonceSha256,
      input.newChatGptIdentitySha256,
      input.newAppServerIdentitySha256,
      input.newKernelPeerMcpIdentitySha256,
      input.requestCorrelationSha256,
      input.completionMarkerIdentitySha256,
      input.sessionDescriptorSha256,
    ]),
  );
}

export function computeHostAcceptanceEventSha256(
  name: string,
  at: string,
  previousSha256: string,
  outcome: string,
): string {
  return sha256(
    JSON.stringify([
      "host-acceptance-event-v1",
      name,
      at,
      previousSha256,
      outcome,
    ]),
  );
}

function parseProcessIdentity(value: unknown, exited: boolean) {
  const record = plainRecord(value);
  exactKeys(record, exited ? ["identitySha256", "createdAt", "exitedAt"] : ["identitySha256", "createdAt"]);
  const base = {
    identitySha256: digest(record.identitySha256),
    createdAt: timestamp(record.createdAt),
  };
  return Object.freeze(
    exited ? { ...base, exitedAt: timestamp(record.exitedAt) } : base,
  );
}

function parseAcceptanceEvent(
  value: unknown,
  expectedPrevious: string,
  name: string,
  outcome: string,
  extras: readonly (readonly [string, unknown])[],
): HostAcceptanceEvent & Record<string, unknown> {
  const record = plainRecord(value);
  exactKeys(record, [
    "observed",
    "at",
    "previousSha256",
    "eventSha256",
    ...extras.map(([key]) => key),
  ]);
  if (
    record.observed !== true ||
    extras.some(([key, expected]) => record[key] !== expected)
  ) fail();
  const at = timestamp(record.at);
  const previousSha256 = digest(record.previousSha256);
  const eventSha256 = digest(record.eventSha256);
  if (
    previousSha256 !== expectedPrevious ||
    eventSha256 !== computeHostAcceptanceEventSha256(name, at, previousSha256, outcome)
  ) fail();
  return Object.freeze({
    observed: true,
    at,
    previousSha256,
    eventSha256,
    ...Object.fromEntries(extras),
  });
}

export function assertHostAcceptanceReceipt(
  value: unknown,
  marker: StableReleaseValidationMarker,
): HostAcceptanceReceipt {
  try {
    const record = plainRecord(value);
    exactKeys(record, [
      "schemaVersion",
      "kind",
      "beta",
      "pluginArtifactTreeDigestSha256",
      "core",
      "observerArtifact",
      "session",
      "oldHost",
      "newHost",
      "request",
      "result",
    ]);
    if (record.schemaVersion !== 1 || record.kind !== "host-acceptance" || record.result !== "passed") fail();
    const beta = plainRecord(record.beta);
    exactKeys(beta, ["version", "tag", "taggedCommit", "npm"]);
    const receiptBeta = Object.freeze({
      version: version(beta.version),
      tag: stringValue(beta.tag, 130),
      taggedCommit: commit(beta.taggedCommit),
      npm: parseNpmDist(beta.npm),
    });
    if (
      receiptBeta.version !== marker.publicBeta.version ||
      receiptBeta.tag !== marker.publicBeta.tag ||
      receiptBeta.taggedCommit !== marker.publicBeta.taggedCommit ||
      !sameJson(receiptBeta.npm, marker.publicBeta.npm)
    ) fail();
    const receiptCore = parseCore(record.core);
    if (!sameJson(receiptCore, marker.core)) fail();
    const pluginArtifactTreeDigestSha256 = digest(record.pluginArtifactTreeDigestSha256);
    if (pluginArtifactTreeDigestSha256 !== marker.publicBeta.pluginArtifactTreeDigestSha256) fail();
    const observerArtifact = parseObserverArtifact(record.observerArtifact);
    if (!sameJson(observerArtifact, marker.publicBeta.observerArtifact)) fail();
    const session = plainRecord(record.session);
    exactKeys(session, ["nonce", "nonceSha256", "descriptorSha256"]);
    const nonce = stringValue(session.nonce, 512);
    if (nonce.length < 32) fail();
    const nonceSha256 = digest(session.nonceSha256);
    const descriptorSha256 = digest(session.descriptorSha256);
    if (sha256(nonce) !== nonceSha256 || nonceSha256 !== marker.hostAcceptance.sessionNonceSha256) fail();

    const oldHostRecord = plainRecord(record.oldHost);
    exactKeys(oldHostRecord, ["chatGpt", "appServer", "kernelPeerMcp"]);
    const newHostRecord = plainRecord(record.newHost);
    exactKeys(newHostRecord, ["chatGpt", "appServer", "kernelPeerMcp"]);
    const oldChatGpt = parseProcessIdentity(oldHostRecord.chatGpt, true) as ExitedHostProcessIdentity;
    const oldAppServer = parseProcessIdentity(oldHostRecord.appServer, true) as ExitedHostProcessIdentity;
    const oldKernelPeerMcp = parseProcessIdentity(oldHostRecord.kernelPeerMcp, true) as ExitedHostProcessIdentity;
    const newChatGpt = parseProcessIdentity(newHostRecord.chatGpt, false) as HostProcessIdentity;
    const newAppServer = parseProcessIdentity(newHostRecord.appServer, false) as HostProcessIdentity;
    const newKernelPeerMcp = parseProcessIdentity(newHostRecord.kernelPeerMcp, false) as HostProcessIdentity;
    const identities = [
      oldChatGpt,
      oldAppServer,
      oldKernelPeerMcp,
      newChatGpt,
      newAppServer,
      newKernelPeerMcp,
    ].map((entry) => entry.identitySha256);
    if (new Set(identities).size !== identities.length) fail();

    const request = plainRecord(record.request);
    exactKeys(request, [
      "correlationSha256", "completionMarkerIdentitySha256", "bindingSha256",
      "started", "sdkAbort", "ownedProcessExit", "ownershipDrained",
      "handlerCancelled", "inFlightRemoved", "completionMarkerChecked",
    ]);
    const correlationSha256 = digest(request.correlationSha256);
    const completionMarkerIdentitySha256 = digest(
      request.completionMarkerIdentitySha256,
    );
    const bindingSha256 = digest(request.bindingSha256);
    if (
      bindingSha256 !== computeHostAcceptanceRequestBindingSha256({
        sessionNonceSha256: nonceSha256,
        newChatGptIdentitySha256: newChatGpt.identitySha256,
        newAppServerIdentitySha256: newAppServer.identitySha256,
        newKernelPeerMcpIdentitySha256: newKernelPeerMcp.identitySha256,
        requestCorrelationSha256: correlationSha256,
        completionMarkerIdentitySha256,
        sessionDescriptorSha256: descriptorSha256,
      })
    ) fail();
    const started = parseAcceptanceEvent(
      request.started,
      bindingSha256,
      "request-started",
      `bound:${completionMarkerIdentitySha256}:${descriptorSha256}`,
      [
        ["completionMarkerIdentitySha256", completionMarkerIdentitySha256],
        ["sessionDescriptorSha256", descriptorSha256],
      ],
    );
    const sdkAbort = parseAcceptanceEvent(request.sdkAbort, started.eventSha256, "sdk-abort", "true", []);
    const ownedProcessExit = parseAcceptanceEvent(request.ownedProcessExit, sdkAbort.eventSha256, "owned-process-exit", "cancelled", [["completion", "cancelled"]]);
    const ownershipDrained = parseAcceptanceEvent(request.ownershipDrained, ownedProcessExit.eventSha256, "ownership-drained", "true", []);
    const handlerCancelled = parseAcceptanceEvent(request.handlerCancelled, ownershipDrained.eventSha256, "handler-cancelled", "cancelled", [["outcome", "cancelled"]]);
    const inFlightRemoved = parseAcceptanceEvent(request.inFlightRemoved, handlerCancelled.eventSha256, "in-flight-removed", "true", []);
    const completionMarkerChecked = parseAcceptanceEvent(
      request.completionMarkerChecked,
      inFlightRemoved.eventSha256,
      "completion-marker-checked",
      `absent:${completionMarkerIdentitySha256}`,
      [
        ["absent", true],
        ["completionMarkerIdentitySha256", completionMarkerIdentitySha256],
      ],
    );

    const oldCreated = [
      oldChatGpt.createdAt,
      oldAppServer.createdAt,
      oldKernelPeerMcp.createdAt,
    ].map(Date.parse);
    const oldExited = [
      oldChatGpt.exitedAt,
      oldAppServer.exitedAt,
      oldKernelPeerMcp.exitedAt,
    ].map(Date.parse);
    const newCreated = [
      newChatGpt.createdAt,
      newAppServer.createdAt,
      newKernelPeerMcp.createdAt,
    ].map(Date.parse);
    const eventTimeline = [
      started.at,
      sdkAbort.at,
      ownedProcessExit.at,
      ownershipDrained.at,
      handlerCancelled.at,
      inFlightRemoved.at,
      completionMarkerChecked.at,
    ].map(Date.parse);
    if (
      oldCreated[0]! > oldCreated[1]! ||
      oldCreated[1]! > oldCreated[2]! ||
      oldCreated.some((created, index) => created >= oldExited[index]!) ||
      Math.max(...oldExited) >= newCreated[0]! ||
      newCreated[0]! > newCreated[1]! ||
      newCreated[1]! > newCreated[2]! ||
      eventTimeline[0]! < newCreated[2]! ||
      eventTimeline.some(
        (entry, index) => index > 0 && eventTimeline[index - 1]! > entry,
      )
    ) fail();

    return Object.freeze({
      schemaVersion: 1,
      kind: "host-acceptance",
      beta: Object.freeze({ ...marker.publicBeta }),
      pluginArtifactTreeDigestSha256,
      core: receiptCore,
      observerArtifact,
      session: Object.freeze({ nonce, nonceSha256, descriptorSha256 }),
      oldHost: Object.freeze({ chatGpt: oldChatGpt, appServer: oldAppServer, kernelPeerMcp: oldKernelPeerMcp }),
      newHost: Object.freeze({ chatGpt: newChatGpt, appServer: newAppServer, kernelPeerMcp: newKernelPeerMcp }),
      request: Object.freeze({ correlationSha256, completionMarkerIdentitySha256, bindingSha256, started, sdkAbort, ownedProcessExit, ownershipDrained, handlerCancelled, inFlightRemoved, completionMarkerChecked }) as unknown as HostAcceptanceReceipt["request"],
      result: "passed",
    });
  } catch {
    return fail();
  }
}

function normalizeRepositoryRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes("\\")
  ) {
    fail();
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail();
  }
  return segments.join("/");
}

function evidenceByteLimit(relativePath: string): number {
  const normalized = normalizeRepositoryRelativePath(relativePath);
  return normalized === PLUGIN_RUNTIME_PATH ||
    normalized === OBSERVER_ARTIFACT_PATH
    ? MAX_FIXED_BINARY_EVIDENCE_BYTES
    : MAX_JSON_EVIDENCE_BYTES;
}

function assertEvidenceBufferLimit(relativePath: string, bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length > evidenceByteLimit(relativePath)) {
    fail();
  }
  return bytes;
}

async function readSafeRepositoryFile(
  repositoryRoot: string,
  relativePath: string,
): Promise<Buffer> {
  try {
    const requestedRoot = path.resolve(repositoryRoot);
    const rootMetadata = await lstat(requestedRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail();
    const root = path.resolve(await realpath(requestedRoot));
    const normalized = normalizeRepositoryRelativePath(relativePath);
    const absolute = path.resolve(root, ...normalized.split("/"));
    const relative = path.relative(root, absolute);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      fail();
    }
    let current = root;
    for (const segment of normalized.split("/")) {
      current = path.join(current, segment);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) fail();
    }
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.size > evidenceByteLimit(normalized)) fail();
    const canonicalAbsolute = path.resolve(await realpath(absolute));
    const targetMatches =
      process.platform === "win32"
        ? canonicalAbsolute.toLowerCase() === absolute.toLowerCase()
        : canonicalAbsolute === absolute;
    if (!targetMatches) fail();
    return assertEvidenceBufferLimit(normalized, await readFile(absolute));
  } catch {
    return fail();
  }
}

export async function readStrictReleaseEvidenceFile(
  repositoryRoot: string,
  relativePath: string,
): Promise<Buffer> {
  return readSafeRepositoryFile(repositoryRoot, relativePath);
}

function parseJson(bytes: Buffer): unknown {
  try {
    return parseStrictJsonBytes(bytes);
  } catch {
    return fail();
  }
}

function projectCapabilityIndex(
  bytes: Buffer,
): readonly CapabilityFingerprintProjection[] {
  const record = plainRecord(parseJson(bytes));
  exactKeys(record, ["schemaVersion", "entries"]);
  if (record.schemaVersion !== 1) fail();
  const entries = strictArray(record.entries);
  return parseCapabilityProjection(
    entries.map((entry) => {
      const capability = plainRecord(entry);
      if (
        !Object.hasOwn(capability, "llm") ||
        !Object.hasOwn(capability, "task") ||
        !Object.hasOwn(capability, "runtimeFingerprintSha256")
      ) {
        fail();
      }
      return {
        llm: capability.llm,
        task: capability.task,
        currentFingerprintSha256: capability.runtimeFingerprintSha256,
      };
    }),
  );
}

export interface ReleaseValidationDependencies {
  readonly readRepositoryFile?: (
    repositoryRoot: string,
    relativePath: string,
  ) => Promise<Buffer>;
  readonly collectCanonicalIdentity?: typeof collectCanonicalRuntimeInputIdentity;
  readonly isGitAncestor?: (
    repositoryRoot: string,
    ancestor: string,
    descendant: string,
  ) => Promise<boolean>;
  readonly readGitFile?: (
    repositoryRoot: string,
    commit: string,
    relativePath: string,
  ) => Promise<Buffer>;
  readonly resolveGitTagCommit?: (
    repositoryRoot: string,
    tag: string,
  ) => Promise<string>;
  readonly lookupNpmDist?: (
    packageName: string,
    packageVersion: string,
  ) => Promise<NpmDistIdentity>;
}

async function defaultResolveGitTagCommit(
  repositoryRoot: string,
  tag: string,
): Promise<string> {
  try {
    const expectedTag = stringValue(tag, 130);
    if (!/^v[0-9A-Za-z.-]+$/u.test(expectedTag)) fail();
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", `refs/tags/${expectedTag}^{commit}`],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 1024,
        windowsHide: true,
        timeout: 30_000,
      },
    );
    return commit(stdout.trim());
  } catch {
    return fail();
  }
}

export function digestReleasePluginArtifactTree(
  entries: readonly Readonly<{ path: string; content: Buffer }>[] ,
): string {
  try {
    const strictEntries = strictArray(entries);
    if (
      strictEntries.length !== RELEASE_PLUGIN_ARTIFACT_PATHS.length
    ) {
      fail();
    }
    const parsedEntries = strictEntries.map((entry, index) => {
      const record = plainRecord(entry);
      exactKeys(record, ["path", "content"]);
      const artifactPath = exactString(
        record.path,
        RELEASE_PLUGIN_ARTIFACT_PATHS[index]!,
      );
      if (!Buffer.isBuffer(record.content)) fail();
      assertEvidenceBufferLimit(artifactPath, record.content);
      return { path: artifactPath, content: record.content };
    });
    return sha256(
      JSON.stringify({
        schemaVersion: 1,
        files: parsedEntries.map((entry) => ({
          path: entry.path,
          sha256: sha256(entry.content),
        })),
      }),
    );
  } catch {
    return fail();
  }
}

async function collectPluginArtifactTreeDigest(
  repositoryRoot: string,
  read: (repositoryRoot: string, relativePath: string) => Promise<Buffer>,
): Promise<string> {
  const entries = await Promise.all(
    RELEASE_PLUGIN_ARTIFACT_PATHS.map(async (artifactPath) =>
      Object.freeze({
        path: artifactPath,
        content: await read(repositoryRoot, artifactPath),
      }),
    ),
  );
  return digestReleasePluginArtifactTree(entries);
}

async function verifyObserverArtifactProvenance(
  repositoryRoot: string,
  observer: BetaReleaseValidationMarker["observerArtifact"],
  read: (repositoryRoot: string, relativePath: string) => Promise<Buffer>,
): Promise<void> {
  const artifactBytes = await read(repositoryRoot, observer.path);
  if (sha256(artifactBytes) !== observer.sha256) fail();
  const manifestBytes = await read(repositoryRoot, observer.buildManifest.path);
  if (sha256(manifestBytes) !== observer.buildManifest.sha256) fail();
  const buildConfigBytes = await read(
    repositoryRoot,
    OBSERVER_BUILD_CONFIG_PATH,
  );
  const manifest = parseObserverBuildInputsManifest(
    parseJson(manifestBytes),
    parseJson(buildConfigBytes),
  );
  if (
    manifest.artifactPath !== observer.path ||
    !sameJson(manifest.protocol, observer.protocol) ||
    manifest.inputsDigestSha256 !== observer.inputsDigestSha256 ||
    manifest.inputs.find(
      (input) => input.path === OBSERVER_BUILD_CONFIG_PATH,
    )?.sha256 !== sha256(buildConfigBytes)
  ) fail();
  await Promise.all(
    manifest.inputs.map(async (input) => {
      const bytes = await read(repositoryRoot, input.path);
      if (sha256(bytes) !== input.sha256) fail();
    }),
  );
}

async function defaultIsGitAncestor(
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      { cwd: repositoryRoot, windowsHide: true, timeout: 30_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function defaultReadGitFile(
  repositoryRoot: string,
  targetCommit: string,
  relativePath: string,
): Promise<Buffer> {
  try {
    commit(targetCommit);
    const normalized = normalizeRepositoryRelativePath(relativePath);
    const byteLimit = evidenceByteLimit(normalized);
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${targetCommit}:${normalized}`],
      {
        cwd: repositoryRoot,
        encoding: "buffer",
        maxBuffer: byteLimit + 1,
        windowsHide: true,
        timeout: 30_000,
      },
    );
    return assertEvidenceBufferLimit(normalized, Buffer.from(stdout));
  } catch {
    return fail();
  }
}

async function defaultLookupNpmDist(
  packageName: string,
  packageVersion: string,
): Promise<NpmDistIdentity> {
  try {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "view",
        `${packageName}@${packageVersion}`,
        "version",
        "dist",
        "--json",
      ],
      { encoding: "utf8", maxBuffer: 16_384, windowsHide: true, timeout: 30_000 },
    );
    return parseNpmViewResponse(JSON.parse(stdout) as unknown, packageVersion);
  } catch {
    return fail();
  }
}

export function parseNpmViewResponse(
  value: unknown,
  expectedVersion: string,
): NpmDistIdentity {
  try {
    version(expectedVersion);
    const record = plainRecord(value);
    exactKeys(record, ["version", "dist"]);
    if (record.version !== expectedVersion) fail();
    const dist = plainRecord(record.dist);
    if (!Object.hasOwn(dist, "integrity") || !Object.hasOwn(dist, "shasum")) {
      fail();
    }
    return parseNpmDist({
      integrity: dist.integrity,
      shasum: dist.shasum,
    });
  } catch {
    return fail();
  }
}

export async function verifyReleaseValidation(
  options: Readonly<{
    repositoryRoot: string;
    packageVersion: string;
    tag: string;
    taggedCommit: string;
    npmChannel: ReleaseChannel;
  }>,
  dependencies: ReleaseValidationDependencies = {},
): Promise<ReleaseValidationMarker> {
  try {
    const tagCommit = commit(options.taggedCommit);
    const resolveGitTagCommit =
      dependencies.resolveGitTagCommit ?? defaultResolveGitTagCommit;
    if (
      (await resolveGitTagCommit(options.repositoryRoot, options.tag)) !==
      tagCommit
    ) {
      fail();
    }
    const markerPath = `.release-validation/v${options.packageVersion}.json`;
    const rawReadRepositoryFile =
      dependencies.readRepositoryFile ?? readSafeRepositoryFile;
    const readRepositoryFile = async (
      repositoryRoot: string,
      relativePath: string,
    ): Promise<Buffer> =>
      assertEvidenceBufferLimit(
        relativePath,
        await rawReadRepositoryFile(repositoryRoot, relativePath),
      );
    const markerBytes = await readRepositoryFile(
      options.repositoryRoot,
      markerPath,
    );
    const packageBytes = await readRepositoryFile(
      options.repositoryRoot,
      "package.json",
    );
    const packageManifest = plainRecord(parseJson(packageBytes));
    if (
      packageManifest.name !== PACKAGE_NAME ||
      packageManifest.version !== options.packageVersion
    ) {
      fail();
    }
    const canonicalIdentity = await (
      dependencies.collectCanonicalIdentity ??
      collectCanonicalRuntimeInputIdentity
    )(options.repositoryRoot);
    const marker = parseReleaseValidationMarker(parseJson(markerBytes), {
      packageVersion: options.packageVersion,
      tag: options.tag,
      npmChannel: options.npmChannel,
      expectedCanonicalRuntimeDigestSha256: canonicalIdentity.digestSha256,
    });
    if (
      marker.core.windowsJobHelper.sha256 !==
      canonicalIdentity.manifest.helperArtifact.sha256
    ) {
      fail();
    }
    const indexBytes = await readRepositoryFile(
      options.repositoryRoot,
      CAPABILITY_INDEX_PATH,
    );
    const capabilityProjection = projectCapabilityIndex(indexBytes);
    if (
      sha256(indexBytes) !== marker.core.capabilityIndex.sha256 ||
      capabilityProjection.length !== marker.core.capabilityIndex.entryCount
    ) {
      fail();
    }
    const freezeBytes = await readRepositoryFile(
      options.repositoryRoot,
      marker.core.currentHostFreeze.path,
    );
    if (sha256(freezeBytes) !== marker.core.currentHostFreeze.sha256) fail();
    assertCurrentHostFreezeReceipt(
      parseJson(freezeBytes),
      marker.core,
      capabilityProjection,
      marker.kind === "beta"
        ? marker.observerArtifact
        : marker.publicBeta.observerArtifact,
    );
    const isAncestor = dependencies.isGitAncestor ?? defaultIsGitAncestor;
    if (
      marker.core.runtimeFrozenCommit === tagCommit ||
      !(await isAncestor(
        options.repositoryRoot,
        marker.core.runtimeFrozenCommit,
        tagCommit,
      ))
    ) {
      fail();
    }
    if (marker.kind === "beta") {
      const currentPluginTreeDigest = await collectPluginArtifactTreeDigest(
        options.repositoryRoot,
        readRepositoryFile,
      );
      if (
        currentPluginTreeDigest !== marker.pluginArtifactTree.digestSha256
      ) fail();
      await verifyObserverArtifactProvenance(
        options.repositoryRoot,
        marker.observerArtifact,
        readRepositoryFile,
      );
      return marker;
    }

    if (
      marker.publicBeta.taggedCommit === tagCommit ||
      (await resolveGitTagCommit(
        options.repositoryRoot,
        marker.publicBeta.tag,
      )) !== marker.publicBeta.taggedCommit ||
      !(await isAncestor(
        options.repositoryRoot,
        marker.publicBeta.taggedCommit,
        tagCommit,
      )) ||
      marker.core.runtimeFrozenCommit === marker.publicBeta.taggedCommit ||
      !(await isAncestor(
        options.repositoryRoot,
        marker.core.runtimeFrozenCommit,
        marker.publicBeta.taggedCommit,
      ))
    ) {
      fail();
    }
    const rawReadGitFile = dependencies.readGitFile ?? defaultReadGitFile;
    const readGitFile = async (
      repositoryRoot: string,
      targetCommit: string,
      relativePath: string,
    ): Promise<Buffer> =>
      assertEvidenceBufferLimit(
        relativePath,
        await rawReadGitFile(repositoryRoot, targetCommit, relativePath),
      );
    const betaPackageBytes = await readGitFile(
      options.repositoryRoot,
      marker.publicBeta.taggedCommit,
      "package.json",
    );
    const betaPackage = plainRecord(parseJson(betaPackageBytes));
    if (
      betaPackage.name !== PACKAGE_NAME ||
      betaPackage.version !== marker.publicBeta.version
    ) {
      fail();
    }
    const betaMarkerBytes = await readGitFile(
      options.repositoryRoot,
      marker.publicBeta.taggedCommit,
      marker.publicBeta.markerPath,
    );
    if (sha256(betaMarkerBytes) !== marker.publicBeta.markerSha256) fail();
    const betaMarker = parseReleaseValidationMarker(parseJson(betaMarkerBytes), {
      packageVersion: marker.publicBeta.version,
      tag: marker.publicBeta.tag,
      npmChannel: "next",
      expectedCanonicalRuntimeDigestSha256:
        marker.core.canonicalRuntime.digestSha256,
    });
    if (betaMarker.kind !== "beta" || !sameJson(betaMarker.core, marker.core)) {
      fail();
    }
    const betaPluginEntries = await Promise.all(
      RELEASE_PLUGIN_ARTIFACT_PATHS.map(async (artifactPath) =>
        Object.freeze({
          path: artifactPath,
          content: await readGitFile(
            options.repositoryRoot,
            marker.publicBeta.taggedCommit,
            artifactPath,
          ),
        }),
      ),
    );
    const betaPluginTreeDigest = digestReleasePluginArtifactTree(
      betaPluginEntries,
    );
    if (
      betaPluginTreeDigest !==
        marker.publicBeta.pluginArtifactTreeDigestSha256 ||
      betaPluginTreeDigest !== betaMarker.pluginArtifactTree.digestSha256
    ) {
      fail();
    }
    if (
      !sameJson(betaMarker.observerArtifact, marker.publicBeta.observerArtifact)
    ) fail();
    await verifyObserverArtifactProvenance(
      options.repositoryRoot,
      marker.publicBeta.observerArtifact,
      async (repositoryRoot, relativePath) =>
        readGitFile(
          repositoryRoot,
          marker.publicBeta.taggedCommit,
          relativePath,
        ),
    );
    const registry = await (
      dependencies.lookupNpmDist ?? defaultLookupNpmDist
    )(PACKAGE_NAME, marker.publicBeta.version);
    if (!sameJson(registry, marker.publicBeta.npm)) fail();
    const hostBytes = await readRepositoryFile(
      options.repositoryRoot,
      marker.hostAcceptance.path,
    );
    if (sha256(hostBytes) !== marker.hostAcceptance.sha256) fail();
    assertHostAcceptanceReceipt(
      parseJson(hostBytes),
      marker,
    );
    return marker;
  } catch {
    return fail();
  }
}

function parseCliArguments(argv: readonly string[]): {
  repositoryRoot: string;
  packageVersion: string;
  tag: string;
  taggedCommit: string;
  npmChannel: ReleaseChannel;
} {
  strictArray(argv);
  const expected = [
    "--repository-root",
    "--package-version",
    "--tag",
    "--tagged-commit",
    "--npm-channel",
  ];
  if (argv.length !== expected.length * 2) fail();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      typeof flag !== "string" ||
      typeof value !== "string" ||
      flag !== expected[index / 2]
    ) {
      fail();
    }
    values.set(flag, value);
  }
  const npmChannel = values.get("--npm-channel");
  if (npmChannel !== "next" && npmChannel !== "latest") fail();
  return {
    repositoryRoot: stringValue(values.get("--repository-root"), 4096),
    packageVersion: version(values.get("--package-version")),
    tag: stringValue(values.get("--tag"), 130),
    taggedCommit: commit(values.get("--tagged-commit")),
    npmChannel,
  };
}

async function main(): Promise<void> {
  try {
    await verifyReleaseValidation(parseCliArguments(process.argv.slice(2)));
    process.stdout.write("Release validation evidence is valid.\n");
  } catch {
    process.stderr.write(`${FAILURE_MESSAGE}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined) {
  const invoked = path.resolve(process.argv[1]);
  const current = path.resolve(fileURLToPath(import.meta.url));
  if (invoked === current) void main();
}
