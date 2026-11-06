import { describe, it, expect } from "vitest";
import { createLoginLimiter, clientIpFromRequest } from "../../app/utils/admin-login-limiter.server";

describe("admin login limiter", () => {
  const WINDOW = 15 * 60 * 1000;

  it("locks an IP out after the per-IP cap of failures, for the whole window", () => {
    const limiter = createLoginLimiter({ perKeyMax: 3, globalMax: 100, windowMs: WINDOW });
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("1.1.1.1", t0 + i).allowed).toBe(true);
      limiter.recordFailure("1.1.1.1", t0 + i);
    }
    const locked = limiter.check("1.1.1.1", t0 + 10);
    expect(locked.allowed).toBe(false);
    expect(locked.retryAfterSec).toBeGreaterThan(0);
    // Another IP is not affected.
    expect(limiter.check("2.2.2.2", t0 + 10).allowed).toBe(true);
    // After the window the IP may try again.
    expect(limiter.check("1.1.1.1", t0 + 2 + WINDOW).allowed).toBe(true);
  });

  it("a success clears the caller's failures", () => {
    const limiter = createLoginLimiter({ perKeyMax: 3, globalMax: 100, windowMs: WINDOW });
    limiter.recordFailure("ip", 1);
    limiter.recordFailure("ip", 2);
    limiter.recordSuccess("ip");
    limiter.recordFailure("ip", 3);
    limiter.recordFailure("ip", 4);
    expect(limiter.check("ip", 5).allowed).toBe(true);
  });

  it("failures older than the window do not count", () => {
    const limiter = createLoginLimiter({ perKeyMax: 2, globalMax: 100, windowMs: WINDOW });
    limiter.recordFailure("ip", 0);
    limiter.recordFailure("ip", WINDOW + 1);
    expect(limiter.check("ip", WINDOW + 2).allowed).toBe(true);
  });

  it("a distributed guess hits the global cap", () => {
    const limiter = createLoginLimiter({ perKeyMax: 10, globalMax: 5, windowMs: WINDOW });
    for (let i = 0; i < 5; i++) limiter.recordFailure(`10.0.0.${i}`, i);
    expect(limiter.check("10.0.0.99", 10).allowed).toBe(false);
    expect(limiter.check("10.0.0.99", 10 + WINDOW).allowed).toBe(true);
  });

  it("takes the rightmost X-Forwarded-For entry (the one the proxy appended)", () => {
    const req = new Request("https://x/admin", {
      headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7" },
    });
    expect(clientIpFromRequest(req)).toBe("203.0.113.7");
    expect(clientIpFromRequest(new Request("https://x/admin"))).toBe("unknown");
  });
});
