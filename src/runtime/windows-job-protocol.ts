import { win32 } from "node:path";
import { TextDecoder } from "node:util";

import protocolV1 from "../../native/windows-job-helper/protocol.v1.json" with {
  type: "json",
};

export type WindowsJobInvocationKind = "native" | "cmd";
export type WindowsJobReason =
  | "noneOrRootExit"
  | "cancelled"
  | "timedOut"
  | "sessionShutdown"
  | "protocolError";
export type WindowsJobStage =
  | "protocolInvalid"
  | "cancelledBeforeReady"
  | "jobCreateFailed"
  | "jobConfigFailed"
  | "stdioDuplicateFailed"
  | "attributeListInitFailed"
  | "handleListAttributeFailed"
  | "jobListAttributeFailed"
  | "commandLineInvalid"
  | "createFailed"
  | "resumeFailed"
  | "terminateJobFailed"
  | "queryJobFailed"
  | "controlChannelFailed"
  | "helperInternal"
  | "waitFailed";

export type WindowsJobFrame =
  | {
      readonly type: "launchConfig";
      readonly kind: WindowsJobInvocationKind;
      readonly executable: string;
      readonly cwd: string;
      readonly argv: readonly string[];
    }
  | { readonly type: "ready" }
  | {
      readonly type: "terminate";
      readonly reason: Exclude<WindowsJobReason, "noneOrRootExit">;
    }
  | {
      readonly type: "error";
      readonly stage: WindowsJobStage;
      readonly reason: WindowsJobReason;
      readonly win32Code: number | null;
    }
  | {
      readonly type: "exit";
      readonly rootExitCode: number;
      readonly reason: Exclude<WindowsJobReason, "protocolError">;
      readonly jobActiveProcessesZero: true;
    };

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

type ProtocolContract = DeepReadonly<typeof protocolV1>;

function cloneAndDeepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null) {
    return value as DeepReadonly<T>;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    clone[key] = cloneAndDeepFreeze(nested);
  }
  return Object.freeze(clone) as DeepReadonly<T>;
}

const protocolContract: ProtocolContract = cloneAndDeepFreeze(protocolV1);
export const WINDOWS_JOB_PROTOCOL: ProtocolContract = protocolContract;

export const WINDOWS_JOB_STAGE_MESSAGES: Readonly<
  Record<WindowsJobStage, string>
> = Object.freeze({
  protocolInvalid: "Windows job helper rejected the control protocol.",
  cancelledBeforeReady:
    "Windows job helper stopped before startup completed.",
  jobCreateFailed: "Windows job helper could not create the owned job.",
  jobConfigFailed: "Windows job helper could not configure the owned job.",
  stdioDuplicateFailed:
    "Windows job helper could not prepare standard streams.",
  attributeListInitFailed:
    "Windows job helper could not prepare process attributes.",
  handleListAttributeFailed:
    "Windows job helper could not isolate inherited handles.",
  jobListAttributeFailed:
    "Windows job helper could not attach atomic job ownership.",
  commandLineInvalid: "Windows job helper rejected the command contract.",
  createFailed: "Windows job helper could not create the target process.",
  resumeFailed: "Windows job helper could not start the owned target.",
  terminateJobFailed:
    "Windows job helper could not terminate the owned job.",
  queryJobFailed:
    "Windows job helper could not verify owned-job state.",
  controlChannelFailed: "Windows job helper control channel failed.",
  helperInternal: "Windows job helper failed internally.",
  waitFailed:
    "Windows job helper could not wait for owned-job completion.",
});

const magicBytes = Buffer.from(protocolContract.frame.magic, "ascii");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function protocolError(): Error {
  return new Error("Windows job protocol violation.");
}

function assertUInt32(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw protocolError();
  }
}

function assertAbsolutePath(value: string, allowEmpty: boolean): void {
  if ((!allowEmpty && value.length === 0) || !win32.isAbsolute(value)) {
    throw protocolError();
  }
}

