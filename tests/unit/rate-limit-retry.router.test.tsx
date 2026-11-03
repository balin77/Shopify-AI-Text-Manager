/**
 * A request our rate limiter refused must never reach a route ErrorBoundary.
 *
 * The REAL react-router data router with its real single-fetch data strategy
 * (`UNSAFE_getTurboStreamSingleFetchDataStrategy`, which calls the global
 * `fetch` for `<path>.data` and decodes turbo-stream) runs against a scripted
 * network. Only the network is fake. The wrapper under test is installed as the
 * global `fetch` exactly as entry.client does it.
 *
 * Without the wrapper every "refused" scenario below ends in
 * `router.state.errors` (the whole page replaced by the ErrorBoundary): that is
 * what the assertions `errors === null` catch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMemoryRouter,
  UNSAFE_getTurboStreamSingleFetchDataStrategy as getSingleFetchDataStrategy,
  UNSAFE_decodeViaTurboStream as decodeViaTurboStream,
} from "react-router";

import { createRateLimitFetch, resetRateLimitState, RATE_LIMIT_MARKER_HEADER, MAX_RETRIES } from "~/utils/rate-limit-retry";
import { encodeTurboStreamValue } from "~/utils/turbo-stream-lite";

type Script = (url: URL, init: RequestInit) => Response | Promise<Response>;
let script: Script;
let serverFetch: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

const refusal = (bucket = "api-read", retryAfter = 2) =>
  new Response(JSON.stringify({ error: "Too many requests, please try again later", retryAfter: 30 }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter), [RATE_LIMIT_MARKER_HEADER]: bucket },
  });

/** A router `.data` answer: GET bodies are keyed by route id, a POST body is the route's own result. */
const dataAnswer = (value: unknown, status = 200) =>
  new Response(encodeTurboStreamValue(value), { status, headers: { "X-Remix-Response": "yes" } });

/** A page `.data` answer: the root always answers too. */
const pageAnswer = (extra: Record<string, unknown> = {}) =>
  dataAnswer({ root: { data: {} }, "routes/home": { data: { page: "home" } }, ...extra });

const MANIFEST = {
  routes: {
    root: { hasLoader: false, hasClientLoader: false },
    "routes/home": { hasLoader: true, hasClientLoader: false },
    "routes/settings": { hasLoader: true, hasClientLoader: false },
    "routes/api.things": { hasLoader: true, hasClientLoader: false },
  },
} as any;

const seenFetchers = new Map<string, any>();
const fetcherOf = (key: string) => seenFetchers.get(key);

function makeRouter(opts: { homeLoader?: boolean } = {}) {
  const manifest = { routes: { ...MANIFEST.routes, "routes/home": { hasLoader: !!opts.homeLoader, hasClientLoader: false } } } as any;
  // The framework's stub: a route the server has no loader for never asks for data.
  const loaderFor = (id: string) => (_args: unknown, singleFetch?: () => Promise<unknown>) =>
    singleFetch && manifest.routes[id].hasLoader ? singleFetch() : Promise.resolve(null);
  const handler = (_args: unknown, singleFetch?: () => Promise<unknown>) => (singleFetch ? singleFetch() : Promise.resolve(null));
  let router: ReturnType<typeof createMemoryRouter>;
  router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        // Like the framework's client routes, every route has a loader/action
        // function; the manifest says which ones exist on the server.
        loader: loaderFor("root") as any,
        children: [
          { id: "routes/home", index: true, loader: loaderFor("routes/home") as any },
          { id: "routes/settings", path: "app/settings", loader: handler as any, action: handler as any },
          { id: "routes/api.things", path: "api/things", loader: handler as any, action: handler as any },
        ],
      },
    ],
    {
      initialEntries: ["/"],
      hydrationData: { loaderData: { root: {}, "routes/home": { page: "home" } } },
      dataStrategy: getSingleFetchDataStrategy(
        () => router,
        manifest,
        {} as any,
        true,
        "/",
        false,
      ) as any,
    },
  );
  // What a mounted useFetcher would have rendered last (the router drops a finished fetcher from its state).
  router.subscribe((state) => state.fetchers.forEach((fetcher, key) => seenFetchers.set(key, fetcher)));
  router.getFetcher("k");
  return router;
}

