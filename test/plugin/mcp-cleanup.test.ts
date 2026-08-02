import { describe, expect, it, vi } from "vitest";

import { cleanupOwnedMcpTransport } from "../../src/plugin/mcp-cleanup.js";

describe("cleanupOwnedMcpTransport", () => {
  it("closes the SDK client before its stdio transport", async () => {
    const events: string[] = [];
    const client = {
      close: vi.fn(async () => {
        events.push("client.close");
      }),
    };
    const transport = {
      close: vi.fn(async () => {
        events.push("transport.close");
      }),
    };

    await cleanupOwnedMcpTransport(client, transport);

    expect(events).toEqual(["client.close", "transport.close"]);
  });

  it("does not inspect transport PID metadata", async () => {
    const close = vi.fn(async () => undefined);
    const transport = {
      close,
      get pid(): never {
        throw new Error("PID metadata must not drive cleanup");
      },
    };

    await cleanupOwnedMcpTransport(undefined, transport);

    expect(close).toHaveBeenCalledOnce();
  });

  it("still closes the transport and aggregates both close failures", async () => {
    const clientError = new Error("client close failed");
    const transportError = new Error("transport close failed");
    const transportClose = vi.fn(async () => {
      throw transportError;
    });

    await expect(
      cleanupOwnedMcpTransport(
        { close: async () => Promise.reject(clientError) },
        { close: transportClose },
      ),
    ).rejects.toEqual(
      new AggregateError(
        [clientError, transportError],
        "Failed to clean up owned MCP transport",
      ),
    );
    expect(transportClose).toHaveBeenCalledOnce();
  });

  it("preserves a single close failure", async () => {
    const failure = new Error("transport close failed");

    await expect(
      cleanupOwnedMcpTransport(undefined, {
        close: async () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
  });
});
