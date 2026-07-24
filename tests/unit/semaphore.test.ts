import { describe, it, expect } from "vitest";
import { Semaphore } from "~/utils/semaphore";

describe("Semaphore", () => {
  it("never runs more than maxConcurrent callbacks at once", async () => {
    const sem = new Semaphore(3, 0);
    let active = 0;
    let maxActive = 0;
    const work = Array.from({ length: 10 }, () =>
      sem.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    );
    await Promise.all(work);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("returns the callback's resolved value", async () => {
    const sem = new Semaphore(2, 0);
    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
  });

  it("propagates a rejected callback without wedging the semaphore", async () => {
    const sem = new Semaphore(1, 0);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // A slot must have been released — this should not hang.
    const result = await sem.run(async () => "ok");
    expect(result).toBe("ok");
  });

  it("enforces the minimum spacing between two slot acquisitions", async () => {
    const sem = new Semaphore(5, 50);
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 3 }, () =>
        sem.run(async () => {
          starts.push(Date.now() - t0);
        }),
      ),
    );
    starts.sort((a, b) => a - b);
    // Each successive start should be at least ~min spacing after the previous.
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(40);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(40);
  });

  it("never drops a queued acquisition under contention (regression: spacing branch used to discard it)", async () => {
    // With the old implementation, a `wait > 0` acquisition removed itself
    // from the queue and relied solely on its own setTimeout to retry; if
    // that timer fired while all slots were full, the acquisition was never
    // re-queued and its promise hung forever. 40 tasks against 5 slots with
    // spacing guarantees many acquisitions land in exactly that situation.
    const sem = new Semaphore(5, 20);
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    const TOTAL = 40;

    const tasks = Array.from({ length: TOTAL }, () =>
      sem.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        // Longer than the spacing interval, so slots stay busy while more
        // acquisitions are queued up behind the spacing gate.
        await new Promise((r) => setTimeout(r, 30));
        active -= 1;
        completed += 1;
      }),
    );

    await Promise.all(tasks);

    expect(completed).toBe(TOTAL);
    expect(maxActive).toBeLessThanOrEqual(5);
  });
});