function encodeStrictString(value: string): Buffer {
  if (value.includes("\0")) {
    throw protocolError();
  }

  const encoded = Buffer.from(value, "utf8");
  let roundTrip: string;
  try {
    roundTrip = strictUtf8.decode(encoded);
  } catch {
    throw protocolError();
  }
  if (
    roundTrip !== value ||
    encoded.length > protocolContract.limits.maxStringBytes
  ) {
    throw protocolError();
  }

  const result = Buffer.allocUnsafe(4 + encoded.length);
  result.writeUInt32LE(encoded.length, 0);
  encoded.copy(result, 4);
  return result;
}

function frameFromPayload(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length > protocolContract.frame.maxPayloadBytes) {
    throw protocolError();
  }

  const result = Buffer.allocUnsafe(
    protocolContract.frame.headerBytes + payload.length,
  );
  magicBytes.copy(result, 0);
  result.writeUInt16LE(protocolContract.frame.version, 4);
  result.writeUInt16LE(type, 6);
  result.writeUInt32LE(payload.length, 8);
  result.set(payload, protocolContract.frame.headerBytes);
  return Uint8Array.from(result);
}

function encodeLaunchConfig(
  frame: Extract<WindowsJobFrame, { type: "launchConfig" }>,
): Uint8Array {
  assertAbsolutePath(frame.executable, false);
  assertAbsolutePath(frame.cwd, false);
  if (frame.argv.length > protocolContract.limits.maxArgCount) {
    throw protocolError();
  }

  const executable = encodeStrictString(frame.executable);
  const cwd = encodeStrictString(frame.cwd);
  const argumentsEncoded = frame.argv.map(encodeStrictString);
  const payloadLength =
    1 +
    executable.length +
    cwd.length +
    4 +
    argumentsEncoded.reduce((sum, argument) => sum + argument.length, 0);
  if (payloadLength > protocolContract.frame.maxPayloadBytes) {
    throw protocolError();
  }

  const payload = Buffer.allocUnsafe(payloadLength);
  let offset = 0;
  payload.writeUInt8(
    valueForKey(protocolContract.invocationKind, frame.kind),
    offset,
  );
  offset += 1;
  executable.copy(payload, offset);
  offset += executable.length;
  cwd.copy(payload, offset);
  offset += cwd.length;
  payload.writeUInt32LE(frame.argv.length, offset);
  offset += 4;
  for (const argument of argumentsEncoded) {
    argument.copy(payload, offset);
    offset += argument.length;
  }

  return frameFromPayload(
    protocolContract.messageType.launchConfig,
    payload,
  );
}

const reasonKeys = Object.freeze(
  Object.keys(protocolContract.reason) as WindowsJobReason[],
);
const stageKeys = Object.freeze(
  Object.keys(protocolContract.stage) as WindowsJobStage[],
);

function keyForValue<K extends string>(
  record: Readonly<Record<K, number>>,
  keys: readonly K[],
  value: number,
): K {
  const key = keys.find((candidate) => record[candidate] === value);
  if (key === undefined) {
    throw protocolError();
  }
  return key;
}

function valueForKey<K extends string>(
  record: Readonly<Record<K, number>>,
  key: unknown,
): number {
  if (
    typeof key !== "string" ||
    !Object.prototype.hasOwnProperty.call(record, key)
  ) {
    throw protocolError();
  }
  const value = record[key as K];
  if (!Number.isInteger(value)) {
    throw protocolError();
  }
  return value;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    throw protocolError();
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw protocolError();
  }
  return descriptor.value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw protocolError();
  }
  return value;
}

function requiredStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw protocolError();
  }
  const length = ownDataProperty(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > protocolContract.limits.maxArgCount
  ) {
    throw protocolError();
  }
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    result.push(requiredString(ownDataProperty(value, String(index))));
  }
  return result;
}

