/**
 * /webhooks is never throttled. The observer counts requests that FAILED
 * verification (401 bad HMAC, 400 missing Shopify headers, 405 non-POST) per
 * client IP and only LOGS a spike: a per-IP block could be aimed at Shopify's
 * shared delivery IPs (an attacker's own Partner app subscribing a webhook to
 * our URL, signed with their secret), a header-keyed bucket at a victim shop.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sourcePath = join(__dirname, "..", "..", "app/middleware/rate-limit-cjs.cjs");
const source = readFileSync(sourcePath, "utf8");
const { createWebhookFailureObserver } = require(sourcePath);

function makeRes() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
    setHeader: (k: string, v: string) => void;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  };
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
}

/** Runs one request through the observer; returns whether the route was reached. */
function send(
  guard: any,
  ip: string,
  routeStatus: number,
  headers: Record<string, string> = {},
  events: string[] = ["finish", "close"],
) {
  const req = { ip, headers };
  const res = makeRes();
  let reached = false;
  guard(req, res, () => {
    reached = true;
    res.statusCode = routeStatus;
    for (const e of events) res.emit(e);
  });
  return { reached, res };
}

describe("webhook failure observer", () => {
  it("is not keyed on the shop header, has no header-presence skip and never answers 429", () => {
    const block = source.slice(
      source.indexOf("function createWebhookFailureObserver"),
      source.indexOf("const webhookFailureObserver"),
    );
    expect(block).not.toContain("x-shopify-shop-domain");
    expect(block).not.toContain("x-shopify-hmac-sha256");
    expect(block).not.toContain("429");
    expect(block).not.toContain(".status(");
    expect(source).not.toContain("skipVerifiedWebhook");
  });

  it("never throttles valid deliveries, however many", () => {
    const warn = vi.fn();
    const guard = createWebhookFailureObserver({ threshold: 3, now: () => 0, warn });
    for (let i = 0; i < 5000; i++) {
      const r = send(guard, "1.1.1.1", 200, { "x-shopify-shop-domain": "victim.myshopify.com" });
      expect(r.reached).toBe(true);
      expect(r.res.statusCode).toBe(200);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("never produces a 429, however many failures an IP piles up", () => {
    const warn = vi.fn();
    const guard = createWebhookFailureObserver({ threshold: 3, now: () => 0, warn });
    for (let i = 0; i < 1000; i++) {
      const r = send(guard, "6.6.6.6", 401);
      expect(r.reached).toBe(true);
      expect(r.res.statusCode).toBe(401);
      expect(r.res.headers["Retry-After"]).toBeUndefined();
    }
    // A genuine delivery from the same (shared) IP still goes through untouched.
    const ok = send(guard, "6.6.6.6", 200);
    expect(ok.reached).toBe(true);
    expect(ok.res.statusCode).toBe(200);
    expect(guard.failureCount("6.6.6.6")).toBe(1000);
  });

  it("warns once per IP per window past the threshold", () => {
    let t = 0;
    const warn = vi.fn();
    const guard = createWebhookFailureObserver({ threshold: 3, windowMs: 60_000, now: () => t, warn });
    send(guard, "6.6.6.6", 401);
    send(guard, "6.6.6.6", 401);
    expect(warn).not.toHaveBeenCalled();
    send(guard, "6.6.6.6", 401);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("6.6.6.6");
    for (let i = 0; i < 50; i++) send(guard, "6.6.6.6", 400);
    expect(warn).toHaveBeenCalledTimes(1);
    // Another IP has its own count.
    send(guard, "7.7.7.7", 401);
    expect(warn).toHaveBeenCalledTimes(1);
    // A new window warns again.
    t = 60_001;
    for (let i = 0; i < 3; i++) send(guard, "6.6.6.6", 401);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("counts 400 and 405 but not 404 or 500", () => {
    const guard = createWebhookFailureObserver({ threshold: 100, now: () => 0, warn: () => {} });
    send(guard, "2.2.2.2", 404);
    send(guard, "2.2.2.2", 500);
    expect(guard.failureCount("2.2.2.2")).toBe(0);
    send(guard, "2.2.2.2", 400);
    send(guard, "2.2.2.2", 405);
    expect(guard.failureCount("2.2.2.2")).toBe(2);
  });

  it("counts on close when finish never fired, and never twice", () => {
    const guard = createWebhookFailureObserver({ threshold: 100, now: () => 0, warn: () => {} });
    send(guard, "3.3.3.3", 401, {}, ["close"]);
    expect(guard.failureCount("3.3.3.3")).toBe(1);
    send(guard, "3.3.3.3", 401, {}, ["finish", "close"]);
    expect(guard.failureCount("3.3.3.3")).toBe(2);
  });

  it("counts once when close fires before finish with the failure status already set", () => {
    const guard = createWebhookFailureObserver({ threshold: 100, now: () => 0, warn: () => {} });
    send(guard, "3.3.3.4", 401, {}, ["close", "finish"]);
    expect(guard.failureCount("3.3.3.4")).toBe(1);
  });

  it("a full map sweeps at most once per window and otherwise evicts the oldest key", () => {
    let t = 0;
    const guard = createWebhookFailureObserver({
      threshold: 1000,
      windowMs: 60_000,
      maxKeys: 10,
      now: () => t,
      warn: () => {},
    });
    for (let i = 0; i < 10; i++) send(guard, `10.0.0.${i}`, 401);
    expect(guard.trackedKeys()).toBe(10);
    expect(guard.pruneRuns()).toBe(0);
    // Many new IPs against a full map within one window: one sweep, then O(1) evictions.
    for (let i = 0; i < 500; i++) {
      t = 1 + i;
      send(guard, `11.0.${i >> 8}.${i & 255}`, 401);
    }
    expect(guard.pruneRuns()).toBe(1);
    expect(guard.trackedKeys()).toBe(10);
    // Oldest evicted first: the earliest IPs are gone, the newest remain.
    expect(guard.failureCount("10.0.0.0")).toBe(0);
    expect(guard.failureCount("11.0.1.243")).toBe(1); // i = 499
    // A new window allows one more sweep.
    t = 60_001 + 500;
    for (let i = 0; i < 50; i++) send(guard, `12.0.0.${i}`, 401);
    expect(guard.pruneRuns()).toBe(2);
    expect(guard.trackedKeys()).toBe(10);
  });

  it("a throwing logger never affects the request", () => {
    const guard = createWebhookFailureObserver({
      threshold: 1,
      now: () => 0,
      warn: () => {
        throw new Error("logger down");
      },
    });
    expect(() => send(guard, "4.4.4.4", 401)).not.toThrow();
    expect(guard.failureCount("4.4.4.4")).toBe(1);
  });
});
