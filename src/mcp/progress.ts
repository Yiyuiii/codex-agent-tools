interface ProgressExtra {
  _meta?: { progressToken?: string | number | undefined };
  signal?: AbortSignal;
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
      if (
        extra.signal?.aborted === true ||
        progressToken === undefined ||
        extra.sendNotification === undefined
      ) {
        return;
      }
      progress += 1;
      let notification: Promise<void>;
      try {
        notification = extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            message: message.slice(0, 500),
          },
        });
      } catch {
        notification = Promise.resolve();
      }
      pending.push(notification.catch(() => undefined));
    },
    async finish() {
      const notifications = Promise.all(pending).then(() => undefined);
      const signal = extra.signal;
      if (signal === undefined) {
        await notifications;
        return;
      }
      if (signal.aborted) {
        return;
      }

      let onAbort!: () => void;
      const aborted = new Promise<void>((resolve) => {
        onAbort = resolve;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          resolve();
        }
      });
      try {
        await Promise.race([notifications, aborted]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
