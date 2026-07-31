import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_TIMER_DELAY_MS,
  scheduleDeadline,
} from "../../src/runtime/deadline.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function useFakeMonotonicTimers(): void {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
}

describe("scheduleDeadline", () => {
  it("does not create a timer when timeout is omitted", () => {
    useFakeMonotonicTimers();
    const onElapsed = vi.fn();

    scheduleDeadline(undefined, onElapsed);

    expect(vi.getTimerCount()).toBe(0);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("chunks a timeout above the Node timer limit without firing early", async () => {
    useFakeMonotonicTimers();
    const onElapsed = vi.fn();

    scheduleDeadline(MAX_TIMER_DELAY_MS + 250, onElapsed);

    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(onElapsed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(onElapsed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onElapsed).toHaveBeenCalledOnce();
  });

  it("invokes the callback only once when the final chunk elapses", async () => {
    useFakeMonotonicTimers();
    const onElapsed = vi.fn();

    scheduleDeadline(MAX_TIMER_DELAY_MS + 250, onElapsed);

    await vi.runAllTimersAsync();
    await vi.runAllTimersAsync();

    expect(onElapsed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the active chunk idempotently", async () => {
    useFakeMonotonicTimers();
    const onElapsed = vi.fn();
    const deadline = scheduleDeadline(MAX_TIMER_DELAY_MS + 250, onElapsed);

    deadline.cancel();
    deadline.cancel();
    await vi.runAllTimersAsync();

    expect(onElapsed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
