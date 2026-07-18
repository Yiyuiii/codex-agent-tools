import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { terminateProcessTree } from "../../src/runtime/process-tree.js";

const fakePath = fileURLToPath(
  new URL("../fakes/spawn-grandchild.mjs", import.meta.url),
);

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
      if (end >= 0) {
        resolve(Number.parseInt(buffer.slice(0, end), 10));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fake parent exited early: ${code}`)));
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
  if (ownedParent?.pid && isAlive(ownedParent.pid)) {
    await terminateProcessTree(ownedParent.pid).catch(() => undefined);
  }
  if (ownedGrandchildPid && isAlive(ownedGrandchildPid)) {
    process.kill(ownedGrandchildPid, "SIGKILL");
  }
  ownedParent = undefined;
  ownedGrandchildPid = undefined;
});

describe("terminateProcessTree", () => {
  it("terminates an owned parent and its grandchild", async () => {
    ownedParent = spawn(process.execPath, [fakePath], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    expect(ownedParent.pid).toBeTypeOf("number");
    ownedGrandchildPid = await readPid(ownedParent);
    expect(isAlive(ownedGrandchildPid)).toBe(true);

    await terminateProcessTree(ownedParent.pid!);
    await waitUntilDead(ownedParent.pid!);
    await waitUntilDead(ownedGrandchildPid);
  });

  it("is idempotent when the process no longer exists", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await expect(terminateProcessTree(child.pid!)).resolves.toBeUndefined();
  });
});
