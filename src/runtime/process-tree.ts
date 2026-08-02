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

export async function terminatePosixProcessGroup(pid: number): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("POSIX process-group termination is unavailable on win32");
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process id: ${pid}`);
  }
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
