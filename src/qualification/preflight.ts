import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import { locateKimi } from "../adapters/kimi/locator.js";
import { buildIsolatedPiConfig } from "../adapters/pi/config.js";
import {
  locatePi,
  locatePiInvocation,
  type PiInvocation,
} from "../adapters/pi/locator.js";
import { resolveLlm } from "../llms/registry.js";
import { VERSION } from "../version.js";
import {
  assertAuthorizationReferenceUnused,
  freezePreflightRecord,
} from "./manifest.js";
import { ACTIVE_QUALIFICATION_PLAN_ID } from "./protocol.js";
import type {
  BuildArtifactIdentity,
  CurrentFrozenPreflightRecord,
  FrozenCredentialMatch,
  FrozenLogicalLlmIdentity,
  FrozenPreflightRecord,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const BATCH_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;

export const QUALIFICATION_BUILD_ARTIFACT_PATHS = Object.freeze([
  "dist/ark-smoke.js",
  "dist/kimi-smoke.js",
  "dist/smoke-evidence.js",
  "plugins/codex-external-agents/runtime/codex-external-agents-mcp.mjs",
] as const);
const CURRENT_QUALIFICATION_LLM_IDS = Object.freeze([
  "ark-agent-deepseek-v4-flash",
  "ark-agent-plan",
  "ark-coding-plan",
  "kimi-k3",
] as const);
export const QUALIFICATION_MAX_BUILD_ARTIFACT_BYTES = 32 * 1_048_576;

export type QualificationPreflightStage =
  | "input"
  | "repository_initial"
  | "package"
  | "build_initial"
  | "runtime_versions"
  | "locators"
  | "pi_config"
  | "credentials"
  | "authorization"
  | "typecheck"
  | "test"
  | "build"
  | "release_smoke"
  | "isolated_acceptance"
  | "diff_check"
  | "repository_final"
  | "build_final"
  | "frozen_candidate"
  | "current_snapshot"
  | "record";

export class QualificationPreflightError extends Error {
  readonly category = "infrastructure";
  readonly count: number;
  readonly stage: QualificationPreflightStage;

  constructor(stage: QualificationPreflightStage, count = 1) {
    super("Qualification preflight failed");
    this.name = "QualificationPreflightError";
    this.stage = stage;
    this.count = Number.isSafeInteger(count) && count > 0 ? count : 1;
  }
}

export interface QualificationPreflightCommandRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  captureStdout: boolean;
}

export interface QualificationPreflightCommandResult {
  exitCode: number;
  stdout: string;
}

export type QualificationPreflightCommandRunner = (
  request: QualificationPreflightCommandRequest,
) => Promise<QualificationPreflightCommandResult>;

export interface QualificationPreflightOptions {
  repositoryRoot: string;
  authorizationReferenceSha256: string;
  lockDirectory: string;
  currentOwnerNonce: string;
}

export interface QualificationPreflightDependencies {
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  runCommand?: QualificationPreflightCommandRunner;
  locateKimiExecutable?: () => Promise<string>;
  locatePiInvocation?: () => Promise<PiInvocation>;
  locatePosixPiExecutable?: () => Promise<string>;
  createTemporaryCodexHome?: () => Promise<string>;
  removeTemporaryCodexHome?: (directory: string) => Promise<void>;
  buildQualificationPiConfig?: () => Promise<{
    contentSha256: string;
  }>;
  assertAuthorizationUnused?: (options: {
    repositoryRoot: string;
    authorizationReferenceSha256: string;
    lockDirectory: string;
    currentOwnerNonce: string;
  }) => Promise<void>;
}

export interface QualificationBuildIdentity {
  buildArtifacts: readonly BuildArtifactIdentity[];
  buildIdentitySha256: string;
}

export interface QualificationCurrentSnapshot {
  repositoryCommit: string;
  packageVersion: string;
  packageLockSha256: string;
  buildArtifacts: readonly BuildArtifactIdentity[];
  buildIdentitySha256: string;
  runtimeVersions: Readonly<{
    node: string;
    codex: string;
  }>;
  piConfigSha256: string;
  logicalLlms: readonly FrozenLogicalLlmIdentity[];
  credentialMatches: readonly FrozenCredentialMatch[];
}

