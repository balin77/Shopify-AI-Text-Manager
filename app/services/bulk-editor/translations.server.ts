/**
 * Bulk editor — translation write path (docs/plans/PLAN_BULK_EDITOR.md §6).
 *
 * These helpers are THE ONLY allowed way for the bulk editor to write foreign
 * translations, because they encode the three invariants that historically
 * broke every other translation path in this app (CLAUDE.md):
 *
 *   1. A save only counts when Shopify ECHOES the key back — `userErrors: []`
 *      alone is the silent-no-op bug (registerAndVerify).
 *   2. A clear only deletes the local DB row when Shopify CONFIRMS the
 *      removal — otherwise DB and storefront diverge (removeAndVerify).
 *   3. Digests are mandatory for translationsRegister. Missing digest ⇒ ONE
 *      re-fetch of the resource ⇒ still missing ⇒ CELL ERROR. No Shopify
 *      write, no DB write (§6.3 — a DB-only "save" is the divergence that
 *      comes back as "saving does nothing").
 *
 * They are deliberately generic over (gateway, resourceId, inputs) so the
 * older write paths (updateContent, seo-bulk-fix, text-translation.handler)
 * can adopt them later without another rewrite — but this phase does NOT
 * rework those paths (Plan §6.2: adopting them everywhere is follow-up work).
 *
 * Server-only: imports the API gateway type + server logger. The pure pieces
 * (DIGEST_BATCH_CHUNK, descriptors) live in columns.shared.ts.
 */

import { getCachedShopLocales } from "../../utils/shop-locales-cache.server";
import {
  FIELD_TO_TRANSLATION_KEY,
  fieldTranslationKeyMap,
  ShopifyContentService,
  type ShopifyAdminClient,
} from "../../../src/services/shopify-content.service";
import type { PrismaClient } from "@prisma/client";
export { canonicalFieldNameForColumn } from "./columns.shared";
import {
  canonicalFieldNameForColumn,
  isFeaturedImageAltColumn,
  metafieldColumnId,
  BULK_COLUMNS_BY_TYPE,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
} from "./columns.shared";

// ─── Column → Shopify translatable-content key ─────────────────────────────

/**
 * Shopify translatable-content key for a bulk column, or null when the column
 * has none (non-field/mofield kinds, non-translatable fields like status).
 *
 * `rowType` matters twice (Phase 5):
 * - "policy" rows resolve through fieldTranslationKeyMap("ShopPolicy") — the
 *   ONE resource where body translates under "body", not "body_html";
 * - "metaobject" rows use the field key itself: Shopify's translatable
 *   content for a Metaobject is keyed by MetaobjectDefinition field key.
 */
export function translationKeyForColumn(column: ColumnDescriptor, rowType?: BulkRowType): string | null {
  if (!column.translatable) return null;
  if (column.kind === "mofield") return column.moFieldKey ?? null;
  // The DB key, NOT the Shopify key: a collection's/article's featured-image
  // alt is stored on Shopify as `alt` on the image's own GID, but mirrored on
  // the PARENT row as "image_alt_text" — the key the single editor writes.
  // Callers that need the Shopify side go through the write path, which
  // resolves the image resource itself.
  if (isFeaturedImageAltColumn(column)) return "image_alt_text";
  if (column.kind !== "field") return null;
  const field = canonicalFieldNameForColumn(column);
  // A MediaImage has exactly ONE translatable key ("alt") — verified against
  // the live API (Settings → Translation Probe → image alt-text section).
  if (rowType === "image") return field === "altText" ? "alt" : null;
  const keyMap = rowType === "policy" ? fieldTranslationKeyMap("ShopPolicy") : FIELD_TO_TRANSLATION_KEY;
  return keyMap[field] ?? null;
}

/** columnId → Shopify key for every translatable column of a row type — used
 * by the loader (foreignValues), the missing-translation filter and the
 * digest prefetch. */
