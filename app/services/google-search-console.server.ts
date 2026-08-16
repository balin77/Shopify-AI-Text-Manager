/**
 * Google Search Console integration (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 6 / A7).
 *
 * OAuth 2.0 to Google + the Search Console API. The refresh token is encrypted
 * at rest (same AES-256-GCM utility as the AI API keys); access tokens are
 * derived per request and never stored. The OAuth `state` is HMAC-signed
 * (CSRF + carries the shop/host so the callback can re-enter the embedded app).
 *
 * The whole feature is opt-in: when the GOOGLE_OAUTH_* env vars are absent,
 * isGscConfigured() is false and the section shows "not configured" rather than
 * erroring. `invalid_grant` (revoked/expired refresh token) clears the stored
 * connection so the merchant is prompted to reconnect.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { encryptApiKey, tryDecryptApiKey } from "../utils/encryption.server";
import { resolvePathsToResources, isContentResourceType } from "./seo/url-resolver.server";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GSC_API = "https://www.googleapis.com/webmasters/v3";
const GSC_INSPECT_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

// Every outbound call to Google is a request-response cycle the merchant is
// waiting on (a Remix loader/action). Without a timeout, a stalled TCP
// connection to Google would hang the request indefinitely. Analytics queries
// get a longer budget — they aggregate rows server-side on Google's end.
const FETCH_TIMEOUT_MS = 10_000;
const ANALYTICS_FETCH_TIMEOUT_MS = 15_000;

// webmasters.readonly = analytics/inspection; webmasters = sitemaps.submit.
// openid+email so we can show which Google account is connected.
const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/webmasters",
  "openid",
  "email",
];

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Thrown when the merchant must (re)connect — caller clears any stored token. */
export class GscReconnectRequiredError extends Error {
  constructor(public reason: string) {
    super(`GSC reconnect required: ${reason}`);
    this.name = "GscReconnectRequiredError";
  }
}

export interface GscOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGscOAuthConfig(): GscOAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL?.replace(/\/$/, "");
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI || (appUrl ? `${appUrl}/auth/google/callback` : undefined);
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function isGscConfigured(): boolean {
  return getGscOAuthConfig() !== null;
}

// ── Signed OAuth state (CSRF + carries shop/host) ────────────────────────────

function stateSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET || process.env.ENCRYPTION_KEY;
  if (secret) return secret;
  // A hardcoded fallback would let anyone forge a valid-looking OAuth state
  // (CSRF) if this ever ran in production without SHOPIFY_API_SECRET or
  // ENCRYPTION_KEY set — both should always be present in production (see
  // scripts/validate-env.js). Fail loudly there instead of signing with a
  // secret an attacker can read straight out of this file. Non-production
  // keeps the fallback so local dev works with a bare-bones .env.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "GSC OAuth state secret is not configured: set SHOPIFY_API_SECRET or ENCRYPTION_KEY in production",
    );
  }
  return "dev-only-state-secret";
}

export function signOAuthState(payload: { shop: string; host: string; customDomain?: string | null }): string {
  // A random per-state nonce lets consumeOAuthState() enforce single-use
  // (replay) semantics below — the signature alone only proves authenticity,
  // not that this exact state hasn't already been redeemed.
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now(), nonce: randomUUID() })).toString(
    "base64url",
  );
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

interface VerifiedOAuthState {
  shop: string;
  host: string;
  customDomain: string | null;
  nonce: string | null;
}

/** Shared signature/TTL check. Does not consume the nonce — see consumeOAuthState(). */
function verifySignedState(state: string): VerifiedOAuthState | null {
  const [body, sig] = (state || "").split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof data.shop !== "string" || typeof data.ts !== "number") return null;
    if (Date.now() - data.ts > STATE_TTL_MS) return null;
    return {
      shop: data.shop,
      host: typeof data.host === "string" ? data.host : "",
      customDomain: typeof data.customDomain === "string" ? data.customDomain : null,
      // Absent on states signed before this nonce field existed (pre-deploy
      // grace — see consumeOAuthState()).
      nonce: typeof data.nonce === "string" ? data.nonce : null,
    };
  } catch {
    return null;
  }
}

