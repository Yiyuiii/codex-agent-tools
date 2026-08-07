import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { types as nodeUtilTypes } from "node:util";

import { inspectWindowsJobHelperArtifact } from "../runtime/windows-job-helper.js";

const FAILURE_MESSAGE = "Canonical runtime inputs are invalid.";
const MAX_TEXT_INPUT_BYTES = 4 * 1024 * 1024;
const NATIVE_ROOT = "native/windows-job-helper";
const BUILD_CONFIG_PATH = `${NATIVE_ROOT}/build.config.json`;
const PROTOCOL_PATH = `${NATIVE_ROOT}/protocol.v1.json`;
const HELPER_ROOT =
  "plugins/codex-external-agents/native/win32-x64";
const HELPER_PATH = `${HELPER_ROOT}/codex-agent-job-helper.exe`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const CANONICAL_RUNTIME_TYPESCRIPT_WRAPPER_PATHS = Object.freeze([
  "src/runtime/owned-agent-process.ts",
  "src/runtime/windows-owned-agent-process.ts",
  "src/runtime/windows-job-helper.ts",
  "src/runtime/windows-job-protocol.ts",
] as const);

const BUILD_CONFIG_KEYS = Object.freeze([
  "schemaVersion",
  "targetFramework",
  "configuration",
  "platform",
  "compilerArguments",
  "references",
  "pathMap",
  "sourceSets",
  "output",
  "generatedProtocolConstants",
] as const);
const PROTOCOL_KEYS = Object.freeze([
  "schemaVersion",
  "mode",
  "frame",
  "limits",
  "messageType",
  "reason",
  "stage",
] as const);

interface CanonicalTextInput {
  readonly path: string;
  readonly sha256: string;
}

export interface CanonicalRuntimeInputManifest {
  readonly schemaVersion: 1;
  readonly buildContract: Readonly<{
    schemaVersion: number;
    targetFramework: string;
    configuration: string;
    platform: string;
    compilerArguments: readonly string[];
    references: readonly string[];
    pathMap: Readonly<{
      sourceRoot: string;
      virtualRoot: string;
    }>;
    productionSourcePaths: readonly string[];
    generatedProtocolConstants: Readonly<{
      relativePath: string;
      sha256: string;
    }>;
  }>;
  readonly protocol: Readonly<{
    schemaVersion: number;
    mode: Readonly<Record<string, string>>;
    frame: Readonly<Record<string, string | number>>;
    limits: Readonly<Record<string, number>>;
    messageType: Readonly<Record<string, number>>;
    reason: Readonly<Record<string, number>>;
    stage: Readonly<Record<string, number>>;
  }>;
  readonly nativeSources: readonly CanonicalTextInput[];
  readonly typescriptWrappers: readonly CanonicalTextInput[];
  readonly helperArtifact: Readonly<{
    path: typeof HELPER_PATH;
    sha256: string;
  }>;
}

export interface CanonicalRuntimeInputIdentity {
  readonly manifest: CanonicalRuntimeInputManifest;
  readonly serialized: string;
  readonly digestSha256: string;
}

function fail(): never {
  throw new Error(FAILURE_MESSAGE);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainRecord(value: unknown): Record<string, unknown> {
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

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(record).sort(ordinalCompare);
  const sortedExpected = [...expected].sort(ordinalCompare);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail();
  }
}

function finiteInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) return fail();
  return value as number;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) return fail();
  return value;
}

function strictArray(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return fail();
  }
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors["length"];
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable !== false ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    (lengthDescriptor.value as number) < 0
  ) {
    return fail();
  }
  const length = lengthDescriptor.value as number;
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

function stringArray(value: unknown): readonly string[] {
  return Object.freeze(strictArray(value).map(stringValue));
}

function normalizeRelativePath(value: unknown): string {
  const candidate = stringValue(value);
  if (
    candidate.length === 0 ||
    path.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate)
  ) {
    return fail();
  }
  const normalized = candidate.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return fail();
  }
  return segments.join("/");
}

function resolveRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
): string {
  const root = path.resolve(repositoryRoot);
  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, absolute);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return fail();
  }
  return absolute;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function assertNoReparseExistingPath(
  absolutePath: string,
): Promise<void> {
  const absolute = path.resolve(absolutePath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) fail();
  }
  if (!sameCanonicalPath(await realpath(absolute), absolute)) fail();
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readStrictText(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  const absolute = resolveRepositoryPath(repositoryRoot, relativePath);
  await assertNoReparseExistingPath(absolute);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.size > MAX_TEXT_INPUT_BYTES) fail();
  const bytes = await readFile(absolute);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail();
  }
  if (text.includes("\0")) fail();
  return text.replace(/\r\n?/gu, "\n");
}

async function readJson(
  repositoryRoot: string,
  relativePath: string,
): Promise<Record<string, unknown>> {
  try {
    return plainRecord(
      JSON.parse(await readStrictText(repositoryRoot, relativePath)),
    );
  } catch {
    return fail();
  }
}

function fixedStringRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, string>> {
  const record = plainRecord(value);
  exactKeys(record, keys);
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, stringValue(record[key])])),
  );
}

function fixedIntegerRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, number>> {
  const record = plainRecord(value);
  exactKeys(record, keys);
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, finiteInteger(record[key])])),
  );
}

function projectBuildContract(
  value: Record<string, unknown>,
): CanonicalRuntimeInputManifest["buildContract"] {
  exactKeys(value, BUILD_CONFIG_KEYS);
  const pathMap = plainRecord(value.pathMap);
  exactKeys(pathMap, ["sourceRoot", "virtualRoot"]);
  const sourceSets = plainRecord(value.sourceSets);
  const production = stringArray(sourceSets.production).map((entry) =>
    normalizeRelativePath(`${NATIVE_ROOT}/${normalizeRelativePath(entry)}`),
  );
  production.sort(ordinalCompare);
  if (
    production.some(
      (entry, index) => index > 0 && entry === production[index - 1],
    )
  ) {
    fail();
  }
  const generated = plainRecord(value.generatedProtocolConstants);
  exactKeys(generated, ["relativePath", "sha256"]);
  const generatedRelativePath = normalizeRelativePath(
    generated.relativePath,
  );
  const generatedSha256 = stringValue(generated.sha256);
  if (!SHA256_PATTERN.test(generatedSha256)) fail();
  const references = [...stringArray(value.references)].sort(ordinalCompare);
  if (
    references.some(
      (entry, index) => index > 0 && entry === references[index - 1],
    )
  ) {
    fail();
  }
  return Object.freeze({
    schemaVersion: finiteInteger(value.schemaVersion),
    targetFramework: stringValue(value.targetFramework),
    configuration: stringValue(value.configuration),
    platform: stringValue(value.platform),
    compilerArguments: stringArray(value.compilerArguments),
    references: Object.freeze(references),
    pathMap: Object.freeze({
      sourceRoot: normalizeRelativePath(pathMap.sourceRoot),
      virtualRoot: stringValue(pathMap.virtualRoot),
    }),
    productionSourcePaths: Object.freeze(production),
    generatedProtocolConstants: Object.freeze({
      relativePath: generatedRelativePath,
      sha256: generatedSha256,
    }),
  });
}

function projectProtocol(
  value: Record<string, unknown>,
): CanonicalRuntimeInputManifest["protocol"] {
  exactKeys(value, PROTOCOL_KEYS);
  const frame = plainRecord(value.frame);
  exactKeys(frame, ["magic", "version", "headerBytes", "maxPayloadBytes"]);
  return Object.freeze({
    schemaVersion: finiteInteger(value.schemaVersion),
    mode: fixedStringRecord(value.mode, ["control", "probe"]),
    frame: Object.freeze({
      magic: stringValue(frame.magic),
      version: finiteInteger(frame.version),
      headerBytes: finiteInteger(frame.headerBytes),
      maxPayloadBytes: finiteInteger(frame.maxPayloadBytes),
    }),
    limits: fixedIntegerRecord(value.limits, [
      "maxStringBytes",
      "maxArgCount",
      "maxNativeCommandLineUtf16UnitsIncludingNul",
    ]),
    messageType: fixedIntegerRecord(value.messageType, [
      "launchConfig",
      "ready",
      "terminate",
      "error",
      "exit",
    ]),
    reason: fixedIntegerRecord(value.reason, [
      "noneOrRootExit",
      "cancelled",
      "timedOut",
      "sessionShutdown",
      "protocolError",
    ]),
    stage: fixedIntegerRecord(value.stage, [
      "protocolInvalid",
      "cancelledBeforeReady",
      "jobCreateFailed",
      "jobConfigFailed",
      "stdioDuplicateFailed",
      "attributeListInitFailed",
      "handleListAttributeFailed",
      "jobListAttributeFailed",
      "commandLineInvalid",
      "createFailed",
      "resumeFailed",
      "terminateJobFailed",
      "queryJobFailed",
      "controlChannelFailed",
      "helperInternal",
      "waitFailed",
    ]),
  });
}

