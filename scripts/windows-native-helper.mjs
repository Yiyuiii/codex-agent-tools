import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
const INTERNAL_PRODUCTION_CARRIER_COMMAND = "__production-carrier-v1";
const INTERNAL_CRASH_CARRIER_COMMAND = "__crash-carrier-v1";
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
  return encodeFrame(
    1,
    Buffer.concat([values[0], values[1], argc, values[2], values[3]]),
  );
}

function encodeLaunchConfig(executable, cwd, argumentsList) {
  const argc = Buffer.alloc(4);
  argc.writeUInt32LE(argumentsList.length, 0);
  return encodeFrame(
    1,
    Buffer.concat([
      encodeString(executable),
      encodeString(cwd),
      argc,
      ...argumentsList.map((argument) => encodeString(argument)),
    ]),
  );
}

function encodeTerminate() {
  return encodeFrame(3, Buffer.from([1]));
}

function encodeMalformedFrame() {
  const result = encodeTerminate();
  result.write("BAD!", 0, "ascii");
  return result;
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

function canOpenOwnedWitness(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r+");
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function waitForOwnedWitnessesHeld(paths) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      paths.every((path) => existsSync(path)) &&
      paths.every((path) => !canOpenOwnedWitness(path))
    ) {
      return true;
    }
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));
  }
  return false;
}

function writeNonceMarkerCreateNew(path, nonce) {
  writeFileSync(path, nonce, { encoding: "utf8", flag: "wx", flush: true });
}

async function waitForNonceMarker(path, nonce, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const contents = readFileSync(path, "utf8");
        if (contents === nonce) return true;
        if (contents.length > nonce.length || !nonce.startsWith(contents)) {
          return false;
        }
      } catch {}
    }
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));
  }
  return false;
}

async function waitForPaths(paths, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) return true;
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));
  }
  return false;
}