// Fake clock for the waits; real macrotasks for the streams the router decodes.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const flushTimers = async (ms: number) => {
  const step = 500;
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
    for (let i = 0; i < 4; i++) await settle();
  }
  for (let i = 0; i < 10; i++) await settle();
};

const urlsFetched = () => serverFetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  resetRateLimitState();
  seenFetchers.clear();
  serverFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => script(new URL(String(input), "http://localhost"), init ?? {}));
  globalThis.fetch = createRateLimitFetch(serverFetch as any, { random: () => 0 });
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("the encoder against the router's own decoder", () => {
  it("round-trips a result object", async () => {
    const value = { data: { success: false, error: "x", n: 3, nested: { a: [1, "b", null, true] } } };
    const res = new Response(encodeTurboStreamValue(value));
    const decoded = await decodeViaTurboStream(res.body as any, window as any);
    expect(decoded.value).toEqual(value);
  });
});

describe("router fetcher POST (real router)", () => {
  it("is sent again after Retry-After and the fetcher gets the real answer", async () => {
    let calls = 0;
    script = (url) =>
      url.pathname.startsWith("/api/") ? (++calls === 1 ? refusal() : dataAnswer({ data: { success: true, saved: 1 } })) : pageAnswer();
    const router = makeRouter();
    const fd = new FormData();
    fd.set("x", "1");
    void router.fetch("k", "routes/api.things", "/api/things", { formMethod: "POST", formData: fd });
    await flushTimers(3000);
    await flushTimers(10);
    expect(router.state.errors).toBeNull();
    expect(fetcherOf("k")?.data).toEqual({ success: true, saved: 1 });
    expect(urlsFetched().filter((u) => u.includes("/api/things.data"))).toHaveLength(2);
  });

  it("when the retries run out the fetcher gets a failed result, not the ErrorBoundary, and nothing revalidates", async () => {
    script = (url) => (url.pathname.startsWith("/api/") ? refusal() : pageAnswer());
    const router = makeRouter({ homeLoader: true });
    const fd = new FormData();
    fd.set("x", "typed text");
    void router.fetch("k", "routes/api.things", "/api/things", { formMethod: "POST", formData: fd });
    await flushTimers(30_000);
    await flushTimers(10);
    expect(router.state.errors).toBeNull();
    const data = fetcherOf("k")?.data as any;
    expect(data).toMatchObject({ success: false, rateLimited: true });
    expect(typeof data.error).toBe("string");
    // 1 send + MAX_RETRIES resends, and no loader read after the refused action.
    expect(urlsFetched()).toHaveLength(1 + MAX_RETRIES);
    expect(urlsFetched().every((u) => u.includes("/api/things.data"))).toBe(true);
  });
});

describe("router fetcher GET (real router)", () => {
  it("is sent again and delivers the real data", async () => {
    let calls = 0;
    script = () => (++calls === 1 ? refusal() : dataAnswer({ "routes/api.things": { data: { success: true, rows: [1] } } }));
    const router = makeRouter();
    router.fetch("k", "routes/api.things", "/api/things?x=1");
    await flushTimers(3000);
    await flushTimers(10);
    expect(router.state.errors).toBeNull();
    expect(fetcherOf("k")?.data).toEqual({ success: true, rows: [1] });
  });

  it("exhausted: the fetcher gets a failed result and no ErrorBoundary", async () => {
    script = () => refusal();
    const router = makeRouter();
    router.fetch("k", "routes/api.things", "/api/things?x=1", { formMethod: "GET" } as any);
    await flushTimers(30_000);
    await flushTimers(10);
    expect(router.state.errors).toBeNull();
    expect(fetcherOf("k")?.data).toMatchObject({ success: false, rateLimited: true });
  });

  it("a newer load of the same fetcher aborts the waiting one: nothing is sent for it afterwards", async () => {
    let n = 0;
    script = (url) => {
      n++;
      return url.search.includes("product=A") ? refusal("api-read", 5) : dataAnswer({ "routes/api.things": { data: { success: true, product: "B" } } });
    };
    const router = makeRouter();
    router.fetch("k", "routes/api.things", "/api/things?product=A", { formMethod: "GET" } as any);
    await flushTimers(100);
    expect(n).toBe(1);
    // The merchant switched products: the same fetcher loads B.
    router.fetch("k", "routes/api.things", "/api/things?product=B", { formMethod: "GET" } as any);
    await flushTimers(20_000);
    const urls = urlsFetched();
    expect(urls.filter((u) => u.includes("product=A"))).toHaveLength(1);
    expect(router.state.errors).toBeNull();
    // The answer on screen is B's, never a late one for A.
    expect(fetcherOf("k")?.data).toEqual({ success: true, product: "B" });
  });
});

