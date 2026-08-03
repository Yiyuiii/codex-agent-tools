export interface McpClosable {
  close(): Promise<void>;
}

export type OwnedMcpTransport = McpClosable;

export async function cleanupOwnedMcpTransport(
  client: McpClosable | undefined,
  transport: OwnedMcpTransport | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  if (client !== undefined) {
    try {
      await client.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (transport !== undefined) {
    try {
      await transport.close();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Failed to clean up owned MCP transport");
  }
}