export function verifyOAuthState(
  state: string,
): { shop: string; host: string; customDomain: string | null } | null {
  const verified = verifySignedState(state);
  if (!verified) return null;
  return { shop: verified.shop, host: verified.host, customDomain: verified.customDomain };
}

// ── Single-use nonce store (OAuth-state replay protection) ──────────────────
//
// This app deploys as a single Node process: server.js documents (see the
// R4-C2 comment there, "the app is currently deployed as a single `web`
// process (Procfile: `web: npm run start:production`; no replica/scale
// config)") that every in-process singleton in this codebase relies on that
// assumption. A plain in-memory Map is therefore sufficient here too — it
// only needs to prevent a nonce being redeemed twice on the ONE process
// handling all callbacks. If this app is ever scaled to multiple instances,
// the upgrade path is a DB-backed nonce table (e.g. a UsedOAuthNonce model
// with a unique constraint on `nonce`) shared across instances, exactly as
// server.js recommends a Postgres advisory lock for the other singletons.
const consumedNonces = new Map<string, number>(); // nonce -> expiresAt (ms)

/** Drop nonces whose state would have expired anyway — bounds the Map to ~STATE_TTL_MS worth of entries. */
function purgeExpiredNonces(now: number): void {
  for (const [nonce, expiresAt] of consumedNonces) {
    if (expiresAt <= now) consumedNonces.delete(nonce);
  }
}

/**
 * Verify the signed OAuth state AND atomically mark its nonce consumed, so a
 * second callback replaying the exact same `state` value (same code request
 * repeated, tab duplicated, network retry replayed by an attacker who
 * observed the redirect) is rejected instead of re-running the connect flow.
 * Returns null on an invalid/expired/tampered state OR a replay.
 *
 * Backward-compat / rollout grace: a state signed by the previous deploy (no
 * `nonce` claim yet) is accepted on TTL + signature alone, exactly like
 * before — it cannot be tracked for single-use, but every state is at most
 * STATE_TTL_MS (10 min) old before it expires naturally, so the replay window
 * for that one-deploy transition period is bounded and small. Once fully
 * rolled out, all newly-issued states carry a nonce and get full single-use
 * enforcement.
 */
export function consumeOAuthState(
  state: string,
): { shop: string; host: string; customDomain: string | null } | null {
  const verified = verifySignedState(state);
  if (!verified) return null;

  const now = Date.now();
  purgeExpiredNonces(now);
  if (verified.nonce) {
    if (consumedNonces.has(verified.nonce)) return null; // replay
    consumedNonces.set(verified.nonce, now + STATE_TTL_MS);
  }
  return { shop: verified.shop, host: verified.host, customDomain: verified.customDomain };
}

export function buildGscAuthUrl(state: string): string | null {
  const cfg = getGscOAuthConfig();
  if (!cfg) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // force a refresh_token on every (re)connect
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// ── Token exchange / refresh ─────────────────────────────────────────────────

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  idToken?: string;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResult> {
  const cfg = getGscOAuthConfig();
  if (!cfg) throw new Error("GSC is not configured");
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token exchange failed: ${json.error || res.status}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in ?? 3600,
    idToken: json.id_token,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const cfg = getGscOAuthConfig();
  if (!cfg) throw new Error("GSC is not configured");
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    if (json.error === "invalid_grant") throw new GscReconnectRequiredError("invalid_grant");
    throw new Error(`Google token refresh failed: ${json.error || res.status}`);
  }
  return json.access_token;
}

/**
 * Best-effort revoke of a refresh token at Google (called on disconnect). Never
 * throws — a revoke failure (network blip, token already revoked, Google
 * outage) must not block deleting the local connection; the merchant's intent
 * to disconnect must always succeed locally regardless of Google's reachability.
 */
