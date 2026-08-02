import { createHash } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeHostAcceptanceCompletionMarkerIdentitySha256,
  computeHostAcceptanceDelegateInputIdentity,
  HOST_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH,
  parseHostAcceptanceDescriptorBytes,
  readHostAcceptanceDescriptor,
  type LoadedHostAcceptanceDescriptor,
} from "../../src/mcp/host-acceptance-descriptor.js";
import {
  createHostAcceptanceEventClient,
  type HostAcceptancePipeTransport,
} from "../../src/mcp/host-acceptance-client.js";
import type { HostAcceptanceLifecycleEvent } from "../../src/mcp/host-acceptance-events.js";

const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);
const SHA256_C = "c".repeat(64);
const SHA1_A = "a".repeat(40);
const COMMIT_A = "1".repeat(40);
const INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const NONCE_A = "A".repeat(43);
const NONCE_B = "B".repeat(43);
const PIPE_A = `codex-agent-tools-host-acceptance-${"a".repeat(32)}`;
const PIPE_B = `codex-agent-tools-host-acceptance-${"b".repeat(32)}`;
const MARKER_ID = "stop-marker-0123456789abcdef";
const ACCEPTANCE_INPUT = Object.freeze({
  llm: "ark-agent-plan",
  prompt: "Write the fixed completion marker only after completion.",
  cwd: process.cwd(),
  timeoutMs: 654_321,
  sessionId: "acceptance-session",
});
const REQUEST_IDENTITY = computeHostAcceptanceDelegateInputIdentity(
  ACCEPTANCE_INPUT,
);
const REQUEST_INPUT_SHA = REQUEST_IDENTITY.inputIdentitySha256;

function descriptorValue(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    packageName: "codex-agent-tools",
    nonce: NONCE_A,
    pipeName: PIPE_A,
    publicBeta: {
      version: "0.1.1-beta.1",
      tag: "v0.1.1-beta.1",
      taggedCommit: COMMIT_A,
      markerPath: ".release-validation/v0.1.1-beta.1.json",
      markerSha256: SHA256_A,
      pluginArtifactTreeDigestSha256: SHA256_B,
      observerArtifact: {
        path:
          "host-acceptance/win32-x64/codex-host-acceptance-observer.exe",
        sha256: SHA256_C,
        protocolVersion: 1,
        buildManifest: {
          path: "host-acceptance/observer-build-inputs.v1.json",
          sha256: SHA256_A,
        },
        protocol: {
          path: "host-acceptance/protocol/observer-protocol.v1.json",
          sha256: SHA256_B,
        },
        inputsDigestSha256: SHA256_C,
      },
      npm: { integrity: INTEGRITY, shasum: SHA1_A },
    },
    request: {
      task: "delegate",
      ...REQUEST_IDENTITY,
      completionMarkerId: MARKER_ID,
      completionMarkerIdentitySha256:
        computeHostAcceptanceCompletionMarkerIdentitySha256({
          nonce:
            typeof overrides.nonce === "string" ? overrides.nonce : NONCE_A,
          completionMarkerId: MARKER_ID,
          inputIdentitySha256: REQUEST_INPUT_SHA,
        }),
    },
    ...overrides,
  };
}

function loadedDescriptor(
  overrides: Record<string, unknown> = {},
): LoadedHostAcceptanceDescriptor {
  return parseHostAcceptanceDescriptorBytes(
    Buffer.from(JSON.stringify(descriptorValue(overrides))),
    { packageName: "codex-agent-tools", packageVersion: "0.1.1-beta.1" },
  );
}

function requestEvent(
  requestIdSha256 = SHA256_A,
): HostAcceptanceLifecycleEvent {
  return {
    type: "requestStarted",
    task: "delegate",
    requestIdType: "string",
    requestIdSha256,
  };
}

function laterEvent(
  type: "sdkAbort" | "handlerCancelled" | "inFlightRemoved",
  requestIdSha256 = SHA256_A,
): HostAcceptanceLifecycleEvent {
  return {
    type,
    requestIdType: "string",
    requestIdSha256,
  };
}

function ownedEvent(requestIdSha256 = SHA256_A): HostAcceptanceLifecycleEvent {
  return {
    type: "ownedExit",
    requestIdType: "string",
    requestIdSha256,
    completion: "cancelled",
    ownershipDrained: true,
  };
}

