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
  plan: { add: Array<{ locale: string; published: boolean }>; remove: string[]; publish: LocalePublicationChange[] },
): Promise<{
  added: string[];
  removed: string[];
  confirmed: LocalePublicationChange[];
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

  return { added, removed, confirmed: published.confirmed, failed };
}
