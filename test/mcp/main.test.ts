import { expect, it } from "vitest";

import { mcpUsage } from "../../src/mcp/main.js";

it("documents the dedicated stdio MCP entry", () => {
  expect(mcpUsage()).toContain("codex-external-agents-mcp");
  expect(mcpUsage()).toContain("stdio");
  expect(mcpUsage()).toContain("external_review");
  expect(mcpUsage()).toContain("external_delegate");
});
