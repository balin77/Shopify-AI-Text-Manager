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
