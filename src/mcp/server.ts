import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { KimiAdapter } from "../adapters/kimi/adapter.js";
import { PiAdapter } from "../adapters/pi/adapter.js";
import type { ExternalAgentAdapter } from "../adapters/adapter.js";
import type { RuntimeKind } from "../domain/types.js";
import {
  resolveLlm,
  supportedLlmIds,
  type LlmRegistry,
} from "../llms/registry.js";
import { ExternalAgentService } from "../tasks/service.js";
import { SERVER_NAME, VERSION } from "../version.js";
import {
  registerExternalTools,
  type ExternalTaskService,
} from "./tools.js";

const defaultRegistry: LlmRegistry = {
  ids: supportedLlmIds,
  resolve: resolveLlm,
};

export function createDefaultExternalAgentService(): ExternalAgentService {
  const kimi = new KimiAdapter();
  const pi = new PiAdapter();
  const adapters = new Map<RuntimeKind, ExternalAgentAdapter>([
    [kimi.runtime, kimi],
    [pi.runtime, pi],
  ]);
  return new ExternalAgentService({ registry: defaultRegistry, adapters });
}

export function createMcpServer(service: ExternalTaskService): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  registerExternalTools(server, service);
  return server;
}

export async function serveMcp(
  service: ExternalTaskService = createDefaultExternalAgentService(),
): Promise<void> {
  const server = createMcpServer(service);
  await server.connect(new StdioServerTransport());
}
