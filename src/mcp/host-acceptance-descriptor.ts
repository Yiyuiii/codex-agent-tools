import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import protocol from "../../host-acceptance/protocol/observer-protocol.v1.json" with {
  type: "json",
};

import { parseStrictJsonBytes } from "../runtime/strict-json.js";

const DESCRIPTOR_ERROR = "Host acceptance descriptor is invalid.";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*$/u;
const OBSERVER_PATH =
  "host-acceptance/win32-x64/codex-host-acceptance-observer.exe";
const BUILD_MANIFEST_PATH = "host-acceptance/observer-build-inputs.v1.json";
const PROTOCOL_PATH =
  "host-acceptance/protocol/observer-protocol.v1.json";

export const HOST_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH =
  protocol.descriptor.relativePath;
export const HOST_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES =
  protocol.descriptor.maximumBytes;
export const HOST_ACCEPTANCE_FRAME_MAXIMUM_BYTES = protocol.frames.maximumBytes;
export const HOST_ACCEPTANCE_MAXIMUM_EVENTS_PER_CONNECTION =
  protocol.frames.maximumEventsPerConnection;

export interface HostAcceptanceRuntimeIdentity {
  readonly packageName: string;
  readonly packageVersion: string;
}

export interface HostAcceptanceDelegateInputIdentity {
  readonly llm: string;
  readonly promptSha256: string;
  readonly cwdSha256: string;
  readonly timeoutMs: number | null;
  readonly sessionIdSha256: string | null;
  readonly inputIdentitySha256: string;
}

export interface LoadedHostAcceptanceDescriptor {
  readonly schemaVersion: 1;
  readonly protocolVersion: 1;
  readonly packageName: string;
  readonly nonce: string;
  readonly pipeName: string;
  readonly pipePath: string;
  readonly descriptorSha256: string;
  readonly publicBeta: Readonly<{
    version: string;
    tag: string;
    taggedCommit: string;
    markerPath: string;
    markerSha256: string;
    pluginArtifactTreeDigestSha256: string;
    observerArtifact: Readonly<{
      path: typeof OBSERVER_PATH;
      sha256: string;
      protocolVersion: 1;
      buildManifest: Readonly<{ path: typeof BUILD_MANIFEST_PATH; sha256: string }>;
      protocol: Readonly<{ path: typeof PROTOCOL_PATH; sha256: string }>;
      inputsDigestSha256: string;
    }>;
    npm: Readonly<{ integrity: string; shasum: string }>;
  }>;
  readonly request: HostAcceptanceDelegateInputIdentity &
    Readonly<{
      task: "delegate";
      completionMarkerId: string;
      completionMarkerIdentitySha256: string;
    }>;
}

function invalidDescriptor(): never {
  throw new Error(DESCRIPTOR_ERROR);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidDescriptor();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) invalidDescriptor();
}

function exactString(value: unknown, expected: string): string {
  if (value !== expected) invalidDescriptor();
  return expected;
}

function matchingString(value: unknown, pattern: RegExp, maximum = 512): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) {
    return invalidDescriptor();
  }
  return value;
}

