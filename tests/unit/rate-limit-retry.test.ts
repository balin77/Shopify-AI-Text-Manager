/**
 * The retry wrapper on plain fetches (appFetch / appFetchJson are callers of the
 * global fetch), and the rules that keep it from becoming a problem of its own:
 * only OUR marked refusal is retried, a wait has a bound, an abort ends it, and
 * a crowd of waiting requests does not become a crowd of refusals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRateLimitFetch,
  resetRateLimitState,
  subscribeRateLimitEvents,
  RATE_LIMIT_MARKER_HEADER,
  MAX_RETRIES,
  MAX_WAIT_MS,
  type RateLimitEvent,
} from "~/utils/rate-limit-retry";
import { appFetchJson } from "~/utils/app-fetch";

const realFetch = globalThis.fetch;
let inner: ReturnType<typeof vi.fn>;
let sentAt: number[];

const refused = (retryAfter: number, bucket = "api") =>
  new Response(JSON.stringify({ error: "Too many requests, please try again later", retryAfter }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter), [RATE_LIMIT_MARKER_HEADER]: bucket },
  });
const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function install(respond: (n: number, url: string, init?: RequestInit) => Response | Promise<Response>) {
  let n = 0;
  inner = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sentAt.push(Date.now());
    return respond(++n, String(input), init);
  });
  globalThis.fetch = createRateLimitFetch(inner as any, { random: () => 0 });
}

beforeEach(() => {
  vi.useFakeTimers();
  sentAt = [];
  resetRateLimitState();
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("plain appFetchJson caller", () => {
  it("a refusal is waited out and the caller gets the real answer", async () => {
    install((n) => (n === 1 ? refused(2) : ok({ keywords: [1] })));
    const p = appFetchJson<{ keywords: number[] }>("/api/seo-keyword?resourceId=1");
    await vi.advanceTimersByTimeAsync(3000);
    const { response, data } = await p;
    expect(response.ok).toBe(true);
    expect(data.keywords).toEqual([1]);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("exhausted: the caller still gets a normal 429 answer (no throw) after 1 + MAX_RETRIES sends", async () => {
    install(() => refused(2));
    const events: RateLimitEvent[] = [];
    const off = subscribeRateLimitEvents((e) => events.push(e));
    const p = appFetchJson<{ error: string }>("/api/seo-keyword?resourceId=1");
    await vi.advanceTimersByTimeAsync(30_000);
    const { response, data } = await p;
    off();
    expect(response.status).toBe(429);
    expect(typeof data.error).toBe("string");
    // Literal on purpose: one send and two resends, never more.
    expect(inner).toHaveBeenCalledTimes(3);
    expect(events.map((e) => e.type)).toEqual(["waiting", "gave-up"]);
  });
});

describe("only our marked refusals are retried", () => {
  it.each([
    ["a 429 without the marker (Shopify throttling, a plan limit)", () => new Response("{}", { status: 429, headers: { "Retry-After": "1" } })],
    ["a 503 with the marker header", () => new Response("{}", { status: 503, headers: { [RATE_LIMIT_MARKER_HEADER]: "api" } })],
    ["a 200 with the marker header", () => new Response("{}", { status: 200, headers: { [RATE_LIMIT_MARKER_HEADER]: "api" } })],
  ])("%s: sent once, returned untouched", async (_name, make) => {
    install(() => make());
    const res = await globalThis.fetch("/api/x", { method: "POST", body: "a=1" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(res.status).not.toBe(0);
  });

  it("a body that cannot be sent twice is not resent", async () => {
    install(() => refused(1));
    const body = new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode("x")); c.close(); } });
    const res = await globalThis.fetch("/api/x", { method: "POST", body, duplex: "half" } as any);
    expect(res.status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("the wait has a bound", () => {
  it("a Retry-After beyond the bound is not waited for: one send, an immediate answer", async () => {
    install(() => refused(Math.ceil(MAX_WAIT_MS / 1000) + 30));
    const res = await globalThis.fetch("/api/x");
    expect(res.status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(1);
    // ...and a second request of that kind is not even sent into the closed window.
    const second = await globalThis.fetch("/api/x");
    expect(second.status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe("abort", () => {
  it("ends the wait with the abort error; nothing is sent afterwards", async () => {
    install(() => refused(5));
    const controller = new AbortController();
    const p = globalThis.fetch("/api/x?productId=A", { signal: controller.signal });
    const settled = p.then(() => "resolved", (e) => e?.name);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await settled).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("an already aborted signal sends nothing during a wait either", async () => {
    install(() => refused(5));
    const controller = new AbortController();
    const p = globalThis.fetch("/api/x", { signal: controller.signal }).catch((e) => e.name);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await p).toBe("AbortError");
  });
});

describe("no retry storm", () => {
  it("a request arriving while the bucket is known to be closed waits for the window instead of being refused again", async () => {
    install((n) => (n === 1 ? refused(4) : ok()));
    const first = globalThis.fetch("/api/x", { method: "POST", body: "a=1" });
    await vi.advanceTimersByTimeAsync(500);
    expect(inner).toHaveBeenCalledTimes(1);
    const t0 = sentAt[0];
    const second = globalThis.fetch("/api/x", { method: "POST", body: "b=2" });
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, second]);
    // The second was never sent before the window (t0 + 4 s) ended.
    expect(sentAt.every((t, i) => i === 0 || t - t0 >= 4000)).toBe(true);
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("many requests refused together stay within 1 + MAX_RETRIES sends each, none inside the window", async () => {
    install(() => refused(3));
    const results = Array.from({ length: 8 }, () => globalThis.fetch("/api/x", { method: "POST", body: "a=1" }));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(results);
    expect(inner.mock.calls.length).toBeLessThanOrEqual(8 * (1 + MAX_RETRIES));
    const t0 = sentAt[0];
    expect(sentAt.filter((t) => t !== t0 && t - t0 < 3000)).toHaveLength(0);
  });
});
