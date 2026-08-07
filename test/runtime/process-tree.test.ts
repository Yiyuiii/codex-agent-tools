import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { terminatePosixProcessGroup } from "../../src/runtime/process-tree.js";

const fakePath = fileURLToPath(
  new URL("../fakes/spawn-grandchild.mjs", import.meta.url),
);
const posixIt = it.runIf(process.platform !== "win32");

let ownedParent: ChildProcess | undefined;
let ownedGrandchildPid: number | undefined;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end >= 0) resolve(Number.parseInt(buffer.slice(0, end), 10));
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`fake parent exited early: ${String(code)}`)),
    );
  });
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(isAlive(pid)).toBe(false);
}

afterEach(async () => {
  if (
    process.platform !== "win32" &&
    ownedParent?.pid !== undefined &&
    isAlive(ownedParent.pid)
  ) {
    await terminatePosixProcessGroup(ownedParent.pid).catch(() => undefined);
  }
  if (ownedGrandchildPid !== undefined && isAlive(ownedGrandchildPid)) {
    process.kill(ownedGrandchildPid, "SIGKILL");
  }
  ownedParent = undefined;
  ownedGrandchildPid = undefined;
});

describe("terminatePosixProcessGroup", () => {
  it.runIf(process.platform === "win32")(
    "fails closed instead of invoking a Windows PID-tree fallback",
    async () => {
      await expect(terminatePosixProcessGroup(process.pid)).rejects.toThrow(
        "POSIX process-group termination is unavailable on win32",
      );
    },
  );

  posixIt("terminates an owned POSIX group", async () => {
    ownedParent = spawn(process.execPath, [fakePath], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(ownedParent.pid).toBeTypeOf("number");
    ownedGrandchildPid = await readPid(ownedParent);
    expect(isAlive(ownedGrandchildPid)).toBe(true);

    await terminatePosixProcessGroup(ownedParent.pid!);
    await waitUntilDead(ownedParent.pid!);
    await waitUntilDead(ownedGrandchildPid);
  });

  posixIt("is idempotent when the group no longer exists", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await expect(
      terminatePosixProcessGroup(child.pid!),
    ).resolves.toBeUndefined();
  });
});
