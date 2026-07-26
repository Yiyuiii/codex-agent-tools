import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import type { ExternalAgentAdapter } from "../../src/adapters/adapter.js";
import type { RuntimeKind } from "../../src/domain/types.js";
import {
  assertCompletedDelegate,
  assertCompletedReview,
  assertLocalToolContract,
  forwardedCredentialEnvironment,
  requireStructuredContent,
} from "../../src/acceptance/local.js";
import { resolveLlm, supportedLlmIds } from "../../src/llms/registry.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { ExternalAgentService } from "../../src/tasks/service.js";

describe("local MCP acceptance assertions", () => {
  it("returns structured MCP content", () => {
    const content = { status: "completed" };
    expect(requireStructuredContent({ structuredContent: content })).toBe(content);
  });

  it("surfaces a bounded MCP error when structured content is absent", () => {
    expect(() =>
      requireStructuredContent({
        isError: true,
        content: [
          {
            type: "text",
            text: 'Unknown logical llm "gemini-3.5-flash". Supported llms: ark-agent-deepseek-v4-flash, ark-agent-plan, ark-coding-plan, kimi-k3',
          },
        ],
      }),
    ).toThrow(
      /Unknown logical llm.*ark-agent-deepseek-v4-flash, ark-agent-plan, ark-coding-plan, kimi-k3/u,
    );
  });

  it("rejects retired Gemini through the real MCP handler before either adapter starts", async () => {
    const kimiRun = vi.fn();
    const piRun = vi.fn();
    const adapters = new Map<RuntimeKind, ExternalAgentAdapter>([
      ["kimi-acp", { runtime: "kimi-acp", run: kimiRun }],
      ["pi-rpc", { runtime: "pi-rpc", run: piRun }],
    ]);
    const service = new ExternalAgentService({
      registry: {
        ids: supportedLlmIds,
        resolve: resolveLlm,
      },
      adapters,
    });
    const server = createMcpServer(service);
    const client = new Client({
      name: "retired-gemini-acceptance",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "external_review",
        arguments: {
          llm: "gemini-3.5-flash",
          task: "review_doc",
          prompt: "Review without modifying files.",
          cwd: process.cwd(),
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringMatching(
            /Unknown logical llm.*ark-agent-deepseek-v4-flash, ark-agent-plan, ark-coding-plan, kimi-k3/u,
          ),
        }),
      );
      expect(piRun).not.toHaveBeenCalled();
      expect(kimiRun).not.toHaveBeenCalled();
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("accepts exactly the two public tools with required llm and safe annotations", () => {
    expect(() =>
      assertLocalToolContract([
        {
          name: "external_review",
          inputSchema: { required: ["llm", "prompt", "cwd", "task"] },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: "external_delegate",
          inputSchema: { required: ["llm", "prompt", "cwd"] },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ]),
    ).not.toThrow();
  });

  it("rejects an extra tool or missing required llm", () => {
    expect(() =>
      assertLocalToolContract([
        {
          name: "external_review",
          inputSchema: { required: ["prompt"] },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: "external_delegate",
          inputSchema: { required: ["llm"] },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        { name: "unexpected", inputSchema: {}, annotations: {} },
      ]),
    ).toThrow(/Unexpected MCP tools|requires llm/u);
  });

  it("requires a completed review with the selected real model and defect evidence", () => {
    expect(() =>
      assertCompletedReview(
        {
          status: "completed",
          actualModel: "deepseek-v4-flash",
          filesChanged: [],
          review: "Empty input has zero length and produces NaN.",
        },
        "deepseek-v4-flash",
      ),
    ).not.toThrow();
    expect(() =>
      assertCompletedReview(
        {
          status: "completed",
          actualModel: "wrong",
          filesChanged: [],
          review: "looks fine",
        },
        "deepseek-v4-flash",
      ),
    ).toThrow(/model|defect/u);
  });

  it("includes bounded adapter diagnostics when a real review fails", () => {
    expect(() =>
      assertCompletedReview(
        {
          status: "failed",
          actualModel: "kimi-code/k3",
          filesChanged: [],
          review: "",
          diagnostics: ["ACP session ended before prompt completion"],
        },
        "kimi-code/k3",
      ),
    ).toThrow(/ACP session ended before prompt completion/u);
  });

  it("forwards only registered credential source variables to the MCP child", () => {
    expect(
      forwardedCredentialEnvironment({
        GEMINI_API_KEY: "gemini",
        GOOGLE_API_KEY: "fallback",
        ARK_API_KEY: "ark-coding-primary",
        VOLCENGINE_API_KEY: "ark-coding-fallback",
        API_KEY_DOUBAO_CODING: "ark-coding-local",
        OPENAI_API_KEY_DOUBAO: "ark-agent",
        ANTHROPIC_API_KEY: "forbidden",
        DEEPSEEK_API_KEY: "forbidden",
        PATH: "C:\\Windows",
      }),
    ).toEqual({
      ARK_API_KEY: "ark-coding-primary",
      VOLCENGINE_API_KEY: "ark-coding-fallback",
      API_KEY_DOUBAO_CODING: "ark-coding-local",
      OPENAI_API_KEY_DOUBAO: "ark-agent",
    });
  });

  it("reports which delegate acceptance evidence is missing", () => {
    expect(() =>
      assertCompletedDelegate(
        {
          status: "completed",
          actualModel: "deepseek-v4-flash",
          filesChanged: ["acceptance-result.txt"],
          commandsRun: [],
          diagnostics: [],
        },
        "deepseek-v4-flash",
        "LOCAL_ACCEPTANCE_OK\n",
        "LOCAL_ACCEPTANCE_OK",
        "acceptance-result.txt",
      ),
    ).toThrow(/commandObserved/u);
  });

  it("accepts an explicitly selected delegate file content", () => {
    expect(() =>
      assertCompletedDelegate(
        {
          status: "completed",
          actualModel: "kimi-code/k3",
          filesChanged: ["result.txt"],
          commandsRun: ["Check repository status"],
          diagnostics: [],
        },
        "kimi-code/k3",
        "KIMI_SMOKE_OK\n",
        "KIMI_SMOKE_OK",
        "result.txt",
      ),
    ).not.toThrow();
  });
});
