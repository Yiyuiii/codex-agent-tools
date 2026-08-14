import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireQualificationLock,
  defaultQualificationLockReleaseOperations,
  qualificationPlanForOwner,
  qualificationLockLocation,
  QualificationLockError,
  readQualificationLockOwner,
  recoverQualificationLock,
  releaseQualificationLock,
  inspectProcessIdentityForPlatform,
  type ProcessIdentityInspector,
  type RecoverQualificationLockOptions,
} from "../../src/qualification/lock.js";
import type { QualificationRecoveryReference } from "../../src/qualification/types.js";

const roots: string[] = [];
const authHash = "a".repeat(64);
const startedAt = "2026-07-26T01:02:03.000Z";
const secret = "SECRET_LOCK_SENTINEL";

async function tempFixture(): Promise<{ repository: string; temp: string }> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-lock-test-${process.pid}-${Date.now()}-${roots.length}`,
  );
  const repository = path.join(root, "repo");
  const temp = path.join(root, "temp");
  await mkdir(repository, { recursive: true });
  await mkdir(temp, { recursive: true });
  roots.push(root);
  return { repository, temp };
}

async function createDirectoryLink(
  target: string,
  linkPath: string,
): Promise<void> {
  await symlink(
    target,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const liveInspector: ProcessIdentityInspector = async () => ({
  alive: true,
  startTime: startedAt,
});
const deadInspector: ProcessIdentityInspector = async () => ({
  alive: false,
  startTime: null,
});

describe("qualification lock", () => {
  it("forces Windows process identity CIM failures to terminate and distinguishes only explicit absence", async () => {
    let command = "";
    await expect(
      inspectProcessIdentityForPlatform(123, {
        platform: "win32",
        commandRunner: async (_executable, args) => {
          command = args.at(-1) ?? "";
          return {
            exitCode: 0,
            stdout: "2026-07-26T01:02:03.000Z",
          };
        },
      }),
    ).resolves.toEqual({ alive: true, startTime: startedAt });
    expect(command).toContain("$ErrorActionPreference = 'Stop'");
    expect(command).toContain("-ErrorAction Stop");
    await expect(
      inspectProcessIdentityForPlatform(123, {
        platform: "win32",
        commandRunner: async () => ({ exitCode: 3, stdout: "" }),
      }),
    ).resolves.toEqual({ alive: false, startTime: null });
    await expect(
      inspectProcessIdentityForPlatform(123, {
        platform: "win32",
        commandRunner: async () => ({ exitCode: 1, stdout: secret }),
      }),
    ).rejects.toThrow("Qualification lock operation failed");
  });

  it("atomically acquires an immutable owner record and rejects a second owner", async () => {
    const fixture = await tempFixture();
    const first = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
      nonce: "11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-07-26T02:00:00.000Z"),
    });

    const location = await qualificationLockLocation(
      fixture.repository,
      fixture.temp,
    );
    expect(first.lockDirectory).toBe(location.lockDirectory);
    const owner = JSON.parse(
      await readFile(path.join(location.lockDirectory, "owner.json"), "utf8"),
    );
    expect(owner).toEqual({
      schemaVersion: 2,
      qualificationPlanId: "four-llm-v1",
      repositoryRealpathSha256: location.repositoryRealpathSha256,
      processId: 123,
      processStartTime: startedAt,
      nonce: "11111111-1111-4111-8111-111111111111",
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      acquiredAt: "2026-07-26T02:00:00.000Z",
    });
    expect(JSON.stringify(owner)).not.toContain(fixture.repository);

    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-2",
        authorizationReferenceSha256: "b".repeat(64),
        processId: 123,
        processIdentityInspector: liveInspector,
      }),
    ).rejects.toThrow("Qualification lock operation failed");
  });

  it("maps legacy owners only to five-llm-v1 and requires the exact current plan on v2", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
      nonce: "11111111-1111-4111-8111-111111111111",
    });
    expect(qualificationPlanForOwner(handle.owner)).toBe("four-llm-v1");
    if (handle.owner.schemaVersion !== 2) {
      throw new Error("expected a current lock owner");
    }

    const ownerPath = path.join(handle.lockDirectory, "owner.json");
    const { qualificationPlanId: _removed, ...currentWithoutPlan } =
      handle.owner;
    await rm(ownerPath);
    await writeFile(
      ownerPath,
      `${JSON.stringify({ ...currentWithoutPlan, schemaVersion: 1 })}\n`,
      "utf8",
    );
    const legacy = await readQualificationLockOwner(handle.lockDirectory);
    expect(qualificationPlanForOwner(legacy)).toBe("five-llm-v1");

    for (const invalid of [
      {
        ...currentWithoutPlan,
        schemaVersion: 1,
        qualificationPlanId: "five-llm-v1",
      },
      { ...currentWithoutPlan, schemaVersion: 2 },
      {
        ...currentWithoutPlan,
        schemaVersion: 2,
        qualificationPlanId: "five-llm-v1",
      },
    ]) {
      await rm(ownerPath);
      await writeFile(ownerPath, `${JSON.stringify(invalid)}\n`, "utf8");
      await expect(
        readQualificationLockOwner(handle.lockDirectory),
      ).rejects.toThrow("Qualification lock operation failed");
    }
  });

  it("persists and recovers the Direct DeepSeek plan in a current lock owner", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "direct-deepseek-batch",
      authorizationReferenceSha256: authHash,
      qualificationPlanId: "direct-deepseek-v1",
      processId: 123,
      processIdentityInspector: liveInspector,
      nonce: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      readQualificationLockOwner(handle.lockDirectory),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      qualificationPlanId: "direct-deepseek-v1",
      batchId: "direct-deepseek-batch",
    });
    expect(qualificationPlanForOwner(handle.owner)).toBe(
      "direct-deepseek-v1",
    );
    await releaseQualificationLock(handle);
  });

  it("rejects a prebuilt lock-root directory link without writing through it", async () => {
    const fixture = await tempFixture();
    const external = path.join(
      path.dirname(fixture.temp),
      "external-lock-root",
    );
    const lockRoot = path.join(
      fixture.temp,
      "codex-agent-tools-qualification-locks",
    );
    await mkdir(external);
    await writeFile(path.join(external, "sentinel.txt"), secret, "utf8");
    await createDirectoryLink(external, lockRoot);

    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        processId: 123,
        processIdentityInspector: liveInspector,
      }),
    ).rejects.toThrow("Qualification lock operation failed");

    expect(await readdir(external)).toEqual(["sentinel.txt"]);
    await expect(
      readFile(path.join(external, "sentinel.txt"), "utf8"),
    ).resolves.toBe(secret);
  });

  it("rejects a linked temp directory before deriving the lock root", async () => {
    const fixture = await tempFixture();
    const external = path.join(path.dirname(fixture.temp), "external-temp");
    const linkedTemp = path.join(path.dirname(fixture.temp), "linked-temp");
    await mkdir(external);
    await writeFile(path.join(external, "sentinel.txt"), secret, "utf8");
    await createDirectoryLink(external, linkedTemp);

    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: linkedTemp,
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        processId: 123,
        processIdentityInspector: liveInspector,
      }),
    ).rejects.toThrow("Qualification lock operation failed");

    expect(await readdir(external)).toEqual(["sentinel.txt"]);
    await expect(
      readFile(path.join(external, "sentinel.txt"), "utf8"),
    ).resolves.toBe(secret);
  });

  it("requires the full owner identity and nonce to release", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
      nonce: "11111111-1111-4111-8111-111111111111",
    });

    await expect(
      releaseQualificationLock({
        ...handle,
        owner: {
          ...handle.owner,
          nonce: "22222222-2222-4222-8222-222222222222",
        },
      }),
    ).rejects.toThrow("Qualification lock operation failed");
    expect(
      await readFile(path.join(handle.lockDirectory, "owner.json"), "utf8"),
    ).toContain(handle.owner.nonce);

    await releaseQualificationLock(handle);
    await expect(
      readFile(path.join(handle.lockDirectory, "owner.json")),
    ).rejects.toThrow();
  });

  it("includes the current plan identity in exact-owner release equality", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });

    await expect(
      releaseQualificationLock({
        ...handle,
        owner: {
          ...handle.owner,
          qualificationPlanId: "five-llm-v1",
        },
      } as never),
    ).rejects.toThrow("Qualification lock operation failed");
    await expect(
      readFile(path.join(handle.lockDirectory, "owner.json"), "utf8"),
    ).resolves.toContain('"qualificationPlanId": "four-llm-v1"');
  });

  it("rejects a lock directory replaced by a directory link before release", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });
    const ownerContents = await readFile(
      path.join(handle.lockDirectory, "owner.json"),
      "utf8",
    );
    const external = path.join(path.dirname(fixture.temp), "external-release");
    await rm(handle.lockDirectory, { recursive: true });
    await mkdir(external);
    await writeFile(path.join(external, "owner.json"), ownerContents, "utf8");
    await createDirectoryLink(external, handle.lockDirectory);

    await expect(releaseQualificationLock(handle)).rejects.toThrow(
      "Qualification lock operation failed",
    );
    await expect(
      readFile(path.join(external, "owner.json"), "utf8"),
    ).resolves.toBe(ownerContents);
  });

  it("treats rename as the release commit point and cleanup as best effort", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });
    await expect(
      releaseQualificationLock(handle, {
        ...defaultQualificationLockReleaseOperations,
        removeOwner: async () => {
          throw new Error(secret);
        },
      }),
    ).resolves.toBeUndefined();

    const next = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-2",
      authorizationReferenceSha256: "b".repeat(64),
      processId: 456,
      processIdentityInspector: liveInspector,
    });
    expect(next.owner.batchId).toBe("batch-2");
  });

  it("keeps the original lock when the release rename fails", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });
    await expect(
      releaseQualificationLock(handle, {
        ...defaultQualificationLockReleaseOperations,
        renameDirectory: async () => {
          throw new Error(secret);
        },
      }),
    ).rejects.toThrow("Qualification lock operation failed");
    await expect(
      readFile(path.join(handle.lockDirectory, "owner.json"), "utf8"),
    ).resolves.toContain(handle.owner.nonce);
  });

  it("leaves an unconfirmable partial owner fail closed after a write failure", async () => {
    const fixture = await tempFixture();
    const location = await qualificationLockLocation(
      fixture.repository,
      fixture.temp,
    );

    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        processId: 123,
        processIdentityInspector: liveInspector,
        writeOwner: async (filePath) => {
          await writeFile(filePath, '{"partial":', {
            encoding: "utf8",
            flag: "wx",
          });
          throw new Error(secret);
        },
      }),
    ).rejects.toThrow("Qualification lock operation failed");

    await expect(
      readFile(path.join(location.lockDirectory, "owner.json"), "utf8"),
    ).resolves.toBe('{"partial":');
    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-2",
        authorizationReferenceSha256: "b".repeat(64),
        processId: 456,
        processIdentityInspector: liveInspector,
      }),
    ).rejects.toThrow("Qualification lock operation failed");
  });

  it("rejects a no-op injected owner writer and removes only the confirmed empty directory", async () => {
    const fixture = await tempFixture();
    const location = await qualificationLockLocation(
      fixture.repository,
      fixture.temp,
    );
    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        processId: 123,
        processIdentityInspector: liveInspector,
        writeOwner: async () => {},
      }),
    ).rejects.toThrow("Qualification lock operation failed");
    await expect(
      readFile(path.join(location.lockDirectory, "owner.json")),
    ).rejects.toThrow();
    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-2",
        authorizationReferenceSha256: "b".repeat(64),
        processId: 456,
        processIdentityInspector: liveInspector,
      }),
    ).resolves.toMatchObject({ owner: { batchId: "batch-2" } });
  });

  it("rejects wrong owner contents without deleting an owner it cannot confirm", async () => {
    const fixture = await tempFixture();
    const location = await qualificationLockLocation(
      fixture.repository,
      fixture.temp,
    );
    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        processId: 123,
        processIdentityInspector: liveInspector,
        writeOwner: async (filePath) => {
          await writeFile(
            filePath,
            `${JSON.stringify({
              schemaVersion: 1,
              repositoryRealpathSha256: location.repositoryRealpathSha256,
              processId: 999,
              processStartTime: startedAt,
              nonce: "99999999-9999-4999-8999-999999999999",
              batchId: "different-owner",
              authorizationReferenceSha256: "9".repeat(64),
              acquiredAt: "2026-07-26T02:00:00.000Z",
            })}\n`,
            { encoding: "utf8", flag: "wx" },
          );
        },
      }),
    ).rejects.toThrow("Qualification lock operation failed");
    await expect(
      readFile(path.join(location.lockDirectory, "owner.json"), "utf8"),
    ).resolves.toContain("different-owner");
    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-2",
        authorizationReferenceSha256: "b".repeat(64),
        processId: 456,
        processIdentityInspector: liveInspector,
      }),
    ).rejects.toThrow("Qualification lock operation failed");
  });

  it("fails closed for a live owner and permits no implicit stale takeover", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });

    await expect(
      recoverQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        processIdentityInspector: liveInspector,
        inspectTerminalManifest: async () => ({ state: "missing" }),
        publishInterruptedManifest: async () => {},
      }),
    ).rejects.toThrow("Qualification lock operation failed");

    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-2",
        authorizationReferenceSha256: "b".repeat(64),
        processId: 456,
        processIdentityInspector: deadInspector,
      }),
    ).rejects.toThrow("Qualification lock operation failed");
    expect(handle.owner.batchId).toBe("batch-1");
  });

  it("recovers a dead or PID-reused owner only after immutable terminal verification", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });
    let terminal:
      | { state: "missing" }
      | {
          state: "valid";
          batchId: string;
          authorizationReferenceSha256: string;
          qualificationPlanId: "four-llm-v1";
        } = { state: "missing" };
    const publisher = vi.fn(async (request: QualificationRecoveryReference) => {
      expect(request).toEqual({
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        qualificationPlanId: "four-llm-v1",
      });
      terminal = {
        state: "valid",
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        qualificationPlanId: "four-llm-v1",
      };
    });

    await recoverQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      processIdentityInspector: async () => ({
        alive: true,
        startTime: "2026-07-26T01:02:04.000Z",
      }),
      inspectTerminalManifest: async () => terminal,
      publishInterruptedManifest: publisher,
    });

    expect(publisher).toHaveBeenCalledOnce();
    await expect(
      readFile(path.join(handle.lockDirectory, "owner.json")),
    ).rejects.toThrow();
  });

  it("rejects a lock directory replaced by a directory link before recovery", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });
    const ownerContents = await readFile(
      path.join(handle.lockDirectory, "owner.json"),
      "utf8",
    );
    const external = path.join(path.dirname(fixture.temp), "external-recover");
    await rm(handle.lockDirectory, { recursive: true });
    await mkdir(external);
    await writeFile(path.join(external, "owner.json"), ownerContents, "utf8");
    await createDirectoryLink(external, handle.lockDirectory);

    await expect(
      recoverQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        processIdentityInspector: deadInspector,
        inspectTerminalManifest: async () => ({
          state: "valid",
          batchId: "batch-1",
          authorizationReferenceSha256: authHash,
          qualificationPlanId: "four-llm-v1",
        }),
        publishInterruptedManifest: async () => {},
      }),
    ).rejects.toThrow("Qualification lock operation failed");
    await expect(
      readFile(path.join(external, "owner.json"), "utf8"),
    ).resolves.toBe(ownerContents);
  });

  it("verifies an existing terminal without publishing a second terminal", async () => {
    const fixture = await tempFixture();
    await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });
    const publisher = vi.fn();

    await recoverQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      processIdentityInspector: deadInspector,
      inspectTerminalManifest: async () => ({
        state: "valid",
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        qualificationPlanId: "four-llm-v1",
      }),
      publishInterruptedManifest: publisher,
    });

    expect(publisher).not.toHaveBeenCalled();
  });

  it("never consults a whole-machine target process inventory during recovery", async () => {
    const fixture = await tempFixture();
    await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });
    const options: RecoverQualificationLockOptions = {
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      processIdentityInspector: deadInspector,
      inspectTerminalManifest: async () => ({
        state: "valid",
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        qualificationPlanId: "four-llm-v1",
      }),
      publishInterruptedManifest: async () => {},
    };
    let inventoryReads = 0;
    Object.defineProperty(options, "inspectTargetProcesses", {
      enumerable: true,
      get: () => {
        inventoryReads += 1;
        throw new Error("whole-machine inventory must remain unused");
      },
    });

    await recoverQualificationLock(options);

    expect(inventoryReads).toBe(0);
  });

  it("retains a stale current lock when an existing terminal reports the legacy plan", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });
    const publisher = vi.fn();

    await expect(
      recoverQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        processIdentityInspector: deadInspector,
        inspectTerminalManifest: async () => ({
          state: "valid",
          batchId: "batch-1",
          authorizationReferenceSha256: authHash,
          qualificationPlanId: "five-llm-v1",
        }),
        publishInterruptedManifest: publisher,
      }),
    ).rejects.toThrow("Qualification lock operation failed");
    expect(publisher).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(handle.lockDirectory, "owner.json"), "utf8"),
    ).resolves.toContain(handle.owner.nonce);
  });

  it.each(["existing", "after_publish"] as const)(
    "keeps the stale lock when a %s terminal has another authorization identity",
    async (scenario) => {
      const fixture = await tempFixture();
      const handle = await acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        processId: 123,
        processIdentityInspector: liveInspector,
      });
      let published = scenario === "existing";
      await expect(
        recoverQualificationLock({
          repositoryRoot: fixture.repository,
          tempDirectory: fixture.temp,
          batchId: "batch-1",
          processIdentityInspector: deadInspector,
          inspectTerminalManifest: async () =>
            published
              ? {
                  state: "valid",
                  batchId: "batch-1",
                  authorizationReferenceSha256: "b".repeat(64),
                  qualificationPlanId: "four-llm-v1" as const,
                }
              : { state: "missing" },
          publishInterruptedManifest: async () => {
            published = true;
          },
        }),
      ).rejects.toThrow("Qualification lock operation failed");
      await expect(
        readFile(path.join(handle.lockDirectory, "owner.json"), "utf8"),
      ).resolves.toContain(authHash);
    },
  );

  it.each(["damaged owner", "nonce drift"] as const)(
    "fails closed for %s without deleting the lock",
    async (scenario) => {
      const fixture = await tempFixture();
      const handle = await acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        processId: 123,
        processIdentityInspector: liveInspector,
      });
      if (scenario === "damaged owner") {
        await writeFile(
          path.join(handle.lockDirectory, "owner.json"),
          "{",
          "utf8",
        );
      }
      const inspectTerminalManifest = vi.fn(async () => {
        if (scenario === "nonce drift") {
          const ownerPath = path.join(handle.lockDirectory, "owner.json");
          await rm(ownerPath);
          await writeFile(
            ownerPath,
            `${JSON.stringify({ ...handle.owner, nonce: "33333333-3333-4333-8333-333333333333" })}\n`,
            "utf8",
          );
        }
        return {
          state: "valid" as const,
          batchId: "batch-1",
          authorizationReferenceSha256: authHash,
          qualificationPlanId: "four-llm-v1" as const,
        };
      });

      await expect(
        recoverQualificationLock({
          repositoryRoot: fixture.repository,
          tempDirectory: fixture.temp,
          batchId: "batch-1",
          processIdentityInspector: deadInspector,
          inspectTerminalManifest,
          publishInterruptedManifest: async () => {},
        }),
      ).rejects.toBeInstanceOf(QualificationLockError);
      await expect(
        readFile(path.join(handle.lockDirectory, "owner.json")),
      ).resolves.toBeDefined();
    },
  );

  it("does not expose owner corruption", async () => {
    const fixture = await tempFixture();
    const location = await qualificationLockLocation(
      fixture.repository,
      fixture.temp,
    );
    await mkdir(location.lockDirectory, { recursive: true });
    await writeFile(
      path.join(location.lockDirectory, "owner.json"),
      `{"secret":"${secret}"}`,
      "utf8",
    );

    let failure: unknown;
    try {
      await recoverQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        processIdentityInspector: deadInspector,
        inspectTerminalManifest: async () => ({ state: "missing" }),
        publishInterruptedManifest: async () => {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(QualificationLockError);
    expect((failure as Error).message).toBe(
      "Qualification lock operation failed",
    );
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("does not expose immutable terminal callback secrets", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });

    await expect(
      recoverQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        processIdentityInspector: deadInspector,
        inspectTerminalManifest: async () => {
          throw new Error(secret);
        },
        publishInterruptedManifest: async () => {},
      }),
    ).rejects.toMatchObject({
      name: "QualificationLockError",
      message: "Qualification lock operation failed",
    });
    await expect(
      readFile(path.join(handle.lockDirectory, "owner.json"), "utf8"),
    ).resolves.not.toContain(secret);
  });

  it.each([
    { alive: true, startTime: null },
    { alive: false, startTime: startedAt },
    { alive: true, startTime: "invalid" },
  ])("rejects invalid injected process identity %#", async (identity) => {
    const fixture = await tempFixture();
    await expect(
      acquireQualificationLock({
        repositoryRoot: fixture.repository,
        tempDirectory: fixture.temp,
        batchId: "batch-1",
        authorizationReferenceSha256: authHash,
        processId: 123,
        processIdentityInspector: async () => identity,
      }),
    ).rejects.toThrow("Qualification lock operation failed");
  });

  it("rejects a non-regular or oversized owner record", async () => {
    for (const kind of ["directory", "oversized"] as const) {
      const fixture = await tempFixture();
      const location = await qualificationLockLocation(
        fixture.repository,
        fixture.temp,
      );
      await mkdir(location.lockDirectory, { recursive: true });
      const ownerPath = path.join(location.lockDirectory, "owner.json");
      if (kind === "directory") {
        await mkdir(ownerPath);
      } else {
        await writeFile(ownerPath, "x".repeat(16_385));
      }

      await expect(
        recoverQualificationLock({
          repositoryRoot: fixture.repository,
          tempDirectory: fixture.temp,
          batchId: "batch-1",
          processIdentityInspector: deadInspector,
          inspectTerminalManifest: async () => ({ state: "missing" }),
          publishInterruptedManifest: async () => {},
        }),
      ).rejects.toThrow("Qualification lock operation failed");
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked owner record",
    async () => {
      const fixture = await tempFixture();
      const location = await qualificationLockLocation(
        fixture.repository,
        fixture.temp,
      );
      await mkdir(location.lockDirectory, { recursive: true });
      const target = path.join(fixture.temp, "target.json");
      await writeFile(target, "{}");
      await symlink(target, path.join(location.lockDirectory, "owner.json"));
      await expect(
        recoverQualificationLock({
          repositoryRoot: fixture.repository,
          tempDirectory: fixture.temp,
          batchId: "batch-1",
          processIdentityInspector: deadInspector,
          inspectTerminalManifest: async () => ({ state: "missing" }),
          publishInterruptedManifest: async () => {},
        }),
      ).rejects.toThrow("Qualification lock operation failed");
    },
  );

  it("does not execute accessor-backed owner fields during release", async () => {
    const fixture = await tempFixture();
    const handle = await acquireQualificationLock({
      repositoryRoot: fixture.repository,
      tempDirectory: fixture.temp,
      batchId: "batch-1",
      authorizationReferenceSha256: authHash,
      processId: 123,
      processIdentityInspector: liveInspector,
    });
    let getterCalls = 0;
    const maliciousOwner = {
      ...handle.owner,
      get nonce() {
        getterCalls += 1;
        return handle.owner.nonce;
      },
    };

    await expect(
      releaseQualificationLock({
        lockDirectory: handle.lockDirectory,
        owner: maliciousOwner,
      }),
    ).rejects.toThrow("Qualification lock operation failed");
    expect(getterCalls).toBe(0);
  });
});