export async function revokeGoogleToken(refreshToken: string): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // Best-effort only — see doc comment above.
  }
}

/** Best-effort email from an OpenID id_token (no signature verification needed — display only). */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

// ── Connection persistence ───────────────────────────────────────────────────

export async function saveGscConnection(
  db: PrismaClient,
  shop: string,
  input: { propertyUrl: string; refreshToken: string; email?: string | null },
): Promise<void> {
  const enc = encryptApiKey(input.refreshToken);
  if (!enc) throw new Error("Failed to encrypt the GSC refresh token");
  await db.googleSearchConsoleConnection.upsert({
    where: { shop },
    create: { shop, propertyUrl: input.propertyUrl, refreshToken: enc, email: input.email ?? null },
    update: { propertyUrl: input.propertyUrl, refreshToken: enc, email: input.email ?? null },
  });
}

/** Update just the property (when a refresh on reconnect didn't return a new token). */
export async function updateGscProperty(
  db: PrismaClient,
  shop: string,
  propertyUrl: string,
  email?: string | null,
): Promise<void> {
  await db.googleSearchConsoleConnection.updateMany({
    where: { shop },
    data: { propertyUrl, ...(email !== undefined ? { email } : {}) },
  });
}

export async function getGscConnection(db: PrismaClient, shop: string) {
  return db.googleSearchConsoleConnection.findUnique({ where: { shop } });
}

export async function deleteGscConnection(db: PrismaClient, shop: string): Promise<void> {
  await db.googleSearchConsoleConnection.deleteMany({ where: { shop } });
}

/** Load the connection, refresh an access token. Clears the connection on invalid_grant. */
export async function getGscAccessToken(
  db: PrismaClient,
  shop: string,
): Promise<{ accessToken: string; propertyUrl: string }> {
  const conn = await getGscConnection(db, shop);
  if (!conn) throw new GscReconnectRequiredError("not_connected");
  // NON-throwing decrypt: a corrupted token or a rotated ENCRYPTION_KEY must
  // yield null (→ clear the connection + prompt reconnect), not throw past this
  // guard and get misclassified as a generic fetch error.
  const refresh = tryDecryptApiKey(conn.refreshToken, "gsc-refresh-token");
  if (!refresh) {
    await deleteGscConnection(db, shop);
    throw new GscReconnectRequiredError("decrypt_failed");
  }
  try {
    const accessToken = await refreshAccessToken(refresh);
    return { accessToken, propertyUrl: conn.propertyUrl };
  } catch (e) {
    if (e instanceof GscReconnectRequiredError) await deleteGscConnection(db, shop);
    throw e;
  }
}

