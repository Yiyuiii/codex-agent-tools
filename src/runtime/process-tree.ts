import path from "node:path";

import { execa } from "execa";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean,
  expected: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (condition() !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition() === expected;
}

async function terminateWindowsTree(pid: number): Promise<void> {
  if (!processIsAlive(pid)) {
    return;
  }

  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  const result = await execa(taskkill, ["/PID", String(pid), "/T", "/F"], {
    reject: false,
    timeout: 10_000,
    windowsHide: true,
  });

  if (result.exitCode !== 0 && processIsAlive(pid)) {
    throw new Error(
      `Failed to terminate Windows process tree ${pid}: taskkill exit ${result.exitCode}`,
    );
  }
}

async function terminatePosixTree(pid: number): Promise<void> {
  if (!processGroupIsAlive(pid)) {
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    return;
  }

  if (await waitFor(() => processGroupIsAlive(pid), false, 1_000)) {
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

export async function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process id: ${pid}`);
  }

  if (process.platform === "win32") {
    await terminateWindowsTree(pid);
    return;
  }

  await terminatePosixTree(pid);
}
