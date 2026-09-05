interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}

export class Semaphore {
  private active = 0;
  private queue: Waiter[] = [];
  constructor(private limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Concurrency must be positive");
    }
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.queue = this.queue.filter((entry) => entry !== waiter);
          reject(signal.reason);
        },
      };
      this.queue.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }
  private release(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        next.resolve(this.release());
      } else {
        this.active--;
      }
    };
  }
}
