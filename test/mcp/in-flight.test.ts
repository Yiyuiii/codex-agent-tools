import { describe, expect, it, vi } from "vitest";

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

  it("starts a task from a factory only after admission succeeds", async () => {
    const inFlight = new InFlightTasks();
    const task = deferred<string>();
    let factoryCalls = 0;

    const tracked = inFlight.run(() => {
      factoryCalls += 1;
      return task.promise;
    });

    expect(factoryCalls).toBe(1);
    expect(inFlight.size).toBe(1);
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

  it("closes admission idempotently, rejects new tasks, and drains existing tasks", async () => {
    const inFlight = new InFlightTasks();
    const first = deferred<void>();
    const second = deferred<void>();
    inFlight.track(first.promise);

    expect(inFlight.shutdownSignal.aborted).toBe(false);
    expect(inFlight.shutdownSignal.reason).toBeUndefined();

    inFlight.closeAdmission();
    expect(inFlight.shutdownSignal.aborted).toBe(true);
    expect(inFlight.shutdownSignal.reason).toBe("session_shutdown");

    inFlight.closeAdmission();
    expect(inFlight.shutdownSignal.reason).toBe("session_shutdown");

    let drained = false;
    const drain = inFlight.drain().then(() => {
      drained = true;
    });

    expect(() => inFlight.track(second.promise)).toThrowError(
      "In-flight task admission is closed.",
    );
    expect(inFlight.size).toBe(1);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    first.resolve();
    await drain;
    expect(drained).toBe(true);
    expect(inFlight.size).toBe(0);
  });

  it("rejects synchronously without invoking a task factory after admission closes", () => {
    const inFlight = new InFlightTasks();
    const factory = vi.fn(() => Promise.resolve("should not start"));
    inFlight.closeAdmission();

    expect(() => inFlight.run(factory)).toThrowError(
      "In-flight task admission is closed.",
    );
    expect(factory).not.toHaveBeenCalled();
    expect(inFlight.size).toBe(0);
  });

  it("runs a best-effort removal hook only after deleting the settled promise", async () => {
    const removalOrder: string[] = [];
    const task = deferred<string>();
    const inFlight = new InFlightTasks();

    const tracked = inFlight.track(task.promise, () => {
      removalOrder.push(`removed:${inFlight.size}`);
      throw new Error("observer unavailable");
    });

    task.resolve("done");
    await expect(tracked).resolves.toBe("done");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(removalOrder).toEqual(["removed:0"]);
    expect(inFlight.size).toBe(0);
  });

  it("absorbs an asynchronously rejected removal hook", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const inFlight = new InFlightTasks();
      const tracked = inFlight.run(
        async () => "done",
        async () => {
          throw new Error("observer rejected");
        },
      );

      await expect(tracked).resolves.toBe("done");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(inFlight.size).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