function digest(value: unknown, pattern = SHA256_PATTERN): string {
  return matchingString(value, pattern, 128);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fieldDigest(domain: string, value: string): string {
  return sha256(JSON.stringify([domain, value]));
}

export function computeHostAcceptanceDelegateInputIdentity(input: Readonly<{
  llm: string;
  prompt: string;
  cwd: string;
  timeoutMs?: number | undefined;
  sessionId?: string | undefined;
}>): HostAcceptanceDelegateInputIdentity {
  const promptSha256 = fieldDigest(protocol.hashDomains.prompt, input.prompt);
  const cwdSha256 = fieldDigest(protocol.hashDomains.cwd, input.cwd);
  const sessionIdSha256 =
    input.sessionId === undefined
      ? null
      : fieldDigest(protocol.hashDomains.sessionId, input.sessionId);
  const timeoutMs = input.timeoutMs ?? null;
  return Object.freeze({
    llm: input.llm,
    promptSha256,
    cwdSha256,
    timeoutMs,
    sessionIdSha256,
    inputIdentitySha256: computeInputIdentityFromDigests({
      llm: input.llm,
      promptSha256,
      cwdSha256,
      timeoutMs,
      sessionIdSha256,
    }),
  });
}

function computeInputIdentityFromDigests(
  input: Omit<HostAcceptanceDelegateInputIdentity, "inputIdentitySha256">,
): string {
  return sha256(
    JSON.stringify([
      protocol.hashDomains.requestInput,
      "delegate",
      input.llm,
      input.promptSha256,
      input.cwdSha256,
      input.timeoutMs,
      input.sessionIdSha256,
    ]),
  );
}

export function computeHostAcceptanceCompletionMarkerIdentitySha256(input: {
  readonly nonce: string;
  readonly completionMarkerId: string;
  readonly inputIdentitySha256: string;
}): string {
  return sha256(
    JSON.stringify([
      protocol.hashDomains.completionMarker,
      input.nonce,
      input.completionMarkerId,
      input.inputIdentitySha256,
    ]),
  );
}

function parseArtifactIdentity(
  value: unknown,
  expectedPath: string,
): Readonly<{ path: string; sha256: string }> {
  const item = record(value);
  exactKeys(item, protocol.descriptor.artifactIdentityKeys);
  return Object.freeze({
    path: exactString(item.path, expectedPath),
    sha256: digest(item.sha256),
  });
}

export function parseHostAcceptanceDescriptorBytes(
  bytes: Uint8Array,
  expected: HostAcceptanceRuntimeIdentity,
): LoadedHostAcceptanceDescriptor {
  try {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > HOST_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES
    ) {
      invalidDescriptor();
    }
    const root = record(parseStrictJsonBytes(bytes));
    exactKeys(root, protocol.descriptor.topLevelKeys);
    if (root.schemaVersion !== 1 || root.protocolVersion !== protocol.protocolVersion) {
      invalidDescriptor();
    }
    const packageName = exactString(root.packageName, expected.packageName);
    const nonce = matchingString(
      root.nonce,
      new RegExp(protocol.descriptor.noncePattern, "u"),
      128,
    );
    const pipeName = matchingString(
      root.pipeName,
      new RegExp(protocol.descriptor.pipeNamePattern, "u"),
      128,
    );

    const beta = record(root.publicBeta);
    exactKeys(beta, protocol.descriptor.publicBetaKeys);
    const version = matchingString(beta.version, VERSION_PATTERN, 128);
    exactString(version, expected.packageVersion);
    const tag = exactString(beta.tag, `v${version}`);
    const markerPath = exactString(
      beta.markerPath,
      `.release-validation/v${version}.json`,
    );
    const observer = record(beta.observerArtifact);
    exactKeys(observer, protocol.descriptor.observerArtifactKeys);
    if (observer.protocolVersion !== protocol.protocolVersion) invalidDescriptor();
    exactString(observer.path, OBSERVER_PATH);
    const buildManifest = parseArtifactIdentity(
      observer.buildManifest,
      BUILD_MANIFEST_PATH,
    );
    const observerProtocol = parseArtifactIdentity(observer.protocol, PROTOCOL_PATH);
    const npm = record(beta.npm);
    exactKeys(npm, protocol.descriptor.npmKeys);
    const integrity = matchingString(
      npm.integrity,
      /^sha512-[A-Za-z0-9+/]{86}==$/u,
      256,
    );

    const request = record(root.request);
    exactKeys(request, protocol.descriptor.requestKeys);
    if (request.task !== "delegate") invalidDescriptor();
    const llm = matchingString(request.llm, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, 128);
    const promptSha256 = digest(request.promptSha256);
    const cwdSha256 = digest(request.cwdSha256);
    const timeoutMs =
      request.timeoutMs === null
        ? null
        : typeof request.timeoutMs === "number" &&
            Number.isSafeInteger(request.timeoutMs) &&
            request.timeoutMs >= 1_000
          ? request.timeoutMs
          : invalidDescriptor();
    const sessionIdSha256 =
      request.sessionIdSha256 === null
        ? null
        : digest(request.sessionIdSha256);
    const inputIdentitySha256 = digest(request.inputIdentitySha256);
    const computedInputIdentity = computeInputIdentityFromDigests({
      llm,
      promptSha256,
      cwdSha256,
      timeoutMs,
      sessionIdSha256,
    });
    if (inputIdentitySha256 !== computedInputIdentity) invalidDescriptor();
    const completionMarkerId = matchingString(
      request.completionMarkerId,
      new RegExp(protocol.descriptor.completionMarkerIdPattern, "u"),
      64,
    );
    const completionMarkerIdentitySha256 = digest(
      request.completionMarkerIdentitySha256,
    );
    if (
      completionMarkerIdentitySha256 !==
      computeHostAcceptanceCompletionMarkerIdentitySha256({
        nonce,
        completionMarkerId,
        inputIdentitySha256,
      })
    ) {
      invalidDescriptor();
    }

    return Object.freeze({
      schemaVersion: 1,
      protocolVersion: 1,
      packageName,
      nonce,
      pipeName,
      pipePath: `\\\\.\\pipe\\${pipeName}`,
      descriptorSha256: sha256(bytes),
      publicBeta: Object.freeze({
        version,
        tag,
        taggedCommit: digest(beta.taggedCommit, COMMIT_PATTERN),
        markerPath,
        markerSha256: digest(beta.markerSha256),
        pluginArtifactTreeDigestSha256: digest(
          beta.pluginArtifactTreeDigestSha256,
        ),
        observerArtifact: Object.freeze({
          path: OBSERVER_PATH,
          sha256: digest(observer.sha256),
          protocolVersion: 1,
          buildManifest: buildManifest as {
            path: typeof BUILD_MANIFEST_PATH;
            sha256: string;
          },
          protocol: observerProtocol as {
            path: typeof PROTOCOL_PATH;
            sha256: string;
          },
          inputsDigestSha256: digest(observer.inputsDigestSha256),
        }),
        npm: Object.freeze({
          integrity,
          shasum: digest(npm.shasum, SHA1_PATTERN),
        }),
      }),
      request: Object.freeze({
        task: "delegate",
        llm,
        promptSha256,
        cwdSha256,
        timeoutMs,
        sessionIdSha256,
        inputIdentitySha256,
        completionMarkerId,
        completionMarkerIdentitySha256,
      }),
    });
  } catch {
    return invalidDescriptor();
  }
}

