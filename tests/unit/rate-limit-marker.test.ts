/**
 * What the limiter's refusal looks like on the wire: the marker the client's
 * retry layer keys on, Retry-After, JSON for fetches, and a self-reloading page
 * (de / en / es) instead of raw JSON for a browser document load.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const limiters = require(join(__dirname, "..", "..", "app/middleware/rate-limit-cjs.cjs"));

function fakeRes() {
  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.headers = {} as Record<string, string>;
  res.body = undefined;
  res.sent = undefined;
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.send = (b: string) => ((res.sent = b), res);
  res.setHeader = (k: string, v: string) => ((res.headers[k] = v), res);
  return res;
}
const req = (over: Record<string, unknown> = {}) => ({
  method: "GET",
  path: "/api/x",
  originalUrl: "/api/x?a=1",
  headers: { accept: "*/*" },
  rateLimit: { limit: 100, resetTime: new Date(Date.now() + 12_000) },
  ...over,
});

describe("429 from our limiter", () => {
  it("carries the marker (the bucket), Retry-After and the JSON body", () => {
    const res = fakeRes();
    limiters.bucketHandler("api-read")(req(), res, () => {}, { windowMs: 60_000 });
    expect(res.statusCode).toBe(429);
    expect(res.headers[limiters.RATE_LIMIT_MARKER_HEADER]).toBe("api-read");
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
    expect(res.body).toMatchObject({ error: "Too many requests, please try again later" });
    expect(res.sent).toBeUndefined();
  });

  it("every exported limiter hands its refusals to a bucket handler", () => {
    const names = ["apiRateLimit", "apiReadRateLimit", "aiActionRateLimit", "contentActionRateLimit", "authRateLimit", "strictRateLimit", "bulkOperationRateLimit"];
    for (const n of names) expect(typeof limiters[n]).toBe("function");
  });

  it("a router data request (.data) gets JSON, never the page", () => {
    const res = fakeRes();
    limiters.bucketHandler("strict")(req({ path: "/app/settings.data", headers: { accept: "text/html" } }), res, () => {}, {});
    expect(res.body).toBeDefined();
    expect(res.sent).toBeUndefined();
  });

  it.each([
    ["de-CH,de;q=0.9", "de", "Gerade sind viele Anfragen"],
    ["es-ES,es;q=0.9", "es", "Hay muchas solicitudes"],
    ["fr-FR", "en", "Many requests are being processed"],
  ])("a document load (Accept-Language %s) gets a self-reloading page in %s", (acceptLanguage, lang, text) => {
    const res = fakeRes();
    limiters.bucketHandler("strict")(
      req({ path: "/app/settings", headers: { accept: "text/html,application/xhtml+xml", "accept-language": acceptLanguage } }),
      res,
      () => {},
      {},
    );
    expect(res.statusCode).toBe(429);
    expect(res.headers["Content-Type"]).toContain("text/html");
    expect(res.headers[limiters.RATE_LIMIT_MARKER_HEADER]).toBe("strict");
    expect(res.sent).toContain(`<html lang="${lang}">`);
    expect(res.sent).toContain(text);
    expect(res.sent).toMatch(/http-equiv="refresh" content="\d+"/);
    expect(res.body).toBeUndefined();
    // Nothing of the request is reflected into the page.
    expect(res.sent).not.toContain("a=1");
  });

  it("a POST never gets the page, even when it accepts HTML", () => {
    const res = fakeRes();
    limiters.bucketHandler("content")(req({ method: "POST", headers: { accept: "text/html" } }), res, () => {}, {});
    expect(res.body).toBeDefined();
    expect(res.sent).toBeUndefined();
  });
});
