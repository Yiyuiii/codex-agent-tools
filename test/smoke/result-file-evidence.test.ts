import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectResultFile,
  type ResultFileOperations,
} from "../../src/smoke/result-file-evidence.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-result-evidence-${process.pid}-${Date.now()}-${roots.length}`,
  );
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function withStatDrift(
  base: BigIntStats,
  drift: "identity" | "type" | "size",
): BigIntStats {
  return new Proxy(base, {
    get(target, property) {
      if (property === "ino" && drift === "identity") return target.ino + 1n;
      if (property === "size" && drift === "size") return target.size + 1n;
      if (property === "isFile" && drift === "type") return () => false;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("safe smoke result-file evidence", () => {
  it("accepts exact content with one trailing newline and records hashes", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "result.txt");
    const raw = "ARK_SMOKE_OK:ark-coding-plan\n";
    const expected = "ARK_SMOKE_OK:ark-coding-plan";
    await writeFile(filePath, raw, "utf8");

    const evidence = await inspectResultFile({
      filePath,
      expectedLine: expected,
      maximumBytes: 65_536,
    });

    expect(evidence).toEqual({
      readStatus: "read",
      byteLength: Buffer.byteLength(raw),
      rawSha256: sha256(raw),
      normalizedSha256: sha256(expected),
      expectedNormalizedSha256: sha256(expected),
      normalizedLineCount: 1,
      containsExpectedLine: true,
      valid: true,
    });
  });

  it.each([
    ["empty", "", 0, false],
    ["wrong line", "WRONG\n", 1, false],
    ["natural-language delimiter", "EXPECTED;\n", 1, false],
    ["extra lines", "before\nEXPECTED\nafter\n", 3, true],
  ])(
    "rejects %s content without exposing it",
    async (_label, raw, lineCount, containsExpectedLine) => {
      const root = await tempRoot();
      const filePath = path.join(root, "result.txt");
      await writeFile(filePath, raw, "utf8");

      const evidence = await inspectResultFile({
        filePath,
        expectedLine: "EXPECTED",
        maximumBytes: 65_536,
      });

      expect(evidence).toMatchObject({
        readStatus: "read",
        normalizedLineCount: lineCount,
        containsExpectedLine,
        valid: false,
      });
      if (raw !== "") {
        expect(JSON.stringify(evidence)).not.toContain(raw);
      }
      expect(JSON.stringify(evidence)).not.toContain(filePath);
    },
  );

  it("keeps current trim semantics for CRLF", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "result.txt");
    await writeFile(filePath, "EXPECTED\r\n", "utf8");

    const evidence = await inspectResultFile({
      filePath,
      expectedLine: "EXPECTED",
      maximumBytes: 65_536,
    });

    expect(evidence).toMatchObject({
      readStatus: "read",
      normalizedLineCount: 1,
      containsExpectedLine: true,
      valid: true,
    });
  });

  it("classifies a missing path without leaking the path", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "missing-secret-result.txt");

    const evidence = await inspectResultFile({
      filePath,
      expectedLine: "EXPECTED",
      maximumBytes: 65_536,
    });

    expect(evidence).toEqual({
      readStatus: "missing",
      expectedNormalizedSha256: sha256("EXPECTED"),
      valid: false,
    });
    expect(JSON.stringify(evidence)).not.toContain(filePath);
  });

  it("retains only raw length and hash for invalid UTF-8", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "result.txt");
    const raw = Buffer.from([0xc3, 0x28]);
    await writeFile(filePath, raw);

    const evidence = await inspectResultFile({
      filePath,
      expectedLine: "EXPECTED",
      maximumBytes: 65_536,
    });

    expect(evidence).toEqual({
      readStatus: "invalid_utf8",
      byteLength: raw.byteLength,
      rawSha256: sha256(raw),
      expectedNormalizedSha256: sha256("EXPECTED"),
      valid: false,
    });
    expect(evidence).not.toHaveProperty("normalizedSha256");
    expect(evidence).not.toHaveProperty("normalizedLineCount");
    expect(evidence).not.toHaveProperty("containsExpectedLine");
  });

  it("uses only bounded handle reads when the file grows during inspection", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "result.txt");
    const maximumBytes = 65_536;
    await writeFile(filePath, "x", "utf8");
    const stableStat = await lstat(filePath, { bigint: true });
    let boundedBytesRequested = 0;
    let unboundedReadFileCalls = 0;
    let closed = false;

    const operations: ResultFileOperations = {
      lstat: async () => stableStat,
      open: async () =>
        ({
          stat: async () => stableStat,
          read: async (
            buffer: Buffer,
            offset: number,
            length: number,
          ) => {
            boundedBytesRequested += length;
            buffer.fill(0x61, offset, offset + length);
            return { bytesRead: length };
          },
          readFile: async () => {
            unboundedReadFileCalls += 1;
            return Buffer.alloc(maximumBytes + 2, 0x61);
          },
          close: async () => {
            closed = true;
          },
        }) as unknown as Awaited<ReturnType<ResultFileOperations["open"]>>,
    };

    const evidence = await inspectResultFile(
      { filePath, expectedLine: "EXPECTED", maximumBytes },
      { operations },
    );

    expect(boundedBytesRequested).toBeGreaterThan(0);
    expect(boundedBytesRequested).toBeLessThanOrEqual(maximumBytes + 1);
    expect(unboundedReadFileCalls).toBe(0);
    expect(closed).toBe(true);
    expect(evidence.readStatus).toBe("read_error");
    expect(evidence).not.toHaveProperty("rawSha256");
  });

  it("uses one maximum-sized target buffer across 65,537 one-byte reads", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "result.txt");
    const maximumBytes = 65_536;
    await writeFile(filePath, "x", "utf8");
    const stableStat = await lstat(filePath, { bigint: true });
    const allocationSizes: number[] = [];
    const seenBuffers = new Set<Buffer>();
    let readCalls = 0;
    let offsetsMatchPositions = true;
    let closeCalls = 0;

    const evidence = await inspectResultFile(
      { filePath, expectedLine: "EXPECTED", maximumBytes },
      {
        allocateBuffer: (size) => {
          allocationSizes.push(size);
          return Buffer.allocUnsafe(size);
        },
        operations: {
          lstat: async () => stableStat,
          open: async () => ({
            stat: async () => stableStat,
            read: async (buffer, offset, _length, position) => {
              readCalls += 1;
              seenBuffers.add(buffer);
              if (seenBuffers.size > 1) {
                throw new Error("bounded read allocated another target");
              }
              offsetsMatchPositions &&= offset === position;
              buffer[offset] = 0x61;
              return { bytesRead: 1 };
            },
            close: async () => {
              closeCalls += 1;
            },
          }),
        },
      },
    );

    expect(allocationSizes).toEqual([maximumBytes + 1]);
    expect(readCalls).toBe(maximumBytes + 1);
    expect(seenBuffers.size).toBe(1);
    expect(offsetsMatchPositions).toBe(true);
    expect(closeCalls).toBe(1);
    expect(evidence.readStatus).toBe("read_error");
    expect(evidence).not.toHaveProperty("rawSha256");
  });

  it("handles deterministic short reads until EOF", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "result.txt");
    const raw = Buffer.from("EXPECTED\n");
    await writeFile(filePath, raw);
    const stableStat = await lstat(filePath, { bigint: true });
    let readCalls = 0;

    const operations: ResultFileOperations = {
      lstat: async () => stableStat,
      open: async () => ({
        stat: async () => stableStat,
        read: async (buffer, offset, _length, position) => {
          readCalls += 1;
          if (position >= raw.byteLength) return { bytesRead: 0 };
          raw.copy(buffer, offset, position, position + 1);
          return { bytesRead: 1 };
        },
        close: async () => {},
      }),
    };

    const evidence = await inspectResultFile(
      { filePath, expectedLine: "EXPECTED", maximumBytes: 65_536 },
      { operations },
    );

    expect(readCalls).toBe(raw.byteLength + 1);
    expect(evidence).toMatchObject({
      readStatus: "read",
      byteLength: raw.byteLength,
      valid: true,
    });
  });

  it("rejects an unreasonable caller maximum before opening a handle", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "result.txt");
    await writeFile(filePath, "x", "utf8");
    const stableStat = await lstat(filePath, { bigint: true });
    let opened = false;

    const evidence = await inspectResultFile(
      {
        filePath,
        expectedLine: "EXPECTED",
        maximumBytes: Number.MAX_SAFE_INTEGER,
      },
      {
        operations: {
          lstat: async () => stableStat,
          open: async () => {
            opened = true;
            throw new Error("must not open");
          },
        },
      },
    );

    expect(opened).toBe(false);
    expect(evidence.readStatus).toBe("read_error");
  });

  it("rejects directories and oversized files before reading", async () => {
    const root = await tempRoot();
    const directory = path.join(root, "directory");
    const oversized = path.join(root, "oversized.txt");
    await mkdir(directory);
    await writeFile(oversized, Buffer.alloc(65_537, 1));

    for (const filePath of [directory, oversized]) {
      const evidence = await inspectResultFile({
        filePath,
        expectedLine: "EXPECTED",
        maximumBytes: 65_536,
      });
      expect(evidence).toEqual({
        readStatus: "read_error",
        expectedNormalizedSha256: sha256("EXPECTED"),
        valid: false,
      });
      expect(JSON.stringify(evidence)).not.toContain(filePath);
    }
  });

  it.each([
    ["symbolic link", true],
    ["other non-regular file", false],
  ])("rejects a reported %s without opening it", async (_label, symbolic) => {
    let opened = false;
    const operations: ResultFileOperations = {
      lstat: async () =>
        ({
          dev: 1n,
          ino: 1n,
          size: 1n,
          isFile: () => false,
          isSymbolicLink: () => symbolic,
        }) as Awaited<ReturnType<ResultFileOperations["lstat"]>>,
      open: async () => {
        opened = true;
        throw new Error("must not open");
      },
    };

    const evidence = await inspectResultFile(
      {
        filePath: "opaque-non-regular-path",
        expectedLine: "EXPECTED",
        maximumBytes: 65_536,
      },
      { operations },
    );

    expect(evidence.readStatus).toBe("read_error");
    expect(opened).toBe(false);
  });

  it.each(["simulated symlink target", "replaced regular path"] as const)(
    "fails closed when open resolves a %s with different identity",
    async (replacementKind) => {
      const root = await tempRoot();
      const filePath = path.join(root, "result.txt");
      const originalPath = path.join(root, "original.txt");
      const replacementPath = path.join(root, "replacement.txt");
      const secret = `RACE_SECRET_SENTINEL_${replacementKind}`;
      await writeFile(filePath, "EXPECTED\n", "utf8");
      await writeFile(replacementPath, secret, "utf8");
      let reads = 0;

      const operations: ResultFileOperations = {
        lstat: async (candidate) => lstat(candidate, { bigint: true }),
        open: async (candidate) => {
          await rename(candidate, originalPath);
          if (replacementKind === "replaced regular path") {
            await rename(replacementPath, candidate);
          }
          const handle = await open(
            replacementKind === "simulated symlink target"
              ? replacementPath
              : candidate,
            "r",
          );
          return {
            stat: async () => handle.stat({ bigint: true }),
            read: async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              reads += 1;
              const result = await handle.read(
                buffer,
                offset,
                length,
                position,
              );
              return { bytesRead: result.bytesRead };
            },
            close: async () => handle.close(),
          };
        },
      };

      const evidence = await inspectResultFile(
        {
          filePath,
          expectedLine: "EXPECTED",
          maximumBytes: 65_536,
        },
        { operations },
      );

      expect(evidence).toEqual({
        readStatus: "read_error",
        expectedNormalizedSha256: sha256("EXPECTED"),
        valid: false,
      });
      expect(reads).toBe(0);
      expect(JSON.stringify(evidence)).not.toContain(secret);
      expect(JSON.stringify(evidence)).not.toContain(sha256(secret));
      expect(JSON.stringify(evidence)).not.toContain(filePath);
      expect(evidence).not.toHaveProperty("rawSha256");
    },
  );

  it("closes the handle after a pre-read identity mismatch", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "result.txt");
    await writeFile(filePath, "EXPECTED", "utf8");
    const stableStat = await lstat(filePath, { bigint: true });
    let readCalls = 0;
    let closeCalls = 0;

    const evidence = await inspectResultFile(
      { filePath, expectedLine: "EXPECTED", maximumBytes: 65_536 },
      {
        operations: {
          lstat: async () => stableStat,
          open: async () => ({
            stat: async () => withStatDrift(stableStat, "identity"),
            read: async () => {
              readCalls += 1;
              return { bytesRead: 0 };
            },
            close: async () => {
              closeCalls += 1;
            },
          }),
        },
      },
    );

    expect(evidence.readStatus).toBe("read_error");
    expect(readCalls).toBe(0);
    expect(closeCalls).toBe(1);
  });

  it("closes the handle when a bounded read throws", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "result.txt");
    await writeFile(filePath, "EXPECTED", "utf8");
    const stableStat = await lstat(filePath, { bigint: true });
    let closeCalls = 0;

    const evidence = await inspectResultFile(
      { filePath, expectedLine: "EXPECTED", maximumBytes: 65_536 },
      {
        operations: {
          lstat: async () => stableStat,
          open: async () => ({
            stat: async () => stableStat,
            read: async () => {
              throw new Error("READ_THROW_SECRET");
            },
            close: async () => {
              closeCalls += 1;
            },
          }),
        },
      },
    );

    expect(evidence.readStatus).toBe("read_error");
    expect(closeCalls).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain("READ_THROW_SECRET");
  });

  it.each(["identity", "type", "size"] as const)(
    "closes and rejects post-read %s drift before hashing",
    async (drift) => {
      const root = await tempRoot();
      const filePath = path.join(root, "result.txt");
      const raw = Buffer.from("EXPECTED");
      await writeFile(filePath, raw);
      const stableStat = await lstat(filePath, { bigint: true });
      let statCalls = 0;
      let closeCalls = 0;

      const evidence = await inspectResultFile(
        { filePath, expectedLine: "EXPECTED", maximumBytes: 65_536 },
        {
          operations: {
            lstat: async () => stableStat,
            open: async () => ({
              stat: async () =>
                statCalls++ === 0
                  ? stableStat
                  : withStatDrift(stableStat, drift),
              read: async (buffer, offset, length, position) => {
                if (position >= raw.byteLength) return { bytesRead: 0 };
                const bytesRead = Math.min(
                  length,
                  raw.byteLength - position,
                );
                raw.copy(
                  buffer,
                  offset,
                  position,
                  position + bytesRead,
                );
                return { bytesRead };
              },
              close: async () => {
                closeCalls += 1;
              },
            }),
          },
        },
      );

      expect(evidence.readStatus).toBe("read_error");
      expect(evidence).not.toHaveProperty("rawSha256");
      expect(closeCalls).toBe(1);
    },
  );

  it("does not serialize file paths or read error messages", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "absolute-secret-path.txt");
    const errorSecret = "READ_ERROR_SECRET_SENTINEL";
    await writeFile(filePath, "EXPECTED", "utf8");
    const operations: ResultFileOperations = {
      lstat: async (candidate) => lstat(candidate, { bigint: true }),
      open: async () => {
        throw new Error(errorSecret);
      },
    };

    const evidence = await inspectResultFile(
      { filePath, expectedLine: "EXPECTED", maximumBytes: 65_536 },
      { operations },
    );
    const serialized = JSON.stringify(evidence);

    expect(evidence.readStatus).toBe("read_error");
    expect(serialized).not.toContain(filePath);
    expect(serialized).not.toContain(errorSecret);
  });
});