export function translationKeysByColumnId(type: BulkRowType): Map<string, string> {
  const map = new Map<string, string>();
  for (const column of BULK_COLUMNS_BY_TYPE[type]) {
    const key = translationKeyForColumn(column, type);
    if (key) map.set(column.id, key);
  }
  return map;
}

/**
 * The subset of {@link translationKeysByColumnId} whose translations really do
 * live on the ROW's own `translatableResource`. Today that means "everything
 * except the featured-image alt", whose key is a DB key for a translation
 * Shopify stores on the image resource — so it must not be used to reason
 * about the row's own translatable content.
 */
export function rowOwnTranslationKeys(type: BulkRowType): Map<string, string> {
  const map = new Map<string, string>();
  for (const column of BULK_COLUMNS_BY_TYPE[type]) {
    if (isFeaturedImageAltColumn(column)) continue;
    const key = translationKeyForColumn(column, type);
    if (key) map.set(column.id, key);
  }
  return map;
}

/** ContentTranslation.resourceType value per bulk row type — matches the
 * strings every existing writer uses ("Product", "Collection", "Article",
 * "Page"; Phase 5: "Blog" per app.blog.tsx, "ShopPolicy" per the policies
 * editor). Metaobject rows do NOT mirror into ContentTranslation at all —
 * they use MetaobjectTranslation (persistTranslationRow branches on it); the
 * entry only keeps the Record total. Note: the TranslatableResourceType ENUM
 * (only needed for translatableResources(resourceType:) queries, which this
 * module does not use) is PRODUCT/COLLECTION/ARTICLE/PAGE/BLOG per Plan §14
 * no. 6 — the ONLINE_STORE_* names were removed with 2024-10. */
export const CONTENT_RESOURCE_TYPE_BY_ROW_TYPE: Record<BulkRowType, string> = {
  product: "Product",
  // Variant rows never reach the translation path (all their columns are
  // translatable:false) — the entry only keeps the Record total.
  variant: "ProductVariant",
  collection: "Collection",
  article: "Article",
  page: "Page",
  blog: "Blog",
  policy: "ShopPolicy",
  metaobject: "Metaobject",
  // Image rows translate on their OWN MediaImage GID (the row id). Their DB
  // mirror is ProductImageAltTranslation, not ContentTranslation — the same
  // split metaobjects already have (persistTranslationRow branches on it).
  image: "MediaImage",
};

// ─── Sub-resource translations (metafields, product options) ───────────────

/**
 * Columns whose translation does NOT ride on the row's own
 * `translatableResource` but on a resource of its own:
 *
 *   metafield column  → the METAFIELD gid,            key "value"
 *   option name       → the PRODUCT OPTION gid,       key "name"
 *   option values     → one PRODUCT OPTION VALUE gid per entry, key "name"
 *
 * These are exactly the keys/resource types the single-item editor writes
 * (sub-resources.action.ts) — the bulk path reuses them so both editors produce
 * the same `ContentTranslation` rows, but writes them through the ECHO-VERIFIED
 * register/remove helpers of this module instead of the unverified
 * saveTranslations.
 *
 * Alt-texts are deliberately NOT here: they ride on the MediaImage resource and
 * their primary write already needs the deprecated productUpdateMedia path.
 */
export function isSubResourceColumn(column: ColumnDescriptor): boolean {
  return column.kind === "metafield" || column.kind === "option";
}

export interface SubResourceTarget {
  /** Shopify GID carrying the translation. */
  resourceId: string;
  /** Translatable key on that resource. */
  key: string;
  /** ContentTranslation.resourceType for the DB mirror — the same strings the
   * single editor writes, so both editors read each other's rows. */
  resourceType: "Metafield" | "ProductOption" | "ProductOptionValue";
}

/** The cached sub-resources of ONE product, keyed the way the columns are. */
export interface ProductSubResourceCache {
  /** "mf.<namespace>.<key>" → Metafield GID. */
  metafieldIdByColumnId: Map<string, string>;
  /** 1-based option position → the option and its values, in order. */
  optionByPosition: Map<number, { id: string; linked: boolean; values: { id: string; name: string }[] }>;
}

