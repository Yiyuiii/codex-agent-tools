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

  track<T>(promise: Promise<T>): Promise<T> {
    if (this.#admissionClosed) {
      throw new Error("In-flight task admission is closed.");
    }

    return this.#trackAdmitted(promise);
  }

  run<T>(factory: () => Promise<T>): Promise<T> {
    if (this.#admissionClosed) {
      throw new Error("In-flight task admission is closed.");
    }

    return this.#trackAdmitted(factory());
  }

  #trackAdmitted<T>(promise: Promise<T>): Promise<T> {
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
