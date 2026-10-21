/**
 * Background access to the Admin API with a token that may EXPIRE.
 *
 * Shopify is moving apps to expiring offline access tokens (~1h, plus a
 * rotating refresh token). The library refreshes a token in exactly one place:
 * when a context is CREATED (`unauthenticated.admin(shop)`, `authenticate.*`).
 * Everything that keeps a client or a raw token past that moment — a scheduler
 * closure, a detached task that outlives its request, a raw-fetch helper that
 * read the token once — starts failing with 401 an hour later.
 *
 * So the rule is: background code never keeps a token, it keeps a SHOP and asks
 * this module per call.
 *
 * - `getOfflineAdmin(shop)` — the offline session + library admin client, via
 *   `unauthenticated.admin(shop)` (which loads the session from storage and
 *   refreshes it when it is within 5 minutes of expiry). Cached in-process for
 *   a short TTL so a loop of hundreds of calls does not cost hundreds of
 *   session reads, and SINGLE-FLIGHT per shop: concurrent callers share one
 *   acquisition, so they cannot race one rotating refresh token against each
 *   other (the second refresh with an already-rotated token is refused).
 * - `createRefreshingAdmin(shop)` — an `AdminApiContext`-shaped client whose
 *   `graphql()` asks `getOfflineAdmin` per call and retries ONCE on a 401 after
 *   a forced reload (a token another instance refreshed, or a migration that
 *   revoked the old one, is then picked up from storage).
 * - `backgroundAdmin(shop, captured)` — what long-running code should hold:
 *   the refreshing client while expiring tokens are on, the captured request
 *   client otherwise (byte-for-byte the old behaviour with the flag off).
 * - `getOfflineAccessToken(shop)` — the raw token for the few raw-fetch callers
 *   (cookie banner, the root-JS workers through `globalThis.__getShopAccessToken`).
 * - `maybeMigrateToExpiringToken(shop)` — the lazy, double-gated migration of a
 *   shop's NON-expiring offline token. Never throws.
 *
 * Residuals, stated: the single-flight is per PROCESS — two instances can still
 * refresh the same shop at once, and the loser's refresh is refused; we then
 * re-read storage once after a short pause (the winner has stored its rotated
 * token by then, usually). The library's OWN refresh paths (webhook / app proxy
 * authentication, `authenticate.admin`'s token exchange) do not go through
 * this single-flight.
 *
 * `shopify.server.ts` injects the library functions through
 * `configureOfflineAdmin` at boot. This module never imports it statically, so
 * the scheduler and the task runners can import it in unit tests without the
 * whole app config (ENCRYPTION_KEY & co.).
 */

import type { Session } from "@shopify/shopify-api";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { logger } from "./logger.server";
import { expiringOfflineTokensEnabled, migrateToExpiringTokensEnabled } from "./offline-token-flags.server";

export interface OfflineAdminContext {
  session: Session;
  admin: AdminApiContext;
}

export interface OfflineAdminDeps {
  /** `shopify.unauthenticated.admin` — loads and (if needed) refreshes the offline session. */
  unauthenticatedAdmin: (shop: string) => Promise<OfflineAdminContext>;
  /** The stored offline session WITHOUT any refresh (migration needs the raw one). */
  loadOfflineSession: (shop: string) => Promise<Session | undefined>;
  storeSession: (session: Session) => Promise<boolean>;
  /** `api.auth.migrateToExpiringToken` of @shopify/shopify-api. */
  migrateToExpiringToken: (params: {
    shop: string;
    nonExpiringOfflineAccessToken: string;
  }) => Promise<{ session: Session }>;
}

let deps: OfflineAdminDeps | null = null;

export function configureOfflineAdmin(next: OfflineAdminDeps): void {
  deps = next;
}

async function resolveDeps(): Promise<OfflineAdminDeps> {
  if (deps) return deps;
  // shopify.server configures this module as a side effect of loading.
  await import("../shopify.server");
  if (!deps) {
    throw new Error("[OfflineAdmin] not configured — shopify.server did not call configureOfflineAdmin");
  }
  return deps;
}

/** The library refreshes a token this close to its expiry (ensure-offline-token-is-not-expired). */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** How long an acquired context is reused before storage is asked again. */
export const CACHE_TTL_MS = 60 * 1000;
/** Pause before the one re-read after a failed acquisition (another instance may be rotating). */
export const ACQUIRE_RETRY_DELAY_MS = 750;

export class OfflineAdminUnavailableError extends Error {
  readonly code = "OFFLINE_ADMIN_UNAVAILABLE";
  constructor(
    readonly shop: string,
    readonly reason: "no_session" | "refresh_failed" | "no_token",
    message: string,
  ) {
    super(message);
    this.name = "OfflineAdminUnavailableError";
  }
}

