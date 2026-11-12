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
    expect(queue.getQueueStats?.().totalQueued ?? 0).toBe(0);
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

  it("exposes the bucket's token limit for the planner", () => {
    expect(queue.getBucketTokenLimit("byo", "claude")).toBe(40_000);
  });
});
