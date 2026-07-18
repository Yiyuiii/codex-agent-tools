import { describe, expect, it } from "vitest";

import {
  assertCompletedDelegate,
  assertCompletedReview,
  assertLocalToolContract,
  forwardedCredentialEnvironment,
  requireStructuredContent,
} from "../../src/acceptance/local.js";

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
            text: "Logical llm gemini-3.5-flash review quality gate is pending",
          },
        ],
      }),
    ).toThrow(/gemini-3\.5-flash review quality gate is pending/u);
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
          actualModel: "gemini-3.5-flash",
          filesChanged: [],
          review: "Empty input has zero length and produces NaN.",
        },
        "gemini-3.5-flash",
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
        "gemini-3.5-flash",
      ),
    ).toThrow(/model|defect/u);
  });

  it("includes bounded adapter diagnostics when a real review fails", () => {
    expect(() =>
      assertCompletedReview(
        {
          status: "failed",
          actualModel: "kimi-code/kimi-for-coding-highspeed",
          filesChanged: [],
          review: "",
          diagnostics: ["ACP session ended before prompt completion"],
        },
        "kimi-code/kimi-for-coding-highspeed",
      ),
    ).toThrow(/ACP session ended before prompt completion/u);
  });

  it("forwards only registered credential source variables to the MCP child", () => {
    expect(
      forwardedCredentialEnvironment({
        GEMINI_API_KEY: "gemini",
        GOOGLE_API_KEY: "fallback",
        OPENAI_API_KEY_DOUBAO: "ark-agent",
        ANTHROPIC_API_KEY: "forbidden",
        DEEPSEEK_API_KEY: "forbidden",
        PATH: "C:\\Windows",
      }),
    ).toEqual({
      GEMINI_API_KEY: "gemini",
      GOOGLE_API_KEY: "fallback",
      OPENAI_API_KEY_DOUBAO: "ark-agent",
    });
  });

  it("reports which delegate acceptance evidence is missing", () => {
    expect(() =>
      assertCompletedDelegate(
        {
          status: "completed",
          actualModel: "gemini-3.5-flash",
          filesChanged: ["acceptance-result.txt"],
          commandsRun: [],
          diagnostics: [],
        },
        "gemini-3.5-flash",
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