function decodeFrames(frames: readonly Uint8Array[]): unknown[] {
  return frames.map((frame) => {
    const text = Buffer.from(frame).toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    return JSON.parse(text.slice(0, -1)) as unknown;
  });
}

describe("host acceptance descriptor", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("strictly accepts the fixed beta/session binding without retaining raw bytes", () => {
    const raw = Buffer.from(JSON.stringify(descriptorValue()));
    const parsed = parseHostAcceptanceDescriptorBytes(raw, {
      packageName: "codex-agent-tools",
      packageVersion: "0.1.1-beta.1",
    });

    expect(parsed.descriptorSha256).toBe(
      createHash("sha256").update(raw).digest("hex"),
    );
    expect(parsed.nonce).toBe(NONCE_A);
    expect(parsed.pipePath).toBe(`\\\\.\\pipe\\${PIPE_A}`);
    expect(parsed.request).toEqual({
      task: "delegate",
      ...REQUEST_IDENTITY,
      inputIdentitySha256: REQUEST_INPUT_SHA,
      completionMarkerId: MARKER_ID,
      completionMarkerIdentitySha256:
        computeHostAcceptanceCompletionMarkerIdentitySha256({
          nonce: NONCE_A,
          completionMarkerId: MARKER_ID,
          inputIdentitySha256: REQUEST_INPUT_SHA,
        }),
    });
    expect(parsed).not.toHaveProperty("raw");
  });

  it.each([
    ["unknown field", () => descriptorValue({ extra: true })],
    ["missing field", () => {
      const value = descriptorValue();
      delete (value as Partial<typeof value>).nonce;
      return value;
    }],
    ["wrong package", () => descriptorValue({ packageName: "other" })],
    ["wrong runtime version", () => ({ ...descriptorValue(), publicBeta: { ...descriptorValue().publicBeta, version: "0.1.1-beta.2", tag: "v0.1.1-beta.2", markerPath: ".release-validation/v0.1.1-beta.2.json" } })],
    ["weak nonce", () => descriptorValue({ nonce: "short" })],
    ["arbitrary pipe", () => descriptorValue({ pipeName: "..\\private" })],
    ["arbitrary marker", () => ({ ...descriptorValue(), request: { ...descriptorValue().request, completionMarkerId: "..\\marker" } })],
    ["arbitrary observer path", () => ({ ...descriptorValue(), publicBeta: { ...descriptorValue().publicBeta, observerArtifact: { ...descriptorValue().publicBeta.observerArtifact, path: "host-acceptance/other.exe" } } })],
    ["wrong digest", () => ({ ...descriptorValue(), request: { ...descriptorValue().request, inputIdentitySha256: "A".repeat(64) } })],
  ])("rejects %s", (_name, makeValue) => {
    expect(() =>
      parseHostAcceptanceDescriptorBytes(
        Buffer.from(JSON.stringify(makeValue())),
        { packageName: "codex-agent-tools", packageVersion: "0.1.1-beta.1" },
      ),
    ).toThrow(/descriptor is invalid/iu);
  });

  it("rejects duplicate keys, invalid UTF-8, NUL, and oversize bytes", () => {
    const validText = JSON.stringify(descriptorValue());
    expect(() =>
      parseHostAcceptanceDescriptorBytes(
        Buffer.from(validText.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
        { packageName: "codex-agent-tools", packageVersion: "0.1.1-beta.1" },
      ),
    ).toThrow(/descriptor is invalid/iu);
    expect(() =>
      parseHostAcceptanceDescriptorBytes(Buffer.from([0xff]), {
        packageName: "codex-agent-tools",
        packageVersion: "0.1.1-beta.1",
      }),
    ).toThrow(/descriptor is invalid/iu);
    expect(() =>
      parseHostAcceptanceDescriptorBytes(Buffer.from(`${validText}\0`), {
        packageName: "codex-agent-tools",
        packageVersion: "0.1.1-beta.1",
      }),
    ).toThrow(/descriptor is invalid/iu);
    expect(() =>
      parseHostAcceptanceDescriptorBytes(Buffer.alloc(16 * 1024 + 1, 0x20), {
        packageName: "codex-agent-tools",
        packageVersion: "0.1.1-beta.1",
      }),
    ).toThrow(/descriptor is invalid/iu);
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("reads only the fixed LOCALAPPDATA file and rejects reparse ancestors or file", async () => {
    const localAppData = await (async () => {
      const root = await import("node:fs/promises").then(({ mkdtemp }) =>
        mkdtemp(path.join(os.tmpdir(), "host-acceptance-descriptor-")),
      );
      roots.push(root);
      return root;
    })();
    const descriptorPath = path.join(
      localAppData,
      ...HOST_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH.split("/"),
    );
    await mkdir(path.dirname(descriptorPath), { recursive: true });
    await writeFile(descriptorPath, JSON.stringify(descriptorValue()));

    await expect(
      readHostAcceptanceDescriptor({
        platform: "win32",
        localAppData,
        expectedPackageName: "codex-agent-tools",
        expectedPackageVersion: "0.1.1-beta.1",
      }),
    ).resolves.toMatchObject({ nonce: NONCE_A });

    const linkedLocalAppData = `${localAppData}-link`;
    roots.push(linkedLocalAppData);
    await symlink(localAppData, linkedLocalAppData, "junction");
    await expect(
      readHostAcceptanceDescriptor({
        platform: "win32",
        localAppData: linkedLocalAppData,
        expectedPackageName: "codex-agent-tools",
        expectedPackageVersion: "0.1.1-beta.1",
      }),
    ).resolves.toBeUndefined();

    const middleLinkRoot = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "host-acceptance-middle-link-")),
    );
    roots.push(middleLinkRoot);
    await mkdir(path.join(middleLinkRoot, "real-host-acceptance"), {
      recursive: true,
    });
    await writeFile(
      path.join(middleLinkRoot, "real-host-acceptance", "session.v1.json"),
      JSON.stringify(descriptorValue()),
    );
    await mkdir(path.join(middleLinkRoot, "codex-agent-tools"), {
      recursive: true,
    });
    await symlink(
      path.join(middleLinkRoot, "real-host-acceptance"),
      path.join(middleLinkRoot, "codex-agent-tools", "host-acceptance"),
      "junction",
    );
    await expect(
      readHostAcceptanceDescriptor({
        platform: "win32",
        localAppData: middleLinkRoot,
        expectedPackageName: "codex-agent-tools",
        expectedPackageVersion: "0.1.1-beta.1",
      }),
    ).resolves.toBeUndefined();

    const fileLinkRoot = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "host-acceptance-file-link-")),
    );
    roots.push(fileLinkRoot);
    const fileLinkPath = path.join(
      fileLinkRoot,
      ...HOST_ACCEPTANCE_DESCRIPTOR_RELATIVE_PATH.split("/"),
    );
    await mkdir(path.dirname(fileLinkPath), { recursive: true });
    const realDescriptor = path.join(fileLinkRoot, "real-session-directory");
    await mkdir(realDescriptor);
    await symlink(realDescriptor, fileLinkPath, "junction");
    await expect(
      readHostAcceptanceDescriptor({
        platform: "win32",
        localAppData: fileLinkRoot,
        expectedPackageName: "codex-agent-tools",
        expectedPackageVersion: "0.1.1-beta.1",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("host acceptance event client", () => {
  it("is a safe no-op outside Windows or without LOCALAPPDATA", async () => {
    const loadDescriptor = vi.fn(async () => loadedDescriptor());
    const connect = vi.fn();
    const linux = createHostAcceptanceEventClient({
      platform: "linux",
      processId: 17,
      loadDescriptor,
      connect,
    });
    const missingRoot = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 17,
      loadDescriptor,
      connect,
      localAppDataAvailable: false,
    });

    await linux.openRequest("delegate", ACCEPTANCE_INPUT);
    await missingRoot.openRequest("delegate", ACCEPTANCE_INPUT);
    await Promise.all([linux.settled(), missingRoot.settled()]);

    expect(loadDescriptor).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("does one descriptor check per request and has zero transport/timer side effects when absent", async () => {
    const loadDescriptor = vi.fn(async () => undefined);
    const connect = vi.fn();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const client = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 17,
      loadDescriptor,
      connect,
    });
    try {
      await client.openRequest("delegate", ACCEPTANCE_INPUT);
      await client.openRequest("delegate", ACCEPTANCE_INPUT);
      await client.settled();

      expect(loadDescriptor).toHaveBeenCalledTimes(2);
      expect(connect).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });

  it("consumes a failed attempt, never retries the same nonce, and allows one new nonce", async () => {
    const first = loadedDescriptor();
    const second = loadedDescriptor({ nonce: NONCE_B, pipeName: PIPE_B });
    const descriptors = [first, first, second, second];
    const loadDescriptor = vi.fn(async () => descriptors.shift());
    const connect = vi.fn((pipePath: string) => {
      if (pipePath.endsWith(PIPE_A)) throw new Error("sync connect failure");
      return { write: vi.fn(async () => undefined), close: vi.fn() };
    });
    const client = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 17,
      loadDescriptor,
      connect,
    });

    await client.openRequest("delegate", ACCEPTANCE_INPUT);
    await client.openRequest("delegate", ACCEPTANCE_INPUT);
    await client.openRequest("delegate", ACCEPTANCE_INPUT);
    await client.openRequest("delegate", ACCEPTANCE_INPUT);
    await client.settled();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls.map(([pipeName]) => pipeName)).toEqual([
      first.pipePath,
      second.pipePath,
    ]);
  });

  it("lets an arbitrary old-host request establish only HELLO before a later exact delegate match", async () => {
    const frames: Uint8Array[] = [];
    const transport: HostAcceptancePipeTransport = {
      write: vi.fn(async (frame) => {
        frames.push(frame);
      }),
      close: vi.fn(),
    };
    const connect = vi.fn(async () => transport);
    const client = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 77,
      loadDescriptor: vi.fn(async () => loadedDescriptor()),
      connect,
    });

    await expect(
      client.openRequest("review", {
        llm: "kimi-k3",
        task: "review_plan",
        prompt: "ordinary old-host handshake",
        cwd: process.cwd(),
      }),
    ).resolves.toBeUndefined();
    await client.settled();
    expect(
      (decodeFrames(frames) as Array<{ type: string }>).map(({ type }) => type),
    ).toEqual(["HELLO"]);

    const sink = await client.openRequest("delegate", ACCEPTANCE_INPUT);
    expect(sink).toBeTypeOf("function");
    sink?.(requestEvent());
    await client.settled();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(
      (decodeFrames(frames) as Array<{ type: string }>).map(({ type }) => type),
    ).toEqual(["HELLO", "REQUEST_STARTED"]);
  });

  it("uses the validated delegate projection and includes every behavioral input field", async () => {
    const connect = vi.fn(async () => ({
      write: vi.fn(async () => undefined),
      close: vi.fn(),
    }));
    const mismatched = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 78,
      loadDescriptor: vi.fn(async () => loadedDescriptor()),
      connect,
    });
    await expect(
      mismatched.openRequest("delegate", {
        ...ACCEPTANCE_INPUT,
        timeoutMs: ACCEPTANCE_INPUT.timeoutMs + 1,
      }),
    ).resolves.toBeUndefined();

    const normalized = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 79,
      loadDescriptor: vi.fn(async () => loadedDescriptor()),
      connect: vi.fn(async () => ({
        write: vi.fn(async () => undefined),
        close: vi.fn(),
      })),
    });
    await expect(
      normalized.openRequest("delegate", {
        ...ACCEPTANCE_INPUT,
        llm: ` ${ACCEPTANCE_INPUT.llm} `,
        prompt: ` ${ACCEPTANCE_INPUT.prompt} `,
        cwd: ` ${ACCEPTANCE_INPUT.cwd} `,
        sessionId: ` ${ACCEPTANCE_INPUT.sessionId} `,
      }),
    ).resolves.toBeTypeOf("function");
  });

  it("returns without waiting for pipe connect and suppresses late HELLO after shutdown", async () => {
    let resolveConnection!: (transport: HostAcceptancePipeTransport) => void;
    const connection = new Promise<HostAcceptancePipeTransport>((resolve) => {
      resolveConnection = resolve;
    });
    const frames: Uint8Array[] = [];
    const transport: HostAcceptancePipeTransport = {
      write: vi.fn(async (frame) => {
        frames.push(frame);
      }),
      close: vi.fn(),
    };
    const client = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 80,
      loadDescriptor: vi.fn(async () => loadedDescriptor()),
      connect: vi.fn(() => connection),
    });

    const opened = client.openRequest("delegate", ACCEPTANCE_INPUT);
    const outcome = await Promise.race([
      opened.then(() => "opened" as const),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    expect(outcome).toBe("opened");

    client.shutdown();
    resolveConnection(transport);
    await client.settled();
    expect(frames).toEqual([]);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("does not connect when shutdown wins while the fixed descriptor read is pending", async () => {
    let resolveDescriptor!: (
      descriptor: LoadedHostAcceptanceDescriptor | undefined,
    ) => void;
    const descriptor = new Promise<LoadedHostAcceptanceDescriptor | undefined>(
      (resolve) => {
        resolveDescriptor = resolve;
      },
    );
    const connect = vi.fn();
    const client = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 81,
      loadDescriptor: vi.fn(() => descriptor),
      connect,
    });

    const opening = client.openRequest("delegate", ACCEPTANCE_INPUT);
    client.shutdown();
    resolveDescriptor(loadedDescriptor());

    await expect(opening).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });

  it("serializes HELLO and one matched request with transport backpressure and ignores late events", async () => {
    const frames: Uint8Array[] = [];
    const releases: Array<() => void> = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const transport: HostAcceptancePipeTransport = {
      close: vi.fn(),
      write: vi.fn((frame) => {
        frames.push(frame);
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        return new Promise<void>((resolve) => {
          releases.push(() => {
            activeWrites -= 1;
            resolve();
          });
        });
      }),
    };
    const client = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 123,
      loadDescriptor: vi.fn(async () => loadedDescriptor()),
      connect: vi.fn(async () => transport),
    });

    const sink = await client.openRequest("delegate", ACCEPTANCE_INPUT);
    expect(sink).toBeTypeOf("function");
    sink?.(requestEvent());
    sink?.(laterEvent("sdkAbort"));
    sink?.(ownedEvent());
    sink?.(laterEvent("handlerCancelled"));
    sink?.(laterEvent("inFlightRemoved"));
    sink?.(laterEvent("sdkAbort"));

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    while (releases.length > 0 || frames.length < 6) {
      releases.shift()?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    releases.shift()?.();
    await client.settled();

    expect(maximumActiveWrites).toBe(1);
    const decoded = decodeFrames(frames) as Array<Record<string, unknown>>;
    expect(decoded.map(({ type }) => type)).toEqual([
      "HELLO",
      "REQUEST_STARTED",
      "REQUEST_ABORTED",
      "OWNED_EXIT",
      "HANDLER_CANCELLED",
      "INFLIGHT_REMOVED",
    ]);
    expect(decoded.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(decoded[0]).toMatchObject({
      schemaVersion: 1,
      protocolVersion: 1,
      type: "HELLO",
      nonce: NONCE_A,
      descriptorSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      mcp: { pid: 123, packageName: "codex-agent-tools", version: "0.1.1-beta.1" },
    });
    expect(decoded[1]).toMatchObject({
      requestIdType: "string",
      requestCorrelationSha256: SHA256_A,
      completionMarkerId: MARKER_ID,
      completionMarkerIdentitySha256:
        computeHostAcceptanceCompletionMarkerIdentitySha256({
          nonce: NONCE_A,
          completionMarkerId: MARKER_ID,
          inputIdentitySha256: REQUEST_INPUT_SHA,
        }),
    });
    expect(JSON.stringify(decoded)).not.toContain("prompt");
    expect(JSON.stringify(decoded)).not.toContain("cwd");
  });

  it("isolates concurrent requests, permits only one matched request, and swallows async write/close failures", async () => {
    const frames: Uint8Array[] = [];
    const transport: HostAcceptancePipeTransport = {
      write: vi.fn(async (frame) => {
        frames.push(frame);
        if (frames.length === 3) throw new Error("async write failure");
      }),
      close: vi.fn(() => {
        throw new Error("sync close failure");
      }),
    };
    const loadDescriptor = vi.fn(async () => loadedDescriptor());
    const client = createHostAcceptanceEventClient({
      platform: "win32",
      processId: 321,
      loadDescriptor,
      connect: vi.fn(async () => transport),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const [first, second] = await Promise.all([
        client.openRequest("delegate", ACCEPTANCE_INPUT),
        client.openRequest("delegate", ACCEPTANCE_INPUT),
      ]);
      expect([first, second].filter((entry) => entry !== undefined)).toHaveLength(1);
      const sink = first ?? second;
      sink?.(requestEvent(SHA256_A));
      sink?.(laterEvent("sdkAbort", SHA256_A));
      sink?.(laterEvent("inFlightRemoved", SHA256_A));
      client.shutdown();
      await client.settled();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(loadDescriptor).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
      const decoded = decodeFrames(frames) as Array<Record<string, unknown>>;
      expect(decoded.filter(({ type }) => type === "REQUEST_STARTED")).toHaveLength(1);
      expect(decoded.some(({ requestCorrelationSha256 }) => requestCorrelationSha256 === SHA256_B)).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
