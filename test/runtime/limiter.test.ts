import { describe, expect, it, vi } from "vitest";

import { KeyedLimiter } from "../../src/runtime/limiter.js";

describe("KeyedLimiter", () => {
  it("removes an aborted waiter without consuming a slot", async () => {
    const limiter = new KeyedLimiter(() => 1);
    let releaseFirst!: () => void;
    const first = limiter.run(
      "kimi-k3",
      undefined,
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    const controller = new AbortController();
    const queuedWork = vi.fn(async () => undefined);
    const second = limiter.run("kimi-k3", controller.signal, queuedWork);

    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(queuedWork).not.toHaveBeenCalled();
    releaseFirst();
    await first;

    await limiter.run("kimi-k3", undefined, queuedWork);
    expect(queuedWork).toHaveBeenCalledOnce();
  });

  it("runs same-key work sequentially", async () => {
    const limiter = new KeyedLimiter(() => 1);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = limiter.run("kimi-k3", undefined, async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push("first-end");
    });
    const second = limiter.run("kimi-k3", undefined, async () => {
      order.push("second-start");
    });

    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("does not share capacity across Coding Plan and Agent Plan pools", async () => {
    const limiter = new KeyedLimiter(() => 1);
    const started: string[] = [];
    let release!: () => void;
    const first = limiter.run("ark-agent-plan", undefined, async () => {
      started.push("agent");
      await new Promise<void>((resolve) => (release = resolve));
    });
    const second = limiter.run("ark-coding-plan", undefined, async () => {
      started.push("coding");
    });

    await vi.waitFor(() => expect(started.sort()).toEqual(["agent", "coding"]));
    release();
    await Promise.all([first, second]);
  });
});
