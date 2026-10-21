/**
 * The webhook limiter used to skip every request that merely CARRIED an
 * `x-shopify-hmac-sha256` header — unverified, so any junk value bypassed it.
 * It now applies to every request, keyed by shop domain.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "..", "..", "app/middleware/rate-limit-cjs.cjs"), "utf8");

describe("webhook rate limit", () => {
  it("has no header-presence skip", () => {
    const block = source.slice(source.indexOf("const webhookRateLimit"), source.indexOf("const authRateLimit"));
    expect(block).not.toMatch(/\bskip\s*:/);
    expect(source).not.toContain("skipVerifiedWebhook");
    expect(block).toContain("x-shopify-shop-domain");
  });
});
