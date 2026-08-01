import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = resolve(repositoryRoot, "native", "windows-job-helper");
const [command, ...arguments_] = process.argv.slice(2);

const fixedCommands = new Set([
  "restore",
  "preflight",
  "preflight-current",
  "test-managed",
  "test-kernel",
  "verify",
  "update-artifact",
  "test",
]);

function fail(message) {
  process.stderr.write(`windows-native-helper: ${message}\n`);
  process.exitCode = 1;
}

function parseFilter(commandName, argumentsList) {
  if (argumentsList.length === 0) {
    return "";
  }
  if (
    (commandName === "test-managed" || commandName === "test-kernel") &&
    argumentsList.length === 2 &&
    argumentsList[0] === "--filter" &&
    /^[A-Za-z][A-Za-z0-9_.-]*$/.test(argumentsList[1])
  ) {
    return argumentsList[1];
  }
  return null;
}

function comparableWindowsPath(path) {
  return normalize(path).replace(/[\\/]+$/u, "").toLowerCase();
}

function resolveTrustedPowerShell() {
  // SystemRoot is the inherited OS trust anchor. cwd and PATH are deliberately
  // excluded; missing, aliased, redirected, or non-canonical roots fail closed.
  const configuredSystemRoot = process.env.SystemRoot;
  if (
    typeof configuredSystemRoot !== "string" ||
    configuredSystemRoot.length === 0 ||
    configuredSystemRoot.includes("\0") ||
    !isAbsolute(configuredSystemRoot)
  ) {
    throw new Error("invalid SystemRoot");
  }
  const systemRoot = realpathSync.native(configuredSystemRoot);
  if (
    comparableWindowsPath(systemRoot) !==
    comparableWindowsPath(configuredSystemRoot)
  ) {
    throw new Error("invalid SystemRoot");
  }
  const expectedPowerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const powershell = realpathSync.native(expectedPowerShell);
  if (
    comparableWindowsPath(powershell) !==
      comparableWindowsPath(expectedPowerShell) ||
    !statSync(powershell).isFile()
  ) {
    throw new Error("invalid SystemRoot");
  }
  return powershell;
}

if (command === undefined || !fixedCommands.has(command)) {
  fail("unsupported command");
} else {
  const filter = parseFilter(command, arguments_);
  if (filter === null) {
    fail("unsupported arguments");
} else if (process.platform !== "win32") {
  fail("Windows x64 is required");
} else if (process.arch !== "x64") {
  fail("Windows x64 is required");
} else {
    const script = resolve(
      nativeRoot,
      command === "restore" ? "restore-toolchain.ps1" : "build.ps1",
    );
    const powershellArguments = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
    ];
    if (command !== "restore") {
      powershellArguments.push("-Action", command);
      if (filter !== "") {
        powershellArguments.push("-Filter", filter);
      }
    }
    let powershell;
    try {
      powershell = resolveTrustedPowerShell();
    } catch {
      fail("invalid SystemRoot");
    }
    if (powershell !== undefined) {
      const result = spawnSync(powershell, powershellArguments, {
        cwd: repositoryRoot,
        stdio: "inherit",
        windowsHide: true,
      });
      if (result.error !== undefined || result.status === null) {
        fail("PowerShell execution failed");
      } else {
        process.exitCode = result.status;
      }
    }
  }
}
