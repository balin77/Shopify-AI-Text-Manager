/**
 * Tiny concurrency limiter (PLAN_SEO_SUITE_COMPLETION.md §1 / §3.3).
 *
 * `p-limit` is not in the repo and pulling it in for a single 5-parallel
 * crawler queue is overkill — this is the ~15-line semaphore the plan asks
 * for instead. Caps how many callbacks run at once AND enforces a minimum
 * spacing between two callbacks starting on the SAME slot, so a burst of N
 * queued requests doesn't hammer the storefront the instant a slot frees up.
 */
export class Semaphore {
  private active = 0;
  private lastStart = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly minSpacingMs: number = 0,
  ) {}

  /** Run `fn` once a slot is free (respecting the min-spacing floor), returning its result. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.active >= this.maxConcurrent) return false;
        const wait = this.minSpacingMs - (Date.now() - this.lastStart);
        if (wait > 0) {
          setTimeout(tryAcquire, wait);
          return true; // scheduled, not granted yet
        }
        this.active += 1;
        this.lastStart = Date.now();
        resolve();
        return true;
      };
      if (!tryAcquire()) this.queue.push(tryAcquire);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
