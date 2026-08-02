import { createConnection, type Socket } from "node:net";

import { PACKAGE_NAME, VERSION } from "../version.js";
import { externalDelegateInputSchema } from "../tasks/schemas.js";
import {
  computeHostAcceptanceDelegateInputIdentity,
  HOST_ACCEPTANCE_FRAME_MAXIMUM_BYTES,
  HOST_ACCEPTANCE_MAXIMUM_EVENTS_PER_CONNECTION,
  readHostAcceptanceDescriptor,
  type LoadedHostAcceptanceDescriptor,
} from "./host-acceptance-descriptor.js";
import type {
  HostAcceptanceEventSink,
  HostAcceptanceLifecycleEvent,
} from "./host-acceptance-events.js";

import protocol from "../../host-acceptance/protocol/observer-protocol.v1.json" with {
  type: "json",
};

export interface HostAcceptancePipeTransport {
  write(frame: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface HostAcceptanceRequestResolver {
  openRequest(
    task: "review" | "delegate",
    input: unknown,
  ): Promise<HostAcceptanceEventSink | undefined>;
}

export interface HostAcceptanceEventClient extends HostAcceptanceRequestResolver {
  shutdown(): void;
  settled(): Promise<void>;
}

type WireFrame = Readonly<Record<string, unknown> & { readonly type: string }>;
type PartialWireFrame = Readonly<
  Record<string, unknown> & { readonly type: string }
>;

function requestKey(event: HostAcceptanceLifecycleEvent): string {
  return `${event.requestIdType}:${event.requestIdSha256}`;
}

function frameBytes(frame: WireFrame): Uint8Array {
  const expected = (
    protocol.frames.keys as Record<string, readonly string[]>
  )[frame.type];
  if (expected === undefined) throw new Error("Host acceptance frame is invalid.");
  const actualKeys = Object.keys(frame).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Host acceptance frame is invalid.");
  }
  const bytes = Buffer.from(`${JSON.stringify(frame)}${protocol.frames.terminator}`);
  if (bytes.byteLength > HOST_ACCEPTANCE_FRAME_MAXIMUM_BYTES) {
    throw new Error("Host acceptance frame is invalid.");
  }
  return bytes;
}

function bestEffortClose(transport: HostAcceptancePipeTransport): void {
  try {
    const result = transport.close();
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // The evidence side channel cannot alter the public task result.
  }
}

class SessionAttempt {
  readonly descriptor: LoadedHostAcceptanceDescriptor;
  #transport: HostAcceptancePipeTransport | undefined;
  #tail: Promise<void>;
  #failed = false;
  #closed = false;
  #claimed = false;
  #eventCount = 0;
  #sequence = 1;
  #helloSent = false;
  #transportClosed = false;

  constructor(
    descriptor: LoadedHostAcceptanceDescriptor,
    processId: number,
  ) {
    this.descriptor = descriptor;
    this.#tail = Promise.resolve();
    this.#processId = processId;
  }

  readonly #processId: number;

  start(
    connector: (
      pipePath: string,
    ) => HostAcceptancePipeTransport | Promise<HostAcceptancePipeTransport>,
  ): void {
    let connection: Promise<HostAcceptancePipeTransport>;
    try {
      connection = Promise.resolve(connector(this.descriptor.pipePath));
    } catch (error) {
      connection = Promise.reject(error);
    }
    this.#tail = connection
      .then(async (transport) => {
        this.#transport = transport;
        if (this.#failed || this.#closed) {
          this.#closeTransport();
          return;
        }
        await transport.write(
          frameBytes({
            schemaVersion: 1,
            protocolVersion: 1,
            type: "HELLO",
            nonce: this.descriptor.nonce,
            sequence: 0,
            descriptorSha256: this.descriptor.descriptorSha256,
            publicBeta: this.descriptor.publicBeta,
            mcp: Object.freeze({
              pid: this.#processId,
              packageName: this.descriptor.packageName,
              version: this.descriptor.publicBeta.version,
            }),
          }),
        );
        this.#helloSent = true;
      })
      .catch(() => {
        this.#fail();
      });
  }

  matches(descriptor: LoadedHostAcceptanceDescriptor): boolean {
    return descriptor.descriptorSha256 === this.descriptor.descriptorSha256;
  }

