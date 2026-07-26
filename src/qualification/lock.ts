import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { types as nodeUtilTypes } from "node:util";

import { execa } from "execa";

import type { AgentProcessCounts } from "../runtime/agent-processes.js";
import type {
  QualificationLockHandle,
  QualificationLockOwner,
  QualificationRecoveryReference,
  QualificationTerminalInspection,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const BATCH_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const LOCK_ROOT_NAME = "codex-agent-tools-qualification-locks";
const OWNER_KEYS = [
  "acquiredAt",
  "authorizationReferenceSha256",
  "batchId",
  "nonce",
  "processId",
  "processStartTime",
  "repositoryRealpathSha256",
  "schemaVersion",
] as const;

export interface ProcessIdentity {
  alive: boolean;
  startTime: string | null;
}

export type ProcessIdentityInspector = (
  processId: number,
) => Promise<ProcessIdentity>;

export type ProcessIdentityCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string }>;

export class QualificationLockError extends Error {
  readonly category = "infrastructure";
  readonly stage = "qualification_lock";
  readonly count = 1;

  constructor() {
    super("Qualification lock operation failed");
    this.name = "QualificationLockError";
  }
}

export interface QualificationLockLocation {
  repositoryRealpathSha256: string;
  lockDirectory: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validBatchId(value: string): boolean {
  return (
    BATCH_ID_PATTERN.test(value) &&
    value !== "." &&
    value !== ".." &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value)
  );
}

function validIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function assertSafeDirectory(
  directory: string,
  expectedRealpath?: string,
): Promise<string> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new QualificationLockError();
  }
  const canonical = await realpath(directory);
  if (
    expectedRealpath !== undefined &&
    !samePath(canonical, expectedRealpath)
  ) {
    throw new QualificationLockError();
  }
  return canonical;
}

function assertDirectChild(
  parentDirectory: string,
  childDirectory: string,
  expectedName: string,
): void {
  const relative = path.relative(parentDirectory, childDirectory);
  if (
    relative !== expectedName ||
    relative === "" ||
    path.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".."
  ) {
    throw new QualificationLockError();
  }
}

interface VerifiedLockPath {
  lockRoot: string;
  lockDirectory: string;
}

async function assertSafeLockDirectory(
  lockDirectory: string,
  expectedRepositoryHash?: string,
): Promise<VerifiedLockPath> {
  const resolvedLockDirectory = path.resolve(lockDirectory);
  const repositoryHash = path.basename(resolvedLockDirectory);
  if (
    !SHA256_PATTERN.test(repositoryHash) ||
    (expectedRepositoryHash !== undefined &&
      repositoryHash !== expectedRepositoryHash)
  ) {
    throw new QualificationLockError();
  }
  const lockRoot = path.dirname(resolvedLockDirectory);
  if (path.basename(lockRoot) !== LOCK_ROOT_NAME) {
    throw new QualificationLockError();
  }
  const tempDirectory = path.dirname(lockRoot);
  assertDirectChild(tempDirectory, lockRoot, LOCK_ROOT_NAME);
  assertDirectChild(lockRoot, resolvedLockDirectory, repositoryHash);
  const canonicalTempDirectory = await assertSafeDirectory(tempDirectory);
  const canonicalLockRoot = path.join(canonicalTempDirectory, LOCK_ROOT_NAME);
  await assertSafeDirectory(lockRoot, canonicalLockRoot);
  const canonicalLockDirectory = path.join(canonicalLockRoot, repositoryHash);
  await assertSafeDirectory(resolvedLockDirectory, canonicalLockDirectory);
  return Object.freeze({
    lockRoot: canonicalLockRoot,
    lockDirectory: canonicalLockDirectory,
  });
}

async function ensureSafeLockRoot(lockRoot: string): Promise<void> {
  const resolvedLockRoot = path.resolve(lockRoot);
  const tempDirectory = path.dirname(resolvedLockRoot);
  if (path.basename(resolvedLockRoot) !== LOCK_ROOT_NAME) {
    throw new QualificationLockError();
  }
  assertDirectChild(tempDirectory, resolvedLockRoot, LOCK_ROOT_NAME);
  const canonicalTempDirectory = await assertSafeDirectory(tempDirectory);
  const canonicalLockRoot = path.join(canonicalTempDirectory, LOCK_ROOT_NAME);
  try {
    await mkdir(resolvedLockRoot);
  } catch (error) {
    if (!isErrnoWithCode(error, "EEXIST")) throw error;
  }
  await assertSafeDirectory(tempDirectory, canonicalTempDirectory);
  await assertSafeDirectory(resolvedLockRoot, canonicalLockRoot);
}

