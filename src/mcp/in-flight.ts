export class InFlightTasks {
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #shutdownController = new AbortController();
  #admissionClosed = false;

  readonly shutdownSignal: AbortSignal = this.#shutdownController.signal;

  get size(): number {
    return this.#tasks.size;
  }

  closeAdmission(): void {
    if (this.#admissionClosed) return;

    this.#admissionClosed = true;
    this.#shutdownController.abort("session_shutdown");
  }

  track<T>(
    promise: Promise<T>,
    onRemoved?: () => void | Promise<void>,
  ): Promise<T> {
    if (this.#admissionClosed) {
      throw new Error("In-flight task admission is closed.");
    }

    return this.#trackAdmitted(promise, onRemoved);
  }

  run<T>(
    factory: () => Promise<T>,
    onRemoved?: () => void | Promise<void>,
  ): Promise<T> {
    if (this.#admissionClosed) {
      throw new Error("In-flight task admission is closed.");
    }

    return this.#trackAdmitted(factory(), onRemoved);
  }

  #trackAdmitted<T>(
    promise: Promise<T>,
    onRemoved?: () => void | Promise<void>,
  ): Promise<T> {
    this.#tasks.add(promise);
    void promise
      .finally(() => {
        if (this.#tasks.delete(promise) && onRemoved !== undefined) {
          try {
            const result = onRemoved();
            if (result !== undefined) {
              void Promise.resolve(result).catch(() => undefined);
            }
          } catch {
            // Removal observation is best effort and cannot affect the task.
          }
        }
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