function sameFileIdentity(
  left: Readonly<{ dev: number | bigint; ino: number | bigint; size: number | bigint }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint; size: number | bigint }>,
): boolean {
  return (
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino) &&
    Number(left.size) === Number(right.size)
  );
}

async function readFixedDescriptorBytes(
  localAppData: string,
): Promise<Buffer | undefined> {
  const root = path.win32.resolve(localAppData);
  if (
    !path.win32.isAbsolute(localAppData) ||
    localAppData.includes("\0") ||
    root !== path.win32.normalize(localAppData)
  ) {
    return undefined;
  }
  const segments = HOST_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH.split("/");
  const descriptorPath = path.win32.join(root, ...segments);
  const expectedPrefix = `${root.toLowerCase()}\\`;
  if (!descriptorPath.toLowerCase().startsWith(expectedPrefix)) return undefined;

  let first;
  try {
    first = await lstat(descriptorPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !first.isFile() ||
    first.isSymbolicLink() ||
    first.size <= 0 ||
    first.size > HOST_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES
  ) {
    return undefined;
  }

  const ancestors = [root];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.win32.join(current, segment);
    ancestors.push(current);
  }
  for (const ancestor of ancestors) {
    const metadata = await lstat(ancestor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
  }
  const canonicalRoot = path.win32.normalize(await realpath(root));
  const canonical = path.win32.normalize(await realpath(descriptorPath));
  const expectedCanonical = path.win32.join(canonicalRoot, ...segments);
  if (canonical.toLowerCase() !== expectedCanonical.toLowerCase()) {
    return undefined;
  }

  const handle = await open(descriptorPath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      Number(before.size) <= 0 ||
      Number(before.size) > HOST_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES ||
      !sameFileIdentity(first, before)
    ) {
      return undefined;
    }
    const storage = Buffer.alloc(HOST_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES + 1);
    let offset = 0;
    while (offset < storage.length) {
      const result = await handle.read(storage, offset, storage.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const final = await lstat(descriptorPath, { bigint: true });
    if (
      offset === 0 ||
      offset > HOST_ACCEPTANCE_DESCRIPTOR_MAXIMUM_BYTES ||
      final.isSymbolicLink() ||
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(first, final)
    ) {
      return undefined;
    }
    return storage.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readHostAcceptanceDescriptor(options: {
  readonly platform?: NodeJS.Platform;
  readonly localAppData?: string;
  readonly expectedPackageName: string;
  readonly expectedPackageVersion: string;
}): Promise<LoadedHostAcceptanceDescriptor | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const localAppData = options.localAppData?.trim();
  if (localAppData === undefined || localAppData.length === 0) return undefined;
  try {
    const bytes = await readFixedDescriptorBytes(localAppData);
    return bytes === undefined
      ? undefined
      : parseHostAcceptanceDescriptorBytes(bytes, {
          packageName: options.expectedPackageName,
          packageVersion: options.expectedPackageVersion,
        });
  } catch {
    return undefined;
  }
}
