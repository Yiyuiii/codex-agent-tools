import { describe, expect, it, vi } from "vitest";

import { createMcpProgressReporter } from "../../src/mcp/progress.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createMcpProgressReporter", () => {
  it("submits ordered notifications and waits for all of them in finish", async () => {
    const controller = new AbortController();
    const first = deferred<void>();
    const second = deferred<void>();
    const notifications: unknown[] = [];
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    const sendNotification = vi
      .fn()
      .mockImplementationOnce((notification: unknown) => {
        notifications.push(notification);
        return first.promise;
      })
      .mockImplementationOnce((notification: unknown) => {
        notifications.push(notification);
        return second.promise;
      });
    const progress = createMcpProgressReporter({
      signal: controller.signal,
      _meta: { progressToken: "token-1" },
      sendNotification,
    });

    progress.report("first");
    progress.report("second");
    expect(notifications).toEqual([
      {
        method: "notifications/progress",
        params: {
          progressToken: "token-1",
          progress: 1,
          message: "first",
        },
      },
      {
        method: "notifications/progress",
        params: {
          progressToken: "token-1",
          progress: 2,
          message: "second",
        },
      },
    ]);

    let finished = false;
    const finishing = progress.finish().then(() => {
      finished = true;
    });
    first.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);

    second.resolve();
    await finishing;
    expect(finished).toBe(true);
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("does not report after the authoritative signal aborts", () => {
    const controller = new AbortController();
    const sendNotification = vi.fn(async () => undefined);
    const progress = createMcpProgressReporter({
      signal: controller.signal,
      _meta: { progressToken: 1 },
      sendNotification,
    });

    controller.abort();
    progress.report("late");

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("lets finish return when abort wins over a notification that never settles", async () => {
    const controller = new AbortController();
    const progress = createMcpProgressReporter({
      signal: controller.signal,
      _meta: { progressToken: "token-1" },
      sendNotification: () => new Promise<void>(() => undefined),
    });
    progress.report("blocked");

    let finished = false;
    const finishing = progress.finish().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);

    controller.abort();
    await finishing;
    expect(finished).toBe(true);
  });

  it("absorbs notification rejection without aborting or rejecting finish", async () => {
    const controller = new AbortController();
    const progress = createMcpProgressReporter({
      signal: controller.signal,
      _meta: { progressToken: "token-1" },
      sendNotification: async () => {
        throw new Error("transport failed");
      },
    });

    progress.report("best effort");

    await expect(progress.finish()).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(false);
  });

  it("absorbs a synchronous notification throw without aborting or rejecting finish", async () => {
    const controller = new AbortController();
    const progress = createMcpProgressReporter({
      signal: controller.signal,
      _meta: { progressToken: "token-1" },
      sendNotification: () => {
        throw new Error("transport failed synchronously");
      },
    });

    expect(() => progress.report("best effort")).not.toThrow();
    await expect(progress.finish()).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(false);
  });
});