function freezeOwner(owner: QualificationLockOwner): QualificationLockOwner {
  return Object.freeze({ ...owner });
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
    throw new QualificationLockError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new QualificationLockError();
    }
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function normalizeOwner(value: unknown): QualificationLockOwner {
  const record = plainRecord(value);
  const keys = Object.keys(record).sort();
  if (
    keys.length !== OWNER_KEYS.length ||
    keys.some((key, index) => key !== OWNER_KEYS[index])
  ) {
    throw new QualificationLockError();
  }
  if (
    record.schemaVersion !== 1 ||
    typeof record.repositoryRealpathSha256 !== "string" ||
    !SHA256_PATTERN.test(record.repositoryRealpathSha256) ||
    typeof record.processId !== "number" ||
    !Number.isSafeInteger(record.processId) ||
    record.processId <= 0 ||
    typeof record.processStartTime !== "string" ||
    !validIsoTimestamp(record.processStartTime) ||
    typeof record.nonce !== "string" ||
    !UUID_PATTERN.test(record.nonce) ||
    typeof record.batchId !== "string" ||
    !validBatchId(record.batchId) ||
    typeof record.authorizationReferenceSha256 !== "string" ||
    !SHA256_PATTERN.test(record.authorizationReferenceSha256) ||
    typeof record.acquiredAt !== "string" ||
    !validIsoTimestamp(record.acquiredAt)
  ) {
    throw new QualificationLockError();
  }
  return freezeOwner(record as unknown as QualificationLockOwner);
}

async function readOwner(
  lockDirectory: string,
): Promise<QualificationLockOwner> {
  let handle;
  try {
    const ownerPath = path.join(lockDirectory, "owner.json");
    const before = await lstat(ownerPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16_384) {
      throw new QualificationLockError();
    }
    handle = await open(ownerPath, "r");
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new QualificationLockError();
    }
    const raw = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < raw.length) {
      const read = await handle.read(raw, offset, raw.length - offset, offset);
      if (read.bytesRead === 0) throw new QualificationLockError();
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new QualificationLockError();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return normalizeOwner(JSON.parse(text) as unknown);
  } catch {
    throw new QualificationLockError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readQualificationLockOwner(
  lockDirectory: string,
): Promise<QualificationLockOwner> {
  try {
    const verified = await assertSafeLockDirectory(lockDirectory);
    const owner = await readOwner(verified.lockDirectory);
    await assertSafeLockDirectory(
      verified.lockDirectory,
      owner.repositoryRealpathSha256,
    );
    return owner;
  } catch {
    throw new QualificationLockError();
  }
}

function ownersEqual(
  left: QualificationLockOwner,
  right: QualificationLockOwner,
): boolean {
  return OWNER_KEYS.every((key) => left[key] === right[key]);
}

export async function qualificationLockLocation(
  repositoryRoot: string,
  tempDirectory = os.tmpdir(),
): Promise<QualificationLockLocation> {
  try {
    const canonicalRepository = await realpath(repositoryRoot);
    const repositoryRealpathSha256 = sha256(canonicalRepository);
    const resolvedTempDirectory = path.resolve(tempDirectory);
    const canonicalTempDirectory = await assertSafeDirectory(
      resolvedTempDirectory,
    );
    const parent = path.join(canonicalTempDirectory, LOCK_ROOT_NAME);
    assertDirectChild(canonicalTempDirectory, parent, LOCK_ROOT_NAME);
    return Object.freeze({
      repositoryRealpathSha256,
      lockDirectory: path.join(parent, repositoryRealpathSha256),
    });
  } catch {
    throw new QualificationLockError();
  }
}

const defaultProcessIdentityCommandRunner: ProcessIdentityCommandRunner =
  async (command, args) => {
    const result = await execa(command, [...args], {
      reject: false,
      timeout: 30_000,
      windowsHide: true,
      ...(command === "ps" ? { env: { LC_ALL: "C" } } : {}),
    });
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout };
  };

