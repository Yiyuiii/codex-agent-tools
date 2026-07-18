interface QueuedJob {
  signal: AbortSignal | undefined;
  start: () => void;
  rejectAborted: () => void;
  onAbort: (() => void) | undefined;
}

interface KeyState {
  active: number;
  queue: QueuedJob[];
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export class KeyedLimiter {
  readonly #states = new Map<string, KeyState>();

  public constructor(
    private readonly limitForKey: (key: string) => number,
  ) {}

  public run<T>(
    key: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }

    const state = this.#stateFor(key);
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = {
        signal,
        onAbort: undefined,
        rejectAborted: () => reject(abortError()),
        start: () => {
          if (signal?.aborted) {
            reject(abortError());
            this.#drain(key, state);
            return;
          }

          state.active += 1;
          void Promise.resolve()
            .then(work)
            .then(resolve, reject)
            .finally(() => {
              state.active -= 1;
              this.#drain(key, state);
            });
        },
      };

      if (state.active < this.#limit(key)) {
        job.start();
        return;
      }

      job.onAbort = () => {
        const index = state.queue.indexOf(job);
        if (index < 0) {
          return;
        }
        state.queue.splice(index, 1);
        signal?.removeEventListener("abort", job.onAbort!);
        job.rejectAborted();
        this.#deleteIdleState(key, state);
      };
      signal?.addEventListener("abort", job.onAbort, { once: true });
      state.queue.push(job);
    });
  }

  #limit(key: string): number {
    const limit = this.limitForKey(key);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Concurrency limit for "${key}" must be a positive integer`);
    }
    return limit;
  }

  #stateFor(key: string): KeyState {
    const current = this.#states.get(key);
    if (current !== undefined) {
      return current;
    }
    const created = { active: 0, queue: [] } satisfies KeyState;
    this.#states.set(key, created);
    return created;
  }

  #drain(key: string, state: KeyState): void {
    while (state.active < this.#limit(key)) {
      const next = state.queue.shift();
      if (next === undefined) {
        break;
      }
      if (next.onAbort !== undefined) {
        next.signal?.removeEventListener("abort", next.onAbort);
      }
      next.start();
    }
    this.#deleteIdleState(key, state);
  }

  #deleteIdleState(key: string, state: KeyState): void {
    if (state.active === 0 && state.queue.length === 0) {
      this.#states.delete(key);
    }
  }
}
