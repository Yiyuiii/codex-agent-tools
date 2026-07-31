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
    expect(tracked).toBe(task.promise);
    task.resolve("done");
    await expect(tracked).resolves.toBe("done");
    expect(inFlight.size).toBe(0);
  });

  it("absorbs rejection when the caller ignores the returned promise", async () => {
    const inFlight = new InFlightTasks();
    const failure = new Error("failed");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      void inFlight.track(Promise.reject(failure));

      expect(inFlight.size).toBe(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(inFlight.size).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not finish draining before the returned promise reaction runs", async () => {
    const inFlight = new InFlightTasks();
    const task = deferred<void>();
    const tracked = inFlight.track(task.promise);
    const order: string[] = [];

    task.promise.then(() => {
      void inFlight.drain().then(() => {
        order.push("drain");
      });
    });
    void tracked.then(() => {
      order.push("tracked");
    });

    task.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(order).toEqual(["tracked", "drain"]);
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
