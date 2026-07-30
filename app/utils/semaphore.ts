/**
 * Tiny concurrency limiter (PLAN_SEO_SUITE_COMPLETION.md §1 / §3.3).
 *
 * `p-limit` is not in the repo and pulling it in for a single 5-parallel
 * crawler queue is overkill — this is the ~15-line semaphore the plan asks
 * for instead. Caps how many callbacks run at once AND enforces a minimum
 * spacing between any two grants, so a burst of N queued requests doesn't
 * hammer the storefront the instant a slot frees up.
 *
 * The spacing floor is GLOBAL, not per slot: `lastGrantAt` is one field, so
 * `new Semaphore(2, 500)` yields two requests per second, not four. Raising
 * the concurrency buys nothing unless the callbacks outlast the floor.
 */
export class Semaphore {
  private active = 0;
  private lastGrantAt = 0;
  /** Non-null while a grant is scheduled to fire after the spacing delay —
   *  guards against scheduling two overlapping timers from concurrent
   *  `pump()` calls (acquire() and release() can both trigger a pump). */
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** FIFO of pending acquisitions. An entry only ever leaves via `pump()`
   *  granting it — never dropped, never re-created — so every `acquire()`
   *  promise is guaranteed to eventually resolve. */
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private minSpacingMs: number = 0,
  ) {}

  /** Raise (or lower) the spacing floor mid-run. The crawler uses this to back
   *  off globally after a 429 instead of hammering an already rate-limited
   *  host with the remaining queue. Already-granted slots are unaffected; the
   *  new floor applies from the next grant on. */
  setMinSpacing(ms: number): void {
    this.minSpacingMs = Math.max(0, ms);
  }

  getMinSpacing(): number {
    return this.minSpacingMs;
  }

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
      this.queue.push(resolve);
      this.pump();
    });
  }

  /**
   * Grants queued acquisitions one at a time: a slot must be free (`active <
   * maxConcurrent`) AND the min-spacing floor since the last grant must have
   * elapsed. Unlike the old design, a spacing wait never removes an entry
   * from the queue without a scheduled resolver — it just delays the next
   * `pump()` call via `pumpTimer`, and the queued entry stays put until then.
   */
  private pump(): void {
    if (this.pumpTimer !== null) return; // a grant is already scheduled — it will re-pump when it fires
    if (this.queue.length === 0 || this.active >= this.maxConcurrent) return;

    const wait = this.minSpacingMs - (Date.now() - this.lastGrantAt);
    if (wait > 0) {
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = null;
        this.pump();
      }, wait);
      return;
    }

    const grant = this.queue.shift()!;
    this.active += 1;
    this.lastGrantAt = Date.now();
    grant();
    this.pump(); // try to grant more of the queue (still gated by active/spacing)
  }

  private release(): void {
    this.active -= 1;
    this.pump();
  }
}
