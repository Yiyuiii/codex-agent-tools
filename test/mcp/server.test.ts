import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { createMcpServer } from "../../src/mcp/server.js";
import { registerExternalTools } from "../../src/mcp/tools.js";
import type { ExternalReviewResult } from "../../src/tasks/results.js";

function reviewResult(): ExternalReviewResult {
  return {
    ok: true,
    status: "completed",
    llm: "kimi-k3",
    actualModel: "kimi-code/k3",
    elapsedMs: 10,
    sessionId: "session-1",
    diagnostics: [],
    filesChanged: [],
    review: "No findings.",
  };
}

describe("codex_external_agents MCP server", () => {
  it("lists only the two approved tools with required llm and accurate annotations", async () => {
    const service = {
      review: vi.fn(async () => reviewResult()),
      delegate: vi.fn(),
    };
    const server = createMcpServer(service);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "external_delegate",
        "external_review",
      ]);
      const review = listed.tools.find((tool) => tool.name === "external_review")!;
      const delegate = listed.tools.find((tool) => tool.name === "external_delegate")!;
      expect(review.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(delegate.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      for (const tool of [review, delegate]) {
        expect(tool.outputSchema).toBeDefined();
        expect(tool.outputSchema?.required).toContain("status");
        expect(tool.outputSchema?.required).toContain("llm");
        expect(tool.inputSchema.required).toContain("llm");
        expect(tool.inputSchema.properties).toHaveProperty("llm");
        expect(tool.inputSchema.properties).not.toHaveProperty("backend");
        expect(tool.inputSchema.properties).not.toHaveProperty("provider");
        expect(tool.inputSchema.properties).not.toHaveProperty("model");
        expect(tool.inputSchema.properties).not.toHaveProperty("proxy");
        expect(tool.inputSchema.properties).not.toHaveProperty("tools");
        expect(tool.inputSchema.properties).not.toHaveProperty("effort");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("passes cancellation and progress hooks into review and returns structured content", async () => {
    let callback:
      | ((input: unknown, extra: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    const signal = new AbortController().signal;
    let observedSignal: AbortSignal | undefined;
    const notifications: unknown[] = [];
    const service = {
      review: vi.fn(async (_input: unknown, context?: { signal?: AbortSignal; onProgress?: (message: string) => void }) => {
        observedSignal = context?.signal;
        context?.onProgress?.("kimi heartbeat 1000ms");
        return reviewResult();
      }),
      delegate: vi.fn(),
    };
    const fakeServer = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (input: unknown, extra: Record<string, unknown>) => Promise<unknown>,
      ) {
        if (name === "external_review") callback = handler;
      },
    };
    registerExternalTools(fakeServer as never, service);

    const result = (await callback?.(
      {
        llm: "kimi-k3",
        task: "review_plan",
        prompt: "Review",
        cwd: process.cwd(),
      },
      {
        signal,
        _meta: { progressToken: "progress-1" },
        sendNotification: async (notification: unknown) => {
          notifications.push(notification);
        },
      },
    )) as { structuredContent: ExternalReviewResult; content: Array<{ text: string }> };

    expect(observedSignal).toBe(signal);
    expect(notifications).toEqual([
      {
        method: "notifications/progress",
        params: {
          progressToken: "progress-1",
          progress: 1,
          message: "kimi heartbeat 1000ms",
        },
      },
    ]);
    expect(result.structuredContent.review).toBe("No findings.");
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "completed",
      llm: "kimi-k3",
    });
  });
});
