import { describe, expect, it } from "vitest";

import {
  WINDOWS_JOB_PROTOCOL,
  WINDOWS_JOB_STAGE_MESSAGES,
  WindowsJobFrameDecoder,
  decodeWindowsJobFrame,
  encodeWindowsJobFrame,
} from "../../src/runtime/windows-job-protocol.js";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replaceAll(/\s/g, ""), "hex"));
}

function rawFrame(type: number, payload: Uint8Array): Uint8Array {
  const frame = Buffer.alloc(12 + payload.length);
  frame.write("CAJ1", 0, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt16LE(type, 6);
  frame.writeUInt32LE(payload.length, 8);
  frame.set(payload, 12);
  return frame;
}

describe("Windows job protocol v1", () => {
  function expectProtocolError(frame: unknown): void {
    let thrown: unknown;
    try {
      encodeWindowsJobFrame(frame as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Windows job protocol violation.");
  }

  function expectDeeplyFrozen(value: unknown): void {
    if (typeof value !== "object" || value === null) {
      return;
    }
    expect(Object.isFrozen(value)).toBe(true);
    for (const nested of Object.values(value)) {
      expectDeeplyFrozen(nested);
    }
  }

  it("exports the canonical frozen contract", () => {
    expect(WINDOWS_JOB_PROTOCOL).toEqual({
      schemaVersion: 1,
      mode: { control: "--control-v1", probe: "--probe-v1" },
      frame: {
        magic: "CAJ1",
        version: 1,
        headerBytes: 12,
        maxPayloadBytes: 1_048_576,
      },
      limits: {
        maxStringBytes: 65_536,
        maxArgCount: 1_024,
        maxNativeCommandLineUtf16UnitsIncludingNul: 32_767,
      },
      messageType: {
        launchConfig: 1,
        ready: 2,
        terminate: 3,
        error: 4,
        exit: 5,
      },
      reason: {
        noneOrRootExit: 0,
        cancelled: 1,
        timedOut: 2,
        sessionShutdown: 3,
        protocolError: 4,
      },
      stage: {
        protocolInvalid: 1,
        cancelledBeforeReady: 2,
        jobCreateFailed: 3,
        jobConfigFailed: 4,
        stdioDuplicateFailed: 5,
        attributeListInitFailed: 6,
        handleListAttributeFailed: 7,
        jobListAttributeFailed: 8,
        commandLineInvalid: 9,
        createFailed: 10,
        resumeFailed: 11,
        terminateJobFailed: 12,
        queryJobFailed: 13,
        controlChannelFailed: 14,
        helperInternal: 15,
        waitFailed: 16,
      },
    });

    if (false) {
      // @ts-expect-error nested protocol values are recursively readonly
      WINDOWS_JOB_PROTOCOL.frame.magic = "BAD!";
    }
  });

  it("deeply freezes a private protocol snapshot against runtime mutation", () => {
    expectDeeplyFrozen(WINDOWS_JOB_PROTOCOL);
    const originalPayloadLimit = WINDOWS_JOB_PROTOCOL.frame.maxPayloadBytes;
    const originalMagic = WINDOWS_JOB_PROTOCOL.frame.magic;
    const originalCancelled = WINDOWS_JOB_PROTOCOL.reason.cancelled;

    for (const mutate of [
      () =>
        Reflect.set(
          WINDOWS_JOB_PROTOCOL.frame,
          "maxPayloadBytes",
          originalPayloadLimit + 1,
        ),
      () => Reflect.set(WINDOWS_JOB_PROTOCOL.frame, "magic", "BAD!"),
      () => Reflect.set(WINDOWS_JOB_PROTOCOL.reason, "cancelled", 99),
    ]) {
      expect(mutate()).toBe(false);
    }
    expect(WINDOWS_JOB_PROTOCOL.frame.maxPayloadBytes).toBe(originalPayloadLimit);
    expect(WINDOWS_JOB_PROTOCOL.frame.magic).toBe(originalMagic);
    expect(WINDOWS_JOB_PROTOCOL.reason.cancelled).toBe(originalCancelled);
    expect(() =>
      encodeWindowsJobFrame({
        type: "launchConfig",
        executable: "C:\\x.exe",
        cwd: "C:\\w",
        argv: Array.from({ length: 17 }, () => "x".repeat(65_536)),
      }),
    ).toThrowError("Windows job protocol violation.");
  });

  it("matches fixed golden vectors for every message payload", () => {
    const vectors = [
      {
        frame: {
          type: "launchConfig" as const,
          executable: "C:\\x.exe",
          cwd: "C:\\w",
          argv: ["ok"],
        },
        encoded: bytes(`
          43 41 4a 31  01 00  01 00  1e 00 00 00
          08 00 00 00  43 3a 5c 78 2e 65 78 65
          04 00 00 00  43 3a 5c 77
          01 00 00 00
          02 00 00 00  6f 6b
        `),
      },
      {
        frame: { type: "ready" as const },
        encoded: bytes("43 41 4a 31 01 00 02 00 00 00 00 00"),
      },
      {
        frame: { type: "terminate" as const, reason: "timedOut" as const },
        encoded: bytes("43 41 4a 31 01 00 03 00 01 00 00 00 02"),
      },
      {
        frame: {
          type: "error" as const,
          stage: "createFailed" as const,
          reason: "cancelled" as const,
          win32Code: 5,
        },
        encoded: bytes(
          "43 41 4a 31 01 00 04 00 08 00 00 00 0a 00 01 01 05 00 00 00",
        ),
      },
      {
        frame: {
          type: "exit" as const,
          rootExitCode: 7,
          reason: "timedOut" as const,
          jobActiveProcessesZero: true as const,
        },
        encoded: bytes(
          "43 41 4a 31 01 00 05 00 08 00 00 00 07 00 00 00 02 01 00 00",
        ),
      },
    ];

    for (const vector of vectors) {
      expect(encodeWindowsJobFrame(vector.frame)).toEqual(vector.encoded);
      expect(decodeWindowsJobFrame(vector.encoded)).toEqual(vector.frame);
    }

    const noWin32Code = {
      type: "error" as const,
      stage: "protocolInvalid" as const,
      reason: "protocolError" as const,
      win32Code: null,
    };
    expect(decodeWindowsJobFrame(encodeWindowsJobFrame(noWin32Code))).toEqual(
      noWin32Code,
    );
  });

  it("decodes short reads and multiple frames delivered together", () => {
    const ready = encodeWindowsJobFrame({ type: "ready" });
    const exit = encodeWindowsJobFrame({
      type: "exit",
      rootExitCode: 0,
      reason: "noneOrRootExit",
      jobActiveProcessesZero: true,
    });
    const merged = Buffer.concat([ready, exit]);
    const decoder = new WindowsJobFrameDecoder();

    expect(decoder.push(merged.subarray(0, 3))).toEqual([]);
    expect(decoder.push(merged.subarray(3, 11))).toEqual([]);
    expect(decoder.push(merged.subarray(11, 17))).toEqual([{ type: "ready" }]);
    expect(decoder.push(merged.subarray(17))).toEqual([
      {
        type: "exit",
        rootExitCode: 0,
        reason: "noneOrRootExit",
        jobActiveProcessesZero: true,
      },
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("copies a combined frame batch linearly and retains only one bounded tail", () => {
    const ready = Buffer.from(encodeWindowsJobFrame({ type: "ready" }));
    const frameCount = 512;
    const shortTail = ready.subarray(0, 7);
    const combined = Buffer.concat([
      ...Array.from({ length: frameCount }, () => ready),
      shortTail,
    ]);
    const originalDescriptor = Object.getOwnPropertyDescriptor(Buffer, "from");
    const originalFrom = Buffer.from;
    let copiedBytes = 0;
    let largestCopy = 0;
    Object.defineProperty(Buffer, "from", {
      ...originalDescriptor,
      value(value: unknown, ...arguments_: unknown[]) {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
          copiedBytes += value.byteLength;
          largestCopy = Math.max(largestCopy, value.byteLength);
        }
        return Reflect.apply(originalFrom, Buffer, [value, ...arguments_]) as Buffer;
      },
    });
    try {
      const decoder = new WindowsJobFrameDecoder();
      expect(decoder.push(combined)).toHaveLength(frameCount);
      expect(copiedBytes).toBeLessThanOrEqual(combined.length * 2);
      expect(decoder.push(ready.subarray(7))).toEqual([{ type: "ready" }]);
      expect(() => decoder.finish()).not.toThrow();

      copiedBytes = 0;
      largestCopy = 0;
      const maximumPayload = WINDOWS_JOB_PROTOCOL.frame.maxPayloadBytes;
      const maximumIncomplete = Buffer.alloc(
        WINDOWS_JOB_PROTOCOL.frame.headerBytes + maximumPayload - 1,
      );
      maximumIncomplete.write("CAJ1", 0, "ascii");
      maximumIncomplete.writeUInt16LE(1, 4);
      maximumIncomplete.writeUInt16LE(1, 6);
      maximumIncomplete.writeUInt32LE(maximumPayload, 8);
      const maximumDecoder = new WindowsJobFrameDecoder();
      expect(maximumDecoder.push(maximumIncomplete)).toEqual([]);
      expect(largestCopy).toBeLessThanOrEqual(
        WINDOWS_JOB_PROTOCOL.frame.headerBytes + maximumPayload,
      );
      expect(() => maximumDecoder.push(Uint8Array.of(0))).toThrowError(
        "Windows job protocol violation.",
      );
      expect(() => maximumDecoder.push(Uint8Array.of(0))).toThrowError(
        "Windows job protocol violation.",
      );
    } finally {
      if (originalDescriptor === undefined) {
        throw new Error("Buffer.from descriptor is unavailable");
      }
      Object.defineProperty(Buffer, "from", originalDescriptor);
    }
  });

  it("copies an incomplete maximum frame linearly across hundreds of pushes", () => {
    const maximumPayload = WINDOWS_JOB_PROTOCOL.frame.maxPayloadBytes;
    const incomplete = Buffer.alloc(
      WINDOWS_JOB_PROTOCOL.frame.headerBytes + maximumPayload - 1,
    );
    incomplete.write("CAJ1", 0, "ascii");
    incomplete.writeUInt16LE(1, 4);
    incomplete.writeUInt16LE(1, 6);
    incomplete.writeUInt32LE(maximumPayload, 8);

    const originalFromDescriptor = Object.getOwnPropertyDescriptor(Buffer, "from");
    const originalConcatDescriptor = Object.getOwnPropertyDescriptor(Buffer, "concat");
    if (originalFromDescriptor === undefined || originalConcatDescriptor === undefined) {
      throw new Error("Buffer copy descriptors are unavailable");
    }
    const originalFrom = Buffer.from;
    const originalConcat = Buffer.concat;
    let copiedBytes = 0;
    Object.defineProperty(Buffer, "from", {
      ...originalFromDescriptor,
      value(value: unknown, ...arguments_: unknown[]) {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
          copiedBytes += value.byteLength;
        }
        return Reflect.apply(originalFrom, Buffer, [value, ...arguments_]) as Buffer;
      },
    });
    Object.defineProperty(Buffer, "concat", {
      ...originalConcatDescriptor,
      value(values: readonly Uint8Array[], ...arguments_: unknown[]) {
        copiedBytes += values.reduce((sum, value) => sum + value.byteLength, 0);
        return Reflect.apply(originalConcat, Buffer, [values, ...arguments_]) as Buffer;
      },
    });
    try {
      const decoder = new WindowsJobFrameDecoder();
      const chunkBytes = 2_048;
      for (let offset = 0; offset < incomplete.length; offset += chunkBytes) {
        expect(decoder.push(incomplete.subarray(offset, offset + chunkBytes))).toEqual([]);
      }
      expect(copiedBytes).toBeLessThanOrEqual(incomplete.length * 4);
      expect(() => decoder.finish()).toThrowError("Windows job protocol violation.");
      expect(() => decoder.push(Uint8Array.of(0))).toThrowError(
        "Windows job protocol violation.",
      );
    } finally {
      Object.defineProperty(Buffer, "from", originalFromDescriptor);
      Object.defineProperty(Buffer, "concat", originalConcatDescriptor);
    }
  });

  it("fails closed on incomplete, malformed, unknown, or oversized frames", () => {
    const ready = encodeWindowsJobFrame({ type: "ready" });

    for (const [name, mutate] of [
      ["magic", (frame: Buffer) => frame.write("BAD!", 0, "ascii")],
      ["version", (frame: Buffer) => frame.writeUInt16LE(2, 4)],
      ["type", (frame: Buffer) => frame.writeUInt16LE(99, 6)],
      ["ready payload", (frame: Buffer) => frame.writeUInt32LE(1, 8)],
    ] as const) {
      const malformed = Buffer.from(ready);
      mutate(malformed);
      if (name === "ready payload") {
        expect(() => decodeWindowsJobFrame(Buffer.concat([malformed, bytes("00")]))).toThrow(
          /protocol/i,
        );
      } else {
        expect(() => decodeWindowsJobFrame(malformed)).toThrow(/protocol/i);
      }
    }

    const oversizedHeader = Buffer.from(ready);
    oversizedHeader.writeUInt32LE(1_048_577, 8);
    const streaming = new WindowsJobFrameDecoder();
    expect(() => streaming.push(oversizedHeader)).toThrow(/protocol/i);

    expect(() => decodeWindowsJobFrame(ready.subarray(0, 11))).toThrow(/protocol/i);
    expect(() => decodeWindowsJobFrame(Buffer.concat([ready, bytes("00")]))).toThrow(
      /protocol/i,
    );

    const incomplete = new WindowsJobFrameDecoder();
    incomplete.push(ready.subarray(0, 11));
    expect(() => incomplete.finish()).toThrow(/protocol/i);
  });

  it("rejects invalid UTF-8, NULs, path, count, string, and frame limits", () => {
    const valid = {
      type: "launchConfig" as const,
      executable: "C:\\x.exe",
      cwd: "C:\\w",
      argv: ["ok"],
    };

    expect(() =>
      encodeWindowsJobFrame({ ...valid, executable: "x.exe" }),
    ).toThrow(/protocol/i);
    expect(() => encodeWindowsJobFrame({ ...valid, cwd: "relative" })).toThrow(
      /protocol/i,
    );
    expect(() =>
      encodeWindowsJobFrame({ ...valid, argv: ["bad\0value"] }),
    ).toThrow(/protocol/i);
    expect(() =>
      encodeWindowsJobFrame({ ...valid, argv: Array.from({ length: 1_025 }, () => "") }),
    ).toThrow(/protocol/i);
    expect(() =>
      encodeWindowsJobFrame({ ...valid, argv: ["x".repeat(65_537)] }),
    ).toThrow(/protocol/i);
    expect(() =>
      encodeWindowsJobFrame({
        ...valid,
        argv: Array.from({ length: 17 }, () => "x".repeat(65_536)),
      }),
    ).toThrow(/protocol/i);

    const invalidUtf8Payload = Buffer.concat([
      bytes("01 00 00 00 ff"),
      bytes("04 00 00 00 43 3a 5c 77"),
      bytes("00 00 00 00"),
    ]);
    expect(() => decodeWindowsJobFrame(rawFrame(1, invalidUtf8Payload))).toThrow(
      /protocol/i,
    );

    const nulPayload = Buffer.concat([
      bytes("08 00 00 00 43 3a 5c 78 00 65 78 65"),
      bytes("04 00 00 00 43 3a 5c 77"),
      bytes("00 00 00 00"),
    ]);
    expect(() => decodeWindowsJobFrame(rawFrame(1, nulPayload))).toThrow(/protocol/i);

    const badArgcPayload = Buffer.concat([
      bytes("08 00 00 00 43 3a 5c 78 2e 65 78 65"),
      bytes("04 00 00 00 43 3a 5c 77"),
      bytes("02 00 00 00"),
      bytes("02 00 00 00 6f 6b"),
    ]);
    expect(() => decodeWindowsJobFrame(rawFrame(1, badArgcPayload))).toThrow(/protocol/i);
  });

  it("uses the shared fully-qualified Windows path boundary vectors", () => {
    const acceptedPaths = [
      "C:\\root\\target.exe",
      "c:/root/target.exe",
      "\\\\server\\share\\target.exe",
      "//server/share/target.exe",
    ] as const;
    const rejectedPaths = [
      "target.exe",
      "Å:\\target.exe",
      "\\root\\target.exe",
      "/root/target.exe",
      "\\\\server",
      "\\\\server\\",
      "\\\\server\\\\target.exe",
      "///server/share/target.exe",
    ] as const;

    for (const acceptedPath of acceptedPaths) {
      const frame = {
        type: "launchConfig" as const,
        executable: acceptedPath,
        cwd: acceptedPath,
        argv: ["\uFEFFargument"],
      };
      expect(decodeWindowsJobFrame(encodeWindowsJobFrame(frame))).toEqual(frame);
    }
    for (const rejectedPath of rejectedPaths) {
      expect(() =>
        encodeWindowsJobFrame({
          type: "launchConfig",
          executable: rejectedPath,
          cwd: "C:\\work",
          argv: [],
        }),
      ).toThrowError("Windows job protocol violation.");
      expect(() =>
        encodeWindowsJobFrame({
          type: "launchConfig",
          executable: "C:\\target.exe",
          cwd: rejectedPath,
          argv: [],
        }),
      ).toThrowError("Windows job protocol violation.");
    }
  });

  it("rejects a UTF-8 BOM before an executable path in both directions", () => {
    const protocolError = "Windows job protocol violation.";
    expect(() =>
      encodeWindowsJobFrame({
        type: "launchConfig",
        executable: "\uFEFFC:\\x.exe",
        cwd: "C:\\w",
        argv: [],
      }),
    ).toThrowError(protocolError);

    const bomExecutablePayload = Buffer.concat([
      bytes("0b 00 00 00 ef bb bf 43 3a 5c 78 2e 65 78 65"),
      bytes("04 00 00 00 43 3a 5c 77"),
      bytes("00 00 00 00"),
    ]);
    expect(() =>
      decodeWindowsJobFrame(rawFrame(1, bomExecutablePayload)),
    ).toThrowError(protocolError);
  });

  it("enforces exact READY, TERMINATE, ERROR, and EXIT payload contracts", () => {
    for (const malformed of [
      rawFrame(2, bytes("00")),
      rawFrame(3, bytes("00")),
      rawFrame(3, bytes("01 00")),
      rawFrame(4, bytes("01 00 00 00 01 00 00 00")),
      rawFrame(4, bytes("01 00 05 00 00 00 00 00")),
      rawFrame(5, bytes("00 00 00 00 04 01 00 00")),
      rawFrame(5, bytes("00 00 00 00 00 00 00 00")),
      rawFrame(5, bytes("00 00 00 00 00 01 01 00")),
    ]) {
      expect(() => decodeWindowsJobFrame(malformed)).toThrow(/protocol/i);
    }
  });

  it("rejects every forged frame discriminator and enum key before encoding", () => {
    expectProtocolError({ type: "forged" });
    expectProtocolError({ type: "terminate", reason: "forged" });
    expectProtocolError({
      type: "error",
      stage: "forged",
      reason: "cancelled",
      win32Code: null,
    });
    expectProtocolError({
      type: "error",
      stage: "protocolInvalid",
      reason: "forged",
      win32Code: null,
    });
    expectProtocolError({
      type: "exit",
      rootExitCode: 0,
      reason: "forged",
      jobActiveProcessesZero: true,
    });
  });

  it("normalizes forged field types, accessors, and proxies to one protocol error", () => {
    const launch = {
      type: "launchConfig",
      executable: "C:\\x.exe",
      cwd: "C:\\w",
      argv: [],
    };
    for (const frame of [
      null,
      Object.create({ type: "ready" }),
      { ...launch, executable: null },
      { ...launch, executable: 1 },
      { ...launch, cwd: null },
      { ...launch, cwd: {} },
      { ...launch, argv: null },
      { ...launch, argv: "not-an-array" },
      { ...launch, argv: [1] },
      { ...launch, argv: Array(1) },
      {
        type: "error",
        stage: "protocolInvalid",
        reason: "protocolError",
        win32Code: "5",
      },
      {
        type: "exit",
        rootExitCode: "0",
        reason: "noneOrRootExit",
        jobActiveProcessesZero: true,
      },
      {
        type: "exit",
        rootExitCode: Number.NaN,
        reason: "noneOrRootExit",
        jobActiveProcessesZero: true,
      },
    ]) {
      expectProtocolError(frame);
    }

    const elementGetter: unknown[] = [];
    Object.defineProperty(elementGetter, "0", {
      enumerable: true,
      get() {
        throw new Error("secret argv getter");
      },
    });
    Object.defineProperty(elementGetter, "length", { value: 1 });
    expectProtocolError({ ...launch, argv: elementGetter });

    const throwingType = {};
    Object.defineProperty(throwingType, "type", {
      get() {
        throw new Error("secret type getter");
      },
    });
    expectProtocolError(throwingType);
    expectProtocolError(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error("secret proxy trap");
          },
          get() {
            throw new Error("secret proxy getter");
          },
        },
      ),
    );
  });

  it("exports a complete fixed redacted stage mapping", () => {
    expect(WINDOWS_JOB_STAGE_MESSAGES).toEqual({
      protocolInvalid: "Windows job helper rejected the control protocol.",
      cancelledBeforeReady: "Windows job helper stopped before startup completed.",
      jobCreateFailed: "Windows job helper could not create the owned job.",
      jobConfigFailed: "Windows job helper could not configure the owned job.",
      stdioDuplicateFailed: "Windows job helper could not prepare standard streams.",
      attributeListInitFailed: "Windows job helper could not prepare process attributes.",
      handleListAttributeFailed: "Windows job helper could not isolate inherited handles.",
      jobListAttributeFailed: "Windows job helper could not attach atomic job ownership.",
      commandLineInvalid: "Windows job helper rejected the command contract.",
      createFailed: "Windows job helper could not create the target process.",
      resumeFailed: "Windows job helper could not start the owned target.",
      terminateJobFailed: "Windows job helper could not terminate the owned job.",
      queryJobFailed: "Windows job helper could not verify owned-job state.",
      controlChannelFailed: "Windows job helper control channel failed.",
      helperInternal: "Windows job helper failed internally.",
      waitFailed: "Windows job helper could not wait for owned-job completion.",
    });
  });
});
