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
 *   acquisition, so they do not fire several refreshes at once. (Shopify does
 *   NOT invalidate a refresh token the moment it is used — every refresh
 *   returns a NEW access + refresh pair, the presented refresh token stays
 *   usable until the app uses the newer one, a new token acquisition happens,
 *   30 days after its first use, or its 90-day expiry. The conflict that is
 *   real is ACQUIRING a token (token exchange) and REFRESHING at the same time
 *   for one store: each retires the other's result.) After a refresh that
 *   failed for good the shop is remembered as failed for `REFRESH_FAILED_TTL_MS`,
 *   so a loop of callers fails fast instead of asking Shopify on every call.
 * - `createRefreshingAdmin(shop)` — an `AdminApiContext`-shaped client whose
 *   `graphql()` asks `getOfflineAdmin` per call and retries ONCE on a 401 after
 *   a forced reload (a token another instance refreshed, or a migration that
 *   revoked the old one, is then picked up from storage).
 * - `backgroundAdmin(shop, captured)` — what long-running code should hold:
 *   the refreshing client while expiring tokens are on, the captured request
 *   client otherwise (byte-for-byte the old behaviour with the flag off).
 * - `getOfflineAccessToken(shop)` — the raw token for the few raw-fetch callers
 *   (cookie banner, the root-JS workers through `globalThis.__getShopAccessToken`).
 * - `maybeMigrateToExpiringToken(shop)` — the double-gated migration of a
 *   shop's NON-expiring offline token, fired from the background only (see its
 *   comment for why never from a request): from the sync scheduler's cycle for
 *   shops that are being used, and from the offline-token sweep
 *   (services/offline-token-sweep.service.ts) for shops that never open the app.
 *   Durable and recoverable (offline-token-migration-store.server.ts). Never
 *   throws.
 *
 * Residuals, stated: the single-flight is per PROCESS — two instances can still
 * refresh the same shop at once; a refresh that Shopify refuses is retried
 * once after a short pause and a re-read of storage (the other instance has
 * stored its pair by then, usually). The library's OWN refresh paths (webhook /
 * app proxy authentication, `authenticate.admin`'s token exchange) do not go
 * through this single-flight.
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
import * as migrationStore from "./offline-token-migration-store.server";

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
/**
 * After the final `refresh_failed` of a shop, callers fail fast for this long
 * instead of asking Shopify again (a loop of 200 calls would otherwise be 200
 * refresh attempts, each with its own re-read pause). Cleared by
 * `invalidateOfflineAdmin` and by every successful store of a new session
 * (afterAuth, a finished migration).
 */
export const REFRESH_FAILED_TTL_MS = 60 * 1000;

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
/** Shops whose refresh just failed for good: when, and the error callers get. */
const refreshFailed = new Map<string, { at: number; error: OfflineAdminUnavailableError }>();

function cacheIsFresh(entry: { ctx: OfflineAdminContext; loadedAt: number } | undefined): boolean {
  if (!entry) return false;
  if (Date.now() - entry.loadedAt > CACHE_TTL_MS) return false;
  const expires = entry.ctx.session.expires;
  // An expiring token close to its end goes back through the library, which
  // refreshes it; a non-expiring one (no `expires`) is only bounded by the TTL.
  if (expires && expires.getTime() - REFRESH_MARGIN_MS < Date.now()) return false;
  return true;
}

/** Bumped by every invalidation; an acquisition caches only if none happened while it was out. */
const generation = new Map<string, number>();

/**
 * Drop the cached context (after a 401, a migration, a reinstall, an
 * uninstall). An acquisition still in flight keeps answering the callers
 * already waiting on it (single-flight is not broken), but what it read can no
 * longer land in the cache — it may predate the event that invalidated it.
 */
export function invalidateOfflineAdmin(shop: string): void {
  cache.delete(shop);
  refreshFailed.delete(shop);
  generation.set(shop, (generation.get(shop) ?? 0) + 1);
}

/** Test seam. */
export function __resetOfflineAdminForTests(): void {
  cache.clear();
  inflight.clear();
  refreshFailed.clear();
  generation.clear();
  migrationsInFlight.clear();
  migrationBackoff.clear();
  migrationSettled.clear();
  migrationNeedsReauth.clear();
  migrationHeldUntil = 0;
  nonExpiringRejectionLoggedAt.clear();
  healAttemptedAt.clear();
  rearmedOnce.clear();
  reissueEpoch.clear();
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
    // The library only refreshes a session that CARRIES a refresh token; an
    // expired one without it comes back as it is. Sending it would be a 401
    // that reads like a revoked install, so it is reported as what it is.
    const expires = ctx.session.expires;
    if (expires && expires.getTime() <= Date.now()) {
      throw new OfflineAdminUnavailableError(
        shop,
        "refresh_failed",
        `Offline token for ${shop} has expired and could not be refreshed (no refresh token)`,
      );
    }
    return ctx;
  } catch (error) {
    if (error instanceof OfflineAdminUnavailableError) throw error;
    if (isSessionNotFound(error)) {
      throw new OfflineAdminUnavailableError(shop, "no_session", `No offline session found for shop: ${shop}`);
    }
    // Everything else from the library here is the REFRESH failing. Shopify
    // answers a refresh it refuses with 401 `{"error":"invalid_request"}`
    // (re-authentication needed), but the library's refresh helper turns every
    // failure except 400 `invalid_subject_token` into a bare `Response` with
    // HTTP 500 — so a 500 here does NOT mean Shopify had a server error; the
    // original status is gone. (A 400 `invalid_subject_token` comes through as
    // such.)
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
  options: { forceReload?: boolean; refusedToken?: string } = {},
): Promise<OfflineAdminContext> {
  if (!options.forceReload) {
    const cached = cache.get(shop);
    if (cacheIsFresh(cached)) return cached!.ctx;
    const running = inflight.get(shop);
    if (running) return running;
    return startAcquisition(shop);
  }
  // A forced reload follows a 401: an acquisition already in flight may have
  // read storage BEFORE that 401 (and so hand back the very token that was just
  // refused). Let it settle, then join or start one that began AFTER it —
  // still single-flight: every forced caller waiting on the same old
  // acquisition joins the one fresh acquisition the first of them starts.
  //
  // With `refusedToken` (the token the 401 answered), a running acquisition is
  // judged by what it RETURNS instead of when it started: one that hands back a
  // DIFFERENT token is newer than the refusal and is used as it is — so a
  // second wave of 401s, arriving while the first wave's fresh acquisition is
  // still out, joins it rather than reading storage once more.
  const running = inflight.get(shop);
  if (running) {
    const result = await running.catch(() => undefined);
    if (
      options.refusedToken !== undefined &&
      result?.session.accessToken &&
      result.session.accessToken !== options.refusedToken
    ) {
      return result;
    }
    const next = inflight.get(shop);
    if (next && next !== running) return next;
  }
  cache.delete(shop);
  return startAcquisition(shop);
}

