import type { Readable, Writable } from "node:stream";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { InFlightTasks } from "./in-flight.js";

export interface McpSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface McpStdioSessionDependencies {
  server: McpServer;
  transport: StdioServerTransport;
  input: Readable;
  output: Writable;
  inFlight: InFlightTasks;
  signalSource: McpSignalSource;
  reportError?: (message: string) => void;
}

export interface McpStdioSession {
  run(): Promise<void>;
  close(): Promise<void>;
}

interface SessionFailure {
  error: unknown;
}

export function createMcpStdioSession(
  dependencies: McpStdioSessionDependencies,
): McpStdioSession {
  let resolveCompletion!: () => void;
  let rejectCompletion!: (reason?: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);

  let started = false;
  let connected = false;
  let closeRequested = false;
  let listenersInstalled = false;
  let completionSettled = false;
  let shutdownPromise: Promise<void> | undefined;
  let firstFailure: SessionFailure | undefined;

  const reportError = (message: string): void => {
    try {
      dependencies.reportError?.(message);
    } catch {
      // Reporting is best-effort and must not change shutdown completion.
    }
  };

  const recordFailure = (error: unknown, message: string): void => {
    firstFailure ??= { error };
    reportError(message);
  };

  const onInputEnd = (): void => {
    requestClose();
  };
  const onInputClose = (): void => {
    requestClose();
  };
  const onInputError = (error: Error): void => {
    requestClose(error, "MCP stdio input failed; shutting down.");
  };
  const onSigint = (): void => {
    requestClose();
  };
  const onSigterm = (): void => {
    requestClose();
  };

  const installListeners = (): void => {
    if (listenersInstalled) return;
    listenersInstalled = true;
    dependencies.input.on("end", onInputEnd);
    dependencies.input.on("close", onInputClose);
    dependencies.input.on("error", onInputError);
    dependencies.signalSource.on("SIGINT", onSigint);
    dependencies.signalSource.on("SIGTERM", onSigterm);
  };

  const removeListeners = (): void => {
    if (!listenersInstalled) return;
    listenersInstalled = false;
    let cleanupFailure: SessionFailure | undefined;
    const attempt = (remove: () => void): void => {
      try {
        remove();
      } catch (error) {
        cleanupFailure ??= { error };
      }
    };

    attempt(() => dependencies.input.off("end", onInputEnd));
    attempt(() => dependencies.input.off("close", onInputClose));
    attempt(() => dependencies.input.off("error", onInputError));
    attempt(() => dependencies.signalSource.off("SIGINT", onSigint));
    attempt(() => dependencies.signalSource.off("SIGTERM", onSigterm));

    if (cleanupFailure !== undefined) {
      recordFailure(
        cleanupFailure.error,
        "MCP session listener cleanup failed.",
      );
    }
  };

  const settleCompletion = (failure?: SessionFailure): void => {
    if (completionSettled) return;
    completionSettled = true;
    if (failure === undefined) {
      resolveCompletion();
    } else {
      rejectCompletion(failure.error);
    }
  };

  const performShutdown = async (): Promise<void> => {
    try {
      try {
        await dependencies.server.close();
      } catch (error) {
        recordFailure(error, "MCP server close failed during shutdown.");
      }

      try {
        await dependencies.inFlight.drain();
      } catch (error) {
        recordFailure(
          error,
          "MCP in-flight task drain failed during shutdown.",
        );
      }
    } finally {
      removeListeners();
    }

    if (firstFailure !== undefined) {
      throw firstFailure.error;
    }
  };

  const startShutdown = (): void => {
    if (!connected || !closeRequested || shutdownPromise !== undefined) return;
    shutdownPromise = performShutdown();
    void shutdownPromise.then(
      () => settleCompletion(),
      (error: unknown) => {
        if (firstFailure === undefined) {
          recordFailure(error, "MCP session shutdown failed.");
        }
        settleCompletion(firstFailure);
      },
    );
  };

  function requestClose(error?: unknown, message?: string): Promise<void> {
    if (!closeRequested) {
      closeRequested = true;
      if (message !== undefined) {
        recordFailure(error, message);
      }
    }
    startShutdown();
    return completion;
  }

  const failConnect = (error: unknown): void => {
    recordFailure(error, "MCP server connection failed.");
    try {
      removeListeners();
    } catch (cleanupError) {
      recordFailure(
        cleanupError,
        "MCP session listener cleanup failed.",
      );
    } finally {
      settleCompletion(firstFailure);
    }
  };

  const run = (): Promise<void> => {
    if (started) return completion;
    started = true;
    installListeners();

    let connection: Promise<void>;
    try {
      connection = dependencies.server.connect(dependencies.transport);
    } catch (error) {
      failConnect(error);
      return completion;
    }

    void connection.then(
      () => {
        connected = true;
        startShutdown();
      },
      (error: unknown) => {
        failConnect(error);
      },
    );
    return completion;
  };

  return {
    run,
    close: () => requestClose(),
  };
}
