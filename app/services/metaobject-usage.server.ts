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
 * Only options that ARE linked are scanned (`linkedMetafieldKey` is set exactly
 * for those), which keeps this to one small query on any real shop. If that
 * scan ever hits its cap the result is UNKNOWN rather than a partial count --
 * a count that silently missed rows is the one output this module must not
 * produce.
 *
 * What it deliberately does NOT do is ask Shopify. PLAN_METAOBJECTS_EDITOR V4
 * (does `Metaobject` expose a reverse relation?) is measured by the Phase-0
 * probe; until that comes back positive there is no live query to prefer over
 * the cache, and inventing one would be the guess this module exists to avoid.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";

/** How many linked options one scan will look at before giving up. */
export const LINKED_OPTION_SCAN_CAP = 5000;

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
    // looked". The caller offers a sync instead of a reassuring zero.
    const productCount = await db.product.count({ where: { shop } });
    if (productCount === 0) return fill({ known: false, reason: "noProducts" });

    const options = await db.productOption.findMany({
      where: { product: { shop }, linkedMetafieldKey: { not: null } },
      select: { productId: true, values: true },
      take: LINKED_OPTION_SCAN_CAP + 1,
    });
    if (options.length > LINKED_OPTION_SCAN_CAP) {
      logger.warn("[MetaobjectUsage] linked-option scan truncated — reporting unknown", {
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
