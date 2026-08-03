import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const windowsIt = it.runIf(process.platform === "win32");

describe("current-host fd3 control preflight", () => {
  it("ships a real C# fd3 probe and a fixed current-runtime harness", () => {
    const probePath = resolve(
      repositoryRoot,
      "native/windows-job-helper/src/Fd3Preflight.cs",
    );
    expect(existsSync(probePath)).toBe(true);
    const probe = readFileSync(probePath, "utf8");
    expect(probe).toContain("_get_osfhandle(3)");
    expect(probe).not.toMatch(/CreateProcess|JobObject|GetEnvironmentVariable/u);
    const readyWrite = probe.indexOf("WriteFrame(controlHandle, ProtocolV1.MessageReady");
    const pendingRead = probe.indexOf("pendingRead = StartRead(controlHandle, 1)");
    const terminalWrite = probe.indexOf("WriteFrame(controlHandle, ProtocolV1.MessageExit");
    expect(readyWrite).toBeGreaterThan(-1);
    expect(pendingRead).toBeGreaterThan(readyWrite);
    expect(terminalWrite).toBeGreaterThan(pendingRead);
    expect(probe).toContain("terminalReason = ReadTerminate(controlHandle)");
    expect(probe).toContain("terminal[4] = (byte)terminalReason");
    const runner = readFileSync(
      resolve(repositoryRoot, "scripts/windows-native-helper.mjs"),
      "utf8",
    );
    expect(runner).toContain("realpathSync.native(process.execPath)");
    expect(runner).toContain("setImmediate(resolveTurn)");
    expect(runner).toContain('["ignore", "pipe", "pipe", "overlapped"]');
    expect(runner.match(/expectedReason: 1/gu)).toHaveLength(2);
    expect(runner.match(/expectedReason: 0/gu)).toHaveLength(1);
    expect(runner).not.toContain("preflight-current");
  });

  windowsIt(
    "executes all fd3 lifecycle cases with the current Node runtime",
    () => {
      const result = spawnSync(
        process.execPath,
        [resolve(repositoryRoot, "scripts/windows-native-helper.mjs"), "preflight"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          timeout: 180_000,
          windowsHide: true,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `windows-native-helper: preflight passed node=${process.version} libuv=${process.versions.uv} cases=5\n`,
      );
    },
    190_000,
  );
});