async function runProbeCase(probePath, options) {
  return await new Promise((resolveCase) => {
    const child = spawn(
      probePath,
      [options.invalid ? "--invalid" : "--control-v1"],
      {
        stdio: ["ignore", "pipe", "pipe", "overlapped"],
        windowsHide: true,
      },
    );
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
      const terminal =
        terminalIndex < 0 ? undefined : state.frames[terminalIndex];
      const terminalNonce =
        terminal?.payload.length === 8
          ? terminal.payload.readUInt32LE(0)
          : undefined;
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
    !normalized
      .toLowerCase()
      .includes(
        normalize(
          "codex-agent-tools\\windows-job-helper\\build-v1",
        ).toLowerCase(),
      ) ||
    !normalized
      .toLowerCase()
      .endsWith(normalize("generated\\Fd3Preflight.exe").toLowerCase()) ||
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

async function runProductionCarrierCase(helperPath, fixturePath, mode) {
  const caseRoot = mkdtempSync(join(tmpdir(), `cat-native-program-${mode}-`));
  const rootMarker = join(caseRoot, "root.marker");
  const childMarker = join(caseRoot, "child.marker");
  const hasOwnedWitnesses = mode === "eof" || mode === "protocol";
  const ownedWitnesses = hasOwnedWitnesses ? [rootMarker, childMarker] : [];
  const argumentsList =
    mode === "natural"
      ? ["--root-with-grandchild", rootMarker, childMarker]
      : hasOwnedWitnesses
        ? ["--root-block-with-grandchild", rootMarker, childMarker]
        : ["--block", rootMarker];
  return await new Promise((resolveCase) => {
    const child = spawn(helperPath, ["--control-v1"], {
      stdio: ["ignore", "pipe", "pipe", "overlapped"],
      windowsHide: true,
    });
    const control = child.stdio[3];
    const state = { buffer: Buffer.alloc(0), frames: [] };
    const stdout = [];
    const stderr = [];
    let processClosed = false;
    let processCode = null;
    let stdoutClosed = false;
    let stderrClosed = false;
    let streamEnded = false;
    let streamClosed = false;
    let streamError = false;
    let decodeError = false;
    let processError = false;
    let terminateSent = false;
    let controlActionStarted = false;
    let controlActionSent = false;
    let controlActionFailed = false;
    let witnessesHeld = false;
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        child.kill();
        control.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }, 15_000);

    const finish = () => {
      if (
        finished ||
        !processClosed ||
        !streamClosed ||
        !stdoutClosed ||
        !stderrClosed
      )
        return;
      finished = true;
      clearTimeout(timer);
      const ready = state.frames[0];
      const terminal = state.frames[1];
      const expectedReason = mode === "natural" ? 0 : 1;
      const expectedExitCode = mode === "natural" ? 0 : 1;
      const markersValid =
        mode === "natural"
          ? existsSync(rootMarker) && existsSync(childMarker)
          : true;
      const witnessesReleased =
        !hasOwnedWitnesses || ownedWitnesses.every(canOpenOwnedWitness);
      const commonSuccess =
        !timedOut &&
        !processError &&
        !decodeError &&
        stdoutClosed &&
        stderrClosed &&
        stdout.length === 0 &&
        stderr.length === 0 &&
        ready?.type === 2 &&
        ready.payload.length === 0 &&
        markersValid;
      const normalSuccess =
        commonSuccess &&
        !streamError &&
        processCode === 0 &&
        streamEnded &&
        state.buffer.length === 0 &&
        state.frames.length === 2 &&
        terminal?.type === 5 &&
        terminal.payload.length === 8 &&
        terminal.payload.readUInt32LE(0) === expectedExitCode &&
        terminal.payload[4] === expectedReason &&
        terminal.payload[5] === 1 &&
        terminal.payload.readUInt16LE(6) === 0 &&
        (mode === "natural" || terminateSent);
      const eofTerminalValid =
        terminal === undefined ||
        (terminal.type === 4 &&
          terminal.payload.length === 8 &&
          terminal.payload.readUInt16LE(0) === 14 &&
          terminal.payload[2] === 3 &&
          terminal.payload[3] === 0 &&
          terminal.payload.readUInt32LE(4) === 0);
      const eofSuccess =
        commonSuccess &&
        mode === "eof" &&
        processCode === 68 &&
        controlActionSent &&
        !controlActionFailed &&
        witnessesHeld &&
        witnessesReleased &&
        state.frames.length >= 1 &&
        state.frames.length <= 2 &&
        eofTerminalValid;
      const protocolSuccess =
        commonSuccess &&
        mode === "protocol" &&
        !streamError &&
        processCode === 68 &&
        streamEnded &&
        state.buffer.length === 0 &&
        state.frames.length === 2 &&
        controlActionSent &&
        !controlActionFailed &&
        witnessesHeld &&
        witnessesReleased &&
        terminal?.type === 4 &&
        terminal.payload.length === 8 &&
        terminal.payload.readUInt16LE(0) === 1 &&
        terminal.payload[2] === 4 &&
        terminal.payload[3] === 0 &&
        terminal.payload.readUInt32LE(4) === 0;
      const success =
        mode === "eof"
          ? eofSuccess
          : mode === "protocol"
            ? protocolSuccess
            : normalSuccess;
      const diagnostic = {
        mode,
        code: processCode,
        timedOut,
        processError,
        streamError,
        decodeError,
        streamEnded,
        streamClosed,
        stdoutClosed,
        stderrClosed,
        bufferedBytes: state.buffer.length,
        frameTypes: state.frames.map((frame) => frame.type),
        stdoutChunks: stdout.length,
        stderrChunks: stderr.length,
        terminateSent,
        controlActionStarted,
        controlActionSent,
        controlActionFailed,
        markersValid,
        witnessesHeld,
        witnessesReleased,
      };
      try {
        rmSync(caseRoot, { recursive: true, force: true });
      } catch {
        diagnostic.cleanupFailed = true;
      }
      resolveCase({
        success: success && diagnostic.cleanupFailed !== true,
        diagnostic,
      });
    };

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.stdout.on("close", () => {
      stdoutClosed = true;
      finish();
    });
    child.stderr.on("close", () => {
      stderrClosed = true;
      finish();
    });
    control.on("data", (chunk) => {
      try {
        decodeAvailable(state, Buffer.from(chunk));
        if (
          mode === "cancel" &&
          !terminateSent &&
          state.frames.some((frame) => frame.type === 2)
        ) {
          terminateSent = true;
          void writeFragments(control, encodeTerminate()).catch(() => {
            streamError = true;
            child.kill();
          });
        }
        if (
          hasOwnedWitnesses &&
          !controlActionStarted &&
          state.frames.some((frame) => frame.type === 2)
        ) {
          controlActionStarted = true;
          void waitForOwnedWitnessesHeld(ownedWitnesses)
            .then(async (held) => {
              if (!held) throw new Error("owned witness was not acquired");
              witnessesHeld = true;
              controlActionSent = true;
              if (mode === "eof") {
                control.end();
              } else {
                await writeFragments(control, encodeMalformedFrame());
              }
            })
            .catch(() => {
              controlActionFailed = true;
              child.kill();
              control.destroy();
            });
        }
      } catch {
        decodeError = true;
        child.kill();
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

    void writeFragments(
      control,
      encodeLaunchConfig(fixturePath, caseRoot, argumentsList),
    ).catch(() => {
      streamError = true;
      child.kill();
    });
  });
}

async function runInternalProductionCarrier(helperArgument, fixtureArgument) {
  if (
    process.env.CODEX_WINDOWS_NATIVE_CARRIER_INTERNAL !== "1" ||
    arguments_.length !== 2 ||
    !isAbsolute(helperArgument) ||
    !isAbsolute(fixtureArgument)
  ) {
    return false;
  }
  let helperPath;
  let fixturePath;
  try {
    helperPath = realpathSync.native(helperArgument);
    fixturePath = realpathSync.native(fixtureArgument);
  } catch {
    return false;
  }
  const expectedRootFragment = normalize(
    "codex-agent-tools\\windows-job-helper\\build-v1",
  ).toLowerCase();
  if (
    !normalize(helperPath).toLowerCase().includes(expectedRootFragment) ||
    !normalize(fixturePath).toLowerCase().includes(expectedRootFragment) ||
    normalize(dirname(helperPath)).toLowerCase() !==
      normalize(dirname(fixturePath)).toLowerCase() ||
    !normalize(helperPath)
      .toLowerCase()
      .endsWith(normalize("generated\\WindowsJobHelper.exe").toLowerCase()) ||
    !normalize(fixturePath)
      .toLowerCase()
      .endsWith(normalize("generated\\KernelFixture.exe").toLowerCase()) ||
    !statSync(helperPath).isFile() ||
    !statSync(fixturePath).isFile()
  ) {
    return false;
  }
  const cases = await Promise.all([
    runProductionCarrierCase(helperPath, fixturePath, "natural"),
    runProductionCarrierCase(helperPath, fixturePath, "cancel"),
    runProductionCarrierCase(helperPath, fixturePath, "eof"),
    runProductionCarrierCase(helperPath, fixturePath, "protocol"),
  ]);
  if (cases.some((result) => !result.success)) {
    process.stderr.write(
      `windows-native-helper: production carrier diagnostics ${JSON.stringify(cases)}\n`,
    );
    return false;
  }
  process.stdout.write(
    "windows-native-helper: production carrier passed cases=4\n",
  );
  return true;
}

async function runInternalCrashCarrier(
  mode,
  helperArgument,
  fixtureArgument,
  caseRootArgument,
  readyMarker,
  goMarker,
  doneMarker,
  rootLock,
  childLock,
  nonce,
) {
  if (
    process.env.CODEX_WINDOWS_NATIVE_CRASH_INTERNAL !== "1" ||
    arguments_.length !== 10 ||
    !new Set(["helper-kill", "parent-death"]).has(mode) ||
    !/^[0-9a-f]{32}$/u.test(nonce) ||
    ![
      helperArgument,
      fixtureArgument,
      caseRootArgument,
      readyMarker,
      goMarker,
      doneMarker,
      rootLock,
      childLock,
    ].every((value) => typeof value === "string" && isAbsolute(value))
  ) {
    return false;
  }

  let helperPath;
  let fixturePath;
  let caseRoot;
  try {
    helperPath = realpathSync.native(helperArgument);
    fixturePath = realpathSync.native(fixtureArgument);
    caseRoot = realpathSync.native(caseRootArgument);
  } catch {
    return false;
  }
  const expectedRootFragment = normalize(
    "codex-agent-tools\\windows-job-helper\\build-v1",
  ).toLowerCase();
  const expectedCasePaths = [
    [readyMarker, "ready.marker"],
    [goMarker, "go.marker"],
    [doneMarker, "done.marker"],
    [rootLock, "root.lock"],
    [childLock, "child.lock"],
  ];
  if (
    !normalize(helperPath).toLowerCase().includes(expectedRootFragment) ||
    !normalize(fixturePath).toLowerCase().includes(expectedRootFragment) ||
    comparableWindowsPath(dirname(helperPath)) !==
      comparableWindowsPath(dirname(fixturePath)) ||
    !normalize(helperPath)
      .toLowerCase()
      .endsWith(normalize("generated\\WindowsJobHelper.exe").toLowerCase()) ||
    !normalize(fixturePath)
      .toLowerCase()
      .endsWith(normalize("generated\\KernelFixture.exe").toLowerCase()) ||
    !statSync(helperPath).isFile() ||
    !statSync(fixturePath).isFile() ||
    comparableWindowsPath(caseRoot) !==
      comparableWindowsPath(caseRootArgument) ||
    expectedCasePaths.some(
      ([path, name]) =>
        comparableWindowsPath(path) !==
          comparableWindowsPath(join(caseRoot, name)) || existsSync(path),
    )
  ) {
    return false;
  }

  return await new Promise((resolveCase) => {
    const child = spawn(helperPath, ["--control-v1"], {
      stdio: ["ignore", "pipe", "pipe", "overlapped"],
      windowsHide: true,
    });
    const control = child.stdio[3];
    const state = { buffer: Buffer.alloc(0), frames: [] };
    const stdout = [];
    const stderr = [];
    let readyStarted = false;
    let killReturned = false;
    let processClosed = false;
    let processCode = null;
    let processSignal = null;
    let controlClosed = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let processError = false;
    let decodeError = false;
    let fatal = false;
    let timedOut = false;
    let finished = false;

    const recordParentFailure = () => {
      if (mode !== "parent-death" || existsSync(doneMarker)) return;
      try {
        writeNonceMarkerCreateNew(doneMarker, nonce);
      } catch {}
    };

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      fatal = true;
      recordParentFailure();
      child.kill();
      control.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }, 15_000);

    const finish = () => {
      if (
        finished ||
        !processClosed ||
        !controlClosed ||
        !stdoutClosed ||
        !stderrClosed
      ) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      const ready = state.frames[0];
      const success =
        mode === "helper-kill" &&
        !fatal &&
        !timedOut &&
        !processError &&
        !decodeError &&
        killReturned &&
        processCode !== 0 &&
        (processSignal !== null || processCode !== null) &&
        stdout.length === 0 &&
        stderr.length === 0 &&
        state.frames.length === 1 &&
        ready?.type === 2 &&
        ready.payload.length === 0;
      if (success) {
        try {
          writeNonceMarkerCreateNew(doneMarker, nonce);
        } catch {
          resolveCase(false);
          return;
        }
      }
      resolveCase(success);
    };

    const failAndSettle = () => {
      fatal = true;
      recordParentFailure();
      child.kill();
      control.destroy();
    };

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.stdout.on("close", () => {
      stdoutClosed = true;
      finish();
    });
    child.stderr.on("close", () => {
      stderrClosed = true;
      finish();
    });
    control.on("data", (chunk) => {
      try {
        decodeAvailable(state, Buffer.from(chunk));
      } catch {
        decodeError = true;
        failAndSettle();
        return;
      }
      if (
        !readyStarted &&
        state.frames.length === 1 &&
        state.frames[0]?.type === 2 &&
        state.frames[0].payload.length === 0
      ) {
        readyStarted = true;
        void (async () => {
          if (!(await waitForPaths([rootLock, childLock], 5_000))) {
            throw new Error("crash witnesses unavailable");
          }
          writeNonceMarkerCreateNew(readyMarker, nonce);
          if (mode === "helper-kill") {
            if (!(await waitForNonceMarker(goMarker, nonce, 5_000))) {
              throw new Error("crash go marker unavailable");
            }
            killReturned = child.kill();
            if (!killReturned) throw new Error("helper kill failed");
          }
        })().catch(failAndSettle);
      } else if (state.frames.length !== 1 || state.frames[0]?.type !== 2) {
        failAndSettle();
      }
    });
    control.on("close", () => {
      controlClosed = true;
      finish();
    });
    control.on("error", () => {
      if (!killReturned) failAndSettle();
    });
    child.on("error", () => {
      processError = true;
    });
    child.on("close", (code, signal) => {
      processClosed = true;
      processCode = code;
      processSignal = signal;
      finish();
    });

    void writeFragments(
      control,
      encodeLaunchConfig(fixturePath, caseRoot, [
        "--crash-root-with-grandchild",
        rootLock,
        childLock,
        nonce,
      ]),
    ).catch(failAndSettle);
  });
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
    new Set([
      "Protocol",
      "CommandLine",
      "ControlChannel",
      "LifecycleMachine",
      "SessionCoordinator",
    ]).has(argumentsList[1])
  ) {
    return argumentsList[1];
  }
  return null;
}

function comparableWindowsPath(path) {
  return normalize(path)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
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
  const expectedPowerShell = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
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
} else if (command === INTERNAL_PRODUCTION_CARRIER_COMMAND) {
  const ok = await runInternalProductionCarrier(arguments_[0], arguments_[1]);
  if (!ok) fail("production carrier failed");
} else if (command === INTERNAL_CRASH_CARRIER_COMMAND) {
  const ok = await runInternalCrashCarrier(...arguments_);
  if (!ok) fail("crash carrier failed");
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
      if (command === "preflight" || command === "test-kernel") {
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
              /^windows-native-helper: preflight passed node=v\d+\.\d+\.\d+ libuv=\d+\.\d+\.\d+ cases=5$/u.test(
                line,
              ),
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