/**
 * Is a failed acquisition really a refused REFRESH of an expiring session? Only
 * then is failing fast for a minute right. The same `refresh_failed` reason also
 * covers any other error the library threw while loading (a database or pool
 * error on a deployment that does not use expiring tokens at all): remembering
 * that would change behaviour with the switches off, so the negative cache is
 * gated on the switch AND on the stored session actually carrying `expires` or
 * a refresh token. A failing lookup counts as "no".
 */
async function refreshWasReallyRefused(shop: string): Promise<boolean> {
  if (!expiringOfflineTokensEnabled()) return false;
  try {
    const stored = await (await resolveDeps()).loadOfflineSession(shop);
    return !!stored && (!!stored.expires || !!stored.refreshToken);
  } catch {
    return false;
  }
}

function startAcquisition(shop: string): Promise<OfflineAdminContext> {
  const failedBefore = refreshFailed.get(shop);
  if (failedBefore) {
    if (Date.now() - failedBefore.at < REFRESH_FAILED_TTL_MS) return Promise.reject(failedBefore.error);
    refreshFailed.delete(shop);
  }
  const startedGeneration = generation.get(shop) ?? 0;
  const promise: Promise<OfflineAdminContext> = (async () => {
    let ctx: OfflineAdminContext;
    try {
      ctx = await acquireOnce(shop);
    } catch (error) {
      if (!(error instanceof OfflineAdminUnavailableError) || error.reason !== "refresh_failed") {
        cache.delete(shop);
        throw error;
      }
      // Shopify does not retire a refresh token the moment it is used, but a
      // refresh and a token acquisition (token exchange) for the same store
      // retire each other's result. If another instance (or a library path
      // outside this single-flight) got in between, ours may have been refused
      // — and whoever won has stored its session, so one more read of storage
      // usually finds a valid token without refreshing at all.
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
        // Only if no invalidation (re-auth, uninstall) landed meanwhile: the
        // failure may predate the event that cleared it.
        if (
          second instanceof OfflineAdminUnavailableError &&
          second.reason === "refresh_failed" &&
          (await refreshWasReallyRefused(shop)) &&
          (generation.get(shop) ?? 0) === startedGeneration
        ) {
          refreshFailed.set(shop, { at: Date.now(), error: second });
        }
        throw second;
      }
    }
    // An invalidation (uninstall, reinstall, 401) that landed while this
    // acquisition was out must not be undone by caching what it read before.
    if ((generation.get(shop) ?? 0) === startedGeneration) cache.set(shop, { ctx, loadedAt: Date.now() });
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

/** What Shopify answers an Admin API request made with a non-expiring offline token, from 2027-01-01. */
const NON_EXPIRING_REJECTED = /Non-expiring access tokens are no longer accepted/i;

function isForbiddenByShape(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof Response) return error.status === 403;
  const e = error as { response?: { code?: number; status?: number }; status?: number };
  return e.response?.code === 403 || e.response?.status === 403 || e.status === 403;
}

/**
 * Is this the 403 Shopify sends for a NON-expiring offline token after the
 * 2027-01-01 deadline ("Non-expiring access tokens are no longer accepted for
 * the Admin API.")? A 403 alone is not enough — a missing access scope is a 403
 * too — so the message is matched as well: in the error's message (the library's
 * `HttpResponseError` embeds the `errors` of the body there), in its parsed
 * `response.body` / `body`, and, for a thrown `Response`, in a CLONE of its body
 * (the original stays readable for whoever catches it next). Matched by shape,
 * like `isUnauthorizedError`. Never throws.
 */
export async function isNonExpiringTokenRejectedError(error: unknown): Promise<boolean> {
  if (!isForbiddenByShape(error)) return false;
  try {
    if (error instanceof Response) return NON_EXPIRING_REJECTED.test(await error.clone().text());
    const e = error as { message?: unknown; body?: unknown; errors?: unknown; response?: { body?: unknown } };
    const parts: unknown[] = [e.message, e.errors, e.body, e.response?.body];
    return parts.some((part) => {
      if (part === undefined || part === null) return false;
      return NON_EXPIRING_REJECTED.test(typeof part === "string" ? part : JSON.stringify(part));
    });
  } catch {
    return false;
  }
}

const nonExpiringRejectionLoggedAt = new Map<string, number>();
const healAttemptedAt = new Map<string, number>();
/** Terminal records already re-armed once by a deadline 403: `shop:fingerprint`. */
const rearmedOnce = new Set<string>();
/**
 * Bumped whenever a NEW offline session is issued for a shop or the shop is gone
 * (afterAuth, app/uninstalled — both call `forgetOfflineTokenMigration`, before
 * its switch gate). A migration run captures it at its start; a changed epoch
 * means a blank session it finds later may be a LATE 401's work on somebody
 * else's session, not the blank our own exchange caused — so it must not store.
 */
const reissueEpoch = new Map<string, number>();
/** The 403 warning is logged at most this often per shop (a loop of callers would repeat it per call). */
const NON_EXPIRING_REJECTION_LOG_INTERVAL_MS = 60 * 1000;

/**
 * A request got the "non-expiring tokens no longer accepted" 403: say so, and
 * start the migration if the switches allow it. Deliberately WITHOUT the quiet
 * gate of the scheduler / sweep: the old token is useless for the Admin API from
 * that moment on, so a request in flight on it cannot be made worse by the
 * migration, and waiting would only prolong the outage. It does NOT retry the request —
 * the same token would be refused again; the migration stores a new pair and the
 * NEXT call picks it up (`maybeMigrateToExpiringToken` invalidates the cache).
 * Never throws.
 */
export function reportNonExpiringTokenRejection(shop: string, refusedToken?: string): void {
  const lastLogged = nonExpiringRejectionLoggedAt.get(shop);
  if (lastLogged === undefined || Date.now() - lastLogged >= NON_EXPIRING_REJECTION_LOG_INTERVAL_MS) {
    nonExpiringRejectionLoggedAt.set(shop, Date.now());
    logger.warn(
      "[OfflineAdmin] Shopify refused a NON-expiring offline token (403, deadline 2027-01-01) — " +
        (migrateToExpiringTokensEnabled()
          ? "starting the migration to an expiring token"
          : "the migration switches are OFF, the shop will keep failing until it is migrated or re-authenticated"),
      { shop },
    );
  }
  if (!migrateToExpiringTokensEnabled()) return;
  void (async () => {
    try {
      const outcome = await maybeMigrateToExpiringToken(shop);
      // The heal step reads the database: throttled per shop like the log, so
      // a loop of 403s does not cost a read per call.
      const lastHeal = healAttemptedAt.get(shop);
      if (lastHeal === undefined || Date.now() - lastHeal >= NON_EXPIRING_REJECTION_LOG_INTERVAL_MS) {
        healAttemptedAt.set(shop, Date.now());
        await healIfMigrationCannotRun(shop, outcome, refusedToken);
      }
    } catch {
      /* never throws */
    }
  })();
}

/**
 * After the deadline the library never learns that the stored token is dead (a
 * 403 does not make it blank the session as a 401 does), so `authenticate.admin`
 * would never token-exchange and a shop that migration can no longer help would
 * stay broken even while its merchant is using the app. If NO migration can run
 * for the shop now — refused for good (needs_reauth), given up, the global config
 * hold, or a failed record past the 7-day recovery window — blank the refused
 * token ourselves (same drift check as the needs_reauth path: only if the stored
 * token is still the refused one), so the merchant's next request token-exchanges
 * an expiring pair. NOT while a migration can still succeed (transient backoff
 * inside the window): that one is left to run. The record is left as it is — it
 * stays the ops-visible fact; afterAuth deletes it when the exchange happens.
 */
async function healIfMigrationCannotRun(shop: string, outcome: MigrationOutcome, refusedToken?: string): Promise<void> {
  // Only a DURABLE verdict about THIS token justifies erasing the only copy of
  // it: a needs_reauth or given-up record whose fingerprint (if it has one)
  // matches the refused token. NOT the global config hold (a held shop is never
  // touched: after the fix + restart it must still be migratable), NOT a shop
  // without a record, NOT a failed record past the 7-day window while the
  // session still holds the token (the next run's exchange decides, and its
  // permanent-refusal path blanks by itself).
  if (outcome === "disabled" || Date.now() < migrationHeldUntil) return;
  const epoch = reissueEpoch.get(shop) ?? 0;
  const record = await migrationStore.getMigrationRecord(shop).catch(() => null);
  if (!record) return;
  const terminal = migrationStore.isTerminal(record);
  if (record.status !== "needs_reauth" && !terminal) return;
  const d = await resolveDeps();
  const current = await d.loadOfflineSession(shop);
  if (!current || current.expires || !current.accessToken) return;
  if (refusedToken !== undefined && current.accessToken !== refusedToken) return;
  const fingerprint = migrationStore.fingerprintToken(current.accessToken);
  if (record.tokenFingerprint && fingerprint !== record.tokenFingerprint) return;

  if (terminal) {
    // A 403 (not a 401) is Shopify saying the token is NOT revoked — only no
    // longer accepted for the Admin API — so it can still be migrated, and the
    // session holds the LAST copy (the ciphertext was erased at the cap).
    // Blanking it would end every chance of an automatic migration. Re-arm
    // exactly ONE run per token and process instead; the heal throttle spaces
    // out the checks, `rearmedOnce` makes it one.
    const key = `${shop}:${fingerprint}`;
    if (rearmedOnce.has(key)) return;
    rearmedOnce.add(key);
    await migrationStore.rearmTerminal(shop);
    migrationBackoff.delete(shop);
    logger.warn(
      "[OfflineAdmin] Deadline 403 on a given-up migration: the token is not revoked, so ONE more migration run is allowed",
      { shop },
    );
    await maybeMigrateToExpiringToken(shop);
    return;
  }
  if (await clearDeadSessionToken(d, shop, current, current.accessToken, epoch)) {
    logger.warn(
      "[OfflineAdmin] Blanked the refused non-expiring token (needs_reauth): the merchant's next request token-exchanges an expiring pair",
      { shop },
    );
  }
}

/**
 * An `AdminApiContext` that never holds a token: every `graphql()` asks
 * `getOfflineAdmin` (cheap while cached) and retries once on a 401 after a
 * forced reload. A 403 "non-expiring tokens are no longer accepted" is NOT
 * retried (same token, same answer): it starts the migration and rethrows.
 */
export function createRefreshingAdmin(shop: string): AdminApiContext {
  const graphql = async (query: unknown, options?: unknown) => {
    const { admin, session } = await getOfflineAdmin(shop);
    try {
      return await (admin.graphql as (q: unknown, o?: unknown) => Promise<unknown>)(query, options);
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        if (await isNonExpiringTokenRejectedError(error)) reportNonExpiringTokenRejection(shop, session.accessToken);
        throw error;
      }
      logger.warn("[OfflineAdmin] 401 from Shopify — reloading the offline session and retrying once", { shop });
      invalidateOfflineAdmin(shop);
      const { admin: fresh } = await getOfflineAdmin(shop, {
        forceReload: true,
        refusedToken: session.accessToken,
      });
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
  // A raw client from admin-client.server.ts already asks for a fresh token per
  // call, and its callers rely on its RAW contract (the HTTP-200 body returned
  // as-is, GraphQL `errors` included). Swapping it for the library client would
  // turn those `errors` into thrown GraphqlQueryErrors — so it stays as it is.
  if (isSelfRefreshingAdminClient(captured)) return captured;
  return createRefreshingAdmin(shop) as unknown as T;
}

/**
 * Marks a client that re-acquires its token on every call by itself (the raw
 * clients of admin-client.server.ts). `backgroundAdmin` returns such a client
 * unchanged. A `Symbol.for` key, so two bundled copies of this module agree.
 */
export const SELF_REFRESHING_ADMIN = Symbol.for("contentpilot.selfRefreshingAdminClient");

export function markSelfRefreshingAdminClient<T extends object>(client: T): T {
  Object.defineProperty(client, SELF_REFRESHING_ADMIN, { value: true, enumerable: false });
  return client;
}

export function isSelfRefreshingAdminClient(client: unknown): boolean {
  return (
    !!client &&
    typeof client === "object" &&
    (client as Record<symbol, unknown>)[SELF_REFRESHING_ADMIN] === true
  );
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
// Migration of a NON-expiring offline token
// ---------------------------------------------------------------------------

export type MigrationOutcome =
  | "disabled"
  | "not_needed"
  | "no_session"
  | "backoff"
  | "migrated"
  | "needs_reauth"
  | "failed";

const migrationsInFlight = new Map<string, Promise<MigrationOutcome>>();
const migrationBackoff = new Map<string, number>();
/** Shops known to hold an expiring token already — not asked again this process. */
const migrationSettled = new Set<string>();
/**
 * Shops Shopify refused PERMANENTLY (400 invalid_subject_token; NOT
 * invalid_requested_token_type, which is a global config error): no automatic
 * retry from the scheduler or the sweep. Mirrors the durable `needs_reauth` record, so the check stays
 * synchronous. Cleared when the shop gets a new token (`forgetOfflineTokenMigration`).
 */
const migrationNeedsReauth = new Set<string>();
/**
 * After the prompt retries of one migration ran out, the shop is not tried
 * again for this long. Short on purpose: the exchange may already have
 * succeeded on Shopify's side (old token revoked) while only our store failed,
 * and the persisted old token keeps the 7-day recovery open — waiting an hour
 * would only mean an hour of failing background calls. The durable record, not
 * this timer, is what protects against the recovery window running out.
 */
export const MIGRATION_BACKOFF_MS = 10 * 60 * 1000;
/**
 * Pauses between the prompt retries of ONE migration run (so up to
 * `length + 1` exchanges within ~22 s) for transient failures: network error,
 * 5xx, 429, a body without the expiring token, `storeSession()` returning false.
 */
export const MIGRATION_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];
/** Exchange attempts in one run (the first plus one per retry delay). */
const attemptsPerRun = () => MIGRATION_RETRY_DELAYS_MS.length + 1;
/**
 * 400 `invalid_requested_token_type` says OUR request is wrong (client id /
 * secret, token type, API version), not that one shop is lost — it would flip
 * every shop. So it is a global configuration error: no shop is marked, no token
 * is erased, and NO shop is tried for this long (a fix + restart retries at once,
 * the hold is in-process).
 */
export const MIGRATION_CONFIG_ERROR_HOLD_MS = 6 * 60 * 60 * 1000;
let migrationHeldUntil = 0;

/**
 * Could `maybeMigrateToExpiringToken(shop)` do anything right now? Cheap and
 * synchronous: lets the scheduler skip its activity lookup for a shop that is
 * already migrated, backed off, being migrated, refused for good, or with the
 * switches off.
 */
export function migrationMayBeNeeded(shop: string): boolean {
  if (!migrateToExpiringTokensEnabled()) return false;
  if (Date.now() < migrationHeldUntil) return false;
  if (migrationSettled.has(shop)) return false;
  if (migrationNeedsReauth.has(shop)) return false;
  if (migrationsInFlight.has(shop)) return false;
  const failedAt = migrationBackoff.get(shop);
  if (failedAt !== undefined && Date.now() - failedAt < MIGRATION_BACKOFF_MS) return false;
  return true;
}

/**
 * A new offline session was just issued for `shop` (afterAuth after a token
 * exchange or install) or the shop is gone (app/uninstalled). Either way a
 * pending migration is moot — a new token acquisition ends Shopify's 7-day
 * recovery window, and an uninstalled shop has nothing to recover — and the
 * durable record holds a credential that must not outlive its use. Drops the
 * in-process migration state (so a `needs_reauth` shop is eligible again) and
 * deletes the record.
 *
 * Gated on the expiring-tokens switch by default, so a request path (afterAuth)
 * touches nothing with the switches off. `force` skips the gate: the uninstall
 * webhook passes it, because after a ROLLBACK (switches turned off again) an
 * unfinished record with its encrypted token may still exist, and one cheap
 * delete on an uninstall is the price of not leaving a credential behind. Never
 * throws.
 */
export async function forgetOfflineTokenMigration(shop: string, options: { force?: boolean } = {}): Promise<void> {
  // Before the gate: the epoch is in-memory bookkeeping for races, not behaviour.
  reissueEpoch.set(shop, (reissueEpoch.get(shop) ?? 0) + 1);
  if (!options.force && !expiringOfflineTokensEnabled()) return;
  migrationNeedsReauth.delete(shop);
  migrationBackoff.delete(shop);
  try {
    await migrationStore.deleteMigrationRecord(shop);
  } catch (error) {
    logger.warn("[OfflineAdmin] Could not delete the token-migration record", { shop, error: describe(error) });
  }
}

/** The error code Shopify's token endpoint put into a failed response body, if readable. */
function exchangeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { response?: { body?: unknown }; body?: unknown };
  const body = e.response?.body ?? e.body;
  if (body && typeof body === "object") {
    const code = (body as { error?: unknown }).error;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function exchangeStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { response?: { code?: number; status?: number }; status?: number };
  return e.response?.code ?? e.response?.status ?? e.status;
}

/**
 * Is this migration failure PERMANENT FOR THE SHOP? Shopify documents 400
 * `invalid_subject_token` as final: the old token is not one it can exchange
 * (already migrated and past the 7-day recovery, or revoked), the shop needs a
 * new token through an ID-token exchange (merchant opens the app) or OAuth, and
 * repeating the request changes nothing.
 */
export function isPermanentMigrationError(error: unknown): boolean {
  if (exchangeErrorCode(error) !== "invalid_subject_token") return false;
  const status = exchangeStatus(error);
  return status === undefined || status === 400;
}

/**
 * Token-endpoint answers that are about OUR request, not about the shop — see
 * `MIGRATION_CONFIG_ERROR_HOLD_MS`: 400 `invalid_requested_token_type` (also
 * documented as permanent), and `invalid_client` (400 or 401: wrong client id /
 * secret). Every other 4xx stays a transient, per-shop failure.
 */
export function isMigrationConfigError(error: unknown): boolean {
  const code = exchangeErrorCode(error);
  const status = exchangeStatus(error);
  if (code === "invalid_requested_token_type") return status === undefined || status === 400;
  if (code === "invalid_client") return status === undefined || status === 400 || status === 401;
  return false;
}

/** `name` and Prisma `code` only: a Prisma message can echo the query arguments, i.e. the ciphertext. */
function safeDbErrorLabel(error: unknown): string {
  const e = error as { name?: string; code?: string } | null;
  return `${e?.name ?? "Error"}${e?.code ? ` ${e.code}` : ""}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exchange `shop`'s non-expiring offline token for an expiring one, once.
 * Gated on BOTH env switches (default: nothing happens). Single-flight per
 * shop and it never throws — callers fire it from paths that must not fail
 * over it.
 *
 * Shopify revokes the old token on migration (documented: immediately, no
 * grace period), so a client still holding it gets a 401: the refreshing
 * clients reload and retry.
 *
 * DURABLE AND RECOVERABLE. The old token is written to `OfflineTokenMigration`,
 * ENCRYPTED, BEFORE the exchange. Since 2026-09-29 Shopify answers a repeat of
 * the same exchange with the same old token within 7 days with the SAME pair
 * (until the app refreshes that pair or a new token is acquired for the store),
 * so a migration that went wrong half-way is repeatable as long as we still
 * hold the old token. It would be lost by exactly the failures that matter: a
 * crash after the exchange, `storeSession()` failing, or the library storing
 * the OLD session with `accessToken: undefined` after a 401 on the revoked
 * token (a request that was in flight). With the record we
 *   - retry transient failures promptly (`MIGRATION_RETRY_DELAYS_MS`, seconds,
 *     not an hour) — a transient failure is a network error, a 5xx/429, a body
 *     without the expiring token, or `storeSession() === false`;
 *   - find the old token in the record when the stored session lost its token,
 *     and run the exchange with it (only inside 7 days of the first attempt);
 *   - recognise a PERMANENT refusal (400 `invalid_subject_token`): status
 *     `needs_reauth`, one error log line (`[OfflineAdmin] NEEDS_REAUTH`), no
 *     automatic retry from here on, and the dead stored token is blanked so the
 *     merchant's next visit token-exchanges directly. afterAuth then deletes the
 *     record. (400 `invalid_requested_token_type` is about OUR request, not the
 *     shop: a global hold, no record is touched — see `isMigrationConfigError`.)
 *   - recognise a record that went STALE: it carries a fingerprint (SHA-256, 16
 *     hex chars, never the token) of the token it was written for; if the shop's
 *     stored session now holds a DIFFERENT non-expiring token (re-issued while
 *     the switches were off, so afterAuth never forgot the record) the record is
 *     deleted and the shop is treated as new — before any status or backoff.
 *
 * The 7-day window is measured from OUR first attempt with that token
 * (`startedAt`), never from the moment Shopify performed the exchange — which
 * can only be later, so the window we allow ourselves is the conservative one.
 *
 * NOBODY ELSE MAY HAVE STORED A SESSION IN THE MEANTIME. A recovery replay can
 * take ~22 s (retry pauses) and the merchant can open the app in that time: the
 * library then token-exchanges and stores its own pair P2 (afterAuth forgets the
 * record); storing our replayed P1 over it would be a regression, and an
 * app/uninstalled landing mid-run must not get a record or a session re-created
 * for it. So the stored session is re-read after the record is written and
 * before EVERY storeSession; if it is gone, has an `expires`, or its token
 * differs from the one the run started with (empty, for a recovery), the run
 * aborts. The mark-functions of the store use updateMany, never upsert, so a
 * deleted row is not re-created either. Residual: the window between that last
 * read and the write is a few milliseconds, not closed.
 *
 * WHEN THE OLD TOKEN IS ERASED: right after the new pair was stored, not later.
 * Keeping it "until the first successful Admin call with the new token" would
 * cover one more failure — the library overwriting the stored pair with a
 * token-less session when a request that was in flight at the migration gets
 * its 401. But that race only exists for a shop whose merchant is active, and
 * such a shop heals itself on its next request (token exchange); a dormant shop
 * — what the sweep migrates — has no request in flight. Against that, a kept
 * old token is a credential at rest for no purpose once the pair is stored (it
 * is revoked for the Admin API; only the 7-day replay could still hand out the
 * pair), and "first successful call" would need extra state. So: erase on
 * success — the record is DELETED then (nothing needs a "migrated" row). If the
 * delete itself fails the record stays `pending` and is cleaned up the next time
 * the shop is looked at (it then has `expires`).
 *
 * It is called from the BACKGROUND only (the sync scheduler's cycle, the
 * offline-token sweep), never from `authenticate.admin`: a request's captured
 * admin/session still holds the old token, and a 401 on it makes the library's
 * `handleClientError` store that OLD session with `accessToken: undefined` —
 * which, landing after this migration stored the new pair, would overwrite it.
 * Firing it from the request itself made that collision the common case. The
 * scheduler only runs while the merchant is active, so it waits for a QUIET
 * moment (no authenticated request of the shop for `MIGRATION_QUIET_MS`,
 * sync-scheduler.service.ts); the sweep only takes shops that have been quiet
 * for much longer. Opening the app does NOT migrate a shop by itself: a
 * non-expiring session is always "active" to the library, so there is no token
 * exchange to piggyback on.
 *
 * Residual, stated: a merchant's token exchange (opening the app) and our
 * migration exchange running at the same moment can retire each other's result
 * (Shopify: acquiring and refreshing/exchanging concurrently for one store); the
 * stored session then ends up with whichever landed last, and the next request
 * heals it. The same goes for the few milliseconds between the last re-read
 * and the write of `clearDeadSessionToken`. And: a request that is still in flight at the moment of the
 * migration (one that authenticated before the quiet window began and runs
 * longer than it, or one that races the exchange) holds the revoked token. Its
 * next Admin call gets a 401, the library stores its OLD session with
 * `accessToken: undefined` over the migrated pair and answers with a bare 401
 * that carries NO retry header (a document request is bounced instead) — so
 * THAT request FAILS for the merchant; it is not retried. The NEXT request
 * finds a session without a token and token exchange recreates it; background
 * calls fail (`no_token`) until that happens.
 */
export async function maybeMigrateToExpiringToken(shop: string): Promise<MigrationOutcome> {
  if (!migrateToExpiringTokensEnabled()) return "disabled";
  if (migrationSettled.has(shop)) return "not_needed";
  const running = migrationsInFlight.get(shop);
  if (running) return running;
  if (Date.now() < migrationHeldUntil) return "backoff";
  if (migrationNeedsReauth.has(shop)) return "needs_reauth";
  const failedAt = migrationBackoff.get(shop);
  if (failedAt !== undefined && Date.now() - failedAt < MIGRATION_BACKOFF_MS) return "backoff";

  const promise = (async (): Promise<MigrationOutcome> => {
    try {
      return await runMigration(shop);
    } catch (error) {
      migrationBackoff.set(shop, Date.now());
      // A run that THREW (database error, ...) counts as a failed run like any
      // other, or it would be retried every tick forever. updateMany: a missing
      // record is not created. Label only — see safeDbErrorLabel.
      await migrationStore
        .markMigrationFailed(shop, `run threw: ${safeDbErrorLabel(error)}`, attemptsPerRun())
        .catch(() => undefined);
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

/**
 * Re-read the stored session; `null` = unchanged and still ours to migrate.
 * Otherwise the run must stop and this is its outcome (see the "NOBODY ELSE"
 * note on `maybeMigrateToExpiringToken`).
 */
async function driftedOutcome(
  d: OfflineAdminDeps,
  shop: string,
  startToken: string,
  epoch: number,
): Promise<MigrationOutcome | null> {
  // A session was re-issued / the shop uninstalled since the run started (the
  // epoch), or it is marked uninstalled now: "a blank is ours" no longer holds
  // (a late 401 may have re-blanked a NEW session, or re-created a row for an
  // uninstalled shop), so nothing may be stored. The record goes with it.
  if ((reissueEpoch.get(shop) ?? 0) !== epoch || (await migrationStore.isShopUninstalled(shop))) {
    await migrationStore.deleteMigrationRecord(shop).catch(() => undefined);
    logger.warn("[OfflineAdmin] Token migration aborted: the shop was re-authenticated or uninstalled while it ran", { shop });
    return "no_session";
  }
  const now = await d.loadOfflineSession(shop);
  // Still ours: same token — or BLANK. Our own exchange revokes the old token, so
  // a request in flight on it gets a 401 and the library stores the session with
  // `accessToken: undefined`; that blank is not "someone else's token", the pair
  // we hold must still be stored over it (and the record kept until it is).
  if (now && !now.expires) {
    const token = now.accessToken || "";
    if (token === startToken || (startToken !== "" && token === "")) return null;
  }
  if (!now || now.expires) {
    // Gone (uninstall) or re-issued by a token exchange: the migration is moot
    // and so is the record (which holds a credential).
    if (now?.expires) {
      migrationSettled.add(shop);
      migrationNeedsReauth.delete(shop);
    }
    await migrationStore.deleteMigrationRecord(shop).catch(() => undefined);
    logger.warn("[OfflineAdmin] Token migration aborted: the stored session changed while it ran", {
      shop,
      reason: now ? "re-issued with an expiring token" : "session gone",
    });
    return now ? "not_needed" : "no_session";
  }
  // Someone stored another NON-EMPTY non-expiring token: whatever we persisted
  // belongs to the old one, so the (encrypted) record goes; the next run starts clean.
  await migrationStore.deleteMigrationRecord(shop).catch(() => undefined);
  logger.warn("[OfflineAdmin] Token migration aborted: the stored session now holds a different token", { shop });
  return "backoff";
}

/** Park `shop` in the in-process backoff until `until` (epoch ms). */
function backoffUntil(shop: string, until: number): void {
  migrationBackoff.set(shop, until - MIGRATION_BACKOFF_MS);
}

/**
 * `invalid_subject_token`: the stored non-expiring token is dead on Shopify's
 * side. Blank it in the session store (what the library's invalidateAccessToken
 * does), so the shop's next authenticate.admin sees an inactive session and
 * token-exchanges at once instead of failing one request with a 401 first.
 */
async function clearDeadSessionToken(
  d: OfflineAdminDeps,
  shop: string,
  current: Session,
  startToken: string,
  epoch: number,
): Promise<boolean> {
  if (!startToken) return false;
  try {
    if (await driftedOutcome(d, shop, startToken, epoch)) return false;
    const Ctor = current.constructor as new (params: object) => Session;
    const cleared = new Ctor(current.toObject());
    cleared.accessToken = undefined;
    if (!(await d.storeSession(cleared))) return false;
    invalidateOfflineAdmin(shop);
    return true;
  } catch (error) {
    logger.warn("[OfflineAdmin] Could not blank the refused offline token", { shop, error: safeDbErrorLabel(error) });
    return false;
  }
}

async function runMigration(shop: string): Promise<MigrationOutcome> {
  const epoch = reissueEpoch.get(shop) ?? 0;
  const d = await resolveDeps();
  const current = await d.loadOfflineSession(shop);
  let record = await migrationStore.getMigrationRecord(shop);

  if (record && !current?.expires && current?.accessToken && record.tokenFingerprint) {
    // The record was written for another token than the one the shop holds now
    // (a token exchange issued a new NON-expiring one while the switches were
    // off, so afterAuth never forgot the record). Its status, backoff and
    // needs_reauth verdict are about the OLD token: drop them, start clean.
    if (migrationStore.fingerprintToken(current.accessToken) !== record.tokenFingerprint) {
      logger.info("[OfflineAdmin] Stale token-migration record (the shop holds a different token now) — discarded", { shop });
      await migrationStore.deleteMigrationRecord(shop);
      migrationNeedsReauth.delete(shop);
      migrationBackoff.delete(shop);
      record = null;
    }
  }

  if (current?.expires) {
    // Already expiring — migrated by us, or re-issued by a token exchange.
    // Either way a leftover record is moot (and may hold a credential).
    migrationSettled.add(shop);
    migrationNeedsReauth.delete(shop);
    if (record) {
      await migrationStore.deleteMigrationRecord(shop).catch((error) => {
        logger.warn("[OfflineAdmin] Could not delete a stale token-migration record", { shop, error: describe(error) });
      });
    }
    return "not_needed";
  }
  // No session row at all: uninstalled (or never installed). A record cannot
  // revive it — storing a session for an uninstalled shop would be wrong.
  if (!current) return "no_session";

  if (record?.status === "needs_reauth") {
    migrationNeedsReauth.add(shop);
    return "needs_reauth";
  }
  if (record) {
    // Persisted backoff (survives a restart) and the terminal state after too
    // many attempts: a shop Shopify keeps answering with something we do not
    // understand is not worth ~24 calls an hour forever.
    const notBefore = migrationStore.retryNotBefore(record, attemptsPerRun());
    if (notBefore > Date.now()) {
      backoffUntil(shop, Number.isFinite(notBefore) ? notBefore : Date.now() + migrationStore.PERSISTED_BACKOFF_MAX_MS);
      return "backoff";
    }
  }

  const startToken = current.accessToken || "";
  let oldToken = startToken || undefined;
  let recovered = false;
  if (!oldToken) {
    // The stored session lost its token (the library stores `accessToken:
    // undefined` after a 401 on a revoked token). The persisted copy is the
    // only way back — and only for 7 days.
    oldToken = migrationStore.recoverableOldToken(record) ?? undefined;
    if (!oldToken) {
      if (record && (record.status === "pending" || record.status === "failed")) {
        // A migration was started, the session lost its token and the window
        // (or the ciphertext) is gone: nothing automatic is left.
        const why = "the stored session has no token and the 7-day recovery window is over";
        await markNeedsReauth(shop, why, 0);
        logNeedsReauth(shop, why, "the session has no token already, so the merchant's next visit token-exchanges directly");
        return "needs_reauth";
      }
      return "no_session";
    }
    recovered = true;
  }

  // Persist BEFORE the exchange. If this fails the migration does not start:
  // an exchange we cannot recover from is worse than no exchange. Only name and
  // code of a database error are carried on — its message can echo the
  // arguments, i.e. the ciphertext.
  try {
    await migrationStore.persistOldToken(shop, oldToken, record);
  } catch (error) {
    throw new Error(`could not persist the old token (${safeDbErrorLabel(error)})`);
  }
  // The upsert may have re-created a record for a shop that was uninstalled
  // (or re-authenticated) since we read it: look again, and take it back out.
  const moot = await driftedOutcome(d, shop, startToken, epoch);
  if (moot) return moot;
  if (recovered) {
    logger.warn("[OfflineAdmin] Stored session has no token — recovering the migration with the persisted old token", { shop });
  }

  let lastError = "unknown";
  const maxAttempts = attemptsPerRun();
  let attempts = 0;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleep(MIGRATION_RETRY_DELAYS_MS[i - 1]);
    attempts++;
    let session: Session | undefined;
    try {
      ({ session } = await d.migrateToExpiringToken({ shop, nonExpiringOfflineAccessToken: oldToken }));
    } catch (error) {
      if (isPermanentMigrationError(error)) {
        const why = `Shopify refused the stored token (HTTP ${exchangeStatus(error) ?? "?"} ${exchangeErrorCode(error)})`;
        await markNeedsReauth(shop, why, attempts);
        const blanked = await clearDeadSessionToken(d, shop, current, startToken, epoch);
        logNeedsReauth(
          shop,
          why,
          blanked
            ? "the dead stored token was blanked, so the merchant's next visit token-exchanges directly"
            : "the dead stored token could NOT be blanked (session changed meanwhile or the write failed): the merchant's first request may fail once with a 401 before the library token-exchanges",
        );
        return "needs_reauth";
      }
      if (isMigrationConfigError(error)) {
        // A global hold, nothing else: no attempts counted, no persisted backoff,
        // no status change on this shop's record (it stays `pending`, token kept).
        migrationHeldUntil = Date.now() + MIGRATION_CONFIG_ERROR_HOLD_MS;
        logger.error(
          `[OfflineAdmin] CONFIG ERROR — Shopify answered the token migration with ${exchangeErrorCode(error)}. ` +
            "This is about OUR request (client id / secret / token type / API version), not about this shop: NO shop is marked and no token " +
            "is erased; ALL migrations pause for 6 h. Fix the configuration and restart.",
          { shop },
        );
        return "failed";
      }
      lastError = describe(error);
      logger.warn("[OfflineAdmin] Token migration attempt failed (transient) — retrying", {
        shop,
        attempt: attempts,
        of: maxAttempts,
        error: lastError,
      });
      continue;
    }
    if (!session?.accessToken || !session.expires) {
      // Without an expiry the exchange did not give us what we asked for;
      // storing it would only overwrite a working token with an unknown one.
      lastError = "exchange returned no expiring token";
      logger.warn("[OfflineAdmin] Token migration returned no expiring token — retrying", { shop, attempt: attempts });
      continue;
    }
    // Somebody may have stored a session while we slept / exchanged.
    const drift = await driftedOutcome(d, shop, startToken, epoch);
    if (drift) return drift;
    let stored = false;
    let storeError = "storeSession returned false";
    try {
      stored = await d.storeSession(session);
    } catch (error) {
      // name/code only: a Prisma validation error can echo the session row,
      // i.e. the (encrypted) tokens, and this goes into logs and lastError.
      storeError = `storeSession threw: ${safeDbErrorLabel(error)}`;
    }
    if (!stored) {
      // The pair exists on Shopify, our copy does not. Repeating the exchange
      // with the persisted old token returns the SAME pair (7 days).
      lastError = storeError;
      logger.error("[OfflineAdmin] Token migrated on Shopify but NOT stored — repeating the exchange with the persisted old token", {
        shop,
        attempt: attempts,
        of: maxAttempts,
      });
      continue;
    }

    invalidateOfflineAdmin(shop);
    migrationBackoff.delete(shop);
    migrationSettled.add(shop);
    await migrationStore.deleteMigrationRecord(shop).catch((error) => {
      logger.warn("[OfflineAdmin] Migrated, but could not delete the token-migration record", {
        shop,
        error: describe(error),
      });
    });
    logger.info("[OfflineAdmin] Migrated offline token to an expiring one", {
      shop,
      expires: session.expires.toISOString(),
      hasRefreshToken: !!session.refreshToken,
      attempts,
      recovered,
    });
    return "migrated";
  }

  await migrationStore.markMigrationFailed(shop, lastError, attempts).catch(() => undefined);
  const after = await migrationStore.getMigrationRecord(shop).catch(() => null);
  const notBefore = after ? migrationStore.retryNotBefore(after, attemptsPerRun()) : 0;
  backoffUntil(
    shop,
    notBefore === Infinity
      ? Date.now() + migrationStore.PERSISTED_BACKOFF_MAX_MS
      : Math.max(notBefore, Date.now() + MIGRATION_BACKOFF_MS),
  );
  if (after && migrationStore.isTerminal(after)) {
    // Once: from here on the record is skipped (persisted), not retried. Its
    // ciphertext has no use any more: erase it, keep the fingerprint.
    await migrationStore.eraseOldToken(shop).catch(() => undefined);
    logger.error(
      "[OfflineAdmin] MIGRATION_GAVE_UP — the token migration kept failing; no automatic retry any more. " +
        "Reset: see RAILWAY-SETUP.md (OfflineTokenMigration)",
      { shop, attempts: after.attempts, error: lastError },
    );
  } else {
    logger.error("[OfflineAdmin] Token migration failed after prompt retries — kept the persisted old token, retried after backoff", {
      shop,
      attempts,
      error: lastError,
    });
  }
  return "failed";
}

async function markNeedsReauth(shop: string, reason: string, attempts: number): Promise<void> {
  migrationNeedsReauth.add(shop);
  await migrationStore.markMigrationNeedsReauth(shop, reason, attempts).catch((error) => {
    logger.warn("[OfflineAdmin] Could not persist needs_reauth for the token migration", { shop, error: safeDbErrorLabel(error) });
  });
}

/** One line, greppable: this is the list of shops that need their merchant. Logged AFTER the blanking attempt, so it can say what happened. */
function logNeedsReauth(shop: string, cause: string, effect: string): void {
  logger.error(`[OfflineAdmin] NEEDS_REAUTH — ${cause}; no automatic retry. ${effect}; or reinstall`, { shop });
}

/**
 * Forget an in-process backoff / needs_reauth verdict of `shop` that the DATABASE
 * no longer backs (an operator reset the row, or deleted it). The sweep calls it
 * for every candidate it just selected — a candidate is by construction not
 * blocked by a record. Leaves a running migration and the global config hold alone.
 */
export function releaseStaleMigrationBlock(shop: string): void {
  if (migrationsInFlight.has(shop)) return;
  migrationBackoff.delete(shop);
  migrationNeedsReauth.delete(shop);
}
