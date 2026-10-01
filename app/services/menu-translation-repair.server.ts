/**
 * Putting back what a re-parent destroys.
 *
 * MEASURED (2026-08-23, API 2026-07, /api/menu-write-probe): moving a menu item
 * to another parent deletes its translations, even though the item keeps its
 * id and the Link GID we address it by is unchanged. It hits the moved item AND
 * every item that merely came along in its subtree, and it hits the GLOBAL and
 * the MARKET layer alike. Reordering within the same parent does not do it, a
 * plain write does not do it, and an outdated translation is not collected —
 * so this module exists for exactly one operation.
 *
 * The same run measured the remedy: the value can be registered again straight
 * after the write, with a digest read after it. So the shape is capture,
 * write, restore — and the capture has to happen BEFORE the write, because
 * afterwards there is nothing left to read.
 *
 * Two rules that are not obvious:
 *
 *   READ FROM SHOPIFY, NOT FROM OUR MIRROR. A shop that translated its menu in
 *   Shopify's own editor holds values this app has never written; they are
 *   destroyed just the same, and a repair sourced from `ContentTranslation`
 *   would restore only the subset we happened to author.
 *
 *   ONE REGISTER PER ITEM. translationsRegister takes a LIST, so every
 *   (locale, market) pair of one item rides in a single call. A branch of five
 *   items with four locales and three markets is ten calls, not sixty.
 */

import type { PrismaClient } from "@prisma/client";
import type { ShopifyApiGateway } from "./shopify-api-gateway.service";
import { MENU_LINK_KEY, MENU_LINK_RESOURCE_TYPE } from "./menu-translations.server";
// The app's ONE verified register document — its echo selection already asks
// for `locale` and `market { id }`, which is exactly what this module has to
// confirm against. A second copy would be a second thing to keep in step.
//
// `registerAndVerify` next to it is deliberately NOT reused: it confirms by
// KEY, which is right when a call carries one locale, and useless here where
// every entry carries the same key "title" and differs only by locale and
// market. Reusing it would report a five-locale restore as confirmed the
// moment ONE locale came back.
import { TRANSLATE_CONTENT_VERIFIED } from "../graphql/content.mutations";
import { logger } from "../utils/logger.server";

/**
 * How many items one repair may cover.
 *
 * A menu has tens of items, so this is a runaway guard rather than a policy:
 * it exists so a malformed tree cannot turn one save into hundreds of calls.
 * Exceeding it is LOGGED and the excess is reported as failed, never dropped
 * silently — an unrestored translation the merchant is not told about is the
 * failure mode this whole module exists to prevent.
 */
const MAX_REPAIR_ITEMS = 100;

export interface CapturedLinkTranslations {
  linkId: string;
  /** One entry per (locale, market) that actually held a value. */
  values: Array<{ locale: string; marketId: string; value: string }>;
}

/** A GraphQL alias that is always a valid name, whatever the locale looks like. */
function aliasFor(localeIndex: number, marketIndex: number): string {
  return marketIndex < 0 ? `g${localeIndex}` : `m${localeIndex}_${marketIndex}`;
}

/**
 * Read every translation of these links, across every locale and market.
 *
 * One query per link, with the locale/market combinations ALIASED into it so
 * the number of round trips does not multiply. Locale and market values travel
 * as VARIABLES, never interpolated into the document: the list comes from
 * Shopify, but a query assembled from data is an injection waiting for the one
 * caller that passes something else.
 */
