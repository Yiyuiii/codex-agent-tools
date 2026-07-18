interface ProgressExtra {
  _meta?: { progressToken?: string | number | undefined };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      message: string;
    };
  }) => Promise<void>;
}

export interface McpProgressReporter {
  report(message: string): void;
  finish(): Promise<void>;
}

export function createMcpProgressReporter(
  extra: ProgressExtra,
): McpProgressReporter {
  const progressToken = extra._meta?.progressToken;
  const pending: Promise<void>[] = [];
  let progress = 0;

  return {
    report(message) {
      if (progressToken === undefined || extra.sendNotification === undefined) {
        return;
      }
      progress += 1;
      pending.push(
        extra
          .sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              message: message.slice(0, 500),
            },
          })
          .catch(() => undefined),
      );
    },
    async finish() {
      await Promise.all(pending);
    },
  };
}
