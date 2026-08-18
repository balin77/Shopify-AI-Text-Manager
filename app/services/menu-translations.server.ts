/**
 * Menu translations — the Shopify + Prisma half.
 *
 * Reading and writing are deliberately asymmetric, and both shapes come from
 * the live measurement recorded in CLAUDE.md:
 *
 * READ is one flat sweep. translatableResources(resourceType: LINK) returns
 * every Link of the shop with its digest and primary title in a page or two —
 * 59 rows for a 59-item shop — while the per-menu nested connection returns
 * nothing at all. The sweep does not say which menu a link belongs to, and it
 * does not have to: the caller already holds the menu tree and derives each
 * item's Link GID from its MenuItem GID, so the join is by id and never by
 * title. Titles repeat across menus; ids do not.
 *
 * WRITE is one call per item. translationsRegister addresses ONE resourceId,
 * and each menu item is its own resource, so a save of N items is N calls.
 * They go through the echo-verified registerAndVerify / removeAndVerify the
 * bulk editor already owns rather than a second implementation of the same
 * rules — Shopify can answer without userErrors and store nothing, and the
 * local row must never outrun what Shopify confirmed.
 *
 * Failures are per ITEM, never all-or-nothing: one stale digest in a menu of
 * sixty must not discard the other fifty-nine edits.
 */

import type { ShopifyApiGateway } from "./shopify-api-gateway.service";
import { registerAndVerify, removeAndVerify } from "./bulk-editor/translations.server";
import { flattenMenuItems } from "./menu-translations.shared";
import { logger } from "../utils/logger.server";
import type { PrismaClient } from "@prisma/client";

/**
 * The ContentTranslation.resourceType for a menu item, matching the Shopify
 * TranslatableResourceType value. One string, one place — a second spelling
 * elsewhere would make the rows invisible to whoever reads them next.
 */
export const MENU_LINK_RESOURCE_TYPE = "Link";
/** The only translatable key a Link has. A link's URL is not translatable. */
export const MENU_LINK_KEY = "title";

/**
 * Sweep paging. The page SIZE is divided by the number of locales asked for,
 * because each locale adds its own aliased translations() connection to every
 * node and Shopify prices a query by its whole selection, not by its rows: at
 * 250 nodes a five-language shop would blow the max query cost, the sweep
 * would throw, and every menu item would render disabled — the feature
 * failing exactly on the shops that need it most. The cap then rises with the
 * same factor so the total reach stays put.
 */
const SWEEP_MAX_NODES = 250;
const SWEEP_MIN_NODES = 25;
const SWEEP_MAX_LINKS = 2000;

export interface LinkTranslationRow {
  linkId: string;
  /** The primary-locale title as Shopify holds it. */
  primaryTitle: string | null;
  /** Required by translationsRegister; null means this row cannot be written. */
  digest: string | null;
  /** locale -> stored translation. Missing key = no translation yet. */
  byLocale: Record<string, string>;
}

export interface ShopLinkTranslations {
  rows: Map<string, LinkTranslationRow>;
  /**
   * True when the sweep stopped while Shopify still had pages. A menu item
   * missing from a TRUNCATED sweep is unknown, not untranslatable, and the UI
   * has to say so instead of offering an edit that cannot be saved.
   */
  truncated: boolean;
}

/**
 * Every Link of the shop, with its digest and its translations in the given
 * locales.
 *
 * The per-locale selections are ALIASED into one query (l0, l1, …) so N
 * languages cost no extra round trips. The locale values travel as GraphQL
 * VARIABLES, never interpolated into the query text: the list originates from
 * Shopify, but a query string assembled from data is an injection waiting for
 * the one caller that passes something else.
 */
