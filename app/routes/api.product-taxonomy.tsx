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
 * ── The names come back in the APP's language ───────────────────────────────
 * Shopify translates the taxonomy itself, and the Admin API hands the
 * translation over through `@inContext(language:)`. Without it the names follow
 * the ADMIN SESSION's language, which is not the language the app is rendered
 * in: a German merchant on a shop that was set up in English gets a German UI
 * with an English category list, and cannot search it in either language. So
 * the caller names the language it is rendering in and it is spent here — but
 * a directive the schema refuses fails the WHOLE query, so a localized attempt
 * that comes back with errors is retried once WITHOUT it. An English label is
 * a small loss; a picker that reports "the taxonomy could not be searched"
 * because of a label is a broken feature.
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
import { translations } from "~/i18n";
import { logger } from "~/utils/logger.server";

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

/**
 * The app's UI language as Shopify's `LanguageCode` enum spells it, or null.
 *
 * Validated against the app's OWN language list rather than against a second
 * copy of it: the enum value is interpolated into the query document (a
 * directive argument cannot be a variable without a second document for the
 * un-localized case), so what may reach it has to be a closed set — and a list
 * written out here would be the one that drifts when a language is added.
 */
function taxonomyLanguage(raw: string | null): string | null {
  const locale = (raw || "").trim().toLowerCase();
  if (!locale || !Object.prototype.hasOwnProperty.call(translations, locale)) return null;
  return locale.toUpperCase().replace(/-/g, "_");
}

/** A schema-level error arrives HERE, as a top-level `errors` array with
 *  `data: null` — never as a userError. Both halves below read it. */
interface GraphqlBody<TData> {
  data?: TData;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

/** Shopify's rate limit arrives in the SAME shape as a refused directive, and
 *  answering it with a second query is the one wrong response. */
function isThrottled(body: GraphqlBody<unknown>): boolean {
  return body.errors?.some((e) => e?.extensions?.code === "THROTTLED") === true;
}

/** What both taxonomy queries select. The search half asks for no `pageInfo`,
 *  so it is optional on the shared shape rather than a second one. */
interface TaxonomyQueryData {
  taxonomy?: {
    categories?: { nodes?: TaxonomyOption[]; pageInfo?: { hasNextPage?: boolean } };
  };
}

/**
 * Runs one taxonomy query, in the app's language when there is one.
 *
 * `build` receives the directive to splice in after the operation signature —
 * empty for the fallback. A localized attempt whose response carries top-level
 * `errors` (which is how an unknown directive, an unsupported language or a
 * schema change arrives — never as a userError) is retried once without it, so
 * the failure mode of LOCALIZATION is an English list and never a dead picker.
 *
 * Two things the retry deliberately does NOT do. It does not fire on a THROTTLE
 * — that error arrives in the same shape, and the answer to "you are asking too
 * often" cannot be asking again in the same breath; the lookup fails, which is
 * what it would have done anyway. And a refusal is not REMEMBERED across
 * requests: the same shape covers a transient error, so a sticky flag would let
 * one bad minute turn localization off for the life of the process.
 */
async function taxonomyQuery(
  admin: { graphql: (query: string, options?: any) => Promise<Response> },
  build: (directive: string) => string,
  variables: Record<string, unknown>,
  language: string | null,
  shop: string,
): Promise<GraphqlBody<TaxonomyQueryData>> {
  if (language) {
    const localized = await admin.graphql(build(` @inContext(language: ${language})`), { variables });
    const body = (await localized.json()) as GraphqlBody<TaxonomyQueryData>;
    if (!body.errors?.length || isThrottled(body)) return body;
    logger.warn("[Taxonomy] Localized lookup refused — retrying in the shop default", {
      context: "Taxonomy", shop, language, error: body.errors[0]?.message,
    });
  }
  const response = await admin.graphql(build(""), { variables });
  return (await response.json()) as GraphqlBody<TaxonomyQueryData>;
}

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
  // The language the CLIENT is rendering in (I18nContext → AISettings
  // .appLanguage). Unknown values fall back to no directive rather than to an
  // error: a label is not worth refusing a lookup over.
  const language = taxonomyLanguage(url.searchParams.get("lang"));

  try {
    if (kind === "taxonomy") {
      const search = (url.searchParams.get("q") || "").trim();
      // Not an error and not an empty result set — the caller is told to keep
      // typing, which is a different thing from "nothing matches".
      if (search.length < MIN_SEARCH_LENGTH) {
        return json({ success: true, tooShort: true, categories: [] as TaxonomyOption[] });
      }

      const body = await taxonomyQuery(
        admin,
        (directive) => `#graphql
          query searchProductTaxonomy($search: String!, $first: Int!)${directive} {
            taxonomy {
              categories(search: $search, first: $first) {
                nodes { id name fullName isLeaf }
              }
            }
          }`,
        { search, first: TAXONOMY_PAGE_SIZE },
        language,
        session.shop,
      );

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
      const body = parent
        ? await taxonomyQuery(
            admin,
            (directive) => `#graphql
              query browseProductTaxonomyChildren($parent: ID!, $first: Int!)${directive} {
                taxonomy {
                  categories(childrenOf: $parent, first: $first) {
                    nodes { id name fullName isLeaf }
                    pageInfo { hasNextPage }
                  }
                }
              }`,
            { parent, first: TAXONOMY_LEVEL_SIZE },
            language,
            session.shop,
          )
        : await taxonomyQuery(
            admin,
            (directive) => `#graphql
              query browseProductTaxonomyRoots($first: Int!)${directive} {
                taxonomy {
                  categories(first: $first) {
                    nodes { id name fullName isLeaf }
                    pageInfo { hasNextPage }
                  }
                }
              }`,
            { first: TAXONOMY_LEVEL_SIZE },
            language,
            session.shop,
          );

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
          categories: nodes.map((n) => ({
            id: n.id,
            fullName: n.fullName || n.name,
            name: n.name,
            isLeaf: n.isLeaf !== false,
          })),
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
