import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat as nodeLstat,
  open as nodeOpen,
} from "node:fs/promises";

export type ResultFileReadStatus =
  | "read"
  | "missing"
  | "invalid_utf8"
  | "read_error";

export interface ResultFileEvidence {
  readStatus: ResultFileReadStatus;
  expectedNormalizedSha256: string;
  valid: boolean;
  byteLength?: number;
  rawSha256?: string;
  normalizedSha256?: string;
  normalizedLineCount?: number;
  containsExpectedLine?: boolean;
}

export interface ResultFileHandle {
  stat(): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface ResultFileOperations {
  lstat(filePath: string): Promise<BigIntStats>;
  open(filePath: string): Promise<ResultFileHandle>;
}

export interface InspectResultFileOptions {
  filePath: string;
  expectedLine: string;
  maximumBytes: number;
}

export interface InspectResultFileDependencies {
  operations?: ResultFileOperations;
  allocateBuffer?: (size: number) => Buffer;
}

const defaultOperations: ResultFileOperations = Object.freeze({
  lstat: async (filePath: string) => nodeLstat(filePath, { bigint: true }),
  open: async (filePath: string) => {
    const handle = await nodeOpen(filePath, "r");
    return {
      stat: async () => handle.stat({ bigint: true }),
      read: async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const result = await handle.read(buffer, offset, length, position);
        return { bytesRead: result.bytesRead };
      },
      close: async () => handle.close(),
    };
  },
});

const MAXIMUM_RESULT_FILE_BYTES = Math.min(
  65_536,
  bufferConstants.MAX_LENGTH - 1,
);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRegularFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    sameIdentity(left, right) &&
    left.size === right.size
  );
}

function unreadable(expectedNormalizedSha256: string): ResultFileEvidence {
  return {
    readStatus: "read_error",
    expectedNormalizedSha256,
    valid: false,
  };
}

async function readBounded(
  handle: ResultFileHandle,
  maximumBytes: number,
  allocateBuffer: (size: number) => Buffer,
): Promise<{ overflow: true } | { overflow: false; raw: Buffer }> {
  const capacity = maximumBytes + 1;
  const buffer = allocateBuffer(capacity);
  if (!Buffer.isBuffer(buffer) || buffer.byteLength !== capacity) {
    throw new Error("Invalid bounded file buffer");
  }
  let position = 0;

  while (position <= maximumBytes) {
    const length = capacity - position;
    const { bytesRead } = await handle.read(
      buffer,
      position,
      length,
      position,
    );
    if (
      !Number.isSafeInteger(bytesRead) ||
      bytesRead < 0 ||
      bytesRead > length
    ) {
      throw new Error("Invalid bounded file read");
    }
    if (bytesRead === 0) {
      return {
        overflow: false,
        raw: buffer.subarray(0, position),
      };
    }
    position += bytesRead;
    if (position > maximumBytes) {
      return { overflow: true };
    }
  }

  return { overflow: true };
}

export async function inspectResultFile(
  options: InspectResultFileOptions,
  dependencies: InspectResultFileDependencies = {},
): Promise<ResultFileEvidence> {
  const expectedNormalizedSha256 = sha256(options.expectedLine);
  const operations = dependencies.operations ?? defaultOperations;
  const allocateBuffer = dependencies.allocateBuffer ?? Buffer.allocUnsafe;
  let pathStat: BigIntStats;

  try {
    pathStat = await operations.lstat(options.filePath);
  } catch (error) {
    return isMissing(error)
      ? {
          readStatus: "missing",
          expectedNormalizedSha256,
          valid: false,
        }
      : unreadable(expectedNormalizedSha256);
  }

  if (
    !Number.isSafeInteger(options.maximumBytes) ||
    options.maximumBytes < 0 ||
    options.maximumBytes > MAXIMUM_RESULT_FILE_BYTES ||
    !pathStat.isFile() ||
    pathStat.size > BigInt(options.maximumBytes)
  ) {
    return unreadable(expectedNormalizedSha256);
  }

  try {
    const handle = await operations.open(options.filePath);
    try {
      const beforeRead = await handle.stat();
      if (!sameRegularFile(pathStat, beforeRead)) {
        return unreadable(expectedNormalizedSha256);
      }

      const readResult = await readBounded(
        handle,
        options.maximumBytes,
        allocateBuffer,
      );
      if (readResult.overflow) {
        return unreadable(expectedNormalizedSha256);
      }
      const raw = readResult.raw;
      const afterRead = await handle.stat();
      if (
        !sameRegularFile(beforeRead, afterRead) ||
        raw.byteLength !== Number(beforeRead.size)
      ) {
        return unreadable(expectedNormalizedSha256);
      }

      const byteLength = raw.byteLength;
      const rawSha256 = sha256(raw);
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        return {
          readStatus: "invalid_utf8",
          byteLength,
          rawSha256,
          expectedNormalizedSha256,
          valid: false,
        };
      }

      const normalized = decoded.trim();
      const lines =
        normalized === "" ? [] : normalized.split(/\r\n|[\r\n]/u);
      return {
        readStatus: "read",
        byteLength,
        rawSha256,
        normalizedSha256: sha256(normalized),
        expectedNormalizedSha256,
        normalizedLineCount: lines.length,
        containsExpectedLine: lines.includes(options.expectedLine),
        valid: normalized === options.expectedLine,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return unreadable(expectedNormalizedSha256);
  }
}
