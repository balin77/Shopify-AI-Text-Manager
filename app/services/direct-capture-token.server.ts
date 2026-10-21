/**
 * Capture token for the direct-translation capture mode in the theme editor.
 *
 * The capture panel runs on the STOREFRONT (the theme editor preview) and
 * writes through the app proxy (`/apps/contentpilot/direct-add`). The proxy
 * signature only proves that a request came through the shop's storefront —
 * every anonymous visitor's request does — so it cannot tell the merchant
 * from a stranger, and the "theme editor only" gate in the storefront script
 * is a UI rule anybody can skip with one `fetch`.
 *
 * This token is what the server checks instead: an HMAC over
 * `{ shop, exp, purpose }`, minted ONLY by the authenticated admin page
 * (app.direct-translations.tsx loader) and handed to the theme editor through
 * the "open capture mode" deep link (or pasted into the panel by hand). It is
 * bound to one shop and one purpose, expires after CAPTURE_TOKEN_TTL_MS, and
 * is compared in constant time.
 *
 * The HMAC key is DERIVED from the app secret with a purpose label, so a value
 * signed for another purpose in this app (e.g. the Search Console OAuth state,
 * which signs with the raw secret) can never verify here and vice versa.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CAPTURE_TOKEN_PURPOSE = "direct-capture";
/** 2 hours: one editing session in the theme editor — short, because the token is a bearer credential handed to a storefront page. */
export const CAPTURE_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function baseSecret(): string {
  const secret = (process.env.SHOPIFY_API_SECRET || process.env.ENCRYPTION_KEY || "").trim();
  if (secret) return secret;
  // Same rule as the GSC OAuth state: a hardcoded fallback would let anyone
  // forge a token if production ever ran without a secret, so fail loudly
  // there. Non-production keeps a fallback so a bare-bones local .env works.
  if (process.env.NODE_ENV === "production") {
    throw new Error("Capture token secret is not configured: set SHOPIFY_API_SECRET or ENCRYPTION_KEY");
  }
  return "dev-only-capture-token-secret";
}

function signingKey(): Buffer {
  return createHmac("sha256", baseSecret()).update("contentpilot/direct-capture-token/v1").digest();
}

function sign(body: string): string {
  return createHmac("sha256", signingKey()).update(body).digest("base64url");
}

/** Mint a capture token for `shop`. Call ONLY from an authenticated admin path. */
export function mintCaptureToken(shop: string, now: number = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ s: shop, e: now + CAPTURE_TOKEN_TTL_MS, p: CAPTURE_TOKEN_PURPOSE }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * True only for an untampered, unexpired capture token minted for `shop`.
 * Never throws on malformed input (it is attacker-controlled).
 */
export function verifyCaptureToken(token: unknown, shop: string, now: number = Date.now()): boolean {
  if (typeof token !== "string" || token.length === 0 || token.length > 512) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  if (!body || !sig) return false;

  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return false;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data || typeof data !== "object") return false;
    if (data.p !== CAPTURE_TOKEN_PURPOSE) return false;
    if (typeof data.s !== "string" || data.s !== shop) return false;
    if (typeof data.e !== "number" || !Number.isFinite(data.e) || data.e <= now) return false;
    return true;
  } catch {
    return false;
  }
}