async function collectTextInputs(
  repositoryRoot: string,
  paths: readonly string[],
): Promise<readonly CanonicalTextInput[]> {
  const normalizedPaths = paths.map(normalizeRelativePath).sort(ordinalCompare);
  if (
    normalizedPaths.some(
      (entry, index) => index > 0 && entry === normalizedPaths[index - 1],
    )
  ) {
    fail();
  }
  const values = await Promise.all(
    normalizedPaths.map(async (relativePath) =>
      Object.freeze({
        path: relativePath,
        sha256: sha256(await readStrictText(repositoryRoot, relativePath)),
      }),
    ),
  );
  return Object.freeze(values);
}

async function collectManifest(
  repositoryRoot: string,
): Promise<CanonicalRuntimeInputManifest> {
  const root = path.resolve(repositoryRoot);
  await assertNoReparseExistingPath(root);
  const [buildConfig, protocol] = await Promise.all([
    readJson(root, BUILD_CONFIG_PATH),
    readJson(root, PROTOCOL_PATH),
  ]);
  const buildContract = projectBuildContract(buildConfig);
  const [nativeSources, typescriptWrappers, helper] = await Promise.all([
    collectTextInputs(root, buildContract.productionSourcePaths),
    collectTextInputs(root, CANONICAL_RUNTIME_TYPESCRIPT_WRAPPER_PATHS),
    inspectWindowsJobHelperArtifact(
      resolveRepositoryPath(root, HELPER_ROOT),
    ),
  ]);
  return Object.freeze({
    schemaVersion: 1,
    buildContract,
    protocol: projectProtocol(protocol),
    nativeSources,
    typescriptWrappers,
    helperArtifact: Object.freeze({
      path: HELPER_PATH,
      sha256: helper.sha256,
    }),
  });
}

function canonicalPathArray(value: unknown): readonly string[] {
  const paths = stringArray(value).map(normalizeRelativePath);
  paths.sort(ordinalCompare);
  if (
    paths.some(
      (entry, index) => index > 0 && entry === paths[index - 1],
    )
  ) {
    fail();
  }
  return Object.freeze(paths);
}

function canonicalizeBuildContract(
  value: unknown,
): CanonicalRuntimeInputManifest["buildContract"] {
  const record = plainRecord(value);
  exactKeys(record, [
    "schemaVersion",
    "targetFramework",
    "configuration",
    "platform",
    "compilerArguments",
    "references",
    "pathMap",
    "productionSourcePaths",
    "generatedProtocolConstants",
  ]);
  if (record.schemaVersion !== 1) fail();
  const pathMap = plainRecord(record.pathMap);
  exactKeys(pathMap, ["sourceRoot", "virtualRoot"]);
  const generated = plainRecord(record.generatedProtocolConstants);
  exactKeys(generated, ["relativePath", "sha256"]);
  const generatedSha256 = stringValue(generated.sha256);
  if (!SHA256_PATTERN.test(generatedSha256)) fail();
  const productionSourcePaths = canonicalPathArray(
    record.productionSourcePaths,
  );
  if (
    productionSourcePaths.some(
      (entry) => !entry.startsWith(`${NATIVE_ROOT}/`),
    )
  ) {
    fail();
  }
  return Object.freeze({
    schemaVersion: 1,
    targetFramework: stringValue(record.targetFramework),
    configuration: stringValue(record.configuration),
    platform: stringValue(record.platform),
    compilerArguments: stringArray(record.compilerArguments),
    references: canonicalPathArray(record.references),
    pathMap: Object.freeze({
      sourceRoot: normalizeRelativePath(pathMap.sourceRoot),
      virtualRoot: stringValue(pathMap.virtualRoot),
    }),
    productionSourcePaths,
    generatedProtocolConstants: Object.freeze({
      relativePath: normalizeRelativePath(generated.relativePath),
      sha256: generatedSha256,
    }),
  });
}