interface RepositorySnapshot {
  commit: string;
  branch: string;
}

interface StableRepositoryFile {
  bytes: Buffer | null;
  sha256: string;
}

interface DeterministicCommand {
  stage: Extract<
    QualificationPreflightStage,
    | "typecheck"
    | "test"
    | "build"
    | "release_smoke"
    | "isolated_acceptance"
    | "diff_check"
  >;
  command: string;
  args: readonly string[];
}

const DETERMINISTIC_COMMANDS: readonly DeterministicCommand[] = Object.freeze([
  Object.freeze({
    stage: "build" as const,
    command: "npm",
    args: Object.freeze(["run", "build"]),
  }),
  Object.freeze({
    stage: "typecheck" as const,
    command: "npm",
    args: Object.freeze(["run", "typecheck"]),
  }),
  Object.freeze({
    stage: "test" as const,
    command: "npm",
    args: Object.freeze(["run", "test:deterministic"]),
  }),
  Object.freeze({
    stage: "release_smoke" as const,
    command: "npm",
    args: Object.freeze(["run", "smoke:release:built"]),
  }),
  Object.freeze({
    stage: "isolated_acceptance" as const,
    command: process.execPath,
    args: Object.freeze([
      "scripts/plugin-isolated-acceptance.mjs",
      "--check-report",
    ]),
  }),
  Object.freeze({
    stage: "diff_check" as const,
    command: "git",
    args: Object.freeze(["diff", "--check"]),
  }),
]);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    !path.win32.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

async function validateStableRepositoryPathChain(
  repositoryRoot: string,
  filePath: string,
): Promise<{ canonicalRoot: string; canonicalFile: string }> {
  const resolvedRoot = path.resolve(repositoryRoot);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (
    !isContainedPath(resolvedRoot, resolvedFile) ||
    path.isAbsolute(relative) ||
    path.win32.isAbsolute(relative)
  ) {
    throw new Error("outside repository");
  }
  const rootStat = await lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("unsafe repository root");
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const segments = relative.split(path.sep);
  let current = resolvedRoot;
  let canonicalParent = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("unsafe repository ancestor");
    }
    const canonicalCurrent = await realpath(current);
    if (!samePath(canonicalCurrent, path.join(canonicalParent, segment))) {
      throw new Error("repository ancestor changed");
    }
    canonicalParent = canonicalCurrent;
  }
  const fileStat = await lstat(resolvedFile);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("not a regular file");
  }
  const canonicalFile = await realpath(resolvedFile);
  if (!samePath(canonicalFile, path.join(canonicalParent, segments.at(-1)!))) {
    throw new Error("repository file changed");
  }
  return Object.freeze({ canonicalRoot, canonicalFile });
}

