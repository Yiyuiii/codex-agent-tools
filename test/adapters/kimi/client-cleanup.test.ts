import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  runKimiAcp,
  type KimiAcpClientDependencies,
  type KimiAcpRunRequest,
} from "../../../src/adapters/kimi/client.js";
import type {
  OwnedAgentProcess,
  OwnedProcessExit,
  OwnedTerminationReason,
  SpawnOwnedAgentProcessRequest,
} from "../../../src/runtime/owned-agent-process.js";
import { spawnWindowsOwnedAgentProcessWithDependencies } from "../../../src/runtime/windows-owned-agent-process.js";
import { resolveWindowsJobHelperForModule } from "../../../src/runtime/windows-job-helper.js";

const windowsIt = it.runIf(process.platform === "win32");
const fakePath = fileURLToPath(
  new URL("../../fakes/fake-kimi-acp.mjs", import.meta.url),
);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const syntheticDistModuleUrl = pathToFileURL(
  path.join(repositoryRoot, "dist", "kimi-cleanup-test.mjs"),
).href;
const tempDirectories: string[] = [];
const teardownCallbacks: Array<() => Promise<void>> = [];

async function spawnCurrentHostOwnedProcess(
  request: SpawnOwnedAgentProcessRequest,
): Promise<OwnedAgentProcess> {
  return spawnWindowsOwnedAgentProcessWithDependencies(request, {
    resolveHelper: () =>
      resolveWindowsJobHelperForModule(syntheticDistModuleUrl),
  });
}

async function createRequest(
  overrides: Partial<KimiAcpRunRequest> = {},
): Promise<KimiAcpRunRequest> {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "codex-agent-kimi-cleanup-test-"),
  );
  tempDirectories.push(cwd);
  await writeFile(path.join(cwd, "fixture.txt"), "fixture-content", "utf8");
  return {
    executable: process.execPath,
    args: [fakePath],
    task: "review",
    cwd,
    prompt: "Review fixture.txt",
    model: "kimi-code/k3",
    environment: { ...process.env },
    heartbeatMs: 1_000,
    secretValues: [],
    ...overrides,
  };
}

function trackedDependencies(
  options: { rejectClosed?: boolean; rootExitCode?: number } = {},
): {
  dependencies: KimiAcpClientDependencies;
  exits: OwnedProcessExit[];
  reasons: OwnedTerminationReason[];
} {
  const exits: OwnedProcessExit[] = [];
  const reasons: OwnedTerminationReason[] = [];
  return {
    exits,
    reasons,
    dependencies: {
      async spawnOwnedAgentProcess(request) {
        const owned = await spawnCurrentHostOwnedProcess(request);
        const watchdog = setTimeout(() => {
          void owned.terminate("cancelled").catch(() => undefined);
        }, 15_000);
        teardownCallbacks.push(async () => {
          clearTimeout(watchdog);
          await owned.terminate("cancelled").catch(() => undefined);
          await owned.closed.catch(() => undefined);
        });
        const closed = owned.closed.then((exit) => {
          const reportedExit =
            options.rootExitCode === undefined
              ? exit
              : Object.freeze({
                  ...exit,
                  rootExitCode: options.rootExitCode,
                });
          exits.push(reportedExit);
          if (options.rejectClosed === true) {
            throw new Error("synthetic owned-process drain failure");
          }
          return reportedExit;
        });
        void closed.catch(() => undefined);
        return {
          stdin: owned.stdin,
          stdout: owned.stdout,
          stderr: owned.stderr,
          ready: owned.ready,
          closed,
          terminate(reason) {
            reasons.push(reason);
            return owned.terminate(reason);
          },
        };
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(teardownCallbacks.splice(0).map((callback) => callback()));
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5 }),
      ),
  );
});