describe("navigation (real router)", () => {
  it("is sent again and lands", async () => {
    let calls = 0;
    script = () => (++calls === 1 ? refusal("strict", 3) : pageAnswer({ "routes/settings": { data: { tab: "x" } } }));
    const router = makeRouter();
    void router.navigate("/app/settings");
    await flushTimers(5000);
    expect(router.state.errors).toBeNull();
    expect(router.state.location.pathname).toBe("/app/settings");
  });

  it("exhausted: the page on screen stays, the navigation stays pending, a new click replaces it", async () => {
    script = (url) => (url.pathname === "/app/settings.data" ? refusal("strict", 5) : pageAnswer());
    const router = makeRouter();
    void router.navigate("/app/settings");
    await flushTimers(60_000);
    expect(router.state.errors).toBeNull();
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.navigation.state).toBe("loading");
    // Held, not hammered: the sends stopped after the retries.
    expect(urlsFetched()).toHaveLength(1 + MAX_RETRIES);
    void router.navigate("/");
    await flushTimers(50);
    expect(router.state.navigation.state).toBe("idle");
    expect(router.state.errors).toBeNull();
  });
});

describe("only OUR refusals are retried", () => {
  it("a 429 without the marker is returned untouched (one send)", async () => {
    script = () => new Response("slow down", { status: 429, headers: { "Retry-After": "1" } });
    const wrapped = globalThis.fetch;
    const res = await wrapped("/api/other");
    expect(res.status).toBe(429);
    expect(serverFetch).toHaveBeenCalledTimes(1);
  });

  it("a handler's own 429 result (X-Remix-Response) reaches the fetcher as its data, once", async () => {
    script = () => dataAnswer({ data: { success: false, error: "plan limit" } }, 429);
    const router = makeRouter();
    const fd = new FormData();
    fd.set("x", "1");
    void router.fetch("k", "routes/api.things", "/api/things", { formMethod: "POST", formData: fd });
    await flushTimers(10);
    expect(serverFetch).toHaveBeenCalledTimes(1);
    expect(fetcherOf("k")?.data).toEqual({ success: false, error: "plan limit" });
  });
});

describe("no retry storm", () => {
  it("many refused requests of one bucket: nothing is sent into the closed window, total sends are bounded", async () => {
    const sentAt: number[] = [];
    script = () => {
      sentAt.push(Date.now());
      return refusal("api", 4);
    };
    const started = Date.now();
    const calls = Array.from({ length: 6 }, (_, i) =>
      globalThis.fetch(`/api/x${i === 0 ? "" : ""}`, { method: "POST", body: "a=1" }).catch(() => undefined),
    );
    await flushTimers(60_000);
    await Promise.all(calls);
    // 6 requests x (1 + MAX_RETRIES) is the ceiling; the gate keeps it far below once the first refusal is known.
    expect(sentAt.length).toBeLessThanOrEqual(6 * (1 + MAX_RETRIES));
    // After the first refusal (t0, window of 4 s) nothing is sent before it ends.
    const afterFirstRefusal = sentAt.filter((t) => t > started && t < started + 4000);
    expect(afterFirstRefusal.length).toBeLessThanOrEqual(6); // the initial burst only, all at t0
    expect(sentAt.filter((t) => t > started && t < started + 4000 && t !== started)).toHaveLength(0);
  });
});
