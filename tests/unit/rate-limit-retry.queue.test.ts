/**
 * The queue of held writes: what it orders, what it never holds up, and its limits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRateLimitFetch,
  resetRateLimitState,
  subscribeRateLimitEvents,
  RATE_LIMIT_MARKER_HEADER,
  type RateLimitEvent,
} from "~/utils/rate-limit-retry";

const realFetch = globalThis.fetch;
let log: Array<{ body: string; at: number; method: string }>;
const refused = (retryAfter: number, bucket = "content") =>
  new Response("{}", { status: 429, headers: { "Retry-After": String(retryAfter), [RATE_LIMIT_MARKER_HEADER]: bucket } });
const ok = () => new Response("{}", { status: 200 });

function install(respond: (n: number, body: string) => Response | Promise<Response>, draws: number[] = []) {
  let n = 0;
  const inner = vi.fn(async (_input: any, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    log.push({ body, at: Date.now(), method: String(init?.method ?? "GET") });
    return respond(++n, body);
  });
  globalThis.fetch = createRateLimitFetch(inner as any, { random: () => draws.shift() ?? 0 });
  return inner;
}

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  resetRateLimitState();
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("ordering", () => {
  it("writes held for the same bucket are retried oldest first even when the newer one wakes first", async () => {
    // first send of each is refused; then everything is accepted
    install((n) => (n <= 2 ? refused(2) : ok()), [0.99, 0]);
    const a = globalThis.fetch("/api/x", { method: "POST", body: "A" });
    const b = globalThis.fetch("/api/x", { method: "POST", body: "B" });
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([a, b]);
    expect(log.map((l) => l.body)).toEqual(["A", "B", "A", "B"]);
  });

  it("a write whose path is KNOWN to be in the closed bucket queues too (registered when it waits for the window)", async () => {
    // A is refused; B and C then arrive for the same path while the window is closed.
    const draws = [0, 0.99, 0]; // A: 0, B: long jitter, C: none
    install((n) => (n === 1 ? refused(2) : ok()), draws);
    const a = globalThis.fetch("/api/x", { method: "POST", body: "A" });
    await vi.advanceTimersByTimeAsync(100);
    const b = globalThis.fetch("/api/x", { method: "POST", body: "B" });
    const c = globalThis.fetch("/api/x", { method: "POST", body: "C" });
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([a, b, c]);
    expect(log.map((l) => l.body)).toEqual(["A", "A", "B", "C"]);
  });

  it("limit, stated: the first send of a path never seen refused can overtake a held write", async () => {
    install((n) => (n === 1 ? refused(5) : ok()), [0.99]);
    const older = globalThis.fetch("/api/content-editor-action", { method: "POST", body: "older" });
    await vi.advanceTimersByTimeAsync(100);
    const newer = globalThis.fetch("/app/products.data", { method: "POST", body: "newer" });
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([older, newer]);
    expect(log.map((l) => l.body)).toEqual(["older", "newer", "older"]);
  });
});

describe("what the queue never holds up", () => {
  it("a READ does not wait for an older held write: it goes out first when it wakes first", async () => {
    install((n) => (n <= 2 ? refused(2) : ok()), [0.99, 0]);
    const w = globalThis.fetch("/api/w", { method: "POST", body: "W" });
    const r = globalThis.fetch("/api/r");
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([w, r]);
    expect(log.map((l) => l.body)).toEqual(["W", "", "", "W"]);
  });

  it("a write waiting for an older one can be aborted", async () => {
    install((n) => (n === 1 ? refused(20) : ok()), [0.99, 0]);
    const a = globalThis.fetch("/api/x", { method: "POST", body: "A" });
    await vi.advanceTimersByTimeAsync(100);
    const c = new AbortController();
    const b = globalThis.fetch("/api/x", { method: "POST", body: "B", signal: c.signal });
    const settled = b.then(() => "ok", (e) => e?.name);
    await vi.advanceTimersByTimeAsync(21_000); // B is past the window, queued behind A (long jitter)
    c.abort();
    expect(await settled).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(60_000);
    await a;
    expect(log.filter((l) => l.body === "B")).toHaveLength(0);
  });

  it("the queue is left when the older write is SENT, not when its handler finishes", async () => {
    let releaseA: (r: Response) => void = () => {};
    install((n, body) => {
      if (body === "A" && n === 1) return refused(2);
      if (body === "A") return new Promise<Response>((resolve) => { releaseA = resolve; }); // a long handler
      return ok();
    }, [0, 0]);
    const a = globalThis.fetch("/api/x", { method: "POST", body: "A" });
    await vi.advanceTimersByTimeAsync(100);
    const b = globalThis.fetch("/api/x", { method: "POST", body: "B" });
    await vi.advanceTimersByTimeAsync(5000);
    // A's resend is out and still running; B went out behind it, not behind its handler.
    expect(log.map((l) => l.body)).toEqual(["A", "A", "B"]);
    releaseA(ok());
    await Promise.all([a, b]);
  });
});

describe("events and the synthesized answer", () => {
  it("giving up on a READ is reported as such (no write): the notice stays quiet about changes", async () => {
    install(() => refused(2));
    const events: RateLimitEvent[] = [];
    const off = subscribeRateLimitEvents((e) => events.push(e));
    const p = globalThis.fetch("/api/r");
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    off();
    expect(events.find((e) => e.type === "gave-up")).toMatchObject({ write: false });
  });
  it("giving up on a WRITE says so", async () => {
    install(() => refused(2));
    const events: RateLimitEvent[] = [];
    const off = subscribeRateLimitEvents((e) => events.push(e));
    const p = globalThis.fetch("/api/w", { method: "POST", body: "x" });
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    off();
    expect(events.find((e) => e.type === "gave-up")).toMatchObject({ write: true });
  });
  it("a router POST answer carries ok: false next to success: false", async () => {
    install(() => refused(2));
    const p = globalThis.fetch("/api/w.data", { method: "POST", body: "x" });
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await p;
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).toContain('"ok"');
    expect(text).toContain('"success"');
  });
});
