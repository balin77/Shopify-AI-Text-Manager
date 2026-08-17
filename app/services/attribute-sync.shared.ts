/**
 * PLAN_CONTENT_CREATION Phase 0 — merchandising attributes.
 *
 * ONE source for (a) the GraphQL selection of the attribute fields and (b) the
 * mapping of a Shopify response onto the Prisma columns. Every sync path — the
 * bulk product sync, the single-product sync, the content sync, the background
 * page sync — pulls both halves from here, so a field can never be fetched by
 * one path and dropped by another. Historic copies of such maps in this repo
 * drifted (see FIELD_TO_TRANSLATION_KEY in shopify-content.service.ts).
 *
 * Client-safe on purpose (no `.server` import): the attribute sidebar
 * (§Phase 2) reads the same shapes.
 *
 * ── THE ONE RULE FOR EVERY READER ────────────────────────────────────────────
 * A column of this block is only meaningful when the row's `attributesSyncedAt`
 * is set. Before that, `vendor: null` / `tags: []` / `isPublished: true` are
 * the migration's DEFAULTS and mean UNKNOWN, not "the merchant left it empty".
 * `attributesKnown()` below is the discriminator — same rule as
 * SeoCrawlPage.indexabilityKnown.
 *
 * The mappers enforce the other half of that rule: when a response does NOT
 * carry the attribute block (an older/partial query path), they return `{}` —
 * they never write a default over a value a previous sync established, and
 * they never stamp `attributesSyncedAt` for data they did not receive.
 */

// ────────────────────────────────────────────────────────────────────────────
// GraphQL selections
// ────────────────────────────────────────────────────────────────────────────

/** Product attribute fields. Interpolated into the product sync queries. */
export const PRODUCT_ATTRIBUTE_SELECTION = `
                  vendor
                  tags
                  templateSuffix
                  publishedAt
                  category {
                    id
                    fullName
                  }`;

/**
 * Membership window of a product. Truncation is reported through
 * `pageInfo.hasNextPage` and stored as `Product.hasMoreCollections` — "in N
 * collections" must not read as complete when it is a cut-off list.
 *
 * `ruleSet` is selected only to learn whether a membership is rule-based:
 * Phase 3's membership picker must not offer to remove such a row, the rule
 * would re-add it on Shopify's side.
 */
export const PRODUCT_COLLECTIONS_PAGE_SIZE = 100;

export const PRODUCT_COLLECTIONS_SELECTION = `
                  collections(first: ${PRODUCT_COLLECTIONS_PAGE_SIZE}) {
                    pageInfo {
                      hasNextPage
                    }
                    nodes {
                      id
                      title
                      ruleSet {
                        appliedDisjunctively
                      }
                    }
                  }`;

/**
 * Collection attribute fields.
 *
 * `ruleSet` is the 2025-10 rule model. From 2026-07 on the same information
 * lives in `sources[]` (PLAN §1.2) — the two are NOT interchangeable, which is
 * why `sourcesJson` stores a discriminated envelope rather than a bare tree.
 * When the API pin moves (PLAN Phase −1), add the `sources` selection here and
 * pass the new shape to `collectionAttributeColumns`; nothing else changes.
 */
import { readConditionFragments, rulesAvailableOn } from "../config/collection-rules.shared";

/** Generated from the kind specs, never hand-written: a read selection that
 *  drifts from the write mapping makes collections read as "unrenderable" for
 *  no reason, and the editor then refuses to touch rules it understands. */
const INCLUSION_CONDITION_FRAGMENTS = readConditionFragments("inclusion");
const EXCLUSION_CONDITION_FRAGMENTS = readConditionFragments("exclusion");

export const COLLECTION_ATTRIBUTE_SELECTION = `
            sortOrder
            templateSuffix
            ruleSet {
              appliedDisjunctively
              rules {
                column
                relation
                condition
              }
            }`;

/**
 * The 2026-07 rule model. Selected INSTEAD of `ruleSet`, never alongside it:
 * `ruleSet` is a lossy back-projection of this (CLAUDE.md — exclusions, extra
 * sources and variant targeting simply vanish from it), so a row that can have
 * the real tree must not also carry the flattened one and leave a reader to
 * pick.
 *
 * `sources` and `ruleSet` are BOTH selected as `...` fragments on the same
 * type, so a query carrying `sources` against 2025-10 fails at the SCHEMA
 * level — a top-level `errors` array with `data: null`, which the sync would
 * read as "no collections". That is why this is a separate constant behind
 * `collectionAttributeSelection()` and never concatenated blindly.
 */