export async function inspectProcessIdentityForPlatform(
  processId: number,
  options: {
    platform: NodeJS.Platform;
    commandRunner?: ProcessIdentityCommandRunner;
  },
): Promise<ProcessIdentity> {
  try {
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw new QualificationLockError();
    }
    const commandRunner =
      options.commandRunner ?? defaultProcessIdentityCommandRunner;
    if (options.platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${processId}" -ErrorAction Stop`,
        "if ($null -eq $p) { exit 3 }",
        "$p.CreationDate.ToUniversalTime().ToString('o')",
      ].join("; ");
      const result = await commandRunner("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);
      if (result.exitCode === 3) return { alive: false, startTime: null };
      if (result.exitCode !== 0) throw new QualificationLockError();
      const startTime = new Date(result.stdout.trim()).toISOString();
      return { alive: true, startTime };
    }
    const result = await commandRunner("ps", [
      "-p",
      String(processId),
      "-o",
      "lstart=",
    ]);
    if (result.exitCode === 1) return { alive: false, startTime: null };
    if (result.exitCode !== 0 || result.stdout.trim() === "") {
      throw new QualificationLockError();
    }
    return {
      alive: true,
      startTime: new Date(result.stdout.trim()).toISOString(),
    };
  } catch {
    throw new QualificationLockError();
  }
}

export const inspectProcessIdentity: ProcessIdentityInspector = (processId) =>
  inspectProcessIdentityForPlatform(processId, {
    platform: process.platform,
  });

function normalizeProcessIdentity(value: unknown): ProcessIdentity {
  const record = plainRecord(value);
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "alive" || keys[1] !== "startTime") {
    throw new QualificationLockError();
  }
  if (record.alive === false && record.startTime === null) {
    return Object.freeze({ alive: false, startTime: null });
  }
  if (
    record.alive === true &&
    typeof record.startTime === "string" &&
    validIsoTimestamp(record.startTime)
  ) {
    return Object.freeze({ alive: true, startTime: record.startTime });
  }
  throw new QualificationLockError();
}

export interface AcquireQualificationLockOptions {
  repositoryRoot: string;
  batchId: string;
  authorizationReferenceSha256: string;
  tempDirectory?: string;
  processId?: number;
  processIdentityInspector?: ProcessIdentityInspector;
  nonce?: string;
  now?: () => Date;
  writeOwner?: (filePath: string, contents: string) => Promise<void>;
}

export async function acquireQualificationLock(
  options: AcquireQualificationLockOptions,
): Promise<QualificationLockHandle> {
  let createdLockDirectory: string | null = null;
  let expectedOwner: QualificationLockOwner | null = null;
  try {
    if (
      !validBatchId(options.batchId) ||
      !SHA256_PATTERN.test(options.authorizationReferenceSha256)
    ) {
      throw new QualificationLockError();
    }
    const location = await qualificationLockLocation(
      options.repositoryRoot,
      options.tempDirectory,
    );
    const processId = options.processId ?? process.pid;
    const identity = normalizeProcessIdentity(
      await (options.processIdentityInspector ?? inspectProcessIdentity)(
        processId,
      ),
    );
    if (
      identity.alive !== true ||
      identity.startTime === null ||
      !validIsoTimestamp(identity.startTime)
    ) {
      throw new QualificationLockError();
    }
    const nonce = options.nonce ?? randomUUID();
    const acquiredAt = (options.now ?? (() => new Date()))().toISOString();
    const owner = normalizeOwner({
      schemaVersion: 1,
      repositoryRealpathSha256: location.repositoryRealpathSha256,
      processId,
      processStartTime: identity.startTime,
      nonce,
      batchId: options.batchId,
      authorizationReferenceSha256: options.authorizationReferenceSha256,
      acquiredAt,
    });
    expectedOwner = owner;
    await ensureSafeLockRoot(path.dirname(location.lockDirectory));
    await mkdir(location.lockDirectory);
    createdLockDirectory = location.lockDirectory;
    await assertSafeLockDirectory(
      location.lockDirectory,
      location.repositoryRealpathSha256,
    );
    const ownerPath = path.join(location.lockDirectory, "owner.json");
    const ownerContents = `${JSON.stringify(owner, null, 2)}\n`;
    await assertSafeLockDirectory(
      location.lockDirectory,
      location.repositoryRealpathSha256,
    );
    if (options.writeOwner === undefined) {
      await writeFile(ownerPath, ownerContents, {
        encoding: "utf8",
        flag: "wx",
      });
    } else {
      await options.writeOwner(ownerPath, ownerContents);
    }
    await assertSafeLockDirectory(
      location.lockDirectory,
      location.repositoryRealpathSha256,
    );
    const persistedOwner = await readOwner(location.lockDirectory);
    if (!ownersEqual(persistedOwner, owner)) {
      throw new QualificationLockError();
    }
    await assertSafeLockDirectory(
      location.lockDirectory,
      location.repositoryRealpathSha256,
    );
    return Object.freeze({
      lockDirectory: location.lockDirectory,
      owner,
    });
  } catch {
    if (createdLockDirectory !== null) {
      try {
        await assertSafeLockDirectory(
          createdLockDirectory,
          expectedOwner?.repositoryRealpathSha256,
        );
        const entries = await readdir(createdLockDirectory, {
          withFileTypes: true,
        });
        if (entries.length === 0) {
          await rmdir(createdLockDirectory);
        } else if (
          expectedOwner !== null &&
          entries.length === 1 &&
          entries[0]?.name === "owner.json" &&
          entries[0].isFile()
        ) {
          const persistedOwner = await readOwner(createdLockDirectory);
          if (ownersEqual(persistedOwner, expectedOwner)) {
            await rm(path.join(createdLockDirectory, "owner.json"));
            await rmdir(createdLockDirectory);
          }
        }
      } catch {
        // Unknown or replaced owner state is deliberately left fail closed.
      }
    }
    throw new QualificationLockError();
  }
}

