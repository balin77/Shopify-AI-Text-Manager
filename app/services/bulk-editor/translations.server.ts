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

import type { ShopifyApiGateway } from "../shopify-api-gateway.service";
import {
  TRANSLATE_CONTENT_VERIFIED,
  REMOVE_TRANSLATIONS,
} from "../../graphql/content.mutations";
import { logger } from "../../utils/logger.server";
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
  DIGEST_BATCH_CHUNK,
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
      const match = shopLocales.find((l) => l.locale === locale && l.published && !l.primary);
      if (!match) {
        return `Locale "${locale}" is not a published foreign locale of this shop.`;
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

// ─── Digest loading ────────────────────────────────────────────────────────

interface TranslatableContentEntry {
  key: string;
  digest: string | null;
}

/**
 * Digests for ONE resource, restricted to `keys` (empty `keys` = all).
 * The single-item building block — loadDigestsForRows uses it as the
 * per-item fallback, and the §6.3 re-fetch rule uses it directly.
 */
export async function fetchDigestsForResource(
  gateway: ShopifyApiGateway,
  resourceId: string,
  keys?: string[],
): Promise<Map<string, string>> {
  const response = await gateway.graphql(
    `#graphql
      query bulkEditorTranslatableContent($resourceId: ID!) {
        translatableResource(resourceId: $resourceId) {
          translatableContent { key digest }
        }
      }`,
    { variables: { resourceId } },
  );
  const data = (await response.json()) as {
    data?: { translatableResource?: { translatableContent?: TranslatableContentEntry[] } | null };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);
  const wanted = keys && keys.length > 0 ? new Set(keys) : null;
  const map = new Map<string, string>();
  for (const entry of data.data?.translatableResource?.translatableContent ?? []) {
    if (!entry.digest) continue;
    if (wanted && !wanted.has(entry.key)) continue;
    map.set(entry.key, entry.digest);
  }
  return map;
}

/**
 * Batch-fetch translation digests for many resources × several keys at once
 * (Plan §6.2 — the multi-key generalization of the seo-bulk-fix
 * loadTranslatableDigests). Aliased `a0..aN` sub-selections because Shopify
 * has no `translatableResourcesByIds`; chunked at DIGEST_BATCH_CHUNK,
 * deduplicated, and with a PER-ITEM fallback when a whole chunk fails.
 *
 * Returns resourceId → (key → digest). A resource that was queried but has no
 * digest for a key simply lacks that key in its inner map — the §6.3 rule
 * (one re-fetch, then cell error) is applied by the CALLER, not here. A
 * resource whose chunk AND per-item fallback both failed is absent from the
 * outer map entirely.
 */
export async function loadDigestsForRows(
  gateway: ShopifyApiGateway,
  resourceIds: string[],
  keys: string[],
): Promise<Map<string, Map<string, string>>> {
  const result = new Map<string, Map<string, string>>();
  if (resourceIds.length === 0 || keys.length === 0) return result;

  const unique = Array.from(new Set(resourceIds));
  const wanted = Array.from(new Set(keys));

  for (let i = 0; i < unique.length; i += DIGEST_BATCH_CHUNK) {
    const chunk = unique.slice(i, i + DIGEST_BATCH_CHUNK);

    // Variable names $r0..$rN match alias names a0..aN, so parsing is
    // index-driven. The query TEXT depends only on chunk.length, never on the
    // GIDs — identical batch sizes stay cacheable server-side.
    const varDefs = chunk.map((_, idx) => `$r${idx}: ID!`).join(", ");
    const selections = chunk
      .map(
        (_, idx) =>
          `a${idx}: translatableResource(resourceId: $r${idx}) { translatableContent { key digest } }`,
      )
      .join("\n        ");
    const query = `#graphql
      query bulkEditorBatchDigests(${varDefs}) {
        ${selections}
      }`;
    const variables: Record<string, string> = {};
    for (let idx = 0; idx < chunk.length; idx++) variables[`r${idx}`] = chunk[idx];

    let parsed:
      | Record<string, { translatableContent?: TranslatableContentEntry[] } | null>
      | null = null;
    try {
      const response = await gateway.graphql(query, { variables });
      const data = (await response.json()) as {
        data?: Record<string, { translatableContent?: TranslatableContentEntry[] } | null>;
      };
      parsed = data.data ?? null;
    } catch (err: unknown) {
      logger.warn("[BULK] Digest batch failed — falling back per item", {
        context: "Bulk",
        chunkStart: i,
        chunkSize: chunk.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (parsed) {
      for (let idx = 0; idx < chunk.length; idx++) {
        const node = parsed[`a${idx}`];
        const map = new Map<string, string>();
        for (const entry of node?.translatableContent ?? []) {
          if (entry.digest && wanted.includes(entry.key)) map.set(entry.key, entry.digest);
        }
        result.set(chunk[idx], map);
      }
      continue;
    }

    // Per-item fallback: one bad chunk must not sink the run — each resource
    // gets its own attempt; individual failures leave the id absent so the
    // caller's re-fetch/cell-error rule takes over.
    for (const id of chunk) {
      try {
        result.set(id, await fetchDigestsForResource(gateway, id, wanted));
      } catch (err: unknown) {
        logger.warn("[BULK] Per-item digest fetch failed", {
          context: "Bulk",
          resourceId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}

// ─── Verified register / remove ────────────────────────────────────────────

export interface TranslationInput {
  key: string;
  value: string;
  locale: string;
  translatableContentDigest: string;
  /** Market GID for a market-specific override; omit for global. */
  marketId?: string;
}

export interface TranslationUserError {
  field?: string[] | string;
  message: string;
}

/** A removal confirms KEYS and nothing else — there is no stored value left to
 *  echo, which is why it is its own type rather than a write with a hole. */
export interface VerifiedRemoveResult {
  /** Keys Shopify echoed back — ONLY these may be mirrored into the DB. */
  confirmedKeys: Set<string>;
  userErrors: TranslationUserError[];
}

export interface VerifiedWriteResult extends VerifiedRemoveResult {
  /**
   * key → the value Shopify echoed back, where it sent one.
   *
   * The same rule the theme path already follows ("mirror the PUSHED value to
   * DB, not the raw one"): what Shopify STORED is the truth, and it is what a
   * URL built from a `handle` translation has to be built from. Absent for a
   * key whose echo carried no value, so callers fall back to what they sent.
   */
  confirmedValues: Map<string, string>;
}

/**
 * ONE translationsRegister call for ONE resource, with echo verification
 * (Plan §6.2 — the generalization of templates-update.action.ts:294-315).
 *
 * Shopify can answer without userErrors yet register NOTHING (App-Embed keys
 * silently no-op this way; the same class of bug hit CookieBanner and
 * ThemeContent). The mutation echoes the translations it actually stored —
 * only echoed (key, locale) pairs land in confirmedKeys. §14 no. 7: the echo
 * selection requests `market { id }` (an object — flat marketId does not
 * exist); the market ASSIGNMENT is still tracked by the app itself, so a
 * missing market in the echo does not un-confirm a key.
 *
 * Throws on transport/GraphQL errors — the caller attributes the failure to
 * every input cell.
 */
export async function registerAndVerify(
  gateway: ShopifyApiGateway,
  resourceId: string,
  inputs: TranslationInput[],
): Promise<VerifiedWriteResult> {
  if (inputs.length === 0) return { confirmedKeys: new Set(), confirmedValues: new Map(), userErrors: [] };

  const response = await gateway.graphql(TRANSLATE_CONTENT_VERIFIED, {
    variables: { resourceId, translations: inputs },
  });
  const data = (await response.json()) as {
    data?: {
      translationsRegister?: {
        translations?:
          | { key: string; locale: string; value: string; market?: { id: string } | null }[]
          | null;
        userErrors?: TranslationUserError[];
      };
    };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);

  const userErrors = data.data?.translationsRegister?.userErrors ?? [];
  const echoed = data.data?.translationsRegister?.translations ?? [];

  const confirmedKeys = new Set<string>();
  const confirmedValues = new Map<string, string>();
  for (const input of inputs) {
    const confirmed = echoed?.find(
      (t) =>
        t.key === input.key &&
        t.locale === input.locale &&
        // When Shopify DOES echo a market, it must be the one we wrote; when
        // it doesn't (older echo shape), the app's own tracking governs.
        (!t.market?.id || !input.marketId || t.market.id === input.marketId),
    );
    if (confirmed) {
      confirmedKeys.add(input.key);
      // What Shopify STORED, where it said so — the value a URL gets built
      // from, and the value mirrored into the DB.
      if (typeof confirmed.value === "string" && confirmed.value !== "") {
        confirmedValues.set(input.key, confirmed.value);
      }
    }
  }

  if (confirmedKeys.size < inputs.length) {
    logger.warn("[BULK] translationsRegister did not echo every key", {
      context: "Bulk",
      resourceId,
      sent: inputs.length,
      confirmed: confirmedKeys.size,
      userErrors: userErrors.length,
    });
  }
  return { confirmedKeys, confirmedValues, userErrors };
}

/**
 * ONE translationsRemove call for ONE resource, with echo verification —
 * the clear-cell counterpart (Plan §6.2, templates-update.action.ts:378ff).
 *
 * Keys whose removal Shopify does NOT confirm must NOT be deleted from the
 * local DB (CLAUDE.md invariant) — the caller keeps the local row and marks
 * the cell failed. `marketId` scopes the removal: with a market only that
 * market's override is removed (the global translation survives); without,
 * the global translation is removed.
 */
export async function removeAndVerify(
  gateway: ShopifyApiGateway,
  resourceId: string,
  translationKeys: string[],
  locale: string,
  marketId: string,
): Promise<VerifiedRemoveResult> {
  if (translationKeys.length === 0) return { confirmedKeys: new Set(), userErrors: [] };

  const response = await gateway.graphql(REMOVE_TRANSLATIONS, {
    variables: {
      resourceId,
      translationKeys,
      locales: [locale],
      marketIds: marketId ? [marketId] : null,
    },
  });
  const data = (await response.json()) as {
    data?: {
      translationsRemove?: {
        translations?: { key: string; locale: string }[] | null;
        userErrors?: TranslationUserError[];
      };
    };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);

  const userErrors = data.data?.translationsRemove?.userErrors ?? [];
  const echoed = data.data?.translationsRemove?.translations ?? [];
  const confirmedKeys = new Set<string>();
  for (const key of translationKeys) {
    if (echoed?.some((t) => t.key === key && t.locale === locale)) confirmedKeys.add(key);
  }

  if (confirmedKeys.size < translationKeys.length) {
    logger.warn("[BULK] translationsRemove did not confirm every key — local rows kept", {
      context: "Bulk",
      resourceId,
      sent: translationKeys.length,
      confirmed: confirmedKeys.size,
      userErrors: userErrors.length,
    });
  }
  return { confirmedKeys, userErrors };
}

/** Separator for a confirmed `${locale} ${key}` pair (NUL can't occur in a
 * locale or a translation key). */
export const LOCALE_KEY_SEP = " ";

/**
 * translationsRemove for ONE resource across SEVERAL locales in a single call,
 * with per-(locale, key) echo verification — the multi-locale generalization
 * of removeAndVerify used by the primary-save stale-translation invalidation
 * (Plan §6.6 / Phase 4b). Returns the set of CONFIRMED `${locale} ${key}`
 * pairs Shopify echoed back; ONLY those may be deleted locally (an unconfirmed
 * removal keeps the local row — CLAUDE.md). Throws on transport/GraphQL errors.
 */
export async function removeAndVerifyAcrossLocales(
  gateway: ShopifyApiGateway,
  resourceId: string,
  translationKeys: string[],
  locales: string[],
  marketId: string,
): Promise<{ confirmedPairs: Set<string>; userErrors: TranslationUserError[] }> {
  if (translationKeys.length === 0 || locales.length === 0) {
    return { confirmedPairs: new Set(), userErrors: [] };
  }

  const response = await gateway.graphql(REMOVE_TRANSLATIONS, {
    variables: {
      resourceId,
      translationKeys,
      locales,
      marketIds: marketId ? [marketId] : null,
    },
  });
  const data = (await response.json()) as {
    data?: {
      translationsRemove?: {
        translations?: { key: string; locale: string }[] | null;
        userErrors?: TranslationUserError[];
      };
    };
    errors?: { message: string }[];
  };
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);

  const userErrors = data.data?.translationsRemove?.userErrors ?? [];
  const echoed = data.data?.translationsRemove?.translations ?? [];
  const confirmedPairs = new Set<string>();
  for (const t of echoed ?? []) confirmedPairs.add(`${t.locale}${LOCALE_KEY_SEP}${t.key}`);
  return { confirmedPairs, userErrors };
}
