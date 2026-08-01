import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = resolve(repositoryRoot, "native", "windows-job-helper");
const [command, ...arguments_] = process.argv.slice(2);

const fixedCommands = new Set([
  "restore",
  "preflight",
  "test-managed",
  "test-kernel",
  "verify",
  "update-artifact",
  "test",
]);

const INTERNAL_PREFLIGHT_COMMAND = "__preflight-harness-v1";
const HEADER_BYTES = 12;
const MAX_PAYLOAD_BYTES = 1_048_576;

function encodeString(value) {
  const encoded = Buffer.from(value, "utf8");
  const result = Buffer.allocUnsafe(4 + encoded.length);
  result.writeUInt32LE(encoded.length, 0);
  encoded.copy(result, 4);
  return result;
}

function encodeFrame(type, payload) {
  const result = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  result.write("CAJ1", 0, "ascii");
  result.writeUInt16LE(1, 4);
  result.writeUInt16LE(type, 6);
  result.writeUInt32LE(payload.length, 8);
  payload.copy(result, HEADER_BYTES);
  return result;
}

function encodeConfig(mode, nonce) {
  const values = [
    encodeString("C:\\preflight\\unused.exe"),
    encodeString("C:\\preflight"),
    encodeString(mode),
    encodeString(nonce.toString(16).padStart(8, "0")),
  ];
  const argc = Buffer.alloc(4);
  argc.writeUInt32LE(2, 0);
  return encodeFrame(1, Buffer.concat([values[0], values[1], argc, values[2], values[3]]));
}

function encodeTerminate() {
  return encodeFrame(3, Buffer.from([1]));
}

function decodeAvailable(state, incoming) {
  state.buffer = Buffer.concat([state.buffer, incoming]);
  while (state.buffer.length >= HEADER_BYTES) {
    if (
      state.buffer.subarray(0, 4).toString("ascii") !== "CAJ1" ||
      state.buffer.readUInt16LE(4) !== 1
    ) {
      throw new Error("protocol");
    }
    const payloadLength = state.buffer.readUInt32LE(8);
    if (payloadLength > MAX_PAYLOAD_BYTES) throw new Error("protocol");
    const frameLength = HEADER_BYTES + payloadLength;
    if (state.buffer.length < frameLength) return;
    state.frames.push({
      type: state.buffer.readUInt16LE(6),
      payload: Buffer.from(state.buffer.subarray(HEADER_BYTES, frameLength)),
    });
    state.buffer = state.buffer.subarray(frameLength);
  }
}

async function writeFragments(stream, value) {
  let offset = 0;
  for (const length of [1, 2, 5, 3, 11]) {
    if (offset >= value.length) break;
    const end = Math.min(value.length, offset + length);
    stream.write(value.subarray(offset, end));
    offset = end;
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  }
  if (offset < value.length) stream.write(value.subarray(offset));
}

async function runProbeCase(probePath, options) {
  return await new Promise((resolveCase) => {
    const child = spawn(probePath, [options.invalid ? "--invalid" : "--control-v1"], {
      stdio: ["ignore", "pipe", "pipe", "overlapped"],
      windowsHide: true,
    });
    const control = child.stdio[3];
    const state = { buffer: Buffer.alloc(0), frames: [] };
    const stdout = [];
    const stderr = [];
    let streamEnded = false;
    let streamClosed = false;
    let streamError = false;
    let processError = false;
    let timedOut = false;
    let terminateSent = options.merged === true;
    let finished = false;
    let processClosed = false;
    let processCode = null;
    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        child.kill();
        control.destroy();
      }
    }, 10_000);

    const finish = () => {
      if (finished || !processClosed || !streamClosed) return;
      finished = true;
      clearTimeout(timer);
      const terminalIndex = state.frames.findIndex((frame) => frame.type === 5);
      const readyIndex = state.frames.findIndex((frame) => frame.type === 2);
      const terminal = terminalIndex < 0 ? undefined : state.frames[terminalIndex];
      const terminalNonce =
        terminal?.payload.length === 8 ? terminal.payload.readUInt32LE(0) : undefined;
      const success =
        !options.invalid &&
        !options.prematureClose &&
        !processError &&
        !streamError &&
        processCode === 0 &&
        stdout.length === 0 &&
        stderr.length === 0 &&
        state.buffer.length === 0 &&
        state.frames.length === 2 &&
        readyIndex === 0 &&
        state.frames[readyIndex]?.payload.length === 0 &&
        terminalIndex === 1 &&
        terminalNonce === options.nonce &&
        terminal.payload[4] === options.expectedReason &&
        terminal.payload[5] === 1 &&
        terminal.payload.readUInt16LE(6) === 0 &&
        streamEnded;
      const quietClosedFailure =
        !timedOut &&
        !processError &&
        stdout.length === 0 &&
        stderr.length === 0 &&
        state.buffer.length === 0;
      const expectedFailure =
        quietClosedFailure &&
        ((options.invalid === true &&
          !streamError &&
          streamEnded &&
          processCode === 64 &&
          state.frames.length === 0) ||
          (options.prematureClose === true &&
            processCode === 68 &&
            terminalIndex === -1 &&
            (streamEnded || streamError) &&
            state.frames.length <= 1 &&
            state.frames.every((frame) => frame.type === 2)));
      resolveCase({
        success,
        expectedFailure,
        diagnostic: {
          code: processCode,
          timedOut,
          processError,
          streamError,
          streamEnded,
          streamClosed,
          bufferedBytes: state.buffer.length,
          frameTypes: state.frames.map((frame) => frame.type),
          stdoutChunks: stdout.length,
          stderrChunks: stderr.length,
        },
      });
    };

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    control.on("data", (chunk) => {
      try {
        decodeAvailable(state, Buffer.from(chunk));
        if (
          options.mode === "explicit" &&
          !terminateSent &&
          state.frames.some((frame) => frame.type === 2)
        ) {
          terminateSent = true;
          void writeFragments(control, encodeTerminate()).catch(() => {
            streamError = true;
            child.kill();
          });
        }
      } catch {
        streamError = true;
      }
    });
    control.on("end", () => {
      streamEnded = true;
    });
    control.on("close", () => {
      streamClosed = true;
      finish();
    });
    control.on("error", () => {
      streamError = true;
    });
    child.on("error", () => {
      processError = true;
    });
    child.on("close", (code) => {
      processClosed = true;
      processCode = code;
      finish();
    });

    if (options.invalid) return;
    const config = encodeConfig(options.mode, options.nonce);
    if (options.merged) {
      control.write(Buffer.concat([config, encodeTerminate()]));
    } else {
      void writeFragments(control, config)
        .then(() => {
          if (options.prematureClose) control.end();
        })
        .catch(() => {
          streamError = true;
          child.kill();
        });
    }
  });
}