export async function fetchShopLinkTranslations(
  gateway: ShopifyApiGateway,
  locales: string[],
): Promise<ShopLinkTranslations> {
  const wanted = [...new Set(locales.filter(Boolean))];
  const variableDefs = wanted.map((_, i) => `$loc${i}: String!`).join(", ");
  const localeSelections = wanted
    .map((_, i) => `l${i}: translations(locale: $loc${i}) { key value }`)
    .join("\n              ");

  const query = `#graphql
    query menuLinkSweep($first: Int!, $after: String${variableDefs ? `, ${variableDefs}` : ""}) {
      translatableResources(first: $first, after: $after, resourceType: LINK) {
        edges {
          node {
            resourceId
            translatableContent { key value digest }
            ${localeSelections}
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const localeVariables: Record<string, string> = {};
  wanted.forEach((locale, i) => {
    localeVariables[`loc${i}`] = locale;
  });

  const pageSize = Math.min(
    SWEEP_MAX_NODES,
    Math.max(SWEEP_MIN_NODES, Math.floor(SWEEP_MAX_NODES / Math.max(1, wanted.length))),
  );
  const pageCap = Math.ceil(SWEEP_MAX_LINKS / pageSize);

  const rows = new Map<string, LinkTranslationRow>();
  let after: string | null = null;
  let pages = 0;
  let moreAvailable = false;

  while (pages < pageCap) {
    const response = await gateway.graphql(query, {
      variables: { first: pageSize, after, ...localeVariables },
    });
    const payload = (await response.json()) as {
      data?: {
        translatableResources?: {
          edges?: Array<{
            node: {
              resourceId: string;
              translatableContent?: Array<{ key: string; value: string | null; digest: string | null }>;
              [aliased: string]: unknown;
            };
          }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (payload.errors?.length) throw new Error(payload.errors[0].message);

    const connection = payload.data?.translatableResources;
    for (const edge of connection?.edges ?? []) {
      const node = edge.node;
      const content = (node.translatableContent ?? []).find((c) => c.key === MENU_LINK_KEY);
      const byLocale: Record<string, string> = {};
      wanted.forEach((locale, i) => {
        const entries = node[`l${i}`] as Array<{ key: string; value: string | null }> | undefined;
        const value = entries?.find((t) => t.key === MENU_LINK_KEY)?.value;
        if (typeof value === "string" && value !== "") byLocale[locale] = value;
      });
      rows.set(node.resourceId, {
        linkId: node.resourceId,
        primaryTitle: content?.value ?? null,
        digest: content?.digest ?? null,
        byLocale,
      });
    }

    pages += 1;
    moreAvailable = !!connection?.pageInfo?.hasNextPage;
    if (!moreAvailable) break;
    after = connection?.pageInfo?.endCursor ?? null;
    if (!after) break;
  }

  if (moreAvailable) {
    logger.warn("[MENU-TRANSLATIONS] Link sweep hit its page cap", {
      context: "MenuTranslations",
      rows: rows.size,
      pages,
    });
  }

  return { rows, truncated: moreAvailable };
}

export interface MenuTranslationSaveEntry {
  linkId: string;
  /** Empty means remove — Shopify rejects a blank translation value anyway. */
  value: string;
  /** From the sweep. A row without one cannot be registered. */
  digest: string | null;
}

export interface MenuTranslationSaveResult {
  savedLinkIds: string[];
  failures: Array<{ linkId: string; message: string }>;
}

/**
 * Write one locale's menu-item translations, per item, echo-verified.
 *
 * An EMPTY value removes rather than stores: Shopify rejects a blank
 * translation value outright, so "cleared the field" and "wrote an empty
 * string" cannot be the same operation the way they can for a metafield.
 *
 * The local mirror follows the confirmation and never leads it — a row is
 * upserted only for a key Shopify echoed, and deleted only for a removal
 * Shopify confirmed. An unconfirmed removal deliberately LEAVES the local row
 * in place: a translation that still exists on Shopify but not locally is the
 * divergence this codebase has been bitten by before.
 */
export async function saveMenuLinkTranslations(
  gateway: ShopifyApiGateway,
  db: PrismaClient,
  shop: string,
  locale: string,
  marketId: string,
  entries: MenuTranslationSaveEntry[],
): Promise<MenuTranslationSaveResult> {
  const savedLinkIds: string[] = [];
  const failures: Array<{ linkId: string; message: string }> = [];

  for (const entry of entries) {
    try {
      if (entry.value === "") {
        const result = await removeAndVerify(gateway, entry.linkId, [MENU_LINK_KEY], locale, marketId);
        if (!result.confirmedKeys.has(MENU_LINK_KEY)) {
          failures.push({
            linkId: entry.linkId,
            message:
              result.userErrors[0]?.message ??
              "Shopify did not confirm the removal — the existing translation was kept.",
          });
          continue;
        }
        await db.contentTranslation.deleteMany({
          where: { shop, resourceId: entry.linkId, key: MENU_LINK_KEY, locale, marketId },
        });
        savedLinkIds.push(entry.linkId);
        continue;
      }

      if (!entry.digest) {
        failures.push({
          linkId: entry.linkId,
          message: "No translatable content digest for this menu item — reload the page and try again.",
        });
        continue;
      }

      const result = await registerAndVerify(gateway, entry.linkId, [
        {
          key: MENU_LINK_KEY,
          value: entry.value,
          locale,
          translatableContentDigest: entry.digest,
          ...(marketId ? { marketId } : {}),
        },
      ]);
      if (!result.confirmedKeys.has(MENU_LINK_KEY)) {
        failures.push({
          linkId: entry.linkId,
          message:
            result.userErrors[0]?.message ??
            "Shopify accepted the call but stored nothing — the translation was not saved.",
        });
        continue;
      }

      // Mirror what Shopify STORED, not what was sent (the theme path's rule).
      const stored = result.confirmedValues.get(MENU_LINK_KEY) ?? entry.value;
      await db.contentTranslation.upsert({
        where: {
          shop_resourceId_key_locale_marketId: {
            shop,
            resourceId: entry.linkId,
            key: MENU_LINK_KEY,
            locale,
            marketId,
          },
        },
        create: {
          shop,
          resourceId: entry.linkId,
          resourceType: MENU_LINK_RESOURCE_TYPE,
          key: MENU_LINK_KEY,
          locale,
          marketId,
          value: stored,
          digest: entry.digest,
        },
        update: { value: stored, digest: entry.digest, resourceType: MENU_LINK_RESOURCE_TYPE },
      });
      savedLinkIds.push(entry.linkId);
    } catch (error) {
      failures.push({
        linkId: entry.linkId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    logger.warn("[MENU-TRANSLATIONS] Some menu items did not save", {
      context: "MenuTranslations",
      shop,
      locale,
      saved: savedLinkIds.length,
      failed: failures.length,
    });
  }

  return { savedLinkIds, failures };
}

// ─── Menu cache refresh ────────────────────────────────────────────────────

/** Depth Shopify documents is 3; this reads one more so an unexpected level
 *  cannot vanish silently. */
const MENUS_WITH_ITEMS_QUERY = `#graphql
  query menusWithItems($first: Int!) {
    menus(first: $first) {
      nodes {
        id
        title
        handle
        items {
          id
          title
          items {
            id
            title
            items {
              id
              title
              items { id title }
            }
          }
        }
      }
    }
  }
`;

const MENU_FETCH_LIMIT = 250;

/**
 * Refresh every menu's cached item tree, and drop translations whose item is
 * gone.
 *
 * This replaces the "sync only the menus missing from the DB" behaviour the
 * page used to have. Menus have NO Shopify webhook, so an incremental sync
 * fetched each tree exactly once, forever: an item added in Shopify never
 * appeared, and a deleted one kept rendering — with the tooltip "Shopify
 * offers no translatable resource for this menu item", i.e. reproducing the
 * precise false claim this whole feature exists to remove. One query for the
 * whole shop is cheaper than the per-menu round trips it replaces, so there is
 * no reason to be incremental here.
 *
 * Both destructive steps inherit syncAllMenus' paranoia: a possibly truncated
 * result deletes nothing, and "Shopify returned zero menus" is treated as a
 * failed read rather than as an empty shop.
 */
export async function refreshMenuCache(
  gateway: ShopifyApiGateway,
  db: PrismaClient,
  shop: string,
): Promise<void> {
  const response = await gateway.graphql(MENUS_WITH_ITEMS_QUERY, {
    variables: { first: MENU_FETCH_LIMIT },
  });
  const payload = (await response.json()) as {
    data?: {
      menus?: {
        nodes?: Array<{ id: string; title: string; handle: string; items?: unknown }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) throw new Error(payload.errors[0].message);

  const menus = payload.data?.menus?.nodes ?? [];

  for (const menu of menus) {
    const data = {
      shop,
      title: menu.title,
      handle: menu.handle,
      items: (menu.items ?? []) as never,
      lastSyncedAt: new Date(),
    };
    await db.menu.upsert({
      where: { shop_id: { shop, id: menu.id } },
      create: { id: menu.id, ...data },
      update: data,
    });
  }

  const truncated = menus.length >= MENU_FETCH_LIMIT;
  if (truncated) {
    logger.warn("[MENU-TRANSLATIONS] Menu list possibly truncated — skipping stale cleanup", {
      context: "MenuTranslations",
      shop,
      menus: menus.length,
    });
    return;
  }

  if (menus.length === 0) {
    // Same guard syncAllMenus applies: an empty answer over a non-empty cache
    // is a failed read far more often than it is a shop that deleted every
    // menu, and acting on it would delete the merchant's translations.
    const localCount = await db.menu.count({ where: { shop } });
    if (localCount > 0) {
      logger.warn("[MENU-TRANSLATIONS] Shopify returned 0 menus over a non-empty cache — nothing deleted", {
        context: "MenuTranslations",
        shop,
        localCount,
      });
      return;
    }
  }

  const liveMenuIds = menus.map((m) => m.id);
  if (liveMenuIds.length > 0) {
    await db.menu.deleteMany({ where: { shop, id: { notIn: liveMenuIds } } });
  }

  // Orphaned item translations. ContentTranslation carries no foreign key —
  // its lifecycle is app code by design (see the model comment) — so a menu
  // item that disappears would otherwise leave its Link row behind forever.
  // Scoped by resourceType so this can only ever touch menu-item rows.
  const liveLinkIds: string[] = [];
  for (const menu of menus) {
    for (const item of flattenMenuItems(menu.items)) {
      if (item.linkId) liveLinkIds.push(item.linkId);
    }
  }
  const orphaned = await db.contentTranslation.deleteMany({
    where: {
      shop,
      resourceType: MENU_LINK_RESOURCE_TYPE,
      ...(liveLinkIds.length > 0 ? { resourceId: { notIn: liveLinkIds } } : {}),
    },
  });
  if (orphaned.count > 0) {
    logger.info("[MENU-TRANSLATIONS] Removed translations of deleted menu items", {
      context: "MenuTranslations",
      shop,
      removed: orphaned.count,
    });
  }
}
