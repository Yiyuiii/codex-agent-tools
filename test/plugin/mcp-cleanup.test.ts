import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupOwnedMcpTransport } from "../../src/plugin/mcp-cleanup.js";
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
  if (ownedParent?.pid !== undefined && isAlive(ownedParent.pid)) {
    await terminateProcessTree(ownedParent.pid).catch(() => undefined);
  }
  if (ownedGrandchildPid !== undefined && isAlive(ownedGrandchildPid)) {
    process.kill(ownedGrandchildPid, "SIGKILL");
  }
  ownedParent = undefined;
  ownedGrandchildPid = undefined;
});

describe("cleanupOwnedMcpTransport", () => {
  it("terminates the owned transport pid before closing client and transport", async () => {
    const events: string[] = [];
    const client = {
      close: vi.fn(async () => {
        events.push("client.close");
      }),
    };
    const transport = {
      pid: 1234,
      close: vi.fn(async () => {
        events.push("transport.close");
      }),
    };

    await cleanupOwnedMcpTransport(
      client,
      transport,
      async (pid) => {
        events.push(`terminate:${pid}`);
      },
    );

    expect(events).toEqual([
      "terminate:1234",
      "client.close",
      "transport.close",
    ]);
  });

  it("leaves no owned MCP parent or grandchild process behind", async () => {
    ownedParent = spawn(process.execPath, [fakePath], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    expect(ownedParent.pid).toBeTypeOf("number");
    ownedGrandchildPid = await readPid(ownedParent);
    expect(isAlive(ownedGrandchildPid)).toBe(true);

    await cleanupOwnedMcpTransport(
      { close: async () => undefined },
      { pid: ownedParent.pid!, close: async () => undefined },
    );

    await waitUntilDead(ownedParent.pid!);
    await waitUntilDead(ownedGrandchildPid);
  });
});