// ── Search Console API ───────────────────────────────────────────────────────

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export async function listSites(accessToken: string): Promise<GscSite[]> {
  const res = await fetch(`${GSC_API}/sites`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GSC listSites failed: ${json.error?.message || res.status}`);
  return (json.siteEntry ?? []).filter((s: GscSite) => s.permissionLevel !== "siteUnverifiedUser");
}

/**
 * Pick the GSC property that best matches a shop. Prefers a domain property or a
 * URL-prefix property whose host contains the shop's domain (myshopify or
 * custom).
 *
 * Deliberately does NOT fall back to `sites[0]` when nothing matches: the
 * merchant's Google account can have any number of unrelated verified
 * properties (other stores, personal sites), and silently picking the first
 * one would submit sitemaps / read analytics for the wrong website. Returning
 * null here tells the caller to store the connection without a property and
 * let the merchant pick the right one explicitly.
 */
export function pickProperty(sites: GscSite[], shop: string, customDomain?: string | null): string | null {
  if (sites.length === 0) return null;
  const needles = [shop.toLowerCase(), customDomain?.toLowerCase()].filter(Boolean) as string[];
  const matches = (siteUrl: string) => {
    const s = siteUrl.toLowerCase();
    return needles.some((n) => s.includes(n));
  };
  // Prefer a matching domain property, then a matching URL property.
  const domainMatch = sites.find((s) => s.siteUrl.startsWith("sc-domain:") && matches(s.siteUrl));
  if (domainMatch) return domainMatch.siteUrl;
  const urlMatch = sites.find((s) => matches(s.siteUrl));
  if (urlMatch) return urlMatch.siteUrl;
  return null;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Country = ISO-3166-1-alpha-3, lowercase (GSC's own format, e.g. "deu", "usa"). */
export interface SearchAnalyticsFilters {
  country?: string;
  device?: "DESKTOP" | "MOBILE" | "TABLET";
}

export interface SearchAnalyticsOptions {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  dimensions?: string[]; // e.g. ["query"], ["query","page"]
  rowLimit?: number;
  filters?: SearchAnalyticsFilters;
}

interface GscDimensionFilter {
  dimension: string;
  operator: string;
  expression: string;
}

/**
 * Build the GSC `dimensionFilterGroups` request fragment from our country/device
 * filter shape. Both filters (when both are set) go into a SINGLE group — GSC
 * ANDs the filters within one group, which is what "queries from Germany on
 * mobile" needs (a second group would OR against the first). Pure and exported
 * so this mapping is unit-testable without mocking fetch.
 */
export function buildDimensionFilterGroups(
  filters?: SearchAnalyticsFilters,
): Array<{ filters: GscDimensionFilter[] }> | undefined {
  if (!filters?.country && !filters?.device) return undefined;
  const group: GscDimensionFilter[] = [];
  if (filters.country) group.push({ dimension: "country", operator: "equals", expression: filters.country });
  if (filters.device) group.push({ dimension: "device", operator: "equals", expression: filters.device });
  return [{ filters: group }];
}

export async function querySearchAnalytics(
  accessToken: string,
  propertyUrl: string,
  opts: SearchAnalyticsOptions,
): Promise<SearchAnalyticsRow[]> {
  const url = `${GSC_API}/sites/${encodeURIComponent(propertyUrl)}/searchAnalytics/query`;
  const dimensionFilterGroups = buildDimensionFilterGroups(opts.filters);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions: opts.dimensions ?? ["query"],
      rowLimit: opts.rowLimit ?? 25,
      dataState: "final", // GSC has 2–3d latency; only settled data
      ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
    }),
    signal: AbortSignal.timeout(ANALYTICS_FETCH_TIMEOUT_MS),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GSC searchAnalytics failed: ${json.error?.message || res.status}`);
  return (json.rows ?? []) as SearchAnalyticsRow[];
}

/** One (query, page) row flagged as a "quick win" — ranks decently but the CTR headroom suggests a title/meta rewrite could pull more clicks. */
export interface CtrOpportunity {
  query: string;
  page: string;
  impressions: number;
  position: number;
  ctr: number;
}

// Position 4-20 = "found, but not front-of-page-1" — the band where a better
// title/meta description has the most leverage (position 1-3 already win the
// click; >20 rarely gets impressions worth optimizing for). 200 impressions
// is a floor so we don't surface statistical noise from single-digit-view rows.
const OPPORTUNITY_MIN_IMPRESSIONS = 200;
const OPPORTUNITY_MIN_POSITION = 4;
const OPPORTUNITY_MAX_POSITION = 20;
const OPPORTUNITY_LIMIT = 10;

/**
 * Filter/rank ["query","page"]-dimension analytics rows down to the top CTR
 * opportunities. Pure and exported so the ranking logic is unit-testable
 * without mocking fetch/Prisma.
 */
