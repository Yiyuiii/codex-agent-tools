import { describe, expect, it } from "vitest";

import { InFlightTasks } from "../../src/mcp/in-flight.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("InFlightTasks", () => {
  it("tracks a resolving promise until it settles", async () => {
    const inFlight = new InFlightTasks();
    const task = deferred<string>();

    const tracked = inFlight.track(task.promise);

    expect(inFlight.size).toBe(1);
    task.resolve("done");
    await expect(tracked).resolves.toBe("done");
    expect(inFlight.size).toBe(0);
  });

  it("preserves rejection while removing the settled promise without an unhandled rejection", async () => {
    const inFlight = new InFlightTasks();
    const failure = new Error("failed");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const tracked = inFlight.track(Promise.reject(failure));

      expect(inFlight.size).toBe(1);
      await expect(tracked).rejects.toBe(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(inFlight.size).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("drains tasks added after draining starts", async () => {
    const inFlight = new InFlightTasks();
    const first = deferred<void>();
    const second = deferred<void>();
    inFlight.track(first.promise);

    let drained = false;
    const drain = inFlight.drain().then(() => {
      drained = true;
    });
    inFlight.track(second.promise);

    first.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    second.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(inFlight.size).toBe(0);
  });
});
