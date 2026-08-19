/**
 * PLAN_CONTENT_CREATION §Phase 3.1 — the two lookups the product attribute tab
 * cannot answer from the cache.
 *
 * ── Two shapes, one taxonomy ────────────────────────────────────────────────
 * `kind=taxonomy` SEARCHES (a flat list of full paths) and
 * `kind=taxonomy-children` BROWSES (one level at a time, `parent` empty for the
 * top-level verticals). Shopify's own picker is exactly these two over one
 * popover, and the browse half is what makes the taxonomy usable by someone
 * who does not already know the word Shopify filed their product under.
 *
 * `childrenOf` is the whole reason browsing is possible at all; it sits next
 * to `descendantsOf` in the schema, which is what makes it ONE level rather
 * than everything below (measured in Settings → Probes → Taxonomy).
 *
 * ── The STRUCTURE is Shopify's, the NAMES come from a second source ─────────
 * Which categories exist, and which sits under which, is asked live: it is
 * Shopify's data, a merchant touches it once per product, and a search
 * endpoint answers it in one call. What is NOT asked live is what they are
 * CALLED, because this API only ever says it in English — measured, twice, in
 * Settings → Probes → Taxonomy. The merchant's language comes out of
 * `TaxonomyCategoryName`, which is Shopify's own published file after import;
 * see [taxonomy-localization.server.ts](../services/taxonomy-localization.server.ts).
 *
 * A GID with no row is the signal that the table is behind, and it triggers a
 * detached import. The response meanwhile carries the API's English name for
 * that one entry — a real label rather than a blank, and per entry rather than
 * per page.
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
import { getCachedShopLocales } from "~/utils/shop-locales-cache.server";
import {
  lookupLocalizedNames,
  scheduleTaxonomyImport,
  searchLocalizedNames,
} from "~/services/taxonomy-localization.server";

/** Enough to choose from, few enough to render in a popover. */
const TAXONOMY_PAGE_SIZE = 20;
/**
 * One LEVEL of the tree, not one screenful. The deepest Shopify branch has
 * well under a hundred direct children, and a level that arrived truncated
 * would hide categories behind a "load more" nobody would press — the browse
 * half has to be complete to be trustworthy, unlike the search half where 20
 * best matches are the point.
 */
const TAXONOMY_LEVEL_SIZE = 250;
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

/** One browsed level. `parentId` echoes what was asked for, so a late response
 *  for a level the merchant already left can be dropped rather than rendered
 *  under the wrong heading. */
export interface TaxonomyLevel {
  parentId: string;
  categories: TaxonomyOption[];
  /** The level did not fit in one page. Shown, never swallowed: a browse list
   *  that silently ends is indistinguishable from a branch that has no more. */
  truncated: boolean;
}

export interface CollectionOption {
  id: string;
  title: string;
  /**
   * Rule-based on Shopify's side. The picker must not offer to TOUCH such a
   * membership — a removal the rule undoes, and a manual add Shopify refuses
   * outright (which, because `productUpdate` is atomic, would take the
   * merchant's text edits down with it).
   *
   * `null` is the third state and the important one: `Collection.isSmart` is
   * NOT NULL DEFAULT false on a column added to an existing table, so a shop
   * synced before Phase 0 reads every collection as manual. Unknown is not
   * manual — `attributesSyncedAt` is the discriminator, and without it the row
   * renders locked with a reason rather than tickable.
   */
  automated: boolean | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || "";

  /**
   * The language the picker speaks. The category field only ever renders in
   * the PRIMARY locale (one value per product, so a foreign locale reads it
   * only), which is why one locale is enough here.
   *
   * A FAILED lookup resolves to `[]` by contract, which reads as "no primary
   * locale" and simply leaves everything in English — never as a wrong
   * language. Not fatal to the request either way: the names are a layer over
   * an answer that is already complete without them.
   */
  const primaryLocale = await getCachedShopLocales(admin, session.shop)
    .then((locales) => locales.find((l) => l.primary)?.locale ?? "")
    .catch(() => "");

  /** Paint the merchant's language over what the API returned, per entry. */
  const localize = async (nodes: TaxonomyOption[]): Promise<TaxonomyOption[]> => {
    if (!primaryLocale || nodes.length === 0) return nodes;
    const { byGid, missing, localized } = await lookupLocalizedNames(
      db,
      primaryLocale,
      nodes.map((n) => n.id),
    );
    // A GID with no row means the table is behind this taxonomy release — or
    // was never imported. That is THE trigger, and it costs nothing to notice
    // because the query that localizes is the query that reveals it.
    if (localized && missing.length > 0) scheduleTaxonomyImport(db, primaryLocale);
    if (byGid.size === 0) return nodes;
    return nodes.map((n) => {
      const hit = byGid.get(n.id);
      return hit ? { ...n, fullName: hit.fullName, name: hit.name } : n;
    });
  };

