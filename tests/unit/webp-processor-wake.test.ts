/**
 * The WebP worker's immediate wake-up (`globalThis.__wakeWebpProcessor`, sent
 * by api.convert-webp.tsx after it created the task rows) and its one rule:
 * never two polls at once — a wake-up during a poll runs ONE more poll right
 * after it, and a missing hook is a no-op on the bundle side.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

(globalThis as any).__db ??= {};
const { WebPProcessorService } = await import("../../webp-processor.service.js");
const { nudgeWebpProcessor } = await import("../../app/utils/webp-wake.server");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("WebPProcessorService wake-up", () => {
  let service: any;
  let calls: number;
  let inFlight: number;
  let maxInFlight: number;
  let gates: Array<ReturnType<typeof deferred>>;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = 0;
    inFlight = 0;
    maxInFlight = 0;
    gates = [];
    service = new WebPProcessorService();
    service.processPendingTasks = vi.fn(async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      inFlight--;
    });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it("start() registers the hook and stop() removes it", () => {
    service.start();
    expect(typeof (globalThis as any).__wakeWebpProcessor).toBe("function");
    service.stop();
    expect((globalThis as any).__wakeWebpProcessor).toBeUndefined();
  });

  it("an idle worker polls at once on a wake-up instead of waiting for the tick", async () => {
    service.start();
    expect(calls).toBe(1);
    gates[0].resolve();
    await settle();
    // Idle now, next tick 10s away.
    expect(nudgeWebpProcessor()).toBe(true);
    expect(calls).toBe(2);
    gates[1].resolve();
    await settle();
    // The wake-up replaced the pending tick rather than adding a second timer.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(9_999);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(3);
  });

  it("a wake-up during a poll never starts a second concurrent poll — it polls once more afterwards", async () => {
    service.start();
    expect(calls).toBe(1);
    nudgeWebpProcessor();
    nudgeWebpProcessor();
    service.wake();
    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);

    gates[0].resolve();
    await settle();
    vi.advanceTimersByTime(0);
    expect(calls).toBe(2);
    expect(maxInFlight).toBe(1);

    gates[1].resolve();
    await settle();
    // Three wake-ups folded into ONE extra poll; back on the regular tick.
    vi.advanceTimersByTime(9_999);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(3);
  });

  it("a stopped worker ignores wake-ups", () => {
    service.wake();
    expect(calls).toBe(0);
  });

  it("a poll error still reschedules", async () => {
    service.processPendingTasks = vi.fn(async () => {
      calls++;
      throw new Error("db down");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    service.start();
    await settle();
    expect(calls).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(calls).toBe(2);
    err.mockRestore();
  });
});

describe("nudgeWebpProcessor (bundle side)", () => {
  afterEach(() => {
    delete (globalThis as any).__wakeWebpProcessor;
  });

  it("is a no-op without a hook", () => {
    delete (globalThis as any).__wakeWebpProcessor;
    expect(nudgeWebpProcessor()).toBe(false);
  });

  it("never throws into the request", () => {
    (globalThis as any).__wakeWebpProcessor = () => {
      throw new Error("boom");
    };
    expect(() => nudgeWebpProcessor()).not.toThrow();
    expect(nudgeWebpProcessor()).toBe(false);
  });
});