/**
 * The `sources` sub-selection, on its own so every reader uses the SAME one.
 *
 * Load-bearing: `fromShopifySources` needs title, targetType and both sides'
 * conditions to tell a renderable source from one it must carry untouched.
 * A caller that selects a NARROWER shape — the rule mutation's echo did — and
 * mirrors it into `sourcesJson` turns every source into an empty renderable
 * one, which then reads as "the merchant deleted their rules" and lets the
 * next diff delete a real source the editor was never allowed to touch.
 */
export const COLLECTION_SOURCES_FIELDS = `sources {
              id
              title
              description
              targetType
              inclusion {
                matchType
                selections { __typename }
                conditions {
                  __typename
${INCLUSION_CONDITION_FRAGMENTS}
                }
              }
              exclusion {
                matchType
                selections { __typename }
                conditions {
                  __typename
${EXCLUSION_CONDITION_FRAGMENTS}
                }
              }
            }`;

export const COLLECTION_SOURCES_SELECTION = `
            sortOrder
            templateSuffix
            ${COLLECTION_SOURCES_FIELDS}`;

/**
 * Which rule model to ask for, decided by the API version the app is pinned to.
 *
 * The whole point of this indirection: asking 2025-10 for `sources` does not
 * degrade, it fails the entire query. A sync that "returned no collections"
 * because of a field it should never have requested is exactly the kind of
 * silent, total failure this codebase keeps guarding against.
 */
export function collectionAttributeSelection(apiVersion: string): string {
  return rulesAvailableOn(apiVersion) ? COLLECTION_SOURCES_SELECTION : COLLECTION_ATTRIBUTE_SELECTION;
}

/** Article attribute fields. `author` is required by ArticleCreateInput (§1.4). */
export const ARTICLE_ATTRIBUTE_SELECTION = `
            author {
              name
            }
            tags
            templateSuffix
            isPublished
            publishedAt`;

/** Page attribute fields. */
export const PAGE_ATTRIBUTE_SELECTION = `
                  templateSuffix
                  isPublished
                  publishedAt`;

// ────────────────────────────────────────────────────────────────────────────
// Response shapes
// ────────────────────────────────────────────────────────────────────────────

export interface ShopifyProductAttributes {
  vendor?: string | null;
  tags?: string[] | null;
  templateSuffix?: string | null;
  publishedAt?: string | null;
  category?: { id: string; fullName?: string | null; name?: string | null } | null;
}

export interface ShopifyProductCollections {
  pageInfo?: { hasNextPage: boolean } | null;
  nodes?: Array<{
    id: string;
    title: string;
    ruleSet?: { appliedDisjunctively?: boolean } | null;
  }> | null;
}

export interface ShopifyCollectionRuleSet {
  appliedDisjunctively?: boolean;
  rules?: Array<{ column: string; relation: string; condition: string }> | null;
}

export interface ShopifyCollectionAttributes {
  /** 2026-07 and up. Mutually exclusive with `ruleSet` by selection, never by
   *  accident — see `collectionAttributeSelection`. */
  sources?: unknown[] | null;
  sortOrder?: string | null;
  templateSuffix?: string | null;
  ruleSet?: ShopifyCollectionRuleSet | null;
}

export interface ShopifyArticleAttributes {
  author?: { name?: string | null } | null;
  tags?: string[] | null;
  templateSuffix?: string | null;
  isPublished?: boolean | null;
  publishedAt?: string | null;
}