export const EMPTY_SUB_RESOURCE_CACHE: ProductSubResourceCache = {
  metafieldIdByColumnId: new Map(),
  optionByPosition: new Map(),
};

/**
 * Which Shopify resources one sub-resource CELL translates into.
 *
 * An option-VALUES cell maps to SEVERAL targets (one per value, positional) —
 * that is why this returns a list and why the caller must split the cell value
 * on LIST_DISPLAY_SEPARATOR. Returns null when the row's cache cannot back the
 * column (no such metafield/option, or an option whose values have no GIDs):
 * the caller turns that into a CELL ERROR, never a silent skip.
 */
export function subResourceTargetsForColumn(
  column: ColumnDescriptor,
  cache: ProductSubResourceCache,
): SubResourceTarget[] | null {
  if (column.kind === "metafield") {
    const id = cache.metafieldIdByColumnId.get(column.id);
    return id ? [{ resourceId: id, key: "value", resourceType: "Metafield" }] : null;
  }
  if (column.kind !== "option" || !column.optionPosition) return null;
  const option = cache.optionByPosition.get(column.optionPosition);
  if (!option) return null;
  // Metaobject-linked options are read-only end to end (Plan §14 no. 5) — their
  // values live in the metaobject, not on the option.
  if (option.linked) return null;
  if (column.optionField === "name") {
    return [{ resourceId: option.id, key: "name", resourceType: "ProductOption" }];
  }
  // Legacy cached values without GIDs cannot be addressed at all.
  if (option.values.length === 0 || option.values.some((v) => !v.id)) return null;
  return option.values.map((v) => ({
    resourceId: v.id,
    key: "name",
    resourceType: "ProductOptionValue" as const,
  }));
}

/**
 * The same cache shape, built from an already-loaded BulkRow instead of from
 * Prisma — the loader and the candidate scan hold the row anyway, so they must
 * not query the option/metafield tables a second time.
 */
export function subResourceCacheFromRow(row: BulkRow): ProductSubResourceCache {
  const metafieldIdByColumnId = new Map<string, string>();
  for (const [columnId, metafield] of Object.entries(row.metafields ?? {})) {
    if (metafield?.id) metafieldIdByColumnId.set(columnId, metafield.id);
  }
  const optionByPosition = new Map<number, { id: string; linked: boolean; values: { id: string; name: string }[] }>();
  for (const option of row.options ?? []) {
    optionByPosition.set(option.position, {
      id: option.id,
      linked: option.linked,
      values: option.hasValueIds ? option.values.map((v) => ({ id: v.id, name: v.name })) : [],
    });
  }
  return { metafieldIdByColumnId, optionByPosition };
}

/**
 * Loads the sub-resource GIDs of several products from the cache — the ids the
 * translation write needs. Restricted to the metafield (namespace, key) pairs
 * actually addressed, so a product with 40 metafields does not drag 40 rows in.
 *
 * A product missing from the result simply has no cache row; the caller turns
 * that into a cell error ("resync this product first"), never a silent skip.
 */