function encodeValidatedWindowsJobFrame(frame: unknown): Uint8Array {
  const type = requiredString(ownDataProperty(frame, "type"));
  switch (type) {
    case "launchConfig":
      return encodeLaunchConfig({
        type,
        kind: requiredString(
          ownDataProperty(frame, "kind"),
        ) as WindowsJobInvocationKind,
        executable: requiredString(ownDataProperty(frame, "executable")),
        cwd: requiredString(ownDataProperty(frame, "cwd")),
        argv: requiredStringArray(ownDataProperty(frame, "argv")),
      });
    case "ready":
      return frameFromPayload(
        protocolContract.messageType.ready,
        Buffer.alloc(0),
      );
    case "terminate": {
      const reasonKey = requiredString(
        ownDataProperty(frame, "reason"),
      ) as WindowsJobReason;
      const reason = valueForKey(protocolContract.reason, reasonKey);
      if (reason === protocolContract.reason.noneOrRootExit) {
        throw protocolError();
      }
      return frameFromPayload(
        protocolContract.messageType.terminate,
        Uint8Array.of(reason),
      );
    }
    case "error": {
      const stage = requiredString(
        ownDataProperty(frame, "stage"),
      ) as WindowsJobStage;
      const reason = requiredString(
        ownDataProperty(frame, "reason"),
      ) as WindowsJobReason;
      const win32Code = ownDataProperty(frame, "win32Code");
      const payload = Buffer.alloc(8);
      payload.writeUInt16LE(
        valueForKey(protocolContract.stage, stage),
        0,
      );
      payload.writeUInt8(
        valueForKey(protocolContract.reason, reason),
        2,
      );
      if (win32Code === null) {
        payload.writeUInt8(0, 3);
        payload.writeUInt32LE(0, 4);
      } else {
        if (typeof win32Code !== "number") {
          throw protocolError();
        }
        assertUInt32(win32Code);
        payload.writeUInt8(1, 3);
        payload.writeUInt32LE(win32Code, 4);
      }
      return frameFromPayload(protocolContract.messageType.error, payload);
    }
    case "exit": {
      const rootExitCode = ownDataProperty(frame, "rootExitCode");
      const reason = requiredString(
        ownDataProperty(frame, "reason"),
      ) as WindowsJobReason;
      const activeProcessesZero = ownDataProperty(
        frame,
        "jobActiveProcessesZero",
      );
      if (typeof rootExitCode !== "number") {
        throw protocolError();
      }
      assertUInt32(rootExitCode);
      const reasonCode = valueForKey(
        protocolContract.reason,
        reason,
      );
      if (
        reasonCode === protocolContract.reason.protocolError ||
        activeProcessesZero !== true
      ) {
        throw protocolError();
      }
      const payload = Buffer.alloc(8);
      payload.writeUInt32LE(rootExitCode, 0);
      payload.writeUInt8(reasonCode, 4);
      payload.writeUInt8(1, 5);
      payload.writeUInt16LE(0, 6);
      return frameFromPayload(protocolContract.messageType.exit, payload);
    }
    default:
      throw protocolError();
  }
}

export function encodeWindowsJobFrame(frame: WindowsJobFrame): Uint8Array {
  try {
    return encodeValidatedWindowsJobFrame(frame);
  } catch {
    throw protocolError();
  }
}

class PayloadReader {
  private offset = 0;

  public constructor(private readonly payload: Buffer) {}

