import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = resolve(repositoryRoot, "host-acceptance", "build.ps1");
const [command, ...arguments_] = process.argv.slice(2);
const fixedCommands = new Set([
  "test-managed",
  "test-kernel",
  "verify",
  "update-artifact",
]);

function fail(message) {
  process.stderr.write(`host-acceptance: ${message}\n`);
  process.exitCode = 1;
}

function comparableWindowsPath(value) {
  return value.replaceAll("/", "\\").toLowerCase();
}

function resolveTrustedFile(expectedPath, failureMessage) {
  try {
    const canonical = realpathSync.native(expectedPath);
    if (
      comparableWindowsPath(canonical) !== comparableWindowsPath(expectedPath) ||
      !statSync(canonical).isFile()
    ) {
      throw new Error("unexpected file identity");
    }
    return canonical;
  } catch {
    throw new Error(failureMessage);
  }
}

function resolveTrustedPowerShell() {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !isAbsolute(systemRoot)) {
    throw new Error("invalid SystemRoot");
  }
  const expected = resolve(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return resolveTrustedFile(expected, "invalid SystemRoot");
}

if (
  command === undefined ||
  !fixedCommands.has(command) ||
  arguments_.length !== 0
) {
  fail("unsupported command");
} else if (process.platform !== "win32" || process.arch !== "x64") {
  fail("Windows x64 is required");
} else {
  try {
    const powershell = resolveTrustedPowerShell();
    const trustedBuildScript = resolveTrustedFile(
      buildScript,
      "observer build entry is unavailable",
    );
    const result = spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        trustedBuildScript,
        "-Action",
        command,
      ],
      {
        cwd: repositoryRoot,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    if (result.error !== undefined || result.status === null) {
      fail("PowerShell execution failed");
    } else {
      process.exitCode = result.status;
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "observer build failed");
  }
}