const cache = new Map<string, { ctx: OfflineAdminContext; loadedAt: number }>();
const inflight = new Map<string, Promise<OfflineAdminContext>>();

function cacheIsFresh(entry: { ctx: OfflineAdminContext; loadedAt: number } | undefined): boolean {
  if (!entry) return false;
  if (Date.now() - entry.loadedAt > CACHE_TTL_MS) return false;
  const expires = entry.ctx.session.expires;
  // An expiring token close to its end goes back through the library, which
  // refreshes it; a non-expiring one (no `expires`) is only bounded by the TTL.
  if (expires && expires.getTime() - REFRESH_MARGIN_MS < Date.now()) return false;
  return true;
}

/** Drop the cached context (after a 401, a migration, a reinstall). */
export function invalidateOfflineAdmin(shop: string): void {
  cache.delete(shop);
}

/** Test seam. */
export function __resetOfflineAdminForTests(): void {
  cache.clear();
  inflight.clear();
  migrationsInFlight.clear();
  migrationBackoff.clear();
  deps = null;
}

function describe(error: unknown): string {
  if (error instanceof Response) return `HTTP ${error.status} ${error.statusText}`.trim();
  if (error instanceof Error) return error.message;
  return String(error);
}

function isSessionNotFound(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    ((error as { name?: string }).name === "SessionNotFoundError" ||
      /could not find a session/i.test((error as { message?: string }).message ?? ""))
  );
}

async function acquireOnce(shop: string): Promise<OfflineAdminContext> {
  const { unauthenticatedAdmin } = await resolveDeps();
  try {
    const ctx = await unauthenticatedAdmin(shop);
    if (!ctx?.session?.accessToken) {
      throw new OfflineAdminUnavailableError(shop, "no_token", `Offline session for ${shop} has no access token`);
    }
    return ctx;
  } catch (error) {
    if (error instanceof OfflineAdminUnavailableError) throw error;
    if (isSessionNotFound(error)) {
      throw new OfflineAdminUnavailableError(shop, "no_session", `No offline session found for shop: ${shop}`);
    }
    // Everything else from the library here is the REFRESH failing: a thrown
    // 500 Response, or Shopify refusing the refresh token (`invalid_subject_token`).
    throw new OfflineAdminUnavailableError(
      shop,
      "refresh_failed",
      `Offline token for ${shop} could not be refreshed: ${describe(error)}`,
    );
  }
}

/**
 * The offline session + admin client for `shop`, refreshed if needed.
 * Throws `OfflineAdminUnavailableError` — never a raw `Response`.
 */
export async function getOfflineAdmin(
  shop: string,
  options: { forceReload?: boolean } = {},
): Promise<OfflineAdminContext> {
  if (!options.forceReload) {
    const cached = cache.get(shop);
    if (cacheIsFresh(cached)) return cached!.ctx;
  }
  const running = inflight.get(shop);
  if (running) return running;

  const promise = (async () => {
    let ctx: OfflineAdminContext;
    try {
      ctx = await acquireOnce(shop);
    } catch (error) {
      if (!(error instanceof OfflineAdminUnavailableError) || error.reason !== "refresh_failed") {
        cache.delete(shop);
        throw error;
      }
      // A rotated refresh token is single-use. If another instance (or a
      // library path outside this single-flight) refreshed first, ours was
      // refused — but the winner has stored the new session, so one more read
      // of storage usually finds a valid token without refreshing at all.
      logger.warn("[OfflineAdmin] Token refresh failed, re-reading the stored session once", {
        shop,
        error: error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, ACQUIRE_RETRY_DELAY_MS));
      try {
        ctx = await acquireOnce(shop);
      } catch (second) {
        cache.delete(shop);
        logger.error("[OfflineAdmin] Offline token unavailable — the shop must open the app to re-authenticate", {
          shop,
          error: describe(second),
        });
        throw second;
      }
    }
    cache.set(shop, { ctx, loadedAt: Date.now() });
    return ctx;
  })().finally(() => {
    if (inflight.get(shop) === promise) inflight.delete(shop);
  });
  inflight.set(shop, promise);
  return promise;
}

/** The raw offline access token — for the few raw-fetch callers. */
export async function getOfflineAccessToken(shop: string): Promise<string> {
  const { session } = await getOfflineAdmin(shop);
  return session.accessToken!;
}

/**
 * Is this a 401 from Shopify? Covers the library's `HttpResponseError`
 * (`response.code`), a thrown `Response`, and a plain `{ status }`. Matched by
 * shape, not by class: two copies of @shopify/shopify-api can coexist in the
 * bundle and `instanceof` would miss one.
 */
export function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof Response) return error.status === 401;
  const e = error as { response?: { code?: number; status?: number }; status?: number };
  return e.response?.code === 401 || e.response?.status === 401 || e.status === 401;
}

/**
 * An `AdminApiContext` that never holds a token: every `graphql()` asks
 * `getOfflineAdmin` (cheap while cached) and retries once on a 401 after a
 * forced reload.
 */
