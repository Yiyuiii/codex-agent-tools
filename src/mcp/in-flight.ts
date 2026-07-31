export class InFlightTasks {
  readonly #tasks = new Set<Promise<unknown>>();

  get size(): number {
    return this.#tasks.size;
  }

  track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => {
      this.#tasks.delete(tracked);
    });
    this.#tasks.add(tracked);
    void tracked.catch(() => undefined);
    return tracked;
  }

  async drain(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }
}