  public readUInt8(): number {
    this.require(1);
    const value = this.payload.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  public readUInt32(): number {
    this.require(4);
    const value = this.payload.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  public readString(): string {
    const byteLength = this.readUInt32();
    if (byteLength > protocolContract.limits.maxStringBytes) {
      throw protocolError();
    }
    this.require(byteLength);
    const encoded = this.payload.subarray(this.offset, this.offset + byteLength);
    this.offset += byteLength;
    let decoded: string;
    try {
      decoded = strictUtf8.decode(encoded);
    } catch {
      throw protocolError();
    }
    if (decoded.includes("\0")) {
      throw protocolError();
    }
    return decoded;
  }

  public assertComplete(): void {
    if (this.offset !== this.payload.length) {
      throw protocolError();
    }
  }

  private require(byteLength: number): void {
    if (byteLength < 0 || this.offset + byteLength > this.payload.length) {
      throw protocolError();
    }
  }
}

function decodeLaunchConfig(payload: Buffer): WindowsJobFrame {
  const reader = new PayloadReader(payload);
  const kind = keyForValue(
    protocolContract.invocationKind,
    ["native", "cmd"],
    reader.readUInt8(),
  );
  const executable = reader.readString();
  const cwd = reader.readString();
  assertAbsolutePath(executable, false);
  assertAbsolutePath(cwd, false);
  const argc = reader.readUInt32();
  if (argc > protocolContract.limits.maxArgCount) {
    throw protocolError();
  }
  const argv: string[] = [];
  for (let index = 0; index < argc; index += 1) {
    argv.push(reader.readString());
  }
  reader.assertComplete();
  return { type: "launchConfig", kind, executable, cwd, argv };
}

function decodePayload(type: number, payload: Buffer): WindowsJobFrame {
  if (type === protocolContract.messageType.launchConfig) {
    return decodeLaunchConfig(payload);
  }
  if (type === protocolContract.messageType.ready) {
    if (payload.length !== 0) {
      throw protocolError();
    }
    return { type: "ready" };
  }
  if (type === protocolContract.messageType.terminate) {
    if (payload.length !== 1) {
      throw protocolError();
    }
    const reason = keyForValue(
      protocolContract.reason,
      reasonKeys,
      payload.readUInt8(0),
    );
    if (reason === "noneOrRootExit") {
      throw protocolError();
    }
    return { type: "terminate", reason };
  }
  if (type === protocolContract.messageType.error) {
    if (payload.length !== 8) {
      throw protocolError();
    }
    const stage = keyForValue(
      protocolContract.stage,
      stageKeys,
      payload.readUInt16LE(0),
    );
    const reason = keyForValue(
      protocolContract.reason,
      reasonKeys,
      payload.readUInt8(2),
    );
    const hasWin32Code = payload.readUInt8(3);
    const code = payload.readUInt32LE(4);
    if (
      (hasWin32Code !== 0 && hasWin32Code !== 1) ||
      (hasWin32Code === 0 && code !== 0)
    ) {
      throw protocolError();
    }
    return {
      type: "error",
      stage,
      reason,
      win32Code: hasWin32Code === 1 ? code : null,
    };
  }
  if (type === protocolContract.messageType.exit) {
    if (payload.length !== 8) {
      throw protocolError();
    }
    const reason = keyForValue(
      protocolContract.reason,
      reasonKeys,
      payload.readUInt8(4),
    );
    if (
      reason === "protocolError" ||
      payload.readUInt8(5) !== 1 ||
      payload.readUInt16LE(6) !== 0
    ) {
      throw protocolError();
    }
    return {
      type: "exit",
      rootExitCode: payload.readUInt32LE(0),
      reason,
      jobActiveProcessesZero: true,
    };
  }
  throw protocolError();
}

function validateHeader(buffer: Buffer): { type: number; payloadLength: number } {
  if (
    !buffer.subarray(0, 4).equals(magicBytes) ||
    buffer.readUInt16LE(4) !== protocolContract.frame.version
  ) {
    throw protocolError();
  }

  const type = buffer.readUInt16LE(6);
  if (!Object.values(protocolContract.messageType).includes(type)) {
    throw protocolError();
  }
  const payloadLength = buffer.readUInt32LE(8);
  if (payloadLength > protocolContract.frame.maxPayloadBytes) {
    throw protocolError();
  }
  return { type, payloadLength };
}

export class WindowsJobFrameDecoder {
  private storage = Buffer.alloc(0);
  private start = 0;
  private end = 0;
  private finished = false;
  private failed = false;

  public push(chunk: Uint8Array): WindowsJobFrame[] {
    if (this.finished || this.failed) {
      throw protocolError();
    }
    const frames: WindowsJobFrame[] = [];
    try {
      const incoming = Buffer.from(chunk);
      let incomingOffset = 0;
      while (incomingOffset < incoming.length) {
        this.ensureWritableCapacity();
        const byteLength = Math.min(
          this.storage.length - this.end,
          incoming.length - incomingOffset,
        );
        incoming.copy(
          this.storage,
          this.end,
          incomingOffset,
          incomingOffset + byteLength,
        );
        this.end += byteLength;
        incomingOffset += byteLength;
        this.decodeAvailable(frames);
      }
      return frames;
    } catch {
      this.failed = true;
      this.clearStorage();
      throw protocolError();
    }
  }

  public finish(): void {
    if (this.finished || this.failed || this.end !== this.start) {
      this.failed = true;
      this.clearStorage();
      throw protocolError();
    }
    this.finished = true;
  }

  private decodeAvailable(frames: WindowsJobFrame[]): void {
    while (this.end - this.start >= protocolContract.frame.headerBytes) {
      const unread = this.storage.subarray(this.start, this.end);
      const { type, payloadLength } = validateHeader(unread);
      const frameLength = protocolContract.frame.headerBytes + payloadLength;
      if (unread.length < frameLength) {
        this.ensureFrameCapacity(frameLength);
        return;
      }
      const payload = unread.subarray(
        protocolContract.frame.headerBytes,
        frameLength,
      );
      frames.push(decodePayload(type, payload));
      this.start += frameLength;
    }
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
    }
  }

  private ensureWritableCapacity(): void {
    if (this.end < this.storage.length) {
      return;
    }
    const unreadLength = this.end - this.start;
    if (this.start > 0) {
      this.storage.copy(this.storage, 0, this.start, this.end);
      this.start = 0;
      this.end = unreadLength;
      if (this.end < this.storage.length) {
        return;
      }
    }
    const maximumFrameBytes =
      protocolContract.frame.headerBytes +
      protocolContract.frame.maxPayloadBytes;
    if (this.storage.length >= maximumFrameBytes) {
      throw protocolError();
    }
    const nextCapacity = Math.min(
      maximumFrameBytes,
      this.storage.length === 0 ? 4_096 : this.storage.length * 2,
    );
    this.replaceStorage(nextCapacity);
  }

  private ensureFrameCapacity(frameLength: number): void {
    if (this.storage.length >= frameLength) {
      return;
    }
    const maximumFrameBytes =
      protocolContract.frame.headerBytes +
      protocolContract.frame.maxPayloadBytes;
    let nextCapacity = Math.max(this.storage.length, 4_096);
    while (nextCapacity < frameLength) {
      nextCapacity = Math.min(maximumFrameBytes, nextCapacity * 2);
      if (nextCapacity === maximumFrameBytes) {
        break;
      }
    }
    if (nextCapacity < frameLength) {
      throw protocolError();
    }
    this.replaceStorage(nextCapacity);
  }

  private replaceStorage(capacity: number): void {
    const replacement = Buffer.allocUnsafe(capacity);
    if (this.end > this.start) {
      this.storage.copy(replacement, 0, this.start, this.end);
    }
    this.end -= this.start;
    this.start = 0;
    this.storage = replacement;
  }

  private clearStorage(): void {
    this.storage = Buffer.alloc(0);
    this.start = 0;
    this.end = 0;
  }
}

export function decodeWindowsJobFrame(encoded: Uint8Array): WindowsJobFrame {
  const decoder = new WindowsJobFrameDecoder();
  const frames = decoder.push(encoded);
  decoder.finish();
  if (frames.length !== 1) {
    throw protocolError();
  }
  return frames[0] as WindowsJobFrame;
}