export function findCtrOpportunities(rows: SearchAnalyticsRow[], limit = OPPORTUNITY_LIMIT): CtrOpportunity[] {
  return rows
    .filter(
      (r) =>
        r.impressions >= OPPORTUNITY_MIN_IMPRESSIONS &&
        r.position >= OPPORTUNITY_MIN_POSITION &&
        r.position <= OPPORTUNITY_MAX_POSITION,
    )
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map((r) => ({
      query: r.keys[0] ?? "",
      page: r.keys[1] ?? "",
      impressions: r.impressions,
      position: r.position,
      ctr: r.ctr,
    }));
}

/** aggregateQueryPageRows result: per-query totals + each query's top page. */
export interface AggregatedQueryRows {
  /** Query-level totals, sorted clicks desc then impressions desc (GSC's own
   *  default ordering for the query dimension). keys = [query]. */
  queries: SearchAnalyticsRow[];
  /** query (lowercased) → the page URL with the most impressions for it —
   *  the adopt flow's item suggestion (PLAN_KEYWORDS_EXPANSION.md §4.1a). */
  topPageByQuery: Map<string, string>;
}

/**
 * Aggregate (query, page)-dimensioned Search Analytics rows down to query
 * totals, so ONE GSC call can feed both the Top-queries table (aggregated)
 * and the Quick-wins detection (raw rows) — saving the separate
 * query-dimensioned call (PLAN_KEYWORDS_EXPANSION.md §4.4). clicks and
 * impressions sum; position is the impression-weighted mean (a straight mean
 * would let a 2-impression page skew a 1000-impression query); ctr is
 * recomputed as clicks/impressions. Pure and exported for unit testing.
 */
