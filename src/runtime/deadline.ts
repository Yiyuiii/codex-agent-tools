import { performance } from "node:perf_hooks";

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface CancellableDeadline {
  cancel(): void;
}

interface DeadlineRuntime {
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const nodeDeadlineRuntime: DeadlineRuntime = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

export function scheduleDeadline(
  timeoutMs: number | undefined,
  onElapsed: () => void,
): CancellableDeadline {
  return scheduleDeadlineWithRuntime(timeoutMs, onElapsed, nodeDeadlineRuntime);
}

function scheduleDeadlineWithRuntime(
  timeoutMs: number | undefined,
  onElapsed: () => void,
  runtime: DeadlineRuntime,
): CancellableDeadline {
  let remainingMs = timeoutMs ?? 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const arm = (): void => {
    const delay = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
    const armedAt = runtime.now();
    timer = runtime.setTimer(() => {
      timer = undefined;
      if (settled) {
        return;
      }

      const elapsedMs = Math.max(0, runtime.now() - armedAt);
      remainingMs = Math.max(0, remainingMs - elapsedMs);
      if (remainingMs === 0) {
        settled = true;
        onElapsed();
        return;
      }

      arm();
    }, delay);
  };

  if (timeoutMs !== undefined) {
    arm();
  }

  return {
    cancel(): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        runtime.clearTimer(timer);
        timer = undefined;
      }
    },
  };
}
