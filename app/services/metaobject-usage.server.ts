/**
 * Who uses a metaobject entry as a product option value -- and whether we know.
 *
 * The answer is THREE-valued on purpose, and that is the whole point of this
 * module. "0 products" and "we cannot tell" look the same in a number and mean
 * opposite things when the next click deletes something from a live shop.
 * It is the same rule `attributesSyncedAt` follows: a value read out of an
 * empty cache is not a measurement.
 *
 * The source is the app's own product cache. `ProductOption.values` stores each
 * value as `{ id, name, linked, linkedValue }`, and `linkedValue` is the
 * metaobject GID -- written by both the product sync and the option mirror, so
 * a linked option is recognisable without a Shopify round trip.
 *
 * The prefilter is ONE substring predicate over `ProductOption.values` looking
 * for a LINKED value, OR'd with `linkedMetafieldKey`. Both writers of that
 * column stringify `linked: !!linkedMetafieldValue`, so a linked option always
 * carries the marker even on the sync path that omits `linkedMetafieldKey` --
 * which is what made a used entry read as unused before, unlocking exactly the
 * destructive delete this module exists to refuse. One predicate rather than
 * one per requested GID: that column is an unindexed text column, and a
 * statement that times out is swallowed into `lookupFailed`, which would leave
 * usage permanently unknown and deletes permanently blocked on a large shop.
 * The prefilter can only over-match; the JSON is parsed afterwards, so the
 * ANSWER is exact. If the scan hits its cap the result is UNKNOWN rather than
 * a partial count.
 *
 * The one Shopify call it does make is a product COUNT, and only when the cache
 * is empty: without it "no cached products" is permanently unknown, and a shop
 * that genuinely has no products could never delete an entry no matter how
 * often it synced. PLAN_METAOBJECTS_EDITOR V4 (does `Metaobject` expose a
 * reverse relation the usage could be read from directly?) is measured by the
 * Phase-0 probe; until that comes back positive there is no live query to
 * prefer over the cache, and inventing one would be the guess this module
 * exists to avoid.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";

/** How many linked options one scan will look at before giving up. */
export const LINKED_OPTION_SCAN_CAP = 5000;

/**
 * How a linked option value looks in the stringified `values` blob.
 *
 * Both writers build it with `JSON.stringify({ ..., linked: !!linkedMetafieldValue, ... })`,
 * so the spelling is fixed and space-free. It is a PREFILTER only — the parse
 * below decides.
 */
const LINKED_VALUE_MARKER = '"linked":true';

export type MetaobjectUsage =
  /** Countable. `products` may legitimately be 0 -- that is a real answer. */
  | { known: true; products: number; options: number }
  /**
   * Not countable. `noProducts` = the shop has no cached products at all
   * (offer a sync); `scanTruncated` = there are more linked options than one
   * scan looks at, so any number would be a floor, not a count.
   */
  | { known: false; reason: "noProducts" | "scanTruncated" | "lookupFailed" };

interface CachedOptionValue {
  id?: string;
  name?: string;
  linked?: boolean;
  linkedValue?: string;
}

/** Parses a `ProductOption.values` blob; a malformed row contributes nothing
 *  rather than throwing -- one bad row must not make a whole shop unknown. */
function parseOptionValues(raw: string): CachedOptionValue[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CachedOptionValue[]) : [];
  } catch {
    return [];
  }
}

/**
 * Usage for several entries at once, keyed by metaobject GID.
 *
 * Every requested GID appears in the result, so a caller never has to decide
 * what a missing key means.
 */
