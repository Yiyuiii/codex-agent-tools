export class InFlightTasks {
  readonly #tasks = new Set<Promise<unknown>>();

  get size(): number {
    return this.#tasks.size;
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.#tasks.add(promise);
    void promise
      .finally(() => {
        this.#tasks.delete(promise);
      })
      .catch(() => undefined);
    return promise;
  }

  async drain(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }
}