  claim(): boolean {
    if (this.#claimed || this.#failed || this.#closed) return false;
    this.#claimed = true;
    return true;
  }

  enqueue(frame: PartialWireFrame): void {
    if (this.#failed || this.#closed) return;
    if (this.#eventCount >= HOST_ACCEPTANCE_MAXIMUM_EVENTS_PER_CONNECTION) {
      this.#fail();
      return;
    }
    this.#eventCount += 1;
    const wire = Object.freeze({
      schemaVersion: 1,
      protocolVersion: 1,
      ...frame,
      nonce: this.descriptor.nonce,
      sequence: this.#sequence++,
    }) as unknown as WireFrame;
    this.#tail = this.#tail
      .then(async () => {
        if (
          this.#failed ||
          this.#transport === undefined ||
          (this.#closed && !this.#helloSent)
        ) {
          return;
        }
        await this.#transport.write(frameBytes(wire));
      })
      .catch(() => {
        this.#fail();
      });
  }

  shutdown(): void {
    if (this.#failed || this.#closed) return;
    this.#closed = true;
    this.#tail = this.#tail.finally(() => {
      this.#closeTransport();
    });
    void this.#tail.catch(() => undefined);
  }

  settled(): Promise<void> {
    return this.#tail.then(() => undefined, () => undefined);
  }

  #fail(): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#closeTransport();
  }

  #closeTransport(): void {
    if (this.#transport === undefined || this.#transportClosed) return;
    this.#transportClosed = true;
    bestEffortClose(this.#transport);
  }
}

function requestSink(
  session: SessionAttempt,
): HostAcceptanceEventSink {
  let correlationKey: string | undefined;
  let removed = false;
  return (event) => {
    try {
      if (removed) return;
      const key = requestKey(event);
      if (correlationKey === undefined) {
        if (event.type !== "requestStarted") return;
        correlationKey = key;
      } else if (key !== correlationKey || event.type === "requestStarted") {
        return;
      }

      const descriptor = session.descriptor;
      switch (event.type) {
        case "requestStarted":
          session.enqueue({
            type: "REQUEST_STARTED",
            requestIdType: event.requestIdType,
            requestCorrelationSha256: event.requestIdSha256,
            inputIdentitySha256: descriptor.request.inputIdentitySha256,
            completionMarkerId: descriptor.request.completionMarkerId,
            completionMarkerIdentitySha256:
              descriptor.request.completionMarkerIdentitySha256,
            descriptorSha256: descriptor.descriptorSha256,
          });
          break;
        case "sdkAbort":
          session.enqueue({
            type: "REQUEST_ABORTED",
            requestIdType: event.requestIdType,
            requestCorrelationSha256: event.requestIdSha256,
          });
          break;
        case "ownedExit":
          session.enqueue({
            type: "OWNED_EXIT",
            requestIdType: event.requestIdType,
            requestCorrelationSha256: event.requestIdSha256,
            completion: "cancelled",
            ownershipDrained: true,
          });
          break;
        case "handlerCancelled":
          session.enqueue({
            type: "HANDLER_CANCELLED",
            requestIdType: event.requestIdType,
            requestCorrelationSha256: event.requestIdSha256,
          });
          break;
        case "inFlightRemoved":
          session.enqueue({
            type: "INFLIGHT_REMOVED",
            requestIdType: event.requestIdType,
            requestCorrelationSha256: event.requestIdSha256,
          });
          removed = true;
          break;
      }
    } catch {
      // Evidence serialization is best effort and cannot alter the task.
    }
  };
}

export function createHostAcceptanceEventClient(options: {
  readonly platform: NodeJS.Platform;
  readonly processId: number;
  readonly localAppDataAvailable?: boolean;
  readonly loadDescriptor: () => Promise<LoadedHostAcceptanceDescriptor | undefined>;
  readonly connect: (
    pipePath: string,
  ) => HostAcceptancePipeTransport | Promise<HostAcceptancePipeTransport>;
}): HostAcceptanceEventClient {
  const enabled =
    options.platform === "win32" &&
    options.localAppDataAvailable !== false &&
    Number.isSafeInteger(options.processId) &&
    options.processId > 0;
  const attempts = new Map<string, SessionAttempt>();
  let closed = false;

  return {
    async openRequest(task, input) {
      if (!enabled || closed) return undefined;
      let descriptor: LoadedHostAcceptanceDescriptor | undefined;
      try {
        descriptor = await options.loadDescriptor();
      } catch {
        return undefined;
      }
      if (descriptor === undefined || closed) return undefined;

      let session = attempts.get(descriptor.nonce);
      if (session === undefined) {
        session = new SessionAttempt(descriptor, options.processId);
        attempts.set(descriptor.nonce, session);
        session.start(options.connect);
      } else if (!session.matches(descriptor)) {
        return undefined;
      }

      if (task !== "delegate") return undefined;
      const parsed = externalDelegateInputSchema.safeParse(input);
      if (!parsed.success) return undefined;
      const actualIdentity = computeHostAcceptanceDelegateInputIdentity(
        parsed.data,
      );
      if (
        actualIdentity.inputIdentitySha256 !==
          descriptor.request.inputIdentitySha256 ||
        !session.claim()
      ) {
        return undefined;
      }
      return requestSink(session);
    },
    shutdown() {
      if (closed) return;
      closed = true;
      for (const session of attempts.values()) session.shutdown();
    },
    async settled() {
      await Promise.all([...attempts.values()].map((session) => session.settled()));
    },
  };
}

function connectNamedPipe(pipePath: string): Promise<HostAcceptancePipeTransport> {
  return new Promise((resolve, reject) => {
    let connected = false;
    let terminalError: Error | undefined;
    const socket: Socket = createConnection(pipePath);
    socket.unref();
    socket.on("error", (error) => {
      terminalError ??= error;
      if (!connected) reject(error);
    });
    socket.once("close", () => {
      if (!connected) {
        reject(new Error("Host acceptance pipe closed before connection."));
      }
    });
    socket.once("connect", () => {
      connected = true;
      resolve({
        write(frame) {
          if (terminalError !== undefined || socket.destroyed) {
            return Promise.reject(
              terminalError ?? new Error("Host acceptance pipe is closed."),
            );
          }
          return new Promise<void>((resolveWrite, rejectWrite) => {
            try {
              socket.write(frame, (error?: Error | null) => {
                if (error === undefined || error === null) resolveWrite();
                else rejectWrite(error);
              });
            } catch (error) {
              rejectWrite(error);
            }
          });
        },
        close() {
          socket.end();
        },
      });
    });
  });
}

export function createDefaultHostAcceptanceEventClient(): HostAcceptanceEventClient {
  const localAppData = process.env.LOCALAPPDATA;
  return createHostAcceptanceEventClient({
    platform: process.platform,
    processId: process.pid,
    localAppDataAvailable:
      typeof localAppData === "string" && localAppData.trim().length > 0,
    loadDescriptor: () =>
      readHostAcceptanceDescriptor({
        platform: process.platform,
        ...(localAppData === undefined ? {} : { localAppData }),
        expectedPackageName: PACKAGE_NAME,
        expectedPackageVersion: VERSION,
      }),
    connect: connectNamedPipe,
  });
}