export interface ShopifyPageAttributes {
  templateSuffix?: string | null;
  isPublished?: boolean | null;
  publishedAt?: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Column mappers
// ────────────────────────────────────────────────────────────────────────────

/** Anything that survives a JSON round-trip — what a Prisma `Json` column takes. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * `sourcesJson` envelope. The shape depends on the API version the sync ran
 * against, and a reader must never have to guess which model a row carries.
 *
 * Declared as a type alias rather than an interface on purpose: only an alias
 * gets TypeScript's implicit index signature, which is what makes it directly
 * assignable to Prisma's `InputJsonObject` without a cast at each call site.
 */
export type CollectionSourcesEnvelope = {
  shape: "ruleSet" | "sources";
  apiVersion: string;
  data: JsonValue;
};

export interface ProductAttributeColumns {
  vendor?: string | null;
  tags?: string[];
  categoryId?: string | null;
  categoryName?: string | null;
  templateSuffix?: string | null;
  publishedAt?: Date | null;
  attributesSyncedAt?: Date;
}

export interface CollectionAttributeColumns {
  sortOrder?: string | null;
  templateSuffix?: string | null;
  isSmart?: boolean;
  sourcesJson?: CollectionSourcesEnvelope;
  attributesSyncedAt?: Date;
}

export interface ArticleAttributeColumns {
  author?: string | null;
  tags?: string[];
  templateSuffix?: string | null;
  isPublished?: boolean;
  publishedAt?: Date | null;
  attributesSyncedAt?: Date;
}

export interface PageAttributeColumns {
  templateSuffix?: string | null;
  isPublished?: boolean;
  publishedAt?: Date | null;
  attributesSyncedAt?: Date;
}

/** null/"" → null, everything else trimmed. Shopify returns "" for unset text. */
function nullableText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Did this response actually carry the attribute block?
 *
 * The check is ALL keys, never "any of them". GraphQL returns every key it was
 * asked for (null-valued if unset), so a response missing even one of them was
 * built from a different, narrower selection — and treating that as a complete
 * block is precisely the failure this module exists to prevent: the missing
 * fields would be written as their defaults (`tags: []`, `isPublished: false`)
 * and stamped with `attributesSyncedAt`, turning "unknown" into a confident
 * wrong value that no later reader can tell apart from the truth.
 */
function hasEveryKey<T extends object>(data: T | null | undefined, keys: Array<keyof T>): boolean {
  if (!data) return false;
  return keys.every((key) => data[key] !== undefined);
}

const PRODUCT_ATTRIBUTE_KEYS: Array<keyof ShopifyProductAttributes> = [
  "vendor",
  "tags",
  "templateSuffix",
  "publishedAt",
  "category",
];

export function hasProductAttributes(data: ShopifyProductAttributes | null | undefined): boolean {
  return hasEveryKey(data, PRODUCT_ATTRIBUTE_KEYS);
}

export function productAttributeColumns(
  data: ShopifyProductAttributes | null | undefined,
  now: Date = new Date(),
): ProductAttributeColumns {
  if (!hasProductAttributes(data)) return {};
  const d = data as ShopifyProductAttributes;
  return {
    vendor: nullableText(d.vendor),
    tags: (d.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0),
    categoryId: d.category?.id ?? null,
    // `fullName` ("Apparel & Accessories > Clothing") is what the UI labels the
    // category with; `name` is only the leaf and is the fallback.
    categoryName: nullableText(d.category?.fullName ?? d.category?.name),
    templateSuffix: nullableText(d.templateSuffix),
    publishedAt: parseDate(d.publishedAt),
    attributesSyncedAt: now,
  };
}

/** Membership rows for `ProductCollection`, plus the truncation flag. */
export function productCollectionRows(
  shop: string,
  productId: string,
  collections: ShopifyProductCollections | null | undefined,
): { rows: Array<{ shop: string; productId: string; collectionId: string; collectionTitle: string; automated: boolean }>; hasMore: boolean } | null {
  // Not requested ⇒ leave the existing rows alone. `null` here is the caller's
  // signal to skip the delete-and-rebuild entirely, NOT "member of nothing".
  if (!collections) return null;
  const nodes = collections.nodes ?? [];
  const seen = new Set<string>();
  const rows: Array<{ shop: string; productId: string; collectionId: string; collectionTitle: string; automated: boolean }> = [];
  for (const node of nodes) {
    if (!node?.id || seen.has(node.id)) continue;
    seen.add(node.id);
    rows.push({
      shop,
      productId,
      collectionId: node.id,
      collectionTitle: node.title ?? "",
      automated: !!node.ruleSet,
    });
  }
  return { rows, hasMore: collections.pageInfo?.hasNextPage ?? false };
}

/** The keys every version delivers. The rule tree is the version-dependent
 *  one and is checked separately. */
const COLLECTION_ATTRIBUTE_KEYS: Array<keyof ShopifyCollectionAttributes> = [
  "sortOrder",
  "templateSuffix",
];

/**
 * Was the collection attribute block delivered?
 *
 * The rule tree arrives under DIFFERENT keys per API version — `ruleSet` up to
 * 2025-10, `sources` from 2026-07 — and the block is only complete when the one
 * this version actually asks for is present. Demanding `ruleSet` on 2026-07
 * would make every response look incomplete and quietly stop the whole
 * attribute sync; accepting either without looking would let a genuinely
 * narrow query through, which is the exact "half-delivered block written as
 * defaults" failure the rest of this module exists to prevent.
 */
export function hasCollectionAttributes(
  data: ShopifyCollectionAttributes | null | undefined,
  apiVersion?: string,
): boolean {
  if (!hasEveryKey(data, COLLECTION_ATTRIBUTE_KEYS)) return false;
  const treeKey: keyof ShopifyCollectionAttributes =
    apiVersion && rulesAvailableOn(apiVersion) ? "sources" : "ruleSet";
  return hasEveryKey(data, [treeKey]);
}

export function collectionAttributeColumns(
  data: ShopifyCollectionAttributes | null | undefined,
  apiVersion: string,
  now: Date = new Date(),
): CollectionAttributeColumns {
  if (!hasCollectionAttributes(data, apiVersion)) return {};
  const d = data as ShopifyCollectionAttributes;
  // Which model this response actually carries. Decided by the API version, not
  // by which key happens to be present: an empty `sources` on 2026-07 means "no
  // rules", while a missing one on 2025-10 means "this version has no such
  // field" — reading them the same way would call every new-model collection
  // manual.
  const hasSources = rulesAvailableOn(apiVersion);
  return {
    sortOrder: nullableText(d.sortOrder),
    templateSuffix: nullableText(d.templateSuffix),
    // From 2026-07 on a collection is rule-based when it HAS sources; below
    // that `ruleSet` is the only signal. Reading `ruleSet` on the newer version
    // would answer "manual" for every collection using the new model, because
    // the projection drops what it cannot express (CLAUDE.md).
    isSmart: hasSources ? (d.sources?.length ?? 0) > 0 : !!d.ruleSet,
    // Stored even when null-ish so a collection that STOPPED being rule-based
    // does not keep a stale tree. The envelope always names its shape, because
    // the two models are not interchangeable and a reader must never guess.
    sourcesJson: hasSources
      ? { shape: "sources", apiVersion, data: (d.sources ?? null) as JsonValue }
      : {
          shape: "ruleSet",
          apiVersion,
          // The rule tree is stored VERBATIM, never flattened (PLAN §2.4): the
          // editor has to be able to hand back a structure it cannot render.
          data: (d.ruleSet ?? null) as JsonValue,
        },
    attributesSyncedAt: now,
  };
}

const ARTICLE_ATTRIBUTE_KEYS: Array<keyof ShopifyArticleAttributes> = [
  "author",
  "tags",
  "templateSuffix",
  "isPublished",
  "publishedAt",
];

export function hasArticleAttributes(data: ShopifyArticleAttributes | null | undefined): boolean {
  return hasEveryKey(data, ARTICLE_ATTRIBUTE_KEYS);
}

export function articleAttributeColumns(
  data: ShopifyArticleAttributes | null | undefined,
  now: Date = new Date(),
): ArticleAttributeColumns {
  if (!hasArticleAttributes(data)) return {};
  const d = data as ShopifyArticleAttributes;
  return {
    author: nullableText(d.author?.name),
    tags: (d.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0),
    templateSuffix: nullableText(d.templateSuffix),
    isPublished: d.isPublished ?? false,
    publishedAt: parseDate(d.publishedAt),
    attributesSyncedAt: now,
  };
}

const PAGE_ATTRIBUTE_KEYS: Array<keyof ShopifyPageAttributes> = [
  "templateSuffix",
  "isPublished",
  "publishedAt",
];

export function hasPageAttributes(data: ShopifyPageAttributes | null | undefined): boolean {
  return hasEveryKey(data, PAGE_ATTRIBUTE_KEYS);
}

export function pageAttributeColumns(
  data: ShopifyPageAttributes | null | undefined,
  now: Date = new Date(),
): PageAttributeColumns {
  if (!hasPageAttributes(data)) return {};
  const d = data as ShopifyPageAttributes;
  return {
    templateSuffix: nullableText(d.templateSuffix),
    isPublished: d.isPublished ?? false,
    publishedAt: parseDate(d.publishedAt),
    attributesSyncedAt: now,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Reader-side discriminator
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE gate every consumer of an attribute column must pass through.
 *
 * `false` ⇒ the row predates the attribute sync: show "unknown" and offer a
 * reload, never a red "missing" finding (PLAN §2.4). A full sync run fills it.
 */
export function attributesKnown(row: { attributesSyncedAt?: Date | string | null } | null | undefined): boolean {
  return !!row?.attributesSyncedAt;
}
