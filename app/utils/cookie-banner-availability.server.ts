/**
 * Cookie-Banner availability cache (Plan §7.5)
 *
 * COOKIE_BANNER is documented in Shopify's `unstable` TranslatableResourceType
 * enum but is NOT yet in the pinned stable version's enum, so it can only be
 * reached through a raw fetch against `/admin/api/unstable/graphql.json`.
 *
 * Strategy: ship Cookie-Banner editing today against `unstable`; if Shopify
 * changes the schema there and our calls start failing, the rubric automatically
 * degrades to a "Coming Soon" placeholder instead of breaking — no deploy
 * needed. Recovery is automatic on the next successful probe.
 *
 *   getCookieBannerAvailability(session) → "available" | "unavailable"
 *
 * Cached in-memory per shop with a 15-minute TTL. On a cache miss we fire a tiny
 * probe (1 resource, key field only). Success → "available"; any error (invalid
 * enum, network, auth) → "unavailable". The cache is consulted by:
 *   - the route loader  → editor vs. Coming-Soon placeholder
 *   - the save action   → pre-flight check before attempting writes
 *
 * When COOKIE_BANNER is promoted into the pinned stable enum, the data path can
 * move off the raw `unstable` fetch in a single small change; this cache keeps
 * working either way.
 */

import { logger } from "~/utils/logger.server";

export type CookieBannerAvailability = "available" | "unavailable";

/** Minimal session shape needed to hit the unstable endpoint. */
export interface CookieBannerSession {
  shop: string;
  accessToken?: string;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes

interface CacheEntry {
  status: CookieBannerAvailability;
  expiresAt: number;
}

// Module-level in-memory cache (per server process). Keyed by shop domain.
const cache = new Map<string, CacheEntry>();

const PROBE_QUERY = `query cookieBannerProbe {
  translatableResources(first: 1, resourceType: COOKIE_BANNER) {
    edges { node { resourceId translatableContent { key } } }
  }
}`;

const CONTENT_QUERY = `query cookieBannerContent {
  translatableResources(first: 10, resourceType: COOKIE_BANNER) {
    edges {
      node {
        resourceId
        translatableContent { key value digest locale }
      }
    }
  }
}`;

/** Raw POST against the unstable Admin GraphQL endpoint with the session token. */
async function unstableGraphQL(
  session: CookieBannerSession,
  query: string,
  variables?: Record<string, unknown>
): Promise<{ data?: unknown; errors?: Array<{ message: string }> }> {
  if (!session.accessToken) {
    throw new Error("No access token on session — cannot reach unstable endpoint");
  }
  const resp = await fetch(`https://${session.shop}/admin/api/unstable/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": session.accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  if (!resp.ok) {
    throw new Error(`Unstable endpoint HTTP ${resp.status}`);
  }
  return resp.json();
}

/**
 * Returns whether COOKIE_BANNER translation is currently reachable for this shop.
 * Never throws — any failure resolves to "unavailable" (and is cached so we do
 * not hammer the endpoint).
 */
export async function getCookieBannerAvailability(
  session: CookieBannerSession,
  opts: { force?: boolean } = {}
): Promise<CookieBannerAvailability> {
  const now = Date.now();
  if (!opts.force) {
    const cached = cache.get(session.shop);
    if (cached && cached.expiresAt > now) {
      return cached.status;
    }
  }

  let status: CookieBannerAvailability = "unavailable";
  try {
    const data = await unstableGraphQL(session, PROBE_QUERY);
    status = data.errors?.length ? "unavailable" : "available";
    if (data.errors?.length) {
      logger.debug("[CookieBanner] probe returned errors → unavailable", {
        context: "CookieBanner",
        shop: session.shop,
        error: data.errors[0]?.message,
      });
    }
  } catch (e) {
    logger.debug("[CookieBanner] probe threw → unavailable", {
      context: "CookieBanner",
      shop: session.shop,
      error: e instanceof Error ? e.message : String(e),
    });
    status = "unavailable";
  }

  cache.set(session.shop, { status, expiresAt: now + TTL_MS });
  return status;
}

/** Cookie-Banner translatable content for one resource (primary-locale values). */
export interface CookieBannerResource {
  resourceId: string;
  translatableContent: Array<{ key: string; value: string | null; digest: string | null; locale: string }>;
}

/**
 * Fetch the COOKIE_BANNER translatable resources. Returns null when the resource
 * is unavailable (so the caller can render the Coming-Soon placeholder). Updates
 * the availability cache as a side effect.
 */
export async function getCookieBannerResources(
  session: CookieBannerSession
): Promise<CookieBannerResource[] | null> {
  try {
    const data = (await unstableGraphQL(session, CONTENT_QUERY)) as {
      data?: { translatableResources?: { edges: Array<{ node: CookieBannerResource }> } };
      errors?: Array<{ message: string }>;
    };
    if (data.errors?.length) {
      cache.set(session.shop, { status: "unavailable", expiresAt: Date.now() + TTL_MS });
      return null;
    }
    cache.set(session.shop, { status: "available", expiresAt: Date.now() + TTL_MS });
    return (data.data?.translatableResources?.edges ?? []).map((e) => e.node);
  } catch (e) {
    logger.debug("[CookieBanner] content fetch threw → unavailable", {
      context: "CookieBanner",
      shop: session.shop,
      error: e instanceof Error ? e.message : String(e),
    });
    cache.set(session.shop, { status: "unavailable", expiresAt: Date.now() + TTL_MS });
    return null;
  }
}

const REGISTER_MUTATION = `mutation cookieBannerRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    userErrors { field message }
  }
}`;

/** One foreign-locale value to register, with the source-content digest. */
export interface CookieBannerTranslationInput {
  key: string;
  value: string;
  /** Digest of the PRIMARY-locale content for this key (from getCookieBannerResources). */
  translatableContentDigest: string;
  locale: string;
}

/**
 * Register foreign-locale Cookie-Banner translations via the unstable endpoint.
 * Returns { ok: false, error } on any failure (never throws); the caller renders
 * a graceful message. Flips the availability cache to "unavailable" when the
 * resource has gone away, so the rubric degrades on the next load.
 */
export async function writeCookieBannerTranslations(
  session: CookieBannerSession,
  resourceId: string,
  translations: CookieBannerTranslationInput[]
): Promise<{ ok: boolean; error?: string }> {
  if (translations.length === 0) return { ok: true };
  try {
    const data = (await unstableGraphQL(session, REGISTER_MUTATION, { resourceId, translations })) as {
      data?: { translationsRegister?: { userErrors?: Array<{ message: string }> } };
      errors?: Array<{ message: string }>;
    };
    if (data.errors?.length) {
      // Schema/enum-level rejection → the resource is no longer reachable.
      cache.set(session.shop, { status: "unavailable", expiresAt: Date.now() + TTL_MS });
      return { ok: false, error: data.errors[0]?.message ?? "Cookie banner temporarily unavailable" };
    }
    const userErrors = data.data?.translationsRegister?.userErrors ?? [];
    if (userErrors.length) {
      return { ok: false, error: userErrors[0]?.message ?? "Translation rejected" };
    }
    return { ok: true };
  } catch (e) {
    logger.debug("[CookieBanner] register threw → unavailable", {
      context: "CookieBanner",
      shop: session.shop,
      error: e instanceof Error ? e.message : String(e),
    });
    cache.set(session.shop, { status: "unavailable", expiresAt: Date.now() + TTL_MS });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Test/maintenance helper — clears the in-memory cache. */
export function __clearCookieBannerCache(): void {
  cache.clear();
}