async function readStableRepositoryFile(
  repositoryRoot: string,
  relativePath: string,
  options: {
    retainBytes?: boolean;
    maximumBytes?: number;
  } = {},
): Promise<StableRepositoryFile> {
  let handle;
  try {
    const resolvedRoot = path.resolve(repositoryRoot);
    const resolvedFile = path.resolve(
      resolvedRoot,
      ...relativePath.replaceAll("\\", "/").split("/"),
    );
    if (!isContainedPath(resolvedRoot, resolvedFile)) {
      throw new Error("outside repository");
    }
    const initialPath = await validateStableRepositoryPathChain(
      resolvedRoot,
      resolvedFile,
    );
    const before = await lstat(resolvedFile);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    handle = await open(resolvedFile, "r");
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      (options.maximumBytes !== undefined && opened.size > options.maximumBytes)
    ) {
      throw new Error("file identity changed");
    }
    const digest = createHash("sha256");
    const bytes =
      options.retainBytes === true ? Buffer.alloc(opened.size) : null;
    const chunk = Buffer.alloc(Math.min(65_536, Math.max(opened.size, 1)));
    let offset = 0;
    while (offset < opened.size) {
      const result = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, opened.size - offset),
        offset,
      );
      if (result.bytesRead === 0) throw new Error("unexpected short read");
      const current = chunk.subarray(0, result.bytesRead);
      digest.update(current);
      if (bytes !== null) current.copy(bytes, offset);
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const finalPath = await lstat(resolvedFile);
    const finalCanonicalPath = await validateStableRepositoryPathChain(
      resolvedRoot,
      resolvedFile,
    );
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      finalPath.dev !== opened.dev ||
      finalPath.ino !== opened.ino ||
      finalPath.size !== opened.size ||
      finalPath.isSymbolicLink() ||
      !samePath(finalCanonicalPath.canonicalRoot, initialPath.canonicalRoot) ||
      !samePath(finalCanonicalPath.canonicalFile, initialPath.canonicalFile)
    ) {
      throw new Error("file changed while reading");
    }
    return Object.freeze({
      bytes,
      sha256: digest.digest("hex"),
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizeBuildArtifacts(
  artifacts: readonly BuildArtifactIdentity[],
): readonly BuildArtifactIdentity[] {
  if (
    artifacts.length !== QUALIFICATION_BUILD_ARTIFACT_PATHS.length ||
    artifacts.some(
      (artifact, index) =>
        artifact.path !== QUALIFICATION_BUILD_ARTIFACT_PATHS[index] ||
        !SHA256_PATTERN.test(artifact.sha256),
    )
  ) {
    throw new QualificationPreflightError("build_initial");
  }
  return Object.freeze(
    artifacts.map((artifact) =>
      Object.freeze({ path: artifact.path, sha256: artifact.sha256 }),
    ),
  );
}

export function computeQualificationBuildIdentitySha256(
  artifacts: readonly BuildArtifactIdentity[],
): string {
  const normalized = normalizeBuildArtifacts(artifacts);
  return sha256(JSON.stringify(normalized));
}

export async function collectQualificationBuildIdentity(
  repositoryRoot: string,
): Promise<QualificationBuildIdentity> {
  try {
    const artifacts: BuildArtifactIdentity[] = [];
    for (const relativePath of QUALIFICATION_BUILD_ARTIFACT_PATHS) {
      const file = await readStableRepositoryFile(
        repositoryRoot,
        relativePath,
        { maximumBytes: QUALIFICATION_MAX_BUILD_ARTIFACT_BYTES },
      );
      artifacts.push(
        Object.freeze({ path: relativePath, sha256: file.sha256 }),
      );
    }
    const buildArtifacts = normalizeBuildArtifacts(artifacts);
    return Object.freeze({
      buildArtifacts,
      buildIdentitySha256:
        computeQualificationBuildIdentitySha256(buildArtifacts),
    });
  } catch (error) {
    if (error instanceof QualificationPreflightError) throw error;
    throw new QualificationPreflightError("build_initial");
  }
}

const defaultCommandRunner: QualificationPreflightCommandRunner = async (
  request,
) => {
  const result = await execa(request.command, [...request.args], {
    cwd: request.cwd,
    env: request.environment,
    reject: false,
    timeout: 30 * 60_000,
    windowsHide: true,
    ...(request.captureStdout
      ? { stdout: "pipe" as const }
      : { stdout: "ignore" as const }),
    stderr: "ignore",
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout:
      request.captureStdout && typeof result.stdout === "string"
        ? result.stdout
        : "",
  };
};

async function defaultTemporaryCodexHome(): Promise<string> {
  return mkdtemp(
    path.join(os.tmpdir(), "codex-agent-tools-qualification-codex-home-"),
  );
}

async function defaultRemoveTemporaryCodexHome(
  directory: string,
): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

async function inStage<T>(
  stage: QualificationPreflightStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof QualificationPreflightError) throw error;
    throw new QualificationPreflightError(stage);
  }
}

function safeSingleLine(
  value: string,
  stage: QualificationPreflightStage,
  maximum = 128,
): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new QualificationPreflightError(stage);
  }
  return normalized;
}

function safeRuntimeVersion(value: string): string {
  const normalized = safeSingleLine(value, "runtime_versions", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+ ()-]{0,127}$/u.test(normalized)) {
    throw new QualificationPreflightError("runtime_versions");
  }
  return normalized;
}

