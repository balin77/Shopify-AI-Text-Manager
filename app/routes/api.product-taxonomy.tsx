/**
 * PLAN_CONTENT_CREATION §Phase 3.1 — the two lookups the product attribute tab
 * cannot answer from the cache.
 *
 * ── Why the taxonomy is not cached ──────────────────────────────────────────
 * Shopify's product taxonomy is ~10 000 categories, it is Shopify's data
 * rather than the shop's, and a merchant touches it once per product. Mirroring
 * it into Prisma would be a sync job, a staleness question and a migration for
 * something a search endpoint answers in one call. So this queries Shopify per
 * keystroke (debounced client-side) and caches nothing.
 *
 * ── Why the collection list IS from the cache ───────────────────────────────
 * The opposite reasoning: it is the SHOP's data, this app already syncs it, and
 * the membership picker has to show titles for collections the product is
 * already in. Reading Shopify again would produce a list that disagrees with
 * the one the collections tab shows.
 *
 * ── What "no results" means ─────────────────────────────────────────────────
 * Never "this shop has none". A failed lookup returns `success: false` with the
 * reason, because the pickers must be able to tell an empty answer apart from
 * an unanswered one — the same rule as `getCachedShopLocales` and
 * `attributesSyncedAt` everywhere else in this app.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { logger } from "~/utils/logger.server";

/** Enough to choose from, few enough to render in a popover. */
const TAXONOMY_PAGE_SIZE = 20;
/** The membership picker filters client-side over what it already has. */
const COLLECTION_PAGE_SIZE = 250;
/** A search this short matches most of the taxonomy — a useless list. */
const MIN_SEARCH_LENGTH = 2;

export interface TaxonomyOption {
  id: string;
  /** "Apparel & Accessories > Clothing > Shirts & Tops" — the whole path. */
  fullName: string;
  /** Only the leaf. Shown smaller, so the path stays readable. */
  name: string;
  /**
   * A non-leaf category is a valid value on Shopify's side, but choosing one
   * means the product is filed under a branch rather than a specific type.
   * Marked so the UI can say so instead of the merchant finding out from a
   * marketplace listing later.
   */
  isLeaf: boolean;
}

export interface CollectionOption {
  id: string;
  title: string;
  /**
   * Rule-based on Shopify's side. The picker must not offer to remove such a
   * membership — the rule would simply re-add it, and the merchant would be
   * left thinking the save silently failed.
   */
  automated: boolean;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || "";

  try {
    if (kind === "taxonomy") {
      const search = (url.searchParams.get("q") || "").trim();
      // Not an error and not an empty result set — the caller is told to keep
      // typing, which is a different thing from "nothing matches".
      if (search.length < MIN_SEARCH_LENGTH) {
        return json({ success: true, tooShort: true, categories: [] as TaxonomyOption[] });
      }

      const response = await admin.graphql(
        `#graphql
          query searchProductTaxonomy($search: String!, $first: Int!) {
            taxonomy {
              categories(search: $search, first: $first) {
                nodes { id name fullName isLeaf }
              }
            }
          }`,
        { variables: { search, first: TAXONOMY_PAGE_SIZE } },
      );
      const body = (await response.json()) as {
        data?: { taxonomy?: { categories?: { nodes?: TaxonomyOption[] } } };
        errors?: Array<{ message?: string }>;
      };

      // A schema-level error arrives as a top-level `errors` array with
      // `data: null` and never as a userError. Read as an empty result it
      // would tell the merchant their search matched nothing.
      if (body.errors?.length) {
        logger.warn("[Taxonomy] Schema-level error", {
          context: "Taxonomy", shop: session.shop, error: body.errors[0]?.message,
        });
        return json({ success: false, error: "The product taxonomy could not be searched." }, { status: 502 });
      }

      const nodes = body.data?.taxonomy?.categories?.nodes ?? [];
      return json({
        success: true,
        tooShort: false,
        categories: nodes.map((n) => ({
          id: n.id,
          fullName: n.fullName || n.name,
          name: n.name,
          isLeaf: n.isLeaf !== false,
        })) satisfies TaxonomyOption[],
      });
    }

    if (kind === "collections") {
      const rows = await db.collection.findMany({
        where: { shop: session.shop },
        select: { id: true, title: true, isSmart: true },
        orderBy: { title: "asc" },
        take: COLLECTION_PAGE_SIZE,
      });
      return json({
        success: true,
        // Capped, and said so: a shop whose collection cache is bigger than
        // the page would otherwise look as if the missing ones do not exist.
        truncated: rows.length === COLLECTION_PAGE_SIZE,
        collections: rows.map((c) => ({
          id: c.id,
          title: c.title,
          automated: c.isSmart === true,
        })) satisfies CollectionOption[],
      });
    }

    return json({ success: false, error: `Unknown lookup "${kind}".` }, { status: 400 });
  } catch (error) {
    logger.error("[Taxonomy] Lookup failed", {
      context: "Taxonomy",
      shop: session.shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ success: false, error: "The lookup failed. Try again in a moment." }, { status: 500 });
  }
}