function canonicalizeTextInputs(
  value: unknown,
): readonly CanonicalTextInput[] {
  const inputs = strictArray(value).map((candidate) => {
    const record = plainRecord(candidate);
    exactKeys(record, ["path", "sha256"]);
    const digest = stringValue(record.sha256);
    if (!SHA256_PATTERN.test(digest)) fail();
    return Object.freeze({
      path: normalizeRelativePath(record.path),
      sha256: digest,
    });
  });
  inputs.sort((left, right) => ordinalCompare(left.path, right.path));
  if (
    inputs.some(
      (entry, index) => index > 0 && entry.path === inputs[index - 1]?.path,
    )
  ) {
    fail();
  }
  return Object.freeze(inputs);
}

function samePaths(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function canonicalizeManifest(
  value: unknown,
): CanonicalRuntimeInputManifest {
  const record = plainRecord(value);
  exactKeys(record, [
    "schemaVersion",
    "buildContract",
    "protocol",
    "nativeSources",
    "typescriptWrappers",
    "helperArtifact",
  ]);
  if (record.schemaVersion !== 1) fail();
  const buildContract = canonicalizeBuildContract(record.buildContract);
  const protocol = projectProtocol(plainRecord(record.protocol));
  if (protocol.schemaVersion !== 1) fail();
  const nativeSources = canonicalizeTextInputs(record.nativeSources);
  if (
    !samePaths(
      buildContract.productionSourcePaths,
      nativeSources.map((entry) => entry.path),
    )
  ) {
    fail();
  }
  const typescriptWrappers = canonicalizeTextInputs(
    record.typescriptWrappers,
  );
  const expectedWrappers = [...CANONICAL_RUNTIME_TYPESCRIPT_WRAPPER_PATHS]
    .map(normalizeRelativePath)
    .sort(ordinalCompare);
  if (
    !samePaths(
      expectedWrappers,
      typescriptWrappers.map((entry) => entry.path),
    )
  ) {
    fail();
  }
  const helper = plainRecord(record.helperArtifact);
  exactKeys(helper, ["path", "sha256"]);
  const helperSha256 = stringValue(helper.sha256);
  if (
    normalizeRelativePath(helper.path) !== HELPER_PATH ||
    !SHA256_PATTERN.test(helperSha256)
  ) {
    fail();
  }
  return Object.freeze({
    schemaVersion: 1,
    buildContract,
    protocol,
    nativeSources,
    typescriptWrappers,
    helperArtifact: Object.freeze({
      path: HELPER_PATH,
      sha256: helperSha256,
    }),
  });
}

export async function collectCanonicalRuntimeInputManifest(
  repositoryRoot: string,
): Promise<CanonicalRuntimeInputManifest> {
  try {
    return await collectManifest(repositoryRoot);
  } catch {
    return fail();
  }
}

export function serializeCanonicalRuntimeInputManifest(
  manifest: unknown,
): string {
  try {
    return JSON.stringify(canonicalizeManifest(manifest));
  } catch {
    return fail();
  }
}

export function digestCanonicalRuntimeInputManifest(
  manifest: unknown,
): string {
  return sha256(serializeCanonicalRuntimeInputManifest(manifest));
}

export async function collectCanonicalRuntimeInputIdentity(
  repositoryRoot: string,
): Promise<CanonicalRuntimeInputIdentity> {
  const manifest = await collectCanonicalRuntimeInputManifest(repositoryRoot);
  const serialized = serializeCanonicalRuntimeInputManifest(manifest);
  return Object.freeze({
    manifest,
    serialized,
    digestSha256: sha256(serialized),
  });
}