describe("runKimiAcp Windows owned-process cleanup", () => {
  windowsIt("ends ACP input and accepts natural root_exit on success", async () => {
    const tracked = trackedDependencies();

    const result = await runKimiAcp(
      await createRequest({
        environment: {
          ...process.env,
          FAKE_KIMI_SCENARIO: "complete-with-descendant",
        },
      }),
      tracked.dependencies,
    );

    expect(result).toMatchObject({ status: "completed", diagnostics: [] });
    expect(result.executionTelemetry).toMatchObject({
      ownedProcessDrained: true,
      ownedProcessCompletion: "root_exit",
    });
    expect(tracked.reasons).toEqual([]);
    expect(tracked.exits).toEqual([
      expect.objectContaining({
        platform: "win32",
        completion: "root_exit",
        ownershipDrained: true,
      }),
    ]);
  });

  windowsIt(
    "prioritizes stdio shutdown over request abort and terminates ownership once",
    async () => {
      const tracked = trackedDependencies();
      const shutdown = new AbortController();
      const caller = new AbortController();

      const result = await runKimiAcp(
        await createRequest({
          environment: { ...process.env, FAKE_KIMI_SCENARIO: "hang" },
          signal: caller.signal,
          shutdownSignal: shutdown.signal,
          onProgress(message) {
            if (message === "kimi prompt started") {
              shutdown.abort("session_shutdown");
              caller.abort("request_cancelled");
            }
          },
        }),
        tracked.dependencies,
      );

      expect(result.status).toBe("cancelled");
      expect(result.executionTelemetry).toMatchObject({
        ownedProcessDrained: true,
        ownedProcessCompletion: "session_shutdown",
      });
      expect(result.diagnostics.join("\n")).not.toContain(
        "ACP connection closed",
      );
      expect(tracked.reasons).toEqual(["session_shutdown"]);
      expect(tracked.exits).toEqual([
        expect.objectContaining({
          completion: "session_shutdown",
          ownershipDrained: true,
        }),
      ]);
    },
  );

  windowsIt("changes completed to failed when owned drain rejects", async () => {
    const tracked = trackedDependencies({ rejectClosed: true });

    const result = await runKimiAcp(
      await createRequest(),
      tracked.dependencies,
    );

    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).not.toHaveProperty(
      "ownedProcessDrained",
    );
    expect(result.executionTelemetry).not.toHaveProperty(
      "ownedProcessCompletion",
    );
    expect(tracked.reasons).toEqual([]);
    expect(result.diagnostics.join("\n")).toContain(
      "synthetic owned-process drain failure",
    );
  });

  windowsIt("rejects a nonzero natural root exit after protocol completion", async () => {
    const tracked = trackedDependencies({ rootExitCode: 17 });

    const result = await runKimiAcp(
      await createRequest(),
      tracked.dependencies,
    );

    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toMatchObject({
      ownedProcessDrained: true,
      ownedProcessCompletion: "root_exit",
    });
    expect(tracked.reasons).toEqual([]);
    expect(result.diagnostics.join("\n")).toContain(
      "Kimi ACP owned process root exited unsuccessfully",
    );
  });

  windowsIt("terminates owned execution after a protocol-level business failure", async () => {
    const tracked = trackedDependencies();

    const result = await runKimiAcp(
      await createRequest({
        environment: { ...process.env, FAKE_KIMI_SCENARIO: "no-model" },
      }),
      tracked.dependencies,
    );

    expect(result.status).toBe("failed");
    expect(result.executionTelemetry).toMatchObject({
      ownedProcessDrained: true,
      ownedProcessCompletion: "cancelled",
    });
    expect(result.diagnostics.join("\n")).toMatch(
      /model configuration.*not available/i,
    );
    expect(tracked.reasons).toEqual(["cancelled"]);
    expect(tracked.exits).toEqual([
      expect.objectContaining({ ownershipDrained: true }),
    ]);
  });

  windowsIt(
    "does not let an unsettled native ACP cancel block owned termination",
    async () => {
      const tracked = trackedDependencies();
      const timeline: string[] = [];
      let releaseNativeCancel!: () => void;
      const stalledNativeCancel = new Promise<void>((resolve) => {
        releaseNativeCancel = resolve;
      });
      const trackedSpawner = tracked.dependencies.spawnOwnedAgentProcess!;
      const caller = new AbortController();
      const dependenciesWithStalledCancel = {
        platform: "win32",
        async spawnOwnedAgentProcess(request: SpawnOwnedAgentProcessRequest) {
          const owned = await trackedSpawner(request);
          return {
            ...owned,
            terminate(reason: OwnedTerminationReason) {
              timeline.push("owned-terminate");
              return owned.terminate(reason);
            },
          };
        },
        notifySessionCancel() {
          timeline.push("native-cancel-started");
          return stalledNativeCancel;
        },
      } as KimiAcpClientDependencies;

      const running = runKimiAcp(
        await createRequest({
          environment: { ...process.env, FAKE_KIMI_SCENARIO: "hang" },
          signal: caller.signal,
          onProgress(message) {
            if (message === "kimi prompt started") caller.abort();
          },
        }),
        dependenciesWithStalledCancel,
      );
      const watchdog = Symbol("test-watchdog");
      let watchdogTimer: NodeJS.Timeout | undefined;
      const earlyOutcome = await Promise.race([
        running,
        new Promise<typeof watchdog>((resolve) => {
          watchdogTimer = setTimeout(() => resolve(watchdog), 2_000);
        }),
      ]);
      releaseNativeCancel();
      const result = await running;
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);

      expect(earlyOutcome).not.toBe(watchdog);
      expect(result.status).toBe("cancelled");
      expect(timeline.slice(0, 2)).toEqual([
        "native-cancel-started",
        "owned-terminate",
      ]);
      expect(tracked.reasons).toEqual(["cancelled"]);
    },
  );
});
