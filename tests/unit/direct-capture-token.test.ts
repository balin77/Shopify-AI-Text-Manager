/**
 * The capture token is the only thing that tells the storefront capture
 * endpoint (proxy.direct-add) the MERCHANT is calling and not an anonymous
 * visitor — the app-proxy signature proves neither. It must be shop-bound,
 * purpose-bound, expiring and tamper-evident.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  mintCaptureToken,
  verifyCaptureToken,
  CAPTURE_TOKEN_TTL_MS,
} from "../../app/services/direct-capture-token.server";

const SHOP = "test.myshopify.com";

describe("capture token", () => {
  it("verifies a fresh token for the shop it was minted for", () => {
    const now = 1_000_000;
    expect(verifyCaptureToken(mintCaptureToken(SHOP, now), SHOP, now + 1000)).toBe(true);
  });

  it("refuses an expired token", () => {
    const now = 1_000_000;
    const token = mintCaptureToken(SHOP, now);
    expect(verifyCaptureToken(token, SHOP, now + CAPTURE_TOKEN_TTL_MS - 1)).toBe(true);
    expect(verifyCaptureToken(token, SHOP, now + CAPTURE_TOKEN_TTL_MS)).toBe(false);
  });

  it("refuses a token minted for another shop", () => {
    const token = mintCaptureToken("other.myshopify.com");
    expect(verifyCaptureToken(token, SHOP)).toBe(false);
  });

  it("refuses a token whose payload was edited", () => {
    const token = mintCaptureToken("other.myshopify.com");
    const [, sig] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ s: SHOP, e: Date.now() + 60_000, p: "direct-capture" }),
    ).toString("base64url");
    expect(verifyCaptureToken(`${forgedBody}.${sig}`, SHOP)).toBe(false);
  });

  it("refuses a tampered signature", () => {
    const token = mintCaptureToken(SHOP);
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyCaptureToken(flipped, SHOP)).toBe(false);
  });

  it("refuses a value signed with the raw app secret (another purpose's key)", () => {
    const secret = process.env.SHOPIFY_API_SECRET || process.env.ENCRYPTION_KEY || "dev-only-capture-token-secret";
    const body = Buffer.from(
      JSON.stringify({ s: SHOP, e: Date.now() + 60_000, p: "direct-capture" }),
    ).toString("base64url");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    expect(verifyCaptureToken(`${body}.${sig}`, SHOP)).toBe(false);
  });

  it("never throws on garbage", () => {
    for (const bad of [undefined, null, 42, {}, "", ".", "a.b.c", "x".repeat(2000), "%%%.***"]) {
      expect(verifyCaptureToken(bad, SHOP)).toBe(false);
    }
  });
});