async function runInternalPreflightHarness(probeArgument) {
  if (
    process.env.CODEX_WINDOWS_NATIVE_PREFLIGHT_INTERNAL !== "1" ||
    arguments_.length !== 1 ||
    typeof probeArgument !== "string" ||
    !isAbsolute(probeArgument)
  ) {
    return false;
  }
  let probePath;
  try {
    probePath = realpathSync.native(probeArgument);
  } catch {
    return false;
  }
  const normalized = normalize(probePath);
  if (
    !normalized.toLowerCase().includes(
      normalize("codex-agent-tools\\windows-job-helper\\build-v1").toLowerCase(),
    ) ||
    !normalized.toLowerCase().endsWith(
      normalize("generated\\Fd3Preflight.exe").toLowerCase(),
    ) ||
    !statSync(probePath).isFile()
  ) {
    return false;
  }
  const base = randomBytes(4).readUInt32LE(0);
  const cases = await Promise.all([
    runProbeCase(probePath, {
      mode: "explicit",
      nonce: base,
      merged: false,
      expectedReason: 1,
    }),
    runProbeCase(probePath, {
      mode: "explicit",
      nonce: (base + 1) >>> 0,
      merged: true,
      expectedReason: 1,
    }),
    runProbeCase(probePath, {
      mode: "autonomous",
      nonce: (base + 2) >>> 0,
      expectedReason: 0,
    }),
  ]);
  const premature = await runProbeCase(probePath, {
    mode: "explicit",
    nonce: (base + 3) >>> 0,
    prematureClose: true,
  });
  const abnormal = await runProbeCase(probePath, {
    mode: "explicit",
    nonce: (base + 4) >>> 0,
    invalid: true,
  });
  if (
    cases.some((result) => !result.success) ||
    !premature.expectedFailure ||
    premature.success ||
    !abnormal.expectedFailure ||
    abnormal.success
  ) {
    process.stderr.write(
      `windows-native-helper: fd3 diagnostics ${JSON.stringify({ cases, premature, abnormal })}\n`,
    );
    return false;
  }
  process.stdout.write(
    `windows-native-helper: preflight passed node=${process.version} libuv=${process.versions.uv} cases=5\n`,
  );
  return true;
}

function fail(message) {
  process.stderr.write(`windows-native-helper: ${message}\n`);
  process.exitCode = 1;
}

function parseFilter(commandName, argumentsList) {
  if (argumentsList.length === 0) {
    return "";
  }
  if (
    commandName === "test-managed" &&
    argumentsList.length === 2 &&
    argumentsList[0] === "--filter" &&
    new Set(["Protocol", "CommandLine", "LifecycleMachine"]).has(argumentsList[1])
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

if (command === INTERNAL_PREFLIGHT_COMMAND) {
  const ok = await runInternalPreflightHarness(arguments_[0]);
  if (!ok) fail("fd3 preflight failed");
} else if (command === undefined || !fixedCommands.has(command)) {
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
      if (command === "preflight") {
        let nodePath;
        try {
          nodePath = realpathSync.native(process.execPath);
        } catch {
          fail("current Node runtime is unavailable");
        }
        if (nodePath !== undefined) {
          powershellArguments.push(
            "-InternalNodePath",
            nodePath,
            "-InternalHarnessPath",
            fileURLToPath(import.meta.url),
          );
        }
      }
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
        stdio: command === "preflight" ? "pipe" : "inherit",
        encoding: command === "preflight" ? "utf8" : undefined,
        windowsHide: true,
      });
      if (result.error !== undefined || result.status === null) {
        fail("PowerShell execution failed");
      } else if (command === "preflight") {
        if (result.status !== 0) {
          fail("fd3 preflight failed");
        } else {
          const report = result.stdout
            .split(/\r?\n/u)
            .find((line) =>
              /^windows-native-helper: preflight passed node=v\d+\.\d+\.\d+ libuv=\d+\.\d+\.\d+ cases=5$/u.test(line),
            );
          if (report === undefined) {
            fail("fd3 preflight failed");
          } else {
            process.stdout.write(`${report}\n`);
          }
        }
      } else {
        process.exitCode = result.status;
      }
    }
  }
}
