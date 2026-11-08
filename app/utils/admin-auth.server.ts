/**
 * Authentication helpers for the standalone /admin page.
 *
 * - The cookie is signed with a secret DERIVED from SHOPIFY_API_SECRET and
 *   ADMIN_PASSWORD, never with the bare password. No extra env variable is
 *   needed, and changing the password still invalidates every session.
 * - The cookie carries its issue time; the server rejects it after
 *   ADMIN_SESSION_MAX_AGE_MS no matter what the browser does with it.
 * - A password shorter than ADMIN_PASSWORD_MIN_LENGTH keeps the page locked.
 */
import { createCookie } from "react-router";
import { createHash, timingSafeEqual } from "node:crypto";

export const ADMIN_PASSWORD_MIN_LENGTH = 16;
export const ADMIN_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

export type AdminPasswordState = "unset" | "too-short" | "ok";

export function adminPasswordState(): AdminPasswordState {
  const p = process.env.ADMIN_PASSWORD;
  if (!p || p.length === 0) return "unset";
  if (p.length < ADMIN_PASSWORD_MIN_LENGTH) return "too-short";
  return "ok";
}

/** The configured password, or null when unset or too short (page stays locked). */
export function adminPassword(): string | null {
  return adminPasswordState() === "ok" ? (process.env.ADMIN_PASSWORD as string) : null;
}

/** Secret used to sign the session cookie. Null while the page is locked. */
export function deriveAdminCookieSecret(): string | null {
  const pw = adminPassword();
  if (!pw) return null;
  return createHash("sha256")
    .update((process.env.SHOPIFY_API_SECRET ?? "") + "\0admin-cookie\0" + pw, "utf-8")
    .digest("hex");
}

export function adminAuthCookie() {
  const secret = deriveAdminCookieSecret() ?? "admin-locked";
  return createCookie("cp_admin", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/", // deliberately not /admin: path scoping drops the cookie on some data requests
    maxAge: ADMIN_SESSION_MAX_AGE_MS / 1000,
    secrets: [secret],
  });
}

/** Set-Cookie value for a fresh session. */
export async function serializeAdminSession(now: number = Date.now()): Promise<string> {
  return adminAuthCookie().serialize({ iat: now });
}

export async function serializeAdminLogout(): Promise<string> {
  return adminAuthCookie().serialize("", { maxAge: 0 });
}

export function constantTimeEqual(a: string, b: string): boolean {
  // Compare fixed-length digests, so neither an early length check nor the
  // comparison itself reveals the expected password's length.
  const ba = createHash("sha256").update(a, "utf-8").digest();
  const bb = createHash("sha256").update(b, "utf-8").digest();
  return timingSafeEqual(ba, bb);
}

/** True when the request carries a valid, unexpired admin session. */
export async function isAdminAuthenticated(
  request: Request,
  now: number = Date.now(),
): Promise<boolean> {
  if (!deriveAdminCookieSecret()) return false;
  let value: unknown;
  try {
    value = await adminAuthCookie().parse(request.headers.get("Cookie"));
  } catch {
    return false;
  }
  if (!value || typeof value !== "object") return false;
  const iat = (value as { iat?: unknown }).iat;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return false;
  const age = now - iat;
  return age >= 0 && age <= ADMIN_SESSION_MAX_AGE_MS;
}

/** Headers for every response of the admin route (login form, errors, redirects). */
export const ADMIN_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};