  try {
    if (kind === "taxonomy") {
      const search = (url.searchParams.get("q") || "").trim();
      // Not an error and not an empty result set — the caller is told to keep
      // typing, which is a different thing from "nothing matches".
      if (search.length < MIN_SEARCH_LENGTH) {
        return json({ success: true, tooShort: true, categories: [] as TaxonomyOption[] });
      }

      // The localized search, first and by preference. Without it the search
      // half was unusable for anyone not typing English: a German merchant
      // types "Vasen", Shopify matches "Vases", and the answer is "no category
      // matches that" for a category that is right there. `null` means this
      // locale has no rows to search, which is a different thing from no
      // matches — and then Shopify's own search below is the better answer.
      if (primaryLocale) {
        const localHits = await searchLocalizedNames(db, primaryLocale, search, TAXONOMY_PAGE_SIZE);
        if (localHits) {
          return json({
            success: true,
            tooShort: false,
            categories: localHits.map((hit) => ({
              id: hit.gid,
              fullName: hit.fullName,
              name: hit.name,
              // The file carries no leaf flag. `isLeaf: false` would mark every
              // hit "(broad)", and `true` would hide the warning where it is
              // due — so the row DESCENDS on click and the level it opens says
              // whether anything is below it. A search hit is a destination,
              // not a verdict about the tree.
              isLeaf: false,
            })) satisfies TaxonomyOption[],
          });
        }
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
        categories: await localize(
          nodes.map((n) => ({
            id: n.id,
            fullName: n.fullName || n.name,
            name: n.name,
            isLeaf: n.isLeaf !== false,
          })),
        ),
      });
    }

    if (kind === "taxonomy-children") {
      // Empty parent = the top level. `categories(first:)` with no filter
      // returns the verticals in Shopify's canonical order (English-sorted,
      // localized labels), which is the order the admin's own picker shows —
      // so nothing is re-sorted here. Sorting alphabetically by the LOCALIZED
      // name would silently reorder the first screen per language.
      const parent = (url.searchParams.get("parent") || "").trim();
      if (parent && !parent.startsWith("gid://shopify/TaxonomyCategory/")) {
        return json({ success: false, error: "A TaxonomyCategory GID is required." }, { status: 400 });
      }

      // Two documents rather than one with an optional argument: a null
      // `childrenOf` is not the same as an absent one, and passing null where
      // Shopify expects a category would filter to nothing rather than to the
      // top level.
      const response = parent
        ? await admin.graphql(
            `#graphql
              query browseProductTaxonomyChildren($parent: ID!, $first: Int!) {
                taxonomy {
                  categories(childrenOf: $parent, first: $first) {
                    nodes { id name fullName isLeaf }
                    pageInfo { hasNextPage }
                  }
                }
              }`,
            { variables: { parent, first: TAXONOMY_LEVEL_SIZE } },
          )
        : await admin.graphql(
            `#graphql
              query browseProductTaxonomyRoots($first: Int!) {
                taxonomy {
                  categories(first: $first) {
                    nodes { id name fullName isLeaf }
                    pageInfo { hasNextPage }
                  }
                }
              }`,
            { variables: { first: TAXONOMY_LEVEL_SIZE } },
          );

      const body = (await response.json()) as {
        data?: {
          taxonomy?: {
            categories?: { nodes?: TaxonomyOption[]; pageInfo?: { hasNextPage?: boolean } };
          };
        };
        errors?: Array<{ message?: string }>;
      };

      // Same rule as the search half: a schema-level error arrives as a
      // top-level `errors` array with `data: null` and never reaches
      // `userErrors`. Rendered as an empty level it would tell the merchant
      // this branch has no subcategories.
      if (body.errors?.length) {
        logger.warn("[Taxonomy] Schema-level error while browsing", {
          context: "Taxonomy", shop: session.shop, parent, error: body.errors[0]?.message,
        });
        return json({ success: false, error: "The product taxonomy could not be opened." }, { status: 502 });
      }

      const nodes = body.data?.taxonomy?.categories?.nodes ?? [];
      return json({
        success: true,
        level: {
          parentId: parent,
          categories: await localize(
            nodes.map((n) => ({
              id: n.id,
              fullName: n.fullName || n.name,
              name: n.name,
              isLeaf: n.isLeaf !== false,
            })),
          ),
          truncated: body.data?.taxonomy?.categories?.pageInfo?.hasNextPage === true,
        } satisfies TaxonomyLevel,
      });
    }

    if (kind === "collections") {
      const rows = await db.collection.findMany({
        where: { shop: session.shop },
        // `attributesSyncedAt` travels WITH `isSmart` for the same reason it
        // travels with every other Phase-0 column: without it the migration's
        // `false` default is indistinguishable from a measured "manual".
        select: { id: true, title: true, isSmart: true, attributesSyncedAt: true },
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
          automated: c.attributesSyncedAt ? c.isSmart === true : null,
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