export async function countLinkedOptionUsage(
  db: PrismaClient,
  shop: string,
  metaobjectIds: string[],
  /**
   * How many products the SHOP has, live. Consulted only when the cache is
   * empty, to tell "nothing synced yet" from "this shop has no products". A
   * `null` result (the call failed) keeps the answer unknown; omitting the
   * callback entirely does the same, which is what the pure tests rely on.
   */
  liveProductCount?: () => Promise<number | null>,
): Promise<Record<string, MetaobjectUsage>> {
  const wanted = [...new Set(metaobjectIds.filter(Boolean))];
  const result: Record<string, MetaobjectUsage> = {};
  if (wanted.length === 0) return result;

  const fill = (usage: MetaobjectUsage) => {
    for (const id of wanted) result[id] = usage;
    return result;
  };

  try {
    // An empty product cache is not "nothing uses this" -- it is "we have not
    // looked". Unless the shop really HAS no products, which only Shopify can
    // say: without that question a shop with an empty catalogue could never
    // delete an entry, and the remedy the UI offers (sync your products) could
    // not change the answer.
    const productCount = await db.product.count({ where: { shop } });
    if (productCount === 0) {
      const live = liveProductCount ? await liveProductCount() : null;
      if (live === 0) return fill({ known: true, products: 0, options: 0 });
      return fill({ known: false, reason: "noProducts" });
    }

    const options = await db.productOption.findMany({
      // See the header: one cheap superset, made exact by the parse below.
      where: {
        product: { shop },
        OR: [{ linkedMetafieldKey: { not: null } }, { values: { contains: LINKED_VALUE_MARKER } }],
      },
      select: { productId: true, values: true },
      take: LINKED_OPTION_SCAN_CAP + 1,
    });
    if (options.length > LINKED_OPTION_SCAN_CAP) {
      logger.warn("[MetaobjectUsage] option scan truncated — reporting unknown", {
        context: "MetaobjectUsage",
        shop,
        cap: LINKED_OPTION_SCAN_CAP,
      });
      return fill({ known: false, reason: "scanTruncated" });
    }

    const productsById = new Map<string, Set<string>>();
    const optionCount = new Map<string, number>();
    for (const id of wanted) {
      productsById.set(id, new Set());
      optionCount.set(id, 0);
    }

    for (const option of options) {
      // Exact match on the parsed JSON, never a substring on the text column:
      // one GID is a prefix of no other, but a `contains` filter would also
      // match a value that merely mentions the id inside another field.
      const values = parseOptionValues(option.values);
      const linkedHere = new Set(
        values.map((v) => v.linkedValue).filter((v): v is string => typeof v === "string" && v !== ""),
      );
      for (const id of wanted) {
        if (!linkedHere.has(id)) continue;
        productsById.get(id)!.add(option.productId);
        optionCount.set(id, (optionCount.get(id) ?? 0) + 1);
      }
    }

    for (const id of wanted) {
      result[id] = {
        known: true,
        products: productsById.get(id)!.size,
        options: optionCount.get(id) ?? 0,
      };
    }
    return result;
  } catch (error: unknown) {
    // A failed lookup is UNKNOWN, never zero -- the same rule the whole module
    // is built on, applied to its own failure.
    logger.error("[MetaobjectUsage] lookup failed", {
      context: "MetaobjectUsage",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return fill({ known: false, reason: "lookupFailed" });
  }
}

/**
 * The shop's live product count, or null when the question could not be asked.
 *
 * Consulted by `countLinkedOptionUsage` only when the product CACHE is empty:
 * it separates "nothing synced yet" from "this shop has no products", and only
 * the second of those makes a zero a real answer. A failure is `null`, never 0
 * -- a throttled response must not unlock a destructive delete.
 *
 * It lives here rather than in either caller so the entry card and the delete
 * action ask the same question the same way.
 */
export async function liveProductCountForUsage(admin: {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}): Promise<number | null> {
  try {
    const response = await admin.graphql(
      `#graphql
        query metaobjectUsageProductCount {
          productsCount { count }
        }`,
    );
    const data = (await response.json()) as {
      data?: { productsCount?: { count?: number } | null };
      errors?: unknown[];
    };
    if (data.errors?.length) return null;
    const count = data.data?.productsCount?.count;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}


// ─── The live cross-check (V4, measured 2026-08-19) ────────────────────────

/** How many references one call looks at. Beyond this the answer is "n or
 *  more", which is enough for every decision that hangs on it. */
export const LIVE_REFERENCE_PAGE = 50;

export type LiveMetaobjectUsage =
  | {
      known: true;
      /**
       * EVERY reference, whatever kind of resource holds it. This is the
       * number that decides, because Shopify refuses on any of them.
       */
      references: number;
      /** How many DISTINCT products are among them — for the message only. */
      products: number;
      /** The page was full, so the true count is "this or more". */
      atLeast: boolean;
    }
  /** We never got an answer — NOT zero. */
  | { known: false };

/**
 * Who references this entry, straight from Shopify.
 *
 * MEASURED (PLAN_METAOBJECTS_EDITOR V4, 2026-08-19): `Metaobject.referencedBy`
 * is a `MetafieldRelationConnection`, it pages through `nodes`, and a node's
 * `referencer` resolves to a **Product** on a real colour entry. Its sibling
 * field `target` does NOT resolve on this shop ("Metafield reference target
 * could not be retrieved"), which is why nothing here selects it: one
 * unresolvable field fails the whole query.
 *
 * Two things this is and is not:
 *
 * - It is what predicts SHOPIFY'S refusal. The platform declines to delete an
 *   entry "while it is referenced by another resource" (V5) — by ANY metafield
 *   reference, not only by a product option. The cache counts option values
 *   only, so it can say zero where Shopify still refuses; this cannot.
 * - It is not a cheap list column. There is no count field on that connection,
 *   so counting means paging. It is asked once, for the ONE entry being
 *   deleted, and the card's list keeps reading the cache.
 *
 * A failure is `known: false`, never zero — the same rule the cached counter
 * follows, for the same reason.
 */
export async function liveMetaobjectUsage(
  admin: {
    graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
  },
  metaobjectId: string,
): Promise<LiveMetaobjectUsage> {
  try {
    const response = await admin.graphql(
      `#graphql
        query metaobjectLiveUsage($id: ID!, $first: Int!) {
          metaobject(id: $id) {
            id
            referencedBy(first: $first) {
              nodes {
                referencer {
                  __typename
                  ... on Product { id }
                }
              }
            }
          }
        }`,
      { variables: { id: metaobjectId, first: LIVE_REFERENCE_PAGE } },
    );
    const data = (await response.json()) as {
      data?: {
        metaobject?: {
          referencedBy?: { nodes?: Array<{ referencer?: { __typename?: string; id?: string } | null }> } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    if (data.errors?.length) {
      logger.warn("[MetaobjectUsage] live referencedBy query failed", {
        context: "MetaobjectUsage",
        metaobjectId,
        error: data.errors[0].message,
      });
      return { known: false };
    }
    // A metaobject that resolves to nothing is not an empty answer — it is a
    // question that was not asked (deleted meanwhile, or another shop's id).
    if (!data.data?.metaobject) return { known: false };

    const nodes = data.data.metaobject.referencedBy?.nodes ?? [];
    const productIds = new Set(
      nodes
        .map((n) => n.referencer)
        .filter((r): r is { __typename?: string; id: string } => typeof r?.id === "string")
        .map((r) => r.id),
    );
    // Both numbers, and they are not interchangeable: a reference held by
    // something that is not a product still makes Shopify refuse the delete,
    // so counting products alone would report "nothing uses this" about an
    // entry that cannot be removed.
    return {
      known: true,
      references: nodes.length,
      products: productIds.size,
      atLeast: nodes.length >= LIVE_REFERENCE_PAGE,
    };
  } catch (error: unknown) {
    logger.warn("[MetaobjectUsage] live referencedBy query threw", {
      context: "MetaobjectUsage",
      metaobjectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { known: false };
  }
}
