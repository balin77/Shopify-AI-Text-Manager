/**
 * Publish / unpublish a shop's languages from inside the app
 * (Settings → Shop-Sprachen).
 *
 * An UNPUBLISHED language is one the merchant is preparing: this app syncs,
 * keeps and auto-translates it exactly like a published one
 * (`translationForeignLocales`), and publishing it is the launch. This module
 * is the one writer of that switch.
 *
 * Rules:
 *  - `shopLocaleUpdate` with `shopLocale: { published }`, one call per locale
 *    (the mutation addresses exactly one).
 *  - A change counts only when Shopify ECHOES the locale back with the
 *    requested `published` value — `userErrors: []` is not enough (the app-wide
 *    echo rule). A top-level `errors` array (a schema-level refusal, or the
 *    missing `write_locales` scope) is a failure with Shopify's own words, never
 *    a silent success.
 *  - The PRIMARY locale is refused before anything is sent: Shopify serves the
 *    storefront in it, and it cannot be unpublished.
 *  - The 60s shop-locale cache is cleared after any confirmed change, or every
 *    page would keep showing the old state for a minute.
 *
 * Not measured, stated: whether a locale published this way is then SHOWN in a
 * given market depends on that market's web presence (Shopify → Markets); this
 * module only flips the shop-level switch, which is the one the Shopify admin's
 * "Publish" button flips too.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger.server";

export interface LocalePublicationChange {
  locale: string;
  published: boolean;
}

export interface LocalePublicationResult {
  confirmed: LocalePublicationChange[];
  failed: Array<{ locale: string; error: string }>;
}

type GraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

// No comments or non-ASCII inside a #graphql document (CLAUDE.md).
const SHOP_LOCALE_UPDATE = `#graphql
  mutation appShopLocaleUpdate($locale: String!, $shopLocale: ShopLocaleInput!) {
    shopLocaleUpdate(locale: $locale, shopLocale: $shopLocale) {
      shopLocale {
        locale
        published
      }
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * Which submitted changes are real work: a known, non-primary locale whose
 * requested state differs from the current one. Pure, so the route and the
 * tests share one reading. Unknown locales and the primary come back as
 * refusals, a no-op is dropped.
 */
export function planLocalePublication(
  current: ReadonlyArray<{ locale: string; primary: boolean; published: boolean }>,
  requested: readonly LocalePublicationChange[],
): { changes: LocalePublicationChange[]; refused: Array<{ locale: string; error: string }> } {
  const byLocale = new Map(current.map((l) => [l.locale, l]));
  const changes: LocalePublicationChange[] = [];
  const refused: Array<{ locale: string; error: string }> = [];
  const seen = new Set<string>();
  for (const change of requested) {
    if (seen.has(change.locale)) continue;
    seen.add(change.locale);
    const known = byLocale.get(change.locale);
    if (!known) {
      refused.push({ locale: change.locale, error: "unknownLocale" });
      continue;
    }
    if (known.primary) {
      refused.push({ locale: change.locale, error: "primaryLocale" });
      continue;
    }
    if (known.published === change.published) continue;
    changes.push({ locale: change.locale, published: change.published });
  }
  return { changes, refused };
}

