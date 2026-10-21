/**
 * The webhook guard counts only requests that FAILED verification (401 bad
 * HMAC, 400 missing Shopify headers, 405 non-POST), keyed by client IP. It
 * must never throttle a genuine delivery: neither by a header-presence skip
 * (junk HMAC bypass) nor by a bucket keyed on the UNVERIFIED shop-domain header
 * (an attacker naming a victim shop got that shop's real deliveries 429'd).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sourcePath = join(__dirname, "..", "..", "app/middleware/rate-limit-cjs.cjs");
const source = readFileSync(sourcePath, "utf8");
const { createWebhookFailureLimiter } = require(sourcePath);

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

/** Runs one request through the guard; returns whether the route was reached. */
function send(guard: any, ip: string, routeStatus: number, headers: Record<string, string> = {}) {
  const req = { ip, headers };
  const res = makeRes();
  let reached = false;
  guard(req, res, () => {
    reached = true;
    res.statusCode = routeStatus;
    res.emit("finish");
  });
  return { reached, res };
}

describe("webhook guard", () => {
  it("is not keyed on the shop header and has no header-presence skip", () => {
    const block = source.slice(source.indexOf("function createWebhookFailureLimiter"), source.indexOf("const webhookRateLimit"));
    expect(block).not.toContain("x-shopify-shop-domain");
    expect(block).not.toContain("x-shopify-hmac-sha256");
    expect(source).not.toContain("skipVerifiedWebhook");
  });

  it("never throttles valid deliveries, however many", () => {
    let t = 0;
    const guard = createWebhookFailureLimiter({ limit: 3, now: () => t });
    for (let i = 0; i < 5000; i++) {
      expect(send(guard, "1.1.1.1", 200, { "x-shopify-shop-domain": "victim.myshopify.com" }).reached).toBe(true);
    }
  });

  it("blocks an IP after too many HMAC failures, without touching other IPs", () => {
    let t = 0;
    const guard = createWebhookFailureLimiter({ limit: 3, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 3; i++) {
      expect(send(guard, "6.6.6.6", 401, { "x-shopify-shop-domain": "victim.myshopify.com" }).reached).toBe(true);
    }
    const blocked = send(guard, "6.6.6.6", 200);
    expect(blocked.reached).toBe(false);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers["Retry-After"]).toBeDefined();
    // Shopify's genuine delivery for the same shop, from its own IP, still goes through.
    expect(send(guard, "1.1.1.1", 200, { "x-shopify-shop-domain": "victim.myshopify.com" }).reached).toBe(true);
    // The window ends.
    t = 60_001;
    expect(send(guard, "6.6.6.6", 200).reached).toBe(true);
  });

  it("counts 400 and 405 but not 404 or 500", () => {
    const guard = createWebhookFailureLimiter({ limit: 2, now: () => 0 });
    send(guard, "2.2.2.2", 404);
    send(guard, "2.2.2.2", 500);
    expect(guard.failureCount("2.2.2.2")).toBe(0);
    send(guard, "2.2.2.2", 400);
    send(guard, "2.2.2.2", 405);
    expect(guard.failureCount("2.2.2.2")).toBe(2);
    expect(send(guard, "2.2.2.2", 200).reached).toBe(false);
  });
});
