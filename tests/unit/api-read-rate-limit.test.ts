/**
 * /api rate limiting: reads (GET/HEAD) have their own 200/min bucket, writes keep
 * the general 100/min, excluded paths count against neither, and a 429 leaves one
 * safe warn line behind.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const limitersPath = join(__dirname, "..", "..", "app/middleware/rate-limit-cjs.cjs");
const loggerPath = join(__dirname, "..", "..", "app/middleware/server-logger.cjs");

function fakeRes() {
  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.body = undefined;
  res.headers = {} as Record<string, string>;
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.setHeader = (k: string, v: string) => ((res.headers[k] = v), res);
  res.getHeader = (k: string) => res.headers[k];
  res.append = res.setHeader;
  res.set = res.setHeader;
  return res;
}

describe("createApiRateLimitRouter", () => {
  const { createApiRateLimitRouter } = require(limitersPath);
  const make = () => {
    const general = vi.fn((_q, _r, next) => next());
    const read = vi.fn((_q, _r, next) => next());
    const next = vi.fn();
    const route = createApiRateLimitRouter({ excludedPaths: ["/running-tasks-count", "/ai-x"], general, read });
    return { general, read, next, route };
  };

  it.each(["GET", "HEAD"])("%s goes to the read limiter only", (method) => {
    const { general, read, next, route } = make();
    route({ method, path: "/product-images" }, fakeRes(), next);
    expect(read).toHaveBeenCalledTimes(1);
    expect(general).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("%s goes to the general limiter only", (method) => {
    const { general, read, next, route } = make();
    route({ method, path: "/create-options" }, fakeRes(), next);
    expect(general).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"])("an excluded path (%s) reaches neither limiter", (method) => {
    const { general, read, next, route } = make();
    route({ method, path: "/running-tasks-count" }, fakeRes(), next);
    expect(general).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("the real limiters", () => {
  it("count a request once, in separate buckets: 100 for writes, 200 for reads", async () => {
    const { apiRateLimit, apiReadRateLimit, createApiRateLimitRouter } = require(limitersPath);
    const route = createApiRateLimitRouter({ excludedPaths: [], general: apiRateLimit, read: apiReadRateLimit });
    const hit = async (method: string, ip: string) => {
      const req: any = { method, path: "/x", originalUrl: "/api/x?id=secret", url: "/x", ip, headers: {}, app: { get: () => false } };
      const res = fakeRes();
      let passed = false;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        res.json = (b: unknown) => ((res.body = b), done(), res);
        route(req, res, () => ((passed = true), done()));
      });
      return passed;
    };
    const ip = "203.0.113.7";
    for (let i = 0; i < 100; i++) expect(await hit("POST", ip)).toBe(true);
    expect(await hit("POST", ip)).toBe(false); // the 101st write is refused
    // The read bucket is untouched by those writes: 200 reads pass, the 201st does not.
    for (let i = 0; i < 200; i++) expect(await hit("GET", ip)).toBe(true);
    expect(await hit("GET", ip)).toBe(false);
    // Another client has its own buckets.
    expect(await hit("GET", "203.0.113.8")).toBe(true);
  });
});

describe("the 429 warn line", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names method, path and limit - no query string, no IP", () => {
    const { standardHandler } = require(limitersPath);
    const { serverLogger } = require(loggerPath);
    const warn = vi.spyOn(serverLogger, "warn").mockImplementation((() => {}) as any);
    const res = fakeRes();
    standardHandler(
      { method: "GET", originalUrl: "/api/product-images?productId=gid%3A%2F%2Fshopify%2FProduct%2F1&token=abc", ip: "198.51.100.9", rateLimit: { limit: 200 } },
      res,
    );
    expect(res.statusCode).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("GET /api/product-images");
    expect(line).toContain("200");
    expect(line).not.toMatch(/productId|token|abc|198\.51\.100\.9|\?/);
  });

  it("states the limiter's real window (auth is 15 minutes, not a minute) and caps the path at 200 characters", () => {
    const { standardHandler } = require(limitersPath);
    const { serverLogger } = require(loggerPath);
    const warn = vi.spyOn(serverLogger, "warn").mockImplementation((() => {}) as any);
    standardHandler(
      { method: "GET", originalUrl: `/auth/${"x".repeat(15_000)}?code=secret`, rateLimit: { limit: 5 } },
      fakeRes(),
      () => {},
      { windowMs: 15 * 60 * 1000 },
    );
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("limit 5 per 900s");
    expect(line.length).toBeLessThan(300);
    expect(line).not.toContain("secret");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a real limiter passes its own window to the handler", async () => {
    const { apiReadRateLimit } = require(limitersPath);
    const { serverLogger } = require(loggerPath);
    const warn = vi.spyOn(serverLogger, "warn").mockImplementation((() => {}) as any);
    const req: any = { method: "GET", path: "/x", originalUrl: "/api/x?q=1", url: "/x", ip: "203.0.113.99", headers: {}, app: { get: () => false } };
    for (let i = 0; i < 201; i++) {
      await new Promise<void>((resolve) => {
        const res = fakeRes();
        res.json = () => (resolve(), res);
        apiReadRateLimit(req, res, () => resolve());
      });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe("[rate-limit] 429 GET /api/x limit 200 per 60s");
  });

  it("a logger that throws never changes the response", () => {
    const { standardHandler } = require(limitersPath);
    const { serverLogger } = require(loggerPath);
    vi.spyOn(serverLogger, "warn").mockImplementation((() => {
      throw new Error("logger down");
    }) as any);
    vi.spyOn(console, "warn").mockImplementation((() => {
      throw new Error("console down");
    }) as any);
    const res = fakeRes();
    expect(() => standardHandler({ method: "POST", originalUrl: "/api/x", rateLimit: { limit: 100 } }, res)).not.toThrow();
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ error: "Too many requests, please try again later" });
  });
});