export function createRefreshingAdmin(shop: string): AdminApiContext {
  const graphql = async (query: unknown, options?: unknown) => {
    const { admin } = await getOfflineAdmin(shop);
    try {
      return await (admin.graphql as (q: unknown, o?: unknown) => Promise<unknown>)(query, options);
    } catch (error) {
      if (!isUnauthorizedError(error)) throw error;
      logger.warn("[OfflineAdmin] 401 from Shopify — reloading the offline session and retrying once", { shop });
      invalidateOfflineAdmin(shop);
      const { admin: fresh } = await getOfflineAdmin(shop, { forceReload: true });
      return (fresh.graphql as (q: unknown, o?: unknown) => Promise<unknown>)(query, options);
    }
  };
  return { graphql } as unknown as AdminApiContext;
}

/**
 * What code that OUTLIVES its request should hold. With expiring tokens on,
 * the refreshing client; with them off, the captured client exactly as before.
 */
export function backgroundAdmin<T>(shop: string, captured: T): T {
  if (!expiringOfflineTokensEnabled()) return captured;
  return createRefreshingAdmin(shop) as unknown as T;
}

// ---------------------------------------------------------------------------
// Root-JS workers (webp-processor, stale-image-cleanup) live outside the
// bundle's module graph and cannot import this file. They reach it through a
// process-wide hook, the same way server.js reaches `globalThis.__aiQueue`.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __getShopAccessToken: ((shop: string) => Promise<string>) | undefined;
}

export function registerShopAccessTokenHook(): void {
  globalThis.__getShopAccessToken = (shop: string) => getOfflineAccessToken(shop);
}

// ---------------------------------------------------------------------------
// Lazy migration of a NON-expiring offline token
// ---------------------------------------------------------------------------

export type MigrationOutcome =
  | "disabled"
  | "not_needed"
  | "no_session"
  | "backoff"
  | "migrated"
  | "failed";

const migrationsInFlight = new Map<string, Promise<MigrationOutcome>>();
const migrationBackoff = new Map<string, number>();
/** After a failed migration the shop is not tried again for this long. */
export const MIGRATION_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Exchange `shop`'s non-expiring offline token for an expiring one, once.
 * Gated on BOTH env switches (default: nothing happens). Single-flight per
 * shop, backed off after a failure, and it never throws — callers fire it from
 * a request path that must not fail over it.
 *
 * Shopify revokes the old token on migration (documented; not measured here),
 * so a client still holding it gets a 401: the refreshing clients reload and
 * retry; a client captured inside a running request does not (residual).
 */
export async function maybeMigrateToExpiringToken(shop: string): Promise<MigrationOutcome> {
  if (!migrateToExpiringTokensEnabled()) return "disabled";
  const running = migrationsInFlight.get(shop);
  if (running) return running;
  const failedAt = migrationBackoff.get(shop);
  if (failedAt !== undefined && Date.now() - failedAt < MIGRATION_BACKOFF_MS) return "backoff";

  const promise = (async (): Promise<MigrationOutcome> => {
    try {
      const d = await resolveDeps();
      const current = await d.loadOfflineSession(shop);
      if (!current?.accessToken) return "no_session";
      if (current.expires) return "not_needed";

      const { session } = await d.migrateToExpiringToken({
        shop,
        nonExpiringOfflineAccessToken: current.accessToken,
      });
      if (!session?.accessToken || !session.expires) {
        // Without an expiry the exchange did not give us what we asked for;
        // storing it would only overwrite a working token with an unknown one.
        migrationBackoff.set(shop, Date.now());
        logger.error("[OfflineAdmin] Token migration returned no expiring token — kept the stored one", { shop });
        return "failed";
      }
      const stored = await d.storeSession(session);
      if (!stored) {
        migrationBackoff.set(shop, Date.now());
        // The old token is likely revoked by now: say so loudly, the shop will
        // need to open the app once (token exchange recreates the session).
        logger.error("[OfflineAdmin] Token migrated on Shopify but NOT stored — the shop must re-open the app", { shop });
        return "failed";
      }
      invalidateOfflineAdmin(shop);
      migrationBackoff.delete(shop);
      logger.info("[OfflineAdmin] Migrated offline token to an expiring one", {
        shop,
        expires: session.expires.toISOString(),
        hasRefreshToken: !!session.refreshToken,
      });
      return "migrated";
    } catch (error) {
      migrationBackoff.set(shop, Date.now());
      logger.error("[OfflineAdmin] Token migration failed — will retry after backoff", {
        shop,
        error: describe(error),
      });
      return "failed";
    }
  })().finally(() => {
    if (migrationsInFlight.get(shop) === promise) migrationsInFlight.delete(shop);
  });
  migrationsInFlight.set(shop, promise);
  return promise;
}
