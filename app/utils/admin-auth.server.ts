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

export type AdminPasswordState = "unset" | "too-short" | "no-secret" | "ok";

export function adminPasswordState(): AdminPasswordState {
  const p = process.env.ADMIN_PASSWORD;
  if (!p || p.length === 0) return "unset";
  if (p.length < ADMIN_PASSWORD_MIN_LENGTH) return "too-short";
  // Without the app secret the derived cookie secret would rest on the
  // password alone, so the page stays locked instead.
  if (!process.env.SHOPIFY_API_SECRET) return "no-secret";
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
    .update((process.env.SHOPIFY_API_SECRET as string) + "\0admin-cookie\0" + pw, "utf-8")
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
  // same-origin (not no-referrer): with no-referrer a browser sends `Origin: null` on a
  // native form POST (page not hydrated yet), which the strict destructive-intent check
  // must refuse. same-origin keeps the real Origin on same-origin requests and sends no
  // referrer cross-origin.
  "Referrer-Policy": "same-origin",
};

/**
 * The admin page, normalised the way React Router matches it: case-insensitive,
 * trailing slashes ignored. Data requests (/admin.data) never reach the
 * document handler, so they are deliberately not listed.
 */
export function isAdminPath(pathname: string): boolean {
  return pathname.toLowerCase().replace(/\/+$/, "") === "/admin";
}

/**
 * Document headers of the app. The embedded-app additions (frame-ancestors for
 * the shop, SAMEORIGIN, strict-origin referrer) must never touch /admin, whose
 * route headers forbid framing. `addEmbeddedHeaders` is Shopify's helper.
 * `matchedAdmin` says the router matched the admin route (authoritative); the
 * normalised path is the fallback.
 */
export function applyDocumentSecurityHeaders(
  request: Request,
  responseHeaders: Headers,
  addEmbeddedHeaders: (request: Request, headers: Headers) => void,
  production: boolean,
  matchedAdmin = false,
): void {
  const admin = matchedAdmin || isAdminPath(new URL(request.url).pathname);
  if (admin) {
    // Also set here, so an /admin document that fails in root's loader or
    // boundary (where the route's headers() is not consulted) stays unframeable.
    for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) responseHeaders.set(k, v);
    responseHeaders.set("Cache-Control", "no-store");
  } else {
    addEmbeddedHeaders(request, responseHeaders);
    responseHeaders.set("X-Frame-Options", "SAMEORIGIN");
    responseHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (production) {
    responseHeaders.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
}

/**
 * Same-origin guard for the admin's state-changing actions that go beyond the
 * SameSite=Lax cookie: a browser tells us where the request came from
 * (`Sec-Fetch-Site`, else `Origin`). A request that names a foreign origin is
 * refused; one that names none (a non-browser client with a valid cookie) passes,
 * because it cannot be a cross-site form post.
 */
export function isSameOriginAdminRequest(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    const hosts = [new URL(request.url).host, request.headers.get("X-Forwarded-Host"), request.headers.get("Host")];
    return hosts.some((h) => !!h && h === new URL(origin).host);
  } catch {
    return false;
  }
}

/**
 * Strict variant for the DESTRUCTIVE intents (delete-shop, mark-uninstalled).
 * SameSite=Lax alone is not enough on a custom domain: a sibling subdomain is
 * "same-site" and its form post carries the cookie. So here a request must
 * NAME its origin, and that origin must be the app's own: the host of
 * SHOPIFY_APP_URL, or the host the browser used to reach us (Host /
 * X-Forwarded-Host / request URL). A missing, `null` or foreign Origin is
 * refused; a `Sec-Fetch-Site` that is present must say same-origin. Other
 * admin intents keep the lenient `isSameOriginAdminRequest`.
 */
export function isNullOriginAdminRequest(request: Request): boolean {
  return request.headers.get("Origin")?.trim().toLowerCase() === "null";
}

/** The German refusal text for the destructive intents (null Origin gets a hint to reload). */
export function strictOriginRefusalMessage(request: Request): string {
  return isNullOriginAdminRequest(request)
    ? "Seite neu laden und nochmals versuchen."
    : "Anfrage von fremdem Ursprung abgelehnt.";
}

export function isStrictSameOriginAdminRequest(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (!originHost) return false;
  const own = new Set<string>();
  const add = (h: string | null | undefined) => {
    if (h) own.add(h.trim().toLowerCase());
  };
  try {
    add(new URL(request.url).host);
  } catch {
    /* ignore */
  }
  add(request.headers.get("X-Forwarded-Host")?.split(",")[0]);
  add(request.headers.get("Host"));
  const appUrl = process.env.SHOPIFY_APP_URL?.trim();
  if (appUrl) {
    try {
      add(new URL(appUrl).host);
    } catch {
      /* ignore */
    }
  }
  return own.has(originHost.toLowerCase());
}
