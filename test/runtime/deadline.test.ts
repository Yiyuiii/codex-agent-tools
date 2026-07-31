import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_TIMER_DELAY_MS,
  scheduleDeadline,
  scheduleDeadlineWithRuntime,
} from "../../src/runtime/deadline.js";
import type { DeadlineRuntime } from "../../src/runtime/deadline.js";

interface ManualTimer {
  readonly callback: () => void;
  readonly handle: ReturnType<typeof setTimeout>;
}

function createManualRuntime() {
  let nowMs = 0;
  let nextHandle = 0;
  const delays: number[] = [];
  const pending: ManualTimer[] = [];
  const runtime: DeadlineRuntime = {
    now: () => nowMs,
    setTimer: (callback, delayMs) => {
      const handle = {
        id: nextHandle++,
      } as unknown as ReturnType<typeof setTimeout>;
      delays.push(delayMs);
      pending.push({ callback, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = pending.findIndex((timer) => timer.handle === handle);
      if (index >= 0) {
        pending.splice(index, 1);
      }
    },
  };

  return {
    delays,
    runtime,
    fireNextAt(nextNowMs: number): void {
      nowMs = nextNowMs;
      const timer = pending.shift();
      if (timer === undefined) {
        throw new Error("No pending deadline timer");
      }
      timer.callback();
    },
  };
}

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

  it("arms exact MAX and remainder chunks", () => {
    const manual = createManualRuntime();
    const onElapsed = vi.fn();

    scheduleDeadlineWithRuntime(
      MAX_TIMER_DELAY_MS + 250,
      onElapsed,
      manual.runtime,
    );

    expect(manual.delays).toEqual([MAX_TIMER_DELAY_MS]);
    manual.fireNextAt(MAX_TIMER_DELAY_MS);
    expect(onElapsed).not.toHaveBeenCalled();
    expect(manual.delays).toEqual([MAX_TIMER_DELAY_MS, 250]);
    manual.fireNextAt(MAX_TIMER_DELAY_MS + 250);
    expect(onElapsed).toHaveBeenCalledOnce();
  });

  it("keeps Number.MAX_SAFE_INTEGER chunked without overflow or early elapsed callback", () => {
    const manual = createManualRuntime();
    const onElapsed = vi.fn();

    scheduleDeadlineWithRuntime(
      Number.MAX_SAFE_INTEGER,
      onElapsed,
      manual.runtime,
    );

    expect(manual.delays).toEqual([MAX_TIMER_DELAY_MS]);
    manual.fireNextAt(MAX_TIMER_DELAY_MS);
    expect(onElapsed).not.toHaveBeenCalled();
    expect(manual.delays).toEqual([
      MAX_TIMER_DELAY_MS,
      MAX_TIMER_DELAY_MS,
    ]);
    manual.fireNextAt(Number.MAX_SAFE_INTEGER);
    expect(onElapsed).toHaveBeenCalledOnce();
  });

  it("re-arms only the remaining duration after an early timer callback", () => {
    const manual = createManualRuntime();
    const onElapsed = vi.fn();

    scheduleDeadlineWithRuntime(1_000, onElapsed, manual.runtime);

    expect(manual.delays).toEqual([1_000]);
    manual.fireNextAt(250);
    expect(onElapsed).not.toHaveBeenCalled();
    expect(manual.delays).toEqual([1_000, 750]);
    manual.fireNextAt(1_000);
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