function validateLockDirectory(
  lockDirectory: string,
  owner: QualificationLockOwner,
): void {
  const resolved = path.resolve(lockDirectory);
  if (
    path.basename(resolved) !== owner.repositoryRealpathSha256 ||
    path.basename(path.dirname(resolved)) !== LOCK_ROOT_NAME
  ) {
    throw new QualificationLockError();
  }
}

async function assertOwnerOnly(lockDirectory: string): Promise<void> {
  const entries = await readdir(lockDirectory, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0]?.name !== "owner.json" ||
    !entries[0].isFile()
  ) {
    throw new QualificationLockError();
  }
}

async function releaseExactOwner(
  handle: QualificationLockHandle,
  operations: QualificationLockReleaseOperations = defaultQualificationLockReleaseOperations,
): Promise<void> {
  const expected = normalizeOwner(handle.owner);
  validateLockDirectory(handle.lockDirectory, expected);
  let verified = await assertSafeLockDirectory(
    handle.lockDirectory,
    expected.repositoryRealpathSha256,
  );
  await assertOwnerOnly(verified.lockDirectory);
  const current = await readOwner(verified.lockDirectory);
  if (!ownersEqual(current, expected)) throw new QualificationLockError();
  verified = await assertSafeLockDirectory(
    verified.lockDirectory,
    expected.repositoryRealpathSha256,
  );
  await assertOwnerOnly(verified.lockDirectory);
  const rechecked = await readOwner(verified.lockDirectory);
  if (!ownersEqual(rechecked, expected)) throw new QualificationLockError();
  verified = await assertSafeLockDirectory(
    verified.lockDirectory,
    expected.repositoryRealpathSha256,
  );
  const retiredDirectory = path.join(
    verified.lockRoot,
    `.${expected.repositoryRealpathSha256}.release.${expected.nonce}`,
  );
  assertDirectChild(
    verified.lockRoot,
    retiredDirectory,
    path.basename(retiredDirectory),
  );
  try {
    await lstat(retiredDirectory);
    throw new QualificationLockError();
  } catch (error) {
    if (!isErrnoWithCode(error, "ENOENT")) throw error;
  }
  await assertSafeDirectory(verified.lockRoot, verified.lockRoot);
  await assertSafeLockDirectory(
    verified.lockDirectory,
    expected.repositoryRealpathSha256,
  );
  await operations.renameDirectory(verified.lockDirectory, retiredDirectory);
  await operations
    .removeOwner(path.join(retiredDirectory, "owner.json"))
    .catch(() => undefined);
  await operations.removeDirectory(retiredDirectory).catch(() => undefined);
}

export interface QualificationLockReleaseOperations {
  renameDirectory(source: string, destination: string): Promise<void>;
  removeOwner(ownerPath: string): Promise<void>;
  removeDirectory(directory: string): Promise<void>;
}

export const defaultQualificationLockReleaseOperations: QualificationLockReleaseOperations =
  Object.freeze({
    renameDirectory: rename,
    removeOwner: async (ownerPath: string) => rm(ownerPath),
    removeDirectory: rmdir,
  });

export async function releaseQualificationLock(
  handle: QualificationLockHandle,
  operations?: QualificationLockReleaseOperations,
): Promise<void> {
  try {
    await releaseExactOwner(handle, operations);
  } catch {
    throw new QualificationLockError();
  }
}