export async function loadProductSubResourceCaches(
  db: Pick<PrismaClient, "productMetafield" | "productOption">,
  shop: string,
  productIds: string[],
  metafieldKeys: { namespace: string; key: string }[],
  needOptions: boolean,
): Promise<Map<string, ProductSubResourceCache>> {
  const caches = new Map<string, ProductSubResourceCache>();
  if (productIds.length === 0) return caches;
  const cacheFor = (productId: string): ProductSubResourceCache => {
    let cache = caches.get(productId);
    if (!cache) {
      cache = { metafieldIdByColumnId: new Map(), optionByPosition: new Map() };
      caches.set(productId, cache);
    }
    return cache;
  };

  if (metafieldKeys.length > 0) {
    const metafields = await db.productMetafield.findMany({
      where: {
        // ProductMetafield/-Option carry no shop column — the tenancy check
        // rides on the relation, exactly like the variant lookup does. Without
        // it a client-supplied product id could reach another shop's rows.
        product: { shop },
        productId: { in: productIds },
        OR: metafieldKeys.map((k) => ({ namespace: k.namespace, key: k.key })),
      },
      select: { id: true, productId: true, namespace: true, key: true },
    });
    for (const mf of metafields) {
      cacheFor(mf.productId).metafieldIdByColumnId.set(metafieldColumnId(mf.namespace, mf.key), mf.id);
    }
  }

  if (needOptions) {
    const options = await db.productOption.findMany({
      where: { product: { shop }, productId: { in: productIds } },
      select: { id: true, productId: true, position: true, values: true, linkedMetafieldKey: true },
    });
    for (const option of options) {
      cacheFor(option.productId).optionByPosition.set(option.position, {
        id: option.id,
        linked: !!option.linkedMetafieldKey,
        values: parseOptionValues(option.values),
      });
    }
  }
  return caches;
}

/** Both cached storage formats parse — `[{id,name}]` and the legacy
 * `["string"]`; legacy entries get an empty id, which makes them unaddressable
 * and is exactly what subResourceTargetsForColumn rejects. */
function parseOptionValues(raw: string | null): { id: string; name: string }[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v: unknown) =>
      typeof v === "string"
        ? { id: "", name: v }
        : { id: String((v as { id?: unknown }).id ?? ""), name: String((v as { name?: unknown }).name ?? "") },
    );
  } catch {
    return [];
  }
}

// ─── Entrance-side locale/market validation ────────────────────────────────

/**
 * Data-integrity gate for both save entrances (route action + /api/ai
 * handler): every foreign locale in a diff must be a PUBLISHED, non-primary
 * shop locale, and every market must be an ACTIVE market (loadMarkets already
 * gates on status === 'ACTIVE' — CLAUDE.md). An unknown locale silently
 * collapsing to primary would rewrite live primary content; a stale market id
 * would write an override no storefront can ever show. Returns an error
 * message, or null when everything checks out.
 */
export async function findInvalidLocaleOrMarket(
  admin: ShopifyAdminClient,
  shop: string,
  entries: { locale: string; marketId: string }[],
): Promise<string | null> {
  const locales = new Set<string>();
  const marketIds = new Set<string>();
  for (const entry of entries) {
    if (entry.locale !== "") locales.add(entry.locale);
    if (entry.marketId !== "") marketIds.add(entry.marketId);
  }
  if (locales.size === 0 && marketIds.size === 0) return null;

  if (locales.size > 0) {
    const shopLocales = await getCachedShopLocales(admin, shop).catch(() => []);
    for (const locale of locales) {
      // Published or not: an unpublished locale is a language being prepared,
      // and writing its translations is exactly what preparing means.
      const match = shopLocales.find((l) => l.locale === locale && !l.primary);
      if (!match) {
        return `Locale "${locale}" is not a foreign locale of this shop.`;
      }
    }
  }

  if (marketIds.size > 0) {
    const { markets } = await new ShopifyContentService(admin).loadMarkets();
    for (const marketId of marketIds) {
      if (!markets.some((m) => m.id === marketId)) {
        return `Market "${marketId}" is not an active market of this shop.`;
      }
    }
  }
  return null;
}

// ─── Verified register / remove / digests ──────────────────────────────────
// Moved to the shared module (PLAN_TRANSLATION_WRITE_UNIFICATION Phase A);
// re-exported under the same names so every existing import keeps working.
export {
  fetchDigestsForResource,
  loadDigestsForRows,
  registerAndVerify,
  removeAndVerify,
  removeAndVerifyAcrossLocales,
  LOCALE_KEY_SEP,
  type TranslationInput,
  type TranslationUserError,
  type VerifiedRemoveResult,
  type VerifiedWriteResult,
} from "../translations/verified-translations.server";