async function runCheckedCommand(
  runner: QualificationPreflightCommandRunner,
  request: QualificationPreflightCommandRequest,
  stage: QualificationPreflightStage,
): Promise<string> {
  return inStage(stage, async () => {
    const result = await runner(request);
    if (
      !Number.isSafeInteger(result.exitCode) ||
      result.exitCode !== 0 ||
      typeof result.stdout !== "string"
    ) {
      throw new QualificationPreflightError(stage);
    }
    return result.stdout;
  });
}

async function captureRepository(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  runner: QualificationPreflightCommandRunner,
  stage: "repository_initial" | "repository_final",
  includeBranch: boolean,
): Promise<RepositorySnapshot> {
  return inStage(stage, async () => {
    const request = (
      command: string,
      args: readonly string[],
    ): QualificationPreflightCommandRequest => ({
      command,
      args,
      cwd: repositoryRoot,
      environment,
      captureStdout: true,
    });
    const status = await runCheckedCommand(
      runner,
      request("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
      stage,
    );
    if (status !== "") throw new QualificationPreflightError(stage);
    const commit = safeSingleLine(
      await runCheckedCommand(
        runner,
        request("git", ["rev-parse", "HEAD"]),
        stage,
      ),
      stage,
      40,
    );
    if (!COMMIT_PATTERN.test(commit)) {
      throw new QualificationPreflightError(stage);
    }
    const branch = includeBranch
      ? safeSingleLine(
          await runCheckedCommand(
            runner,
            request("git", ["branch", "--show-current"]),
            stage,
          ),
          stage,
          256,
        )
      : "";
    return Object.freeze({ commit, branch });
  });
}

async function readPackageIdentity(repositoryRoot: string): Promise<{
  packageVersion: string;
  packageLockSha256: string;
}> {
  return inStage("package", async () => {
    const [packageFile, packageLock] = await Promise.all([
      readStableRepositoryFile(repositoryRoot, "package.json", {
        retainBytes: true,
        maximumBytes: 1_048_576,
      }),
      readStableRepositoryFile(repositoryRoot, "package-lock.json", {
        maximumBytes: 64 * 1_048_576,
      }),
    ]);
    if (packageFile.bytes === null) {
      throw new QualificationPreflightError("package");
    }
    const packageText = new TextDecoder("utf-8", { fatal: true }).decode(
      packageFile.bytes,
    );
    const parsed: unknown = JSON.parse(packageText);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { version?: unknown }).version !== "string"
    ) {
      throw new QualificationPreflightError("package");
    }
    const packageVersion = safeSingleLine(
      (parsed as { version: string }).version,
      "package",
      128,
    );
    if (packageVersion !== VERSION) {
      throw new QualificationPreflightError("package");
    }
    return Object.freeze({
      packageVersion,
      packageLockSha256: packageLock.sha256,
    });
  });
}

async function collectRuntimeVersions(options: {
  repositoryRoot: string;
  environment: NodeJS.ProcessEnv;
  nodeVersion: string;
  runner: QualificationPreflightCommandRunner;
  createTemporaryCodexHome: () => Promise<string>;
  removeTemporaryCodexHome: (directory: string) => Promise<void>;
}): Promise<{
  node: string;
  codex: string;
}> {
  return inStage("runtime_versions", async () => {
    const node = safeRuntimeVersion(options.nodeVersion);
    const temporaryCodexHome = await options.createTemporaryCodexHome();
    let codexOutput: string;
    try {
      const resolvedRepository = path.resolve(options.repositoryRoot);
      const resolvedTemporaryHome = path.resolve(temporaryCodexHome);
      if (
        temporaryCodexHome.trim() === "" ||
        !path.isAbsolute(temporaryCodexHome) ||
        samePath(resolvedTemporaryHome, resolvedRepository) ||
        isContainedPath(resolvedRepository, resolvedTemporaryHome) ||
        (options.environment.CODEX_HOME !== undefined &&
          samePath(resolvedTemporaryHome, options.environment.CODEX_HOME))
      ) {
        throw new QualificationPreflightError("runtime_versions");
      }
      codexOutput = await runCheckedCommand(
        options.runner,
        {
          command: options.environment.CODEX_COMMAND?.trim() || "codex",
          args: ["--version"],
          cwd: options.repositoryRoot,
          environment: {
            ...options.environment,
            CODEX_HOME: temporaryCodexHome,
          },
          captureStdout: true,
        },
        "runtime_versions",
      );
    } finally {
      await inStage("runtime_versions", () =>
        options.removeTemporaryCodexHome(temporaryCodexHome),
      );
    }
    return Object.freeze({
      node,
      codex: safeRuntimeVersion(codexOutput),
    });
  });
}

function exactFrozenRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.isFrozen(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function assertWindowsPiInvocation(value: unknown): void {
  if (!exactFrozenRecord(value, ["argvPrefix", "executable", "identity"])) {
    throw new QualificationPreflightError("locators");
  }
  const executable = safeSingleLine(value.executable as string, "locators", 32_768);
  const argvPrefix = value.argvPrefix;
  const identity = value.identity;
  if (
    executable !== process.execPath ||
    !Array.isArray(argvPrefix) ||
    !Object.isFrozen(argvPrefix) ||
    argvPrefix.length !== 1 ||
    typeof argvPrefix[0] !== "string" ||
    !path.win32.isAbsolute(safeSingleLine(argvPrefix[0], "locators", 32_768)) ||
    !exactFrozenRecord(identity, [
      "nodeEngine",
      "packageName",
      "packageVersion",
    ]) ||
    identity.packageName !== "@earendil-works/pi-coding-agent" ||
    typeof identity.packageVersion !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(
      identity.packageVersion,
    ) ||
    typeof identity.nodeEngine !== "string" ||
    !/^>=(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(
      identity.nodeEngine,
    )
  ) {
    throw new QualificationPreflightError("locators");
  }
}

async function assertStaticLocators(options: {
  platform: NodeJS.Platform;
  locateKimiExecutable: () => Promise<string>;
  locatePiInvocation: () => Promise<PiInvocation>;
  locatePosixPiExecutable: () => Promise<string>;
}): Promise<void> {
  await inStage("locators", async () => {
    const [kimiExecutable, piLaunch] = await Promise.all([
      options.locateKimiExecutable(),
      options.platform === "win32"
        ? options.locatePiInvocation()
        : options.locatePosixPiExecutable(),
    ]);
    safeSingleLine(kimiExecutable, "locators", 32_768);
    if (options.platform === "win32") {
      assertWindowsPiInvocation(piLaunch);
    } else {
      safeSingleLine(piLaunch as string, "locators", 32_768);
    }
  });
}

function selectedCredentialName(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): string | null {
  for (const name of names) {
    const match = Object.entries(environment).find(
      ([candidate, value]) =>
        candidate.toUpperCase() === name.toUpperCase() &&
        typeof value === "string" &&
        value.trim() !== "",
    );
    if (match !== undefined) return name;
  }
  return null;
}

function collectFixedIdentities(environment: NodeJS.ProcessEnv): {
  logicalLlms: readonly FrozenLogicalLlmIdentity[];
  credentialMatches: readonly FrozenCredentialMatch[];
} {
  const logicalLlms: FrozenLogicalLlmIdentity[] = [];
  const credentialMatches: FrozenCredentialMatch[] = [];
  let missingCredentials = 0;
  for (const llm of CURRENT_QUALIFICATION_LLM_IDS) {
    const profile = resolveLlm(llm);
    logicalLlms.push(
      Object.freeze({
        llm,
        runtime: profile.runtime,
        model: profile.model,
        provider: profile.provider ?? null,
        route: profile.network,
      }),
    );
    const environmentVariableName =
      profile.credentialEnv.length === 0
        ? null
        : selectedCredentialName(profile.credentialEnv, environment);
    if (profile.credentialEnv.length > 0 && environmentVariableName === null) {
      missingCredentials += 1;
    }
    credentialMatches.push(Object.freeze({ llm, environmentVariableName }));
  }
  if (missingCredentials > 0) {
    throw new QualificationPreflightError("credentials", missingCredentials);
  }
  return Object.freeze({
    logicalLlms: Object.freeze(logicalLlms),
    credentialMatches: Object.freeze(credentialMatches),
  });
}

function sameBuildIdentity(
  left: QualificationBuildIdentity,
  right: QualificationBuildIdentity,
): boolean {
  return (
    left.buildIdentitySha256 === right.buildIdentitySha256 &&
    JSON.stringify(left.buildArtifacts) === JSON.stringify(right.buildArtifacts)
  );
}

function validateInput(options: QualificationPreflightOptions): void {
  if (
    typeof options.repositoryRoot !== "string" ||
    options.repositoryRoot.trim() === "" ||
    typeof options.authorizationReferenceSha256 !== "string" ||
    !SHA256_PATTERN.test(options.authorizationReferenceSha256) ||
    typeof options.lockDirectory !== "string" ||
    options.lockDirectory.trim() === "" ||
    !path.isAbsolute(options.lockDirectory) ||
    typeof options.currentOwnerNonce !== "string" ||
    !UUID_PATTERN.test(options.currentOwnerNonce)
  ) {
    throw new QualificationPreflightError("input");
  }
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

async function collectQualificationPiConfigSha256(
  dependencies: QualificationPreflightDependencies,
): Promise<string> {
  return inStage("pi_config", async () => {
    const config = await (
      dependencies.buildQualificationPiConfig ??
      (() =>
        buildIsolatedPiConfig({
          version: VERSION,
          providers: ["ark"],
          qualification: true,
        }))
    )();
    if (!SHA256_PATTERN.test(config.contentSha256)) {
      throw new QualificationPreflightError("pi_config");
    }
    return config.contentSha256;
  });
}

function validAllowedBatchStatus(status: string, batchId: string): boolean {
  if (status === "") return true;
  const allowedPrefix = `docs/smoke/evidence/batches/${batchId}/`;
  const lines = status.split(/\r?\n/u).filter((line) => line !== "");
  if (lines.length === 0) return false;
  return lines.every((line) => {
    if (!line.startsWith("?? ")) return false;
    const relativePath = line.slice(3).replaceAll("\\", "/");
    if (!relativePath.startsWith(allowedPrefix)) return false;
    const remainder = relativePath.slice(allowedPrefix.length);
    return (
      remainder.length > 0 &&
      remainder
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        )
    );
  });
}

export async function assertQualificationFrozenCandidate(
  options: {
    repositoryRoot: string;
    batchId: string;
    preflight: FrozenPreflightRecord;
  },
  dependencies: QualificationPreflightDependencies = {},
): Promise<void> {
  return inStage("frozen_candidate", async () => {
    if (
      typeof options.repositoryRoot !== "string" ||
      options.repositoryRoot.trim() === "" ||
      typeof options.batchId !== "string" ||
      !validBatchId(options.batchId)
    ) {
      throw new QualificationPreflightError("frozen_candidate");
    }
    const preflight = freezePreflightRecord(options.preflight);
    const repositoryRoot = path.resolve(options.repositoryRoot);
    const environment = dependencies.environment ?? process.env;
    const runner = dependencies.runCommand ?? defaultCommandRunner;
    const request = (
      args: readonly string[],
    ): QualificationPreflightCommandRequest => ({
      command: "git",
      args,
      cwd: repositoryRoot,
      environment,
      captureStdout: true,
    });
    const status = await runCheckedCommand(
      runner,
      request(["status", "--porcelain=v1", "--untracked-files=all"]),
      "frozen_candidate",
    );
    if (!validAllowedBatchStatus(status, options.batchId)) {
      throw new QualificationPreflightError("frozen_candidate");
    }
    const commit = safeSingleLine(
      await runCheckedCommand(
        runner,
        request(["rev-parse", "HEAD"]),
        "frozen_candidate",
      ),
      "frozen_candidate",
      40,
    );
    if (!COMMIT_PATTERN.test(commit) || commit !== preflight.repositoryCommit) {
      throw new QualificationPreflightError("frozen_candidate");
    }
    let currentBuild: QualificationBuildIdentity;
    try {
      currentBuild = await collectQualificationBuildIdentity(repositoryRoot);
    } catch {
      throw new QualificationPreflightError("frozen_candidate");
    }
    if (
      currentBuild.buildIdentitySha256 !== preflight.buildIdentitySha256 ||
      JSON.stringify(currentBuild.buildArtifacts) !==
        JSON.stringify(preflight.buildArtifacts)
    ) {
      throw new QualificationPreflightError("frozen_candidate");
    }
    const finalStatus = await runCheckedCommand(
      runner,
      request(["status", "--porcelain=v1", "--untracked-files=all"]),
      "frozen_candidate",
    );
    if (!validAllowedBatchStatus(finalStatus, options.batchId)) {
      throw new QualificationPreflightError("frozen_candidate");
    }
    const finalCommit = safeSingleLine(
      await runCheckedCommand(
        runner,
        request(["rev-parse", "HEAD"]),
        "frozen_candidate",
      ),
      "frozen_candidate",
      40,
    );
    if (
      !COMMIT_PATTERN.test(finalCommit) ||
      finalCommit !== preflight.repositoryCommit
    ) {
      throw new QualificationPreflightError("frozen_candidate");
    }
  });
}

export const assertQualificationCandidateUnchanged =
  assertQualificationFrozenCandidate;

export async function collectQualificationCurrentSnapshot(
  options: {
    repositoryRoot: string;
  },
  dependencies: QualificationPreflightDependencies = {},
): Promise<QualificationCurrentSnapshot> {
  return inStage("current_snapshot", async () => {
    if (
      typeof options.repositoryRoot !== "string" ||
      options.repositoryRoot.trim() === ""
    ) {
      throw new QualificationPreflightError("current_snapshot");
    }
    const repositoryRoot = path.resolve(options.repositoryRoot);
    const environment = dependencies.environment ?? process.env;
    const platform = dependencies.platform ?? process.platform;
    const runner = dependencies.runCommand ?? defaultCommandRunner;
    const commit = safeSingleLine(
      await runCheckedCommand(
        runner,
        {
          command: "git",
          args: ["rev-parse", "HEAD"],
          cwd: repositoryRoot,
          environment,
          captureStdout: true,
        },
        "current_snapshot",
      ),
      "current_snapshot",
      40,
    );
    if (!COMMIT_PATTERN.test(commit)) {
      throw new QualificationPreflightError("current_snapshot");
    }
    const packageIdentity = await readPackageIdentity(repositoryRoot);
    let buildIdentity: QualificationBuildIdentity;
    try {
      buildIdentity = await collectQualificationBuildIdentity(repositoryRoot);
    } catch {
      throw new QualificationPreflightError("current_snapshot");
    }
    await assertStaticLocators({
      platform,
      locateKimiExecutable:
        dependencies.locateKimiExecutable ??
        (() => locateKimi({ environment, platform })),
      locatePiInvocation:
        dependencies.locatePiInvocation ??
        (() => locatePiInvocation({ environment, platform })),
      locatePosixPiExecutable:
        dependencies.locatePosixPiExecutable ??
        (() => locatePi({ environment, platform })),
    });
    const runtimeVersions = await collectRuntimeVersions({
      repositoryRoot,
      environment,
      nodeVersion: dependencies.nodeVersion ?? process.version,
      runner,
      createTemporaryCodexHome:
        dependencies.createTemporaryCodexHome ?? defaultTemporaryCodexHome,
      removeTemporaryCodexHome:
        dependencies.removeTemporaryCodexHome ??
        defaultRemoveTemporaryCodexHome,
    });
    const piConfigSha256 =
      await collectQualificationPiConfigSha256(dependencies);
    const identities = collectFixedIdentities(environment);
    return Object.freeze({
      repositoryCommit: commit,
      packageVersion: packageIdentity.packageVersion,
      packageLockSha256: packageIdentity.packageLockSha256,
      buildArtifacts: buildIdentity.buildArtifacts,
      buildIdentitySha256: buildIdentity.buildIdentitySha256,
      runtimeVersions,
      piConfigSha256,
      logicalLlms: identities.logicalLlms,
      credentialMatches: identities.credentialMatches,
    });
  });
}

export async function runQualificationPreflight(
  options: QualificationPreflightOptions,
  dependencies: QualificationPreflightDependencies = {},
): Promise<CurrentFrozenPreflightRecord> {
  validateInput(options);
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const runner = dependencies.runCommand ?? defaultCommandRunner;
  const assertAuthorizationUnused =
    dependencies.assertAuthorizationUnused ??
    ((input) => assertAuthorizationReferenceUnused(input));

  const initialRepository = await captureRepository(
    repositoryRoot,
    environment,
    runner,
    "repository_initial",
    true,
  );
  const packageIdentity = await readPackageIdentity(repositoryRoot);
  const initialBuild = await inStage("build_initial", () =>
    collectQualificationBuildIdentity(repositoryRoot),
  );
  await assertStaticLocators({
    platform,
    locateKimiExecutable:
      dependencies.locateKimiExecutable ??
      (() => locateKimi({ environment, platform })),
    locatePiInvocation:
      dependencies.locatePiInvocation ??
      (() => locatePiInvocation({ environment, platform })),
    locatePosixPiExecutable:
      dependencies.locatePosixPiExecutable ??
      (() => locatePi({ environment, platform })),
  });
  const runtimeVersions = await collectRuntimeVersions({
    repositoryRoot,
    environment,
    nodeVersion: dependencies.nodeVersion ?? process.version,
    runner,
    createTemporaryCodexHome:
      dependencies.createTemporaryCodexHome ?? defaultTemporaryCodexHome,
    removeTemporaryCodexHome:
      dependencies.removeTemporaryCodexHome ?? defaultRemoveTemporaryCodexHome,
  });
  const piConfigSha256 = await collectQualificationPiConfigSha256(dependencies);
  const fixedIdentities = await inStage("credentials", async () =>
    collectFixedIdentities(environment),
  );
  await inStage("authorization", () =>
    assertAuthorizationUnused({
      repositoryRoot,
      authorizationReferenceSha256: options.authorizationReferenceSha256,
      lockDirectory: options.lockDirectory,
      currentOwnerNonce: options.currentOwnerNonce,
    }),
  );

  for (const command of DETERMINISTIC_COMMANDS) {
    await runCheckedCommand(
      runner,
      {
        command: command.command,
        args: command.args,
        cwd: repositoryRoot,
        environment,
        captureStdout: false,
      },
      command.stage,
    );
  }

  const finalRepository = await captureRepository(
    repositoryRoot,
    environment,
    runner,
    "repository_final",
    false,
  );
  if (finalRepository.commit !== initialRepository.commit) {
    throw new QualificationPreflightError("repository_final");
  }
  const finalBuild = await inStage("build_final", async () => {
    try {
      return await collectQualificationBuildIdentity(repositoryRoot);
    } catch {
      throw new QualificationPreflightError("build_final");
    }
  });
  if (!sameBuildIdentity(initialBuild, finalBuild)) {
    throw new QualificationPreflightError("build_final");
  }
  const closedRepository = await captureRepository(
    repositoryRoot,
    environment,
    runner,
    "repository_final",
    false,
  );
  if (closedRepository.commit !== initialRepository.commit) {
    throw new QualificationPreflightError("repository_final");
  }
  return inStage("record", async () => {
    const preflight = freezePreflightRecord({
      schemaVersion: 3,
      qualificationPlanId: ACTIVE_QUALIFICATION_PLAN_ID,
      repositoryCommit: initialRepository.commit,
      repositoryBranch: initialRepository.branch,
      repositoryDirty: false,
      packageVersion: packageIdentity.packageVersion,
      packageLockSha256: packageIdentity.packageLockSha256,
      buildArtifacts: finalBuild.buildArtifacts,
      buildIdentitySha256: finalBuild.buildIdentitySha256,
      runtimeVersions,
      piConfigSha256,
      logicalLlms: fixedIdentities.logicalLlms,
      credentialMatches: fixedIdentities.credentialMatches,
    });
    if (preflight.schemaVersion !== 3) {
      throw new QualificationPreflightError("record");
    }
    return preflight;
  });
}
