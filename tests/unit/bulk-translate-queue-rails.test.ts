/**
 * Queue rails of the packaged translate run (PLAN_BULK_TRANSLATE_BATCHING
 * 19.6 / M-2): a package whose estimate exceeds the bucket's per-minute token
 * allowance is rejected AT ENQUEUE (it could never be admitted), a package
 * starved on the shared bucket is rejected after its admission timeout (the
 * caller splits), and at most one LARGE package per shop executes at a time.
 * Requests that are NOT packages keep today's behaviour exactly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AIQueueService,
  isAIRequestTooLarge,
  isAIRequestStarved,
  PACKAGE_PER_SHOP_LIMIT,
} from "../../src/services/ai-queue.service";

vi.mock("../../app/db.server", () => ({
  db: { task: { update: vi.fn().mockResolvedValue({}) } },
}));

describe("package queue rails", () => {
  let queue: AIQueueService;
  beforeEach(() => {
    (AIQueueService as any).instance = undefined;
    queue = AIQueueService.getInstance();
  });
  afterEach(() => {
    queue.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("rejects a package estimate above the bucket TPM immediately, without ever calling execute", async () => {
    const execute = vi.fn(async () => "x");
    // byo:claude is 40 000 TPM by default.
    await expect(
      queue.enqueue("s.myshopify.com", "t1", "claude", 40_001, execute, "byo", undefined, { packageCall: true }),
    ).rejects.toSatisfy(isAIRequestTooLarge);
    expect(execute).not.toHaveBeenCalled();
  });

  it("an ordinary (non-package) request above the TPM is NOT rejected at enqueue -- today's behaviour is kept", async () => {
    const execute = vi.fn(async () => "x");
    const pending = queue.enqueue("s.myshopify.com", "t1", "claude", 40_001, execute, "byo");
    // It sits in the queue (never admitted) instead of being rejected.
    await Promise.race([
      pending.then(() => "settled", () => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 200)),
    ]).then((outcome) => expect(outcome).toBe("waiting"));
    expect(execute).not.toHaveBeenCalled();
  });

  it("a package that fits is executed", async () => {
    const result = await queue.enqueue("s.myshopify.com", "t1", "openai", 5000, async () => "ok", "byo", undefined, {
      packageCall: true,
    });
    expect(result).toBe("ok");
  });

  it("a starved package is rejected after its admission timeout and leaves the queue", async () => {
    vi.useFakeTimers();
    // A bucket that can never admit: 1 request per minute already used.
    (queue as any).rateLimits.set("byo:claude", { maxTokensPerMinute: 40_000, maxRequestsPerMinute: 0 });
    const execute = vi.fn(async () => "x");
    const pending = queue.enqueue("s.myshopify.com", "t1", "claude", 1000, execute, "byo", undefined, {
      packageCall: true,
      admissionTimeoutMs: 5000,
    });
    const settled = pending.then(
      () => "resolved",
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(5001);
    const error = await settled;
    expect(isAIRequestStarved(error)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(queue.getQueueStats().queueLength).toBe(0);
  });

  it("at most one LARGE package per shop executes at a time ", async () => {
    // 15 000 of 40 000 TPM is above the 25 % share: large.
    let running = 0;
    let maxRunning = 0;
    const release: Array<() => void> = [];
    const run = () =>
      new Promise<string>((resolve) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        release.push(() => {
          running--;
          resolve("done");
        });
      });
    (queue as any).rateLimits.set("byo:openai", { maxTokensPerMinute: 60_000, maxRequestsPerMinute: 100 });
    const a1 = queue.enqueue("a.myshopify.com", "t", "openai", 20_000, run, "byo", undefined, { packageCall: true });
    const a2 = queue.enqueue("a.myshopify.com", "t", "openai", 20_000, run, "byo", undefined, { packageCall: true });
    await vi.waitFor(() => expect(release.length).toBe(1), { timeout: 3000 });
    // The second large package of the SAME shop is still waiting.
    await new Promise((r) => setTimeout(r, 400));
    expect(release.length).toBe(1);
    release.shift()!();
    await vi.waitFor(() => expect(release.length).toBe(1), { timeout: 3000 });
    release.shift()!();
    await Promise.all([a1, a2]);
    expect(maxRunning).toBe(1);
  });

  it("one shop holds at most PACKAGE_PER_SHOP_LIMIT package requests in flight; other shops and non-package calls are not held back", async () => {
    let running = 0;
    let maxRunning = 0;
    const release: Array<() => void> = [];
    const run = () =>
      new Promise<string>((resolve) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        release.push(() => {
          running--;
          resolve("done");
        });
      });
    (queue as any).rateLimits.set("byo:openai", { maxTokensPerMinute: 1_000_000, maxRequestsPerMinute: 1000 });
    const all = Array.from({ length: 4 }, () =>
      queue.enqueue("a.myshopify.com", "t", "openai", 1000, run, "byo", undefined, { packageCall: true }),
    );
    await vi.waitFor(() => expect(release.length).toBe(PACKAGE_PER_SHOP_LIMIT), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(release.length).toBe(PACKAGE_PER_SHOP_LIMIT);
    // Another shop and an ordinary call of the SAME shop still get a slot.
    const other = queue.enqueue("b.myshopify.com", "t", "openai", 1000, async () => "other", "byo", undefined, { packageCall: true });
    const plain = queue.enqueue("a.myshopify.com", "t", "openai", 1000, async () => "plain", "byo");
    await expect(Promise.all([other, plain])).resolves.toEqual(["other", "plain"]);
    while (release.length > 0) {
      release.shift()!();
      await new Promise((r) => setTimeout(r, 150));
    }
    await vi.waitFor(() => expect(release.length + running).toBeGreaterThanOrEqual(0));
    // Drain the remaining ones.
    for (let i = 0; i < 6 && running + release.length > 0; i++) {
      while (release.length > 0) release.shift()!();
      await new Promise((r) => setTimeout(r, 150));
    }
    await Promise.all(all);
    expect(maxRunning).toBe(PACKAGE_PER_SHOP_LIMIT);
  });

  it("the admission clock does not run out while a package waits only behind its OWN shop's packages", async () => {
    (queue as any).rateLimits.set("byo:openai", { maxTokensPerMinute: 1_000_000, maxRequestsPerMinute: 1000 });
    const release: Array<() => void> = [];
    const hold = () => new Promise<string>((resolve) => release.push(() => resolve("done")));
    const first = Array.from({ length: PACKAGE_PER_SHOP_LIMIT }, () =>
      queue.enqueue("a.myshopify.com", "t", "openai", 1000, hold, "byo", undefined, { packageCall: true }),
    );
    await vi.waitFor(() => expect(release.length).toBe(PACKAGE_PER_SHOP_LIMIT), { timeout: 3000 });
    const waiting = queue.enqueue("a.myshopify.com", "t", "openai", 1000, async () => "late", "byo", undefined, {
      packageCall: true,
      admissionTimeoutMs: 250,
    });
    let settled: unknown = null;
    void waiting.then(
      (v) => (settled = v),
      (e) => (settled = e),
    );
    // Several admission periods pass: still queued, not "starved".
    await new Promise((r) => setTimeout(r, 900));
    expect(settled).toBeNull();
    while (release.length > 0) release.shift()!();
    await vi.waitFor(() => expect(settled).toBe("late"), { timeout: 3000 });
    await Promise.all(first);
  });

  it("drain() clears the admission timers of requests it rejects", async () => {
    (queue as any).rateLimits.set("byo:claude", { maxTokensPerMinute: 40_000, maxRequestsPerMinute: 0 });
    const pending = queue
      .enqueue("s.myshopify.com", "t1", "claude", 1000, async () => "x", "byo", undefined, { packageCall: true, admissionTimeoutMs: 60_000 })
      .then(() => "resolved", (e) => e);
    const queued = (queue as any).queues.get("s.myshopify.com")[0];
    expect(queued.admissionTimer).toBeDefined();
    queue.stop();
    await queue.drain(10);
    const error = await pending;
    expect((error as { code?: string }).code).toBe("AI_QUEUE_SHUTTING_DOWN");
    expect(queued.admissionTimer).toBeUndefined();
  });

  it("exposes the bucket's token limit for the planner", () => {
    expect(queue.getBucketTokenLimit("byo", "claude")).toBe(40_000);
  });
});
