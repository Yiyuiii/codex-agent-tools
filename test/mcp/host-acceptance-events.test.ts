import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createHostAcceptanceRequestIdentity,
  emitHostAcceptanceEvent,
  type HostAcceptanceLifecycleEvent,
} from "../../src/mcp/host-acceptance-events.js";

describe("host acceptance lifecycle events", () => {
  it("marks the SDK request id type and exposes only a domain-separated SHA-256", () => {
    const rawStringId = "private-request-17";
    const stringIdentity = createHostAcceptanceRequestIdentity(rawStringId);
    const numberIdentity = createHostAcceptanceRequestIdentity(17);

    expect(stringIdentity).toEqual({
      requestIdType: "string",
      requestIdSha256: createHash("sha256")
        .update(
          "codex-agent-tools/host-acceptance/request-id/v1\0string\0private-request-17",
          "utf8",
        )
        .digest("hex"),
    });
    expect(numberIdentity).toEqual({
      requestIdType: "number",
      requestIdSha256: createHash("sha256")
        .update(
          `codex-agent-tools/host-acceptance/request-id/v1\0number\0${17}`,
          "utf8",
        )
        .digest("hex"),
    });
    expect(JSON.stringify(stringIdentity)).not.toContain(rawStringId);
    expect(stringIdentity.requestIdSha256).not.toBe(
      numberIdentity.requestIdSha256,
    );
  });

  it("keeps synchronous throws and asynchronous rejections best effort", async () => {
    const event: HostAcceptanceLifecycleEvent = {
      type: "requestStarted",
      task: "review",
      requestIdType: "number",
      requestIdSha256: "a".repeat(64),
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      expect(() =>
        emitHostAcceptanceEvent(() => {
          throw new Error("sync sink failure");
        }, event),
      ).not.toThrow();
      expect(() =>
        emitHostAcceptanceEvent(async () => {
          throw new Error("async sink failure");
        }, event),
      ).not.toThrow();

      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does nothing when no sink is installed", () => {
    const event = Object.freeze({
      type: "inFlightRemoved" as const,
      requestIdType: "number" as const,
      requestIdSha256: "b".repeat(64),
    });

    expect(() => emitHostAcceptanceEvent(undefined, event)).not.toThrow();
  });
});