export function aggregateQueryPageRows(rows: SearchAnalyticsRow[]): AggregatedQueryRows {
  interface Acc {
    query: string;
    clicks: number;
    impressions: number;
    positionWeighted: number; // Σ position·impressions (÷ impressions at the end)
    topPage: string;
    topPageImpressions: number;
  }
  const byQuery = new Map<string, Acc>();
  for (const row of rows) {
    const query = row.keys?.[0] ?? "";
    const page = row.keys?.[1] ?? "";
    if (!query) continue;
    const key = query.toLowerCase();
    let acc = byQuery.get(key);
    if (!acc) {
      acc = { query, clicks: 0, impressions: 0, positionWeighted: 0, topPage: page, topPageImpressions: row.impressions };
      byQuery.set(key, acc);
    } else if (row.impressions > acc.topPageImpressions) {
      acc.topPage = page;
      acc.topPageImpressions = row.impressions;
    }
    acc.clicks += row.clicks;
    acc.impressions += row.impressions;
    acc.positionWeighted += row.position * row.impressions;
  }

  const queries: SearchAnalyticsRow[] = Array.from(byQuery.values())
    .map((acc) => ({
      keys: [acc.query],
      clicks: acc.clicks,
      impressions: acc.impressions,
      ctr: acc.impressions > 0 ? acc.clicks / acc.impressions : 0,
      position: acc.impressions > 0 ? acc.positionWeighted / acc.impressions : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  const topPageByQuery = new Map<string, string>();
  for (const [key, acc] of byQuery) {
    if (acc.topPage) topPageByQuery.set(key, acc.topPage);
  }
  return { queries, topPageByQuery };
}

/**
 * `resolveGscPagePath` used to be defined here — extracted to
 * `seo/url-resolver.server.ts` (PLAN_SEO_SUITE_COMPLETION.md §1/§3.1) so the
 * Phase-1 crawler can share the exact same path→resource mapping instead of
 * a second, drifting copy. Re-exported so every existing importer (the Quick
 * wins "Optimize" deep-link in app.seo.search-console.tsx, and this file's
 * own unit tests) keeps working unchanged. */
export { resolveGscPagePath, type ResolvedGscPage } from "./seo/url-resolver.server";

/**
 * Submit a sitemap to GSC. `sitemapUrl` must be the sitemap's FULL absolute URL
 * (e.g. "https://shop.example.com/sitemap.xml") — the sitemaps.submit API takes
 * this as the resource identifier, not a path relative to the property. This
 * holds even for `sc-domain:` (domain) properties: the sitemap itself is still
 * served over https from the store's host, only the *property* is domain-scoped.
 */
export async function submitSitemap(
  accessToken: string,
  propertyUrl: string,
  sitemapUrl: string,
): Promise<void> {
  const url = `${GSC_API}/sites/${encodeURIComponent(propertyUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 204) {
    const json: any = await res.json().catch(() => ({}));
    throw new Error(`GSC submitSitemap failed: ${json.error?.message || res.status}`);
  }
}

export async function inspectUrl(
  accessToken: string,
  propertyUrl: string,
  inspectionUrl: string,
): Promise<any> {
  const res = await fetch(GSC_INSPECT_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl, siteUrl: propertyUrl }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GSC urlInspection failed: ${json.error?.message || res.status}`);
  return json.inspectionResult ?? null;
}

/** Compact shape the "Inspect URL" card actually renders. */
export interface UrlInspectionSummary {
  verdict: string; // "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" | "VERDICT_UNSPECIFIED"
  coverageState: string;
  robotsTxtState: string;
  indexingState: string;
  lastCrawlTime: string | null;
}

/**
 * Reduce the raw (large, deeply nested) urlInspection.index API response down
 * to the handful of fields the UI needs. The full response also carries
 * mobileUsabilityResult/richResultsResult/AMP data we don't use — kept pure
 * and exported so the shape mapping is unit-testable without a live call.
 */
export function summarizeInspection(inspectionResult: any): UrlInspectionSummary {
  const idx = inspectionResult?.indexStatusResult ?? {};
  return {
    verdict: idx.verdict || "VERDICT_UNSPECIFIED",
    coverageState: idx.coverageState || "",
    robotsTxtState: idx.robotsTxtState || "",
    indexingState: idx.indexingState || "",
    lastCrawlTime: idx.lastCrawlTime || null,
  };
}

// ── Keyword enrichment ───────────────────────────────────────────────────────

/** Default trailing window for analytics (GSC has 2–3 day latency). */
export function defaultDateRange(now: Date, days = 28): { startDate: string; endDate: string } {
  const end = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3d lag
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

/**
 * The 28-day window immediately BEFORE defaultDateRange(now, days) — used for
 * the period-over-period deltas on the Top queries table. Butts directly up
 * against the current window (previous.endDate = current.startDate - 1 day),
 * no gap and no overlap, so every day in the trailing 56 days is counted
 * exactly once between the two windows.
 */
export function previousDateRange(now: Date, days = 28): { startDate: string; endDate: string } {
  const { startDate: currentStart } = defaultDateRange(now, days);
  const end = new Date(new Date(`${currentStart}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000);
  // `days` (not days - 1): defaultDateRange spans days+1 inclusive calendar
  // days (start = end - days), so the previous window must too — a shorter
  // window would systematically inflate clicks/impressions deltas by ~1/days.
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

/** Per-query deltas the Top queries table renders (clicks/impressions/position/ctr). */
export interface QueryDelta {
  clicksDelta: number;
  impressionsDelta: number;
  positionDelta: number; // current - previous; negative = improved (lower position is better)
  ctrDelta: number;
}

/**
 * Match current/previous period rows by query (case-insensitive) and compute
 * deltas. Only queries present in BOTH periods get an entry — a query with no
 * previous-period row has nothing to compare against (see findLostQueries for
 * the complementary "disappeared" case).
 */
export function computeQueryDeltas(
  current: SearchAnalyticsRow[],
  previous: SearchAnalyticsRow[],
): Map<string, QueryDelta> {
  const previousByQuery = new Map<string, SearchAnalyticsRow>();
  for (const row of previous) {
    const q = (row.keys?.[0] ?? "").toLowerCase();
    if (q) previousByQuery.set(q, row);
  }

  const deltas = new Map<string, QueryDelta>();
  for (const row of current) {
    const q = (row.keys?.[0] ?? "").toLowerCase();
    if (!q) continue;
    const prev = previousByQuery.get(q);
    if (!prev) continue;
    deltas.set(q, {
      clicksDelta: row.clicks - prev.clicks,
      impressionsDelta: row.impressions - prev.impressions,
      positionDelta: row.position - prev.position,
      ctrDelta: row.ctr - prev.ctr,
    });
  }
  return deltas;
}

/** One query that had meaningful traffic last period but no longer shows up at all. */
export interface LostQuery {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

// A query with fewer than this many previous-period impressions is too thin to
// call "lost" with confidence — could just be normal long-tail noise dropping
// in/out of GSC's rowLimit-capped response.
const LOST_QUERY_MIN_IMPRESSIONS = 50;
const LOST_QUERY_LIMIT = 10;

/**
 * Queries that had real traffic in the previous period but don't appear at all
 * in the current one — a signal that content ranking for them may have
 * regressed or been removed. Sorted by previous-period impressions descending
 * (biggest drop-off first) and capped at `limit`. Pure/exported for unit
 * testing without a live call.
 */
export function findLostQueries(
  current: SearchAnalyticsRow[],
  previous: SearchAnalyticsRow[],
  minImpressions = LOST_QUERY_MIN_IMPRESSIONS,
  limit = LOST_QUERY_LIMIT,
): LostQuery[] {
  const currentQueries = new Set<string>();
  for (const row of current) {
    const q = (row.keys?.[0] ?? "").toLowerCase();
    if (q) currentQueries.add(q);
  }

  return previous
    .filter((row) => {
      const q = (row.keys?.[0] ?? "").toLowerCase();
      return q && row.impressions >= minImpressions && !currentQueries.has(q);
    })
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map((row) => ({
      query: row.keys[0] ?? "",
      clicks: row.clicks,
      impressions: row.impressions,
      position: row.position,
    }));
}

// A manual "Sync keyword rankings" click and the daily auto-sync can both fire
// on the same calendar day; truncating to UTC midnight makes capturedAt a
// stable per-day key so the (keywordId, capturedAt) unique index dedupes them
// into a single snapshot row instead of one chart data point per sync.
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// One year of daily charts plus slack; bounds table growth without losing the
// history the "last 12 months" ranking chart needs.
const SNAPSHOT_RETENTION_DAYS = 400;

/**
 * Fetch GSC query analytics and write per-keyword position/clicks/impressions/ctr
 * back onto matching SeoKeywordAssignment rows (exact, case-insensitive query
 * match — the GSC columns live on the assignment since the keywords expansion,
 * PLAN_KEYWORDS_EXPANSION.md §2). Still query-dimension only: every assignment
 * of the same keyword receives the same aggregate metrics; the per-(query,
 * page) split is the Phase-2 loader consolidation. Returns the number of
 * assignment rows enriched. Caller must pass `now` (the service stays
 * deterministic / testable).
 */
export async function enrichKeywordsFromGsc(
  db: PrismaClient,
  shop: string,
  now: Date,
): Promise<number> {
  const { accessToken, propertyUrl } = await getGscAccessToken(db, shop);
  const { startDate, endDate } = defaultDateRange(now);
  const rows = await querySearchAnalytics(accessToken, propertyUrl, {
    startDate,
    endDate,
    dimensions: ["query"],
    rowLimit: 1000,
  });

  // Best row per query keyword (GSC already aggregates by the query dimension).
  const byKeyword = new Map<string, SearchAnalyticsRow>();
  for (const row of rows) {
    const kw = (row.keys?.[0] ?? "").toLowerCase();
    if (kw) byKeyword.set(kw, row);
  }

  const assignments = await db.seoKeywordAssignment.findMany({
    where: { shop },
    select: { id: true, keyword: { select: { keyword: true } } },
  });
  const capturedAt = utcMidnight(now);
  let enriched = 0;
  for (const a of assignments) {
    const row = byKeyword.get(a.keyword.keyword.toLowerCase());
    if (!row) continue;
    await db.seoKeywordAssignment.update({
      where: { id: a.id },
      data: {
        gscPosition: row.position,
        gscClicks: row.clicks,
        gscImpressions: row.impressions,
        gscCtr: row.ctr,
        gscUpdatedAt: now,
      },
    });
    await db.seoKeywordSnapshot.upsert({
      where: { assignmentId_capturedAt: { assignmentId: a.id, capturedAt } },
      create: {
        shop,
        assignmentId: a.id,
        capturedAt,
        position: row.position,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
      },
      update: {
        position: row.position,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
      },
    });
    enriched += 1;
  }

  // Retention: one deleteMany per sync run rather than a separate scheduled
  // job — cheap (an indexed range delete) and keeps the prune tied to the
  // same shop-scoped code path that writes the snapshots.
  const retentionCutoff = new Date(now.getTime() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.seoKeywordSnapshot.deleteMany({ where: { shop, capturedAt: { lt: retentionCutoff } } });

  return enriched;
}

// ── Per-page rollup (PLAN_SEO_SUITE_COMPLETION.md §5.1 option b) ────────────

/** Trailing window for the per-page rollup — wider than the 28d keyword
 *  window: freshness analysis (freshness.service.ts) wants a stable,
 *  low-noise read on long-term ranking rather than day-to-day movement. */
const PAGE_STAT_WINDOW_DAYS = 90;
const PAGE_STAT_ROW_LIMIT = 1000;

/**
 * Fetch GSC page-dimensioned analytics (ONE extra API call) and upsert
 * SeoGscPageStat rows — the per-page rollup app/services/seo/freshness.service.ts
 * joins against `shopifyUpdatedAt`. Called once per daily auto-sync tick
 * (gsc-auto-sync.service.ts), right after the existing keyword enrichment —
 * kept in its OWN try/catch there so a failure here (quota, transient Google
 * error) never blocks the keyword sync that already existed. Returns the
 * number of rows upserted. Caller must pass `now` (stays deterministic/testable).
 */
export async function enrichPageStatsFromGsc(db: PrismaClient, shop: string, now: Date): Promise<number> {
  const { accessToken, propertyUrl } = await getGscAccessToken(db, shop);
  const { startDate, endDate } = defaultDateRange(now, PAGE_STAT_WINDOW_DAYS);
  const rows = await querySearchAnalytics(accessToken, propertyUrl, {
    startDate,
    endDate,
    dimensions: ["page"],
    rowLimit: PAGE_STAT_ROW_LIMIT,
  });
  if (rows.length === 0) return 0;

  const pages = rows.map((r) => r.keys?.[0]).filter((p): p is string => !!p);
  const resolved = await resolvePathsToResources(db, shop, pages);

  let synced = 0;
  for (const row of rows) {
    const page = row.keys?.[0];
    if (!page) continue;
    const ref = resolved.get(page);
    // A policy page resolves to a real ShopPolicy id, but this column's domain
    // is the four content types every reader narrows to (freshness, quick
    // wins). Storing "Policy" would put a value in the table that nothing maps.
    const usable = !!ref?.id && isContentResourceType(ref.resourceType);
    const resourceType = usable ? ref!.resourceType : null;
    const resourceId = usable ? ref!.id : null;
    await db.seoGscPageStat.upsert({
      where: { shop_page: { shop, page } },
      create: {
        shop,
        page,
        resourceType,
        resourceId,
        position: row.position,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        windowDays: PAGE_STAT_WINDOW_DAYS,
        syncedAt: now,
      },
      update: {
        resourceType,
        resourceId,
        position: row.position,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        windowDays: PAGE_STAT_WINDOW_DAYS,
        syncedAt: now,
      },
    });
    synced += 1;
  }

  return synced;
}
