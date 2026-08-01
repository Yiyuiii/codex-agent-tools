import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { type OwnedAgentProcess } from "../../src/runtime/owned-agent-process.js";
import { scheduleDeadline } from "../../src/runtime/deadline.js";
import { buildChildEnvironment } from "../../src/runtime/environment.js";
import { spawnWindowsOwnedAgentProcessWithDependencies } from "../../src/runtime/windows-owned-agent-process.js";
import { resolveWindowsJobHelperForModule } from "../../src/runtime/windows-job-helper.js";

const windowsIt = it.runIf(process.platform === "win32");
const roots: string[] = [];
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const syntheticDistModuleUrl = pathToFileURL(
  path.join(repositoryRoot, "dist", "owned-process-integration.mjs"),
).href;

function spawnCurrentHostOwnedProcess(
  request: Parameters<typeof spawnWindowsOwnedAgentProcessWithDependencies>[0],
): ReturnType<typeof spawnWindowsOwnedAgentProcessWithDependencies> {
  return spawnWindowsOwnedAgentProcessWithDependencies(request, {
    resolveHelper: () =>
      resolveWindowsJobHelperForModule(syntheticDistModuleUrl),
  });
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cat-owned-wrapper-"));
  roots.push(root);
  return root;
}

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return once(stream, "close").then(() =>
    Buffer.concat(chunks).toString("utf8"),
  );
}

function waitForText(
  stream: NodeJS.ReadableStream,
  expected: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let text = "";
    const cleanup = (): void => {
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
    };
    const onData = (chunk: Buffer | string): void => {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (!text.includes(expected)) return;
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Owned-process marker stream failed."));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Owned-process marker was not observed."));
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

function installTeardownWatchdog(owned: OwnedAgentProcess): () => boolean {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    void owned.terminate("cancelled").catch(() => undefined);
  }, 15_000);
  return () => {
    clearTimeout(timer);
    return fired;
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows OwnedAgentProcess current-host integration", () => {
  windowsIt(
    "drains flood output before READY while running to natural completion",
    async () => {
      const cwd = await temporaryDirectory();
      const floodBytes = 1024 * 1024;
      const childScript =
        `const size=${floodBytes};` +
        "process.stdout.write(Buffer.alloc(size,79),()=>{" +
        "process.stderr.write(Buffer.alloc(size,69));" +
        "});";
      const owned = await spawnCurrentHostOwnedProcess({
        executable: process.execPath,
        args: ["-e", childScript],
        cwd,
        environment: {
          ...buildChildEnvironment(
            { network: "direct", credentialEnv: [] },
            process.env,
          ),
          OWNED_INTEGRATION_SENTINEL: "natural",
        },
      });
      // Contract: callers attach consumers immediately, before awaiting READY.
      const stdout = collect(owned.stdout);
      const stderr = collect(owned.stderr);
      const clearWatchdog = installTeardownWatchdog(owned);

      await owned.ready;
      await expect(owned.closed).resolves.toMatchObject({
        platform: "win32",
        completion: "root_exit",
        rootExitCode: 0,
        signal: null,
        ownershipDrained: true,
      });
      const stdoutText = await stdout;
      const stderrText = await stderr;
      expect(stdoutText).toHaveLength(floodBytes);
      expect(stderrText).toHaveLength(floodBytes);
      expect(stdoutText[0]).toBe("O");
      expect(stdoutText.at(-1)).toBe("O");
      expect(stderrText[0]).toBe("E");
      expect(stderrText.at(-1)).toBe("E");
      expect(clearWatchdog()).toBe(false);
    },
  );

  windowsIt(
    "maps one explicit invocation deadline to timed_out and drains descendants",
    async () => {
      const cwd = await temporaryDirectory();
      const childScript =
        "const {spawn}=require('node:child_process');" +
        "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});" +
        "process.stdout.write('OWNED_TIMEOUT_ARMED\\n');" +
        "setInterval(()=>{},1000);";
      const owned = await spawnCurrentHostOwnedProcess({
        executable: process.execPath,
        args: ["-e", childScript],
        cwd,
        environment: {
          ...buildChildEnvironment(
            { network: "direct", credentialEnv: [] },
            process.env,
          ),
          OWNED_INTEGRATION_SENTINEL: "timeout",
        },
      });
      const armed = waitForText(owned.stdout, "OWNED_TIMEOUT_ARMED");
      const stdout = collect(owned.stdout);
      const stderr = collect(owned.stderr);
      const clearWatchdog = installTeardownWatchdog(owned);

      await owned.ready;
      await armed;
      const deadline = scheduleDeadline(150, () => {
        void owned.terminate("timed_out").catch(() => undefined);
      });
      try {
        await expect(owned.closed).resolves.toMatchObject({
          platform: "win32",
          completion: "timed_out",
          signal: null,
          ownershipDrained: true,
        });
      } finally {
        deadline.cancel();
      }
      expect(await stdout).toContain("OWNED_TIMEOUT_ARMED");
      expect(await stderr).toBe("");
      expect(clearWatchdog()).toBe(false);
    },
  );
});