function targetsAreZero(counts: AgentProcessCounts): boolean {
  const record = plainRecord(counts);
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "kimi" ||
    keys[1] !== "piRpc" ||
    keys[2] !== "realSmoke"
  ) {
    throw new QualificationLockError();
  }
  const countOf = (value: unknown): number => {
    const countRecord = plainRecord(value);
    if (
      Object.keys(countRecord).length !== 1 ||
      typeof countRecord.count !== "number" ||
      !Number.isSafeInteger(countRecord.count) ||
      countRecord.count < 0
    ) {
      throw new QualificationLockError();
    }
    return countRecord.count;
  };
  return (
    countOf(record.kimi) === 0 &&
    countOf(record.piRpc) === 0 &&
    countOf(record.realSmoke) === 0
  );
}

function normalizeTerminalInspection(
  value: unknown,
): QualificationTerminalInspection {
  const record = plainRecord(value);
  const keys = Object.keys(record).sort();
  if (keys.length === 1 && keys[0] === "state" && record.state === "missing") {
    return Object.freeze({ state: "missing" });
  }
  if (
    keys.length === 3 &&
    keys[0] === "authorizationReferenceSha256" &&
    keys[1] === "batchId" &&
    keys[2] === "state" &&
    record.state === "valid" &&
    typeof record.batchId === "string" &&
    validBatchId(record.batchId) &&
    typeof record.authorizationReferenceSha256 === "string" &&
    SHA256_PATTERN.test(record.authorizationReferenceSha256)
  ) {
    return Object.freeze({
      state: "valid",
      batchId: record.batchId,
      authorizationReferenceSha256: record.authorizationReferenceSha256,
    });
  }
  throw new QualificationLockError();
}

function terminalMatchesOwner(
  inspection: QualificationTerminalInspection,
  owner: QualificationLockOwner,
): boolean {
  return (
    inspection.state === "valid" &&
    inspection.batchId === owner.batchId &&
    inspection.authorizationReferenceSha256 ===
      owner.authorizationReferenceSha256
  );
}

export interface RecoverQualificationLockOptions {
  repositoryRoot: string;
  batchId: string;
  tempDirectory?: string;
  processIdentityInspector?: ProcessIdentityInspector;
  inspectTargetProcesses: () => Promise<AgentProcessCounts>;
  inspectTerminalManifest: (
    batchId: string,
  ) => Promise<QualificationTerminalInspection>;
  publishInterruptedManifest: (
    reference: QualificationRecoveryReference,
  ) => Promise<void>;
}

export async function recoverQualificationLock(
  options: RecoverQualificationLockOptions,
): Promise<void> {
  try {
    if (!validBatchId(options.batchId)) throw new QualificationLockError();
    const location = await qualificationLockLocation(
      options.repositoryRoot,
      options.tempDirectory,
    );
    let verified = await assertSafeLockDirectory(
      location.lockDirectory,
      location.repositoryRealpathSha256,
    );
    const owner = await readOwner(verified.lockDirectory);
    verified = await assertSafeLockDirectory(
      verified.lockDirectory,
      location.repositoryRealpathSha256,
    );
    if (
      owner.repositoryRealpathSha256 !== location.repositoryRealpathSha256 ||
      owner.batchId !== options.batchId
    ) {
      throw new QualificationLockError();
    }
    const identity = normalizeProcessIdentity(
      await (options.processIdentityInspector ?? inspectProcessIdentity)(
        owner.processId,
      ),
    );
    if (
      identity.alive === true &&
      identity.startTime === owner.processStartTime
    ) {
      throw new QualificationLockError();
    }
    const counts = await options.inspectTargetProcesses();
    if (!targetsAreZero(counts)) throw new QualificationLockError();

    const terminal = normalizeTerminalInspection(
      await options.inspectTerminalManifest(owner.batchId),
    );
    if (terminal.state === "missing") {
      await options.publishInterruptedManifest({
        batchId: owner.batchId,
        authorizationReferenceSha256: owner.authorizationReferenceSha256,
      });
      const published = normalizeTerminalInspection(
        await options.inspectTerminalManifest(owner.batchId),
      );
      if (!terminalMatchesOwner(published, owner)) {
        throw new QualificationLockError();
      }
    } else if (!terminalMatchesOwner(terminal, owner)) {
      throw new QualificationLockError();
    }

    verified = await assertSafeLockDirectory(
      verified.lockDirectory,
      owner.repositoryRealpathSha256,
    );
    const unchanged = await readOwner(verified.lockDirectory);
    if (!ownersEqual(owner, unchanged)) throw new QualificationLockError();
    await releaseExactOwner({
      lockDirectory: verified.lockDirectory,
      owner,
    });
  } catch {
    throw new QualificationLockError();
  }
}