export async function setShopLocalesPublished(
  admin: GraphqlClient,
  shop: string,
  changes: readonly LocalePublicationChange[],
): Promise<LocalePublicationResult> {
  const result: LocalePublicationResult = { confirmed: [], failed: [] };
  // Sequential: a handful of locales at most, and a failure in one must not
  // race the next into the rate limiter.
  for (const change of changes) {
    try {
      const response = await admin.graphql(SHOP_LOCALE_UPDATE, {
        variables: { locale: change.locale, shopLocale: { published: change.published } },
      });
      const body = (await response.json()) as {
        errors?: Array<{ message?: string }>;
        data?: {
          shopLocaleUpdate?: {
            shopLocale?: { locale?: string; published?: boolean } | null;
            userErrors?: Array<{ message?: string }>;
          } | null;
        } | null;
      };
      if (body.errors?.length) {
        result.failed.push({ locale: change.locale, error: body.errors[0]?.message || "GraphQL error" });
        continue;
      }
      const payload = body.data?.shopLocaleUpdate;
      const userErrors = payload?.userErrors ?? [];
      if (userErrors.length > 0) {
        result.failed.push({ locale: change.locale, error: userErrors.map((e) => e.message).join("; ") });
        continue;
      }
      const echoed = payload?.shopLocale;
      if (!echoed || echoed.locale !== change.locale || echoed.published !== change.published) {
        result.failed.push({ locale: change.locale, error: "notConfirmed" });
        continue;
      }
      result.confirmed.push(change);
    } catch (error: unknown) {
      result.failed.push({ locale: change.locale, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (result.confirmed.length > 0) {
    const { clearShopLocalesCache } = await import("../utils/shop-locales-cache.server");
    clearShopLocalesCache(shop);
  }
  if (result.failed.length > 0) {
    logger.warn("[ShopLocalePublish] Some locale changes were not confirmed", {
      context: "ShopLocalePublish",
      shop,
      failed: result.failed,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Adding and removing a language
// ---------------------------------------------------------------------------
//
// A language ADDED here is enabled UNPUBLISHED (Shopify's own default), which
// is exactly the "prepare, then launch" flow: the app fills it like any other
// locale and the merchant publishes it when it is ready. A language REMOVED
// here is disabled on Shopify — which, per Shopify's documentation, takes its
// translations with it (NOT measured by this app; the tab states it as a
// warning and asks for a separate confirmation). After a CONFIRMED removal the
// local mirrors of that locale go too, every layer: they describe nothing any
// more, and if Shopify should keep the translations after all, re-adding the
// language and the next sync bring them back.

const AVAILABLE_LOCALES = `#graphql
  query appAvailableLocales {
    availableLocales {
      isoCode
      name
    }
  }`;

const SHOP_LOCALE_ENABLE = `#graphql
  mutation appShopLocaleEnable($locale: String!) {
    shopLocaleEnable(locale: $locale) {
      shopLocale {
        locale
        published
      }
      userErrors {
        field
        message
      }
    }
  }`;

const SHOP_LOCALE_DISABLE = `#graphql
  mutation appShopLocaleDisable($locale: String!) {
    shopLocaleDisable(locale: $locale) {
      locale
      userErrors {
        field
        message
      }
    }
  }`;

export interface AvailableLocale {
  isoCode: string;
  name: string;
}

/**
 * Every language Shopify lets a shop add. `null` on a failed read — "we cannot
 * tell" must not render as "nothing can be added".
 */
export async function loadAvailableLocales(admin: GraphqlClient): Promise<AvailableLocale[] | null> {
  try {
    const response = await admin.graphql(AVAILABLE_LOCALES);
    const body = (await response.json()) as {
      errors?: unknown[];
      data?: { availableLocales?: AvailableLocale[] | null } | null;
    };
    if (body.errors?.length || !Array.isArray(body.data?.availableLocales)) return null;
    return body.data!.availableLocales!.filter((l) => l && typeof l.isoCode === "string");
  } catch {
    return null;
  }
}

/**
 * The full set of changes one save may carry, replayed over the shop's CURRENT
 * locales and the languages Shopify offers. Pure (the route and the tests share
 * it). A locale in both `add` and `remove` is dropped from both; a locale being
 * removed carries no publication change; an ADDED locale may ask to be
 * published right away (it is enabled unpublished first).
 */
export function planLocaleChanges(
  current: ReadonlyArray<{ locale: string; primary: boolean; published: boolean }>,
  available: ReadonlyArray<AvailableLocale> | null,
  requested: {
    publish: readonly LocalePublicationChange[];
    add: ReadonlyArray<{ locale: string; published: boolean }>;
    remove: readonly string[];
  },
): {
  add: Array<{ locale: string; published: boolean }>;
  remove: string[];
  publish: LocalePublicationChange[];
  refused: Array<{ locale: string; error: string }>;
} {
  const refused: Array<{ locale: string; error: string }> = [];
  const enabled = new Map(current.map((l) => [l.locale, l]));
  const addSet = new Set(requested.add.map((a) => a.locale));
  const removeSet = new Set(requested.remove);
  const both = new Set([...addSet].filter((l) => removeSet.has(l)));

  const add: Array<{ locale: string; published: boolean }> = [];
  const seenAdd = new Set<string>();
  for (const entry of requested.add) {
    if (both.has(entry.locale) || seenAdd.has(entry.locale)) continue;
    seenAdd.add(entry.locale);
    if (enabled.has(entry.locale)) {
      refused.push({ locale: entry.locale, error: "alreadyEnabled" });
      continue;
    }
    if (available === null) {
      refused.push({ locale: entry.locale, error: "availableLookupFailed" });
      continue;
    }
    if (!available.some((a) => a.isoCode === entry.locale)) {
      refused.push({ locale: entry.locale, error: "notAvailable" });
      continue;
    }
    add.push({ locale: entry.locale, published: !!entry.published });
  }

  const remove: string[] = [];
  for (const locale of new Set(requested.remove)) {
    if (both.has(locale)) continue;
    const known = enabled.get(locale);
    if (!known) {
      refused.push({ locale, error: "unknownLocale" });
      continue;
    }
    if (known.primary) {
      refused.push({ locale, error: "primaryLocale" });
      continue;
    }
    remove.push(locale);
  }

  const removing = new Set(remove);
  const plan = planLocalePublication(
    current,
    requested.publish.filter((c) => !removing.has(c.locale) && !addSet.has(c.locale)),
  );
  return { add, remove, publish: plan.changes, refused: [...refused, ...plan.refused] };
}

type MinimalDb = Pick<
  PrismaClient,
  "contentTranslation" | "themeTranslation" | "metaobjectTranslation" | "productImageAltTranslation" | "autoTranslateRetry"
>;

/**
 * The retry list's owed pairs for the removed locales. A PENDING row sheds them
 * by itself (the sweep filters to the shop's current locales), but an
 * EXHAUSTED row is never looked at again and is cleared only by a delivery —
 * which can no longer happen for a language that is gone, so it would stay
 * listed in the auto-translate card for good.
 */
async function purgeRetryPairs(db: MinimalDb, shop: string, removed: readonly string[]): Promise<void> {
  const { retryPairsOf } = await import("./translations/translation-retry.server");
  const gone = new Set(removed.map((l) => l.toLowerCase()));
  const rows = await db.autoTranslateRetry.findMany({ where: { shop }, select: { id: true, pairs: true } });
  for (const row of rows) {
    const pairs = retryPairsOf(row.pairs);
    const kept = pairs.filter((p) => !gone.has(p.locale.toLowerCase()));
    if (kept.length === pairs.length) continue;
    if (kept.length === 0) await db.autoTranslateRetry.delete({ where: { id: row.id } });
    else await db.autoTranslateRetry.update({ where: { id: row.id }, data: { pairs: kept as unknown as object } });
  }
}

const lc = (s: string) => s.toLowerCase();
const sameLocale = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

async function runLocaleMutation(
  admin: GraphqlClient,
  document: string,
  locale: string,
  confirmed: (payload: Record<string, unknown> | null | undefined) => boolean,
  field: "shopLocaleEnable" | "shopLocaleDisable",
): Promise<string | null> {
  try {
    const response = await admin.graphql(document, { variables: { locale } });
    const body = (await response.json()) as {
      errors?: Array<{ message?: string }>;
      data?: Record<string, { userErrors?: Array<{ message?: string }> } & Record<string, unknown>> | null;
    };
    if (body.errors?.length) return body.errors[0]?.message || "GraphQL error";
    const payload = body.data?.[field];
    const userErrors = payload?.userErrors ?? [];
    if (userErrors.length > 0) return userErrors.map((e) => e.message).join("; ");
    return confirmed(payload) ? null : "notConfirmed";
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

const SHOP_LOCALES_PUBLISHED = `#graphql
  query appShopLocalesPublished {
    shopLocales {
      locale
      published
    }
  }`;

/**
 * The market write sends `marketWebPresenceIds` ALONE, after the publish step.
 * Whether Shopify ties presence membership to publication (auto-publishing on
 * assignment, or unpublishing on removal) is NOT measured — if it does, a
 * publish flip confirmed a moment earlier in the same save would be undone
 * silently. So every locale a market write touched is checked once against the
 * state this save meant to leave it in. A failed read reports nothing: it can
 * neither confirm nor refute.
 */
async function publicationMovedByMarkets(
  admin: GraphqlClient,
  touched: readonly LocaleMarketChange[],
  confirmedPublish: readonly LocalePublicationChange[],
  added: readonly string[],
  before: Record<string, boolean> = {},
): Promise<Array<{ locale: string; error: string }>> {
  try {
    const response = await admin.graphql(SHOP_LOCALES_PUBLISHED);
    const body = (await response.json()) as {
      errors?: unknown[];
      data?: { shopLocales?: Array<{ locale?: string; published?: boolean }> | null } | null;
    };
    const rows = body.data?.shopLocales;
    if (body.errors?.length || !Array.isArray(rows)) return [];
    const now = new Map(rows.map((r) => [lc(String(r.locale)), r.published]));
    const out: Array<{ locale: string; error: string }> = [];
    for (const change of touched) {
      const key = lc(change.locale);
      const explicit = confirmedPublish.find((c) => lc(c.locale) === key);
      const expected =
        explicit?.published ??
        Object.entries(before).find(([l]) => lc(l) === key)?.[1] ??
        (added.some((a) => lc(a) === key) ? false : undefined);
      const actual = now.get(key);
      if (expected === undefined || typeof actual !== "boolean") continue;
      if (actual !== expected) out.push({ locale: change.locale, error: "publicationMovedByMarkets" });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Apply one planned save: enable what is added (then publish those asked to
 * be), flip the publications, disable what is removed and purge its local
 * mirrors. Each step counts only on Shopify's ECHO; one failure never stops
 * the others.
 */
export async function applyLocaleChanges(
  admin: GraphqlClient,
  db: MinimalDb,
  shop: string,
  plan: {
    add: Array<{ locale: string; published: boolean }>;
    remove: string[];
    publish: LocalePublicationChange[];
    /** From `planMarketAssignments`; applied after adding and publishing. */
    markets?: LocaleMarketChange[];
    /** Each existing locale's `published` BEFORE this save — what the market
     *  write must not have moved (see the re-check below). */
    publishedBefore?: Record<string, boolean>;
  },
): Promise<{
  added: string[];
  removed: string[];
  confirmed: LocalePublicationChange[];
  marketsConfirmed: LocaleMarketChange[];
  failed: Array<{ locale: string; error: string }>;
}> {
  const added: string[] = [];
  const removed: string[] = [];
  const failed: Array<{ locale: string; error: string }> = [];
  const publishAfterAdd: LocalePublicationChange[] = [];

  for (const entry of plan.add) {
    const error = await runLocaleMutation(
      admin,
      SHOP_LOCALE_ENABLE,
      entry.locale,
      (payload) => sameLocale((payload?.shopLocale as { locale?: string } | undefined)?.locale, entry.locale),
      "shopLocaleEnable",
    );
    if (error) {
      failed.push({ locale: entry.locale, error });
      continue;
    }
    added.push(entry.locale);
    if (entry.published) publishAfterAdd.push({ locale: entry.locale, published: true });
  }

  const published = await setShopLocalesPublished(admin, shop, [...plan.publish, ...publishAfterAdd]);
  failed.push(...published.failed);

  // A language whose ADDITION failed does not exist on Shopify, so its market
  // assignment is not sent — the add's own failure already names it.
  const failedAdds = new Set(plan.add.filter((a) => !added.includes(a.locale)).map((a) => lc(a.locale)));
  const marketChanges = (plan.markets ?? []).filter((m) => !failedAdds.has(lc(m.locale)));
  const markets = await setLocaleMarkets(admin, marketChanges);
  failed.push(...markets.failed);
  if (marketChanges.length > 0) {
    failed.push(...(await publicationMovedByMarkets(admin, marketChanges, published.confirmed, added, plan.publishedBefore)));
  }

  for (const locale of plan.remove) {
    const error = await runLocaleMutation(
      admin,
      SHOP_LOCALE_DISABLE,
      locale,
      (payload) => sameLocale(payload?.locale, locale),
      "shopLocaleDisable",
    );
    if (error) {
      failed.push({ locale, error });
      continue;
    }
    removed.push(locale);
  }

  if (removed.length > 0) {
    // Every layer of the removed locales; a failure here is bookkeeping after
    // an irreversible act and must not report the removal as failed — the
    // next sync of each resource drops what is left (it no longer reads the
    // locale, and its delete scope has no locale filter).
    try {
      const where = { shop, locale: { in: removed } };
      // Its own failure must not cost the mirror purge below.
      await purgeRetryPairs(db, shop, removed).catch((error: unknown) =>
        logger.warn("[ShopLocalePublish] Retry pairs of a removed locale could not be purged", {
          context: "ShopLocalePublish",
          shop,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await Promise.all([
        db.contentTranslation.deleteMany({ where }),
        db.themeTranslation.deleteMany({ where }),
        db.metaobjectTranslation.deleteMany({ where }),
        db.productImageAltTranslation.deleteMany({
          where: { locale: { in: removed }, image: { product: { shop } } },
        }),
      ]);
    } catch (error: unknown) {
      logger.warn("[ShopLocalePublish] Local mirrors of a removed locale could not be purged", {
        context: "ShopLocalePublish",
        shop,
        removed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failed.length > 0) {
    logger.warn("[ShopLocalePublish] Some language changes were not confirmed", {
      context: "ShopLocalePublish",
      shop,
      failed,
    });
  }

  if (added.length > 0 || removed.length > 0) {
    const { clearShopLocalesCache } = await import("../utils/shop-locales-cache.server");
    clearShopLocalesCache(shop);
  }

  return { added, removed, confirmed: published.confirmed, marketsConfirmed: markets.confirmed, failed };
}

// ---------------------------------------------------------------------------
// Which MARKETS show a language
// ---------------------------------------------------------------------------
//
// Publishing a language is not enough for the storefront's language picker:
// it lists only the languages of the visitor's market WEB PRESENCE (Shopify
// admin → Markets → a market → Languages). A language added and published here
// therefore showed nowhere until the merchant found that setting — reported by
// the owner with Dutch on a live shop, 2026-09.
//
// The unit of assignment is the WEB PRESENCE, not the market: secondary markets
// often SHARE the primary market's presence (CLAUDE.md, "Markets"), and a
// language on a shared presence is on every market using it — so the tab offers
// one checkbox per presence, labelled with every market that uses it.
//
// READ: the markets query whose shape `loadMarkets` already runs in production,
// with the presence `id` added. Only presences of an ACTIVE market are OFFERED
// (the CLAUDE.md gate), but every presence is read: the write sends a FULL set,
// and a set built from active markets alone would, under replace semantics,
// silently take the language off a draft market's presence — so a presence of
// an inactive market that carries the locale is preserved in every set sent.
// WRITE: `shopLocaleUpdate(locale, shopLocale: { marketWebPresenceIds })` — the
// FULL set of presences the locale should be on. NOT measured (the schema proxy
// is unreachable from the build sandbox): neither the input field nor whether it
// replaces or adds. So the write is confirmed by RE-READING the presences, never
// by its echo — a set that did not come out as requested is "notConfirmed",
// which also catches an add-only reading of the field. A presence whose DEFAULT
// language is this locale always keeps it (Shopify cannot drop a presence's
// default language), so the plan forces those in rather than sending a removal
// that must fail.

// Paged, and both connections report `pageInfo`: the write sends a FULL set, so
// a presence the read never reached would be dropped from it under replace
// semantics, and the confirming re-read would share the blind spot and call it
// confirmed. A read that cannot prove it saw everything is `null`.
const MARKET_WEB_PRESENCES = `#graphql
  query appMarketWebPresences($after: String) {
    markets(first: 50, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          status
          webPresences(first: 10) {
            pageInfo {
              hasNextPage
            }
            edges {
              node {
                id
                defaultLocale {
                  locale
                }
                alternateLocales {
                  locale
                }
              }
            }
          }
        }
      }
    }
  }`;

/** A shop with more markets than this is read as "could not load" rather than half-read. */
const MAX_MARKET_PAGES = 20;

const SHOP_LOCALE_MARKETS_UPDATE = `#graphql
  mutation appShopLocaleMarkets($locale: String!, $shopLocale: ShopLocaleInput!) {
    shopLocaleUpdate(locale: $locale, shopLocale: $shopLocale) {
      shopLocale {
        locale
      }
      userErrors {
        field
        message
      }
    }
  }`;

export interface MarketWebPresence {
  id: string;
  /** Names of every ACTIVE market that uses this presence, in Shopify's order. */
  marketNames: string[];
  /** Used by at least one ACTIVE market — only those are offered in the tab. */
  active: boolean;
  defaultLocale: string;
  /** Default + alternates, lower-cased for comparison. */
  locales: string[];
}

export interface LocaleMarketChange {
  locale: string;
  webPresenceIds: string[];
}


/**
 * The shop's market web presences with the languages each one serves. `null` on
 * a failed read (a missing scope, a throttle, a schema change) — "we cannot
 * tell" must never render as "this language is in no market".
 */
export async function loadMarketWebPresences(admin: GraphqlClient): Promise<MarketWebPresence[] | null> {
  type PageInfo = { hasNextPage?: boolean; endCursor?: string | null } | null;
  try {
    const byId = new Map<string, MarketWebPresence>();
    let after: string | null = null;
    for (let page = 0; page < MAX_MARKET_PAGES; page++) {
      const response = await admin.graphql(MARKET_WEB_PRESENCES, { variables: { after } });
      const body = (await response.json()) as {
        errors?: unknown[];
        data?: {
          markets?: {
            pageInfo?: PageInfo;
            edges?: Array<{
              node?: {
                name?: string;
                status?: string;
                webPresences?: {
                  pageInfo?: PageInfo;
                  edges?: Array<{
                    node?: {
                      id?: string;
                      defaultLocale?: { locale?: string } | null;
                      alternateLocales?: Array<{ locale?: string } | null> | null;
                    } | null;
                  }>;
                } | null;
              } | null;
            }>;
          } | null;
        } | null;
      };
      const markets = body.data?.markets;
      const edges = markets?.edges;
      if (body.errors?.length || !Array.isArray(edges) || typeof markets?.pageInfo?.hasNextPage !== "boolean") {
        return null;
      }
      for (const edge of edges) {
        const market = edge?.node;
        if (!market) return null;
        const active = market.status === "ACTIVE";
        const presences = market.webPresences;
        // A market with no web presence (B2B, POS) answers an empty list; a
        // truncated or unanswered list is not the same thing.
        if (presences && presences.pageInfo?.hasNextPage !== false) return null;
        for (const wpEdge of presences?.edges ?? []) {
          const wp = wpEdge?.node;
          const defaultLocale = wp?.defaultLocale?.locale;
          // Incomplete ⇒ we cannot say which languages it carries: refuse.
          if (!wp?.id || !defaultLocale) return null;
          const existing = byId.get(wp.id);
          if (existing) {
            if (active) {
              existing.active = true;
              if (market.name && !existing.marketNames.includes(market.name)) existing.marketNames.push(market.name);
            }
            continue;
          }
          const alternates = (wp.alternateLocales ?? [])
            .map((a) => a?.locale)
            .filter((l): l is string => typeof l === "string");
          byId.set(wp.id, {
            id: wp.id,
            marketNames: active && market.name ? [market.name] : [],
            active,
            defaultLocale,
            locales: [...new Set([defaultLocale, ...alternates].map(lc))],
          });
        }
      }
      if (!markets!.pageInfo!.hasNextPage) return [...byId.values()];
      after = markets!.pageInfo!.endCursor ?? null;
      if (!after) return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** The presences a locale is on right now. */
export function presencesOfLocale(presences: readonly MarketWebPresence[], locale: string): string[] {
  return presences.filter((p) => p.locales.includes(lc(locale))).map((p) => p.id);
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Which requested market assignments are real work. Pure. A locale must exist
 * (or be added in the same save) and not be the primary or being removed; an id
 * that is no presence of this shop refuses that locale's change outright rather
 * than sending a partial set; a presence whose DEFAULT language this is stays in
 * the set; an unchanged set is dropped.
 */
export function planMarketAssignments(
  current: ReadonlyArray<{ locale: string; primary: boolean }>,
  presences: readonly MarketWebPresence[] | null,
  requested: readonly LocaleMarketChange[],
  context: { adding?: readonly string[]; removing?: readonly string[] } = {},
): { changes: LocaleMarketChange[]; refused: Array<{ locale: string; error: string }> } {
  const changes: LocaleMarketChange[] = [];
  const refused: Array<{ locale: string; error: string }> = [];
  if (requested.length === 0) return { changes, refused };
  if (presences === null) {
    return { changes, refused: requested.map((r) => ({ locale: r.locale, error: "marketsUnreadable" })) };
  }
  const known = new Map(current.map((l) => [lc(l.locale), l]));
  const adding = new Set((context.adding ?? []).map(lc));
  const removing = new Set((context.removing ?? []).map(lc));
  const offered = new Set(presences.filter((p) => p.active).map((p) => p.id));
  const seen = new Set<string>();
  for (const request of requested) {
    const key = lc(request.locale);
    if (seen.has(key) || removing.has(key)) continue;
    seen.add(key);
    const entry = known.get(key);
    if (!entry && !adding.has(key)) {
      refused.push({ locale: request.locale, error: "unknownLocale" });
      continue;
    }
    if (entry?.primary) {
      refused.push({ locale: request.locale, error: "primaryLocale" });
      continue;
    }
    const ids = [...new Set(request.webPresenceIds)];
    if (ids.some((id) => !offered.has(id))) {
      refused.push({ locale: request.locale, error: "unknownMarket" });
      continue;
    }
    // Kept whatever was ticked: the presences whose DEFAULT this is, and the
    // inactive ones the tab does not show.
    const forced = presences
      .filter((p) => lc(p.defaultLocale) === key || (!p.active && p.locales.includes(key)))
      .map((p) => p.id);
    const wanted = [...new Set([...ids, ...forced])];
    // An added locale is on no presence yet; an unchanged set costs no call.
    const now = entry ? presencesOfLocale(presences, request.locale) : [];
    if (sameSet(wanted, now)) continue;
    changes.push({ locale: request.locale, webPresenceIds: wanted });
  }
  return { changes, refused };
}

/**
 * Send each assignment, then RE-READ the presences once and confirm every
 * locale's set against it. One failure never stops the others.
 */
export async function setLocaleMarkets(
  admin: GraphqlClient,
  changes: readonly LocaleMarketChange[],
): Promise<{ confirmed: LocaleMarketChange[]; failed: Array<{ locale: string; error: string }> }> {
  const confirmed: LocaleMarketChange[] = [];
  const failed: Array<{ locale: string; error: string }> = [];
  const sent: LocaleMarketChange[] = [];
  for (const change of changes) {
    try {
      const response = await admin.graphql(SHOP_LOCALE_MARKETS_UPDATE, {
        variables: { locale: change.locale, shopLocale: { marketWebPresenceIds: change.webPresenceIds } },
      });
      const body = (await response.json()) as {
        errors?: Array<{ message?: string }>;
        data?: {
          shopLocaleUpdate?: {
            shopLocale?: { locale?: string } | null;
            userErrors?: Array<{ message?: string }>;
          } | null;
        } | null;
      };
      if (body.errors?.length) {
        failed.push({ locale: change.locale, error: body.errors[0]?.message || "GraphQL error" });
        continue;
      }
      const userErrors = body.data?.shopLocaleUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        failed.push({ locale: change.locale, error: userErrors.map((e) => e.message).join("; ") });
        continue;
      }
      if (!sameLocale(body.data?.shopLocaleUpdate?.shopLocale?.locale, change.locale)) {
        failed.push({ locale: change.locale, error: "notConfirmed" });
        continue;
      }
      sent.push(change);
    } catch (error: unknown) {
      failed.push({ locale: change.locale, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (sent.length > 0) {
    const after = await loadMarketWebPresences(admin);
    for (const change of sent) {
      if (after === null) {
        failed.push({ locale: change.locale, error: "marketsUnverified" });
      } else if (sameSet(presencesOfLocale(after, change.locale), change.webPresenceIds)) {
        confirmed.push(change);
      } else {
        failed.push({ locale: change.locale, error: "notConfirmed" });
      }
    }
  }
  return { confirmed, failed };
}