export async function captureLinkTranslations(
  gateway: ShopifyApiGateway,
  linkIds: string[],
  locales: string[],
  marketIds: string[],
): Promise<CapturedLinkTranslations[]> {
  if (linkIds.length === 0 || locales.length === 0) return [];

  const ids = linkIds.slice(0, MAX_REPAIR_ITEMS);
  if (linkIds.length > ids.length) {
    logger.warn("[MENU-REPAIR] More items than one repair may cover — the excess is reported as failed", {
      context: "MenuTranslationRepair",
      asked: linkIds.length,
      covered: ids.length,
    });
  }

  // The document is built once and reused for every link: same shape, only the
  // resource id changes.
  const declarations = [
    "$id: ID!",
    ...locales.map((_, i) => `$l${i}: String!`),
    ...marketIds.map((_, i) => `$mk${i}: ID!`),
  ].join(", ");
  const selections: string[] = [];
  locales.forEach((_, li) => {
    selections.push(`${aliasFor(li, -1)}: translations(locale: $l${li}) { key value }`);
    marketIds.forEach((_, mi) => {
      selections.push(`${aliasFor(li, mi)}: translations(locale: $l${li}, marketId: $mk${mi}) { key value }`);
    });
  });
  const query = `#graphql
    query menuRepairCapture(${declarations}) {
      translatableResource(resourceId: $id) {
        resourceId
        ${selections.join("\n        ")}
      }
    }
  `;

  const variables: Record<string, unknown> = {};
  locales.forEach((locale, i) => (variables[`l${i}`] = locale));
  marketIds.forEach((marketId, i) => (variables[`mk${i}`] = marketId));

  const out: CapturedLinkTranslations[] = [];
  for (const linkId of ids) {
    try {
      const response = await gateway.graphql(query, { variables: { ...variables, id: linkId } });
      const payload = (await response.json()) as {
        data?: { translatableResource?: Record<string, unknown> | null };
        errors?: Array<{ message: string }>;
      };
      if (payload.errors?.length) {
        logger.warn("[MENU-REPAIR] Could not capture an item's translations before the move", {
          context: "MenuTranslationRepair",
          linkId,
          error: payload.errors[0].message,
        });
        continue;
      }
      const resource = payload.data?.translatableResource;
      if (!resource) continue;

      const values: CapturedLinkTranslations["values"] = [];
      const pick = (alias: string): string | null => {
        const rows = resource[alias] as Array<{ key: string; value: string }> | undefined;
        return rows?.find((r) => r.key === MENU_LINK_KEY)?.value ?? null;
      };
      locales.forEach((locale, li) => {
        const global = pick(aliasFor(li, -1));
        if (global) values.push({ locale, marketId: "", value: global });
        marketIds.forEach((marketId, mi) => {
          const scoped = pick(aliasFor(li, mi));
          // A market read returns the market's OWN row only (measured), so a
          // value here is genuinely market-specific and not an echo of the
          // global one.
          if (scoped) values.push({ locale, marketId, value: scoped });
        });
      });
      if (values.length > 0) out.push({ linkId, values });
    } catch (error) {
      logger.warn("[MENU-REPAIR] Capture threw", {
        context: "MenuTranslationRepair",
        linkId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

const DIGEST_QUERY = `#graphql
  query menuRepairDigest($id: ID!) {
    translatableResource(resourceId: $id) {
      translatableContent {
        key
        digest
      }
    }
  }
`;

export interface RestoreOutcome {
  /** How many (item, locale, market) values are back. */
  restored: number;
  failed: Array<{ linkId: string; message: string }>;
}

/**
 * Write the captured values back.
 *
 * The digest is read AFTER the move, never carried over from the capture:
 * translationsRegister is bound to the digest of the CURRENT primary value,
 * and a stale one is refused. The echo is then checked per value — an accepted
 * mutation that stored nothing is the failure this codebase names most often,
 * and here it would mean a translation the merchant believes is safe.
 */
export async function restoreLinkTranslations(
  gateway: ShopifyApiGateway,
  db: PrismaClient,
  shop: string,
  captured: CapturedLinkTranslations[],
): Promise<RestoreOutcome> {
  const outcome: RestoreOutcome = { restored: 0, failed: [] };

  for (const entry of captured) {
    try {
      const digestResponse = await gateway.graphql(DIGEST_QUERY, { variables: { id: entry.linkId } });
      const digestPayload = (await digestResponse.json()) as {
        data?: {
          translatableResource?: { translatableContent?: Array<{ key: string; digest: string | null }> } | null;
        };
        errors?: Array<{ message: string }>;
      };
      if (digestPayload.errors?.length) {
        outcome.failed.push({ linkId: entry.linkId, message: digestPayload.errors[0].message });
        continue;
      }
      const digest =
        digestPayload.data?.translatableResource?.translatableContent?.find((c) => c.key === MENU_LINK_KEY)
          ?.digest ?? null;
      if (!digest) {
        outcome.failed.push({
          linkId: entry.linkId,
          message: "No translatable content digest after the move — the value could not be written back.",
        });
        continue;
      }

      const response = await gateway.graphql(TRANSLATE_CONTENT_VERIFIED, {
        variables: {
          resourceId: entry.linkId,
          translations: entry.values.map((v) => ({
            key: MENU_LINK_KEY,
            locale: v.locale,
            value: v.value,
            translatableContentDigest: digest,
            ...(v.marketId ? { marketId: v.marketId } : {}),
          })),
        },
      });
      const payload = (await response.json()) as {
        data?: {
          translationsRegister?: {
            translations?: Array<{ key: string; value: string; locale: string; market?: { id: string } | null }>;
            userErrors?: Array<{ message: string }>;
          };
        };
        errors?: Array<{ message: string }>;
      };
      if (payload.errors?.length) {
        outcome.failed.push({ linkId: entry.linkId, message: payload.errors[0].message });
        continue;
      }
      const userErrors = payload.data?.translationsRegister?.userErrors ?? [];
      if (userErrors.length > 0) {
        outcome.failed.push({ linkId: entry.linkId, message: userErrors[0].message });
        continue;
      }

      const echoed = payload.data?.translationsRegister?.translations ?? [];
      const confirmed = new Set(
        echoed
          .filter((t) => t.key === MENU_LINK_KEY)
          .map((t) => `${t.locale} ${t.market?.id ?? ""}`),
      );

      const missed: string[] = [];
      for (const value of entry.values) {
        if (!confirmed.has(`${value.locale} ${value.marketId}`)) {
          missed.push(`${value.locale}${value.marketId ? ` / ${value.marketId}` : ""}`);
          continue;
        }
        outcome.restored += 1;
        // Mirror only what Shopify confirmed, and only after it confirmed —
        // the local row must never outrun the storefront.
        await db.contentTranslation.upsert({
          where: {
            shop_resourceId_key_locale_marketId: {
              shop,
              resourceId: entry.linkId,
              key: MENU_LINK_KEY,
              locale: value.locale,
              marketId: value.marketId,
            },
          },
          create: {
            shop,
            resourceId: entry.linkId,
            resourceType: MENU_LINK_RESOURCE_TYPE,
            key: MENU_LINK_KEY,
            locale: value.locale,
            marketId: value.marketId,
            value: value.value,
            digest,
          },
          update: { value: value.value, digest, resourceType: MENU_LINK_RESOURCE_TYPE },
        });
      }
      if (missed.length > 0) {
        outcome.failed.push({
          linkId: entry.linkId,
          message: `Shopify did not confirm the restored translation for: ${missed.join(", ")}.`,
        });
      }
    } catch (error) {
      outcome.failed.push({
        linkId: entry.linkId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (outcome.failed.length > 0) {
    logger.warn("[MENU-REPAIR] Some translations could not be restored after a move", {
      context: "MenuTranslationRepair",
      shop,
      restored: outcome.restored,
      failed: outcome.failed.length,
    });
  }
  return outcome;
}
