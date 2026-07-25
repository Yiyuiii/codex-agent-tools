import { terminateProcessTree } from "../runtime/process-tree.js";

export interface McpClosable {
  close(): Promise<void>;
}

export interface OwnedMcpTransport extends McpClosable {
  readonly pid: number | null;
}

export type OwnedProcessTerminator = (pid: number) => Promise<void>;

export async function cleanupOwnedMcpTransport(
  client: McpClosable | undefined,
  transport: OwnedMcpTransport | undefined,
  terminate: OwnedProcessTerminator = terminateProcessTree,
): Promise<void> {
  const errors: unknown[] = [];
  const pid = transport?.pid;

  if (pid !== undefined && pid !== null) {
    try {
      await terminate(pid);
    } catch (error) {
      errors.push(error);
    }
  }
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
