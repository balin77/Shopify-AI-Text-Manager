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
import {
  DIGEST_BATCH_CHUNK,
  fieldNameOfColumn,
  BULK_COLUMNS_BY_TYPE,
  type BulkRowType,
  type ColumnDescriptor,
} from "./columns.shared";

// ─── Column → Shopify translatable-content key ─────────────────────────────

/**
 * Bulk-editor column field names that differ from the canonical UI field
 * names of FIELD_TO_TRANSLATION_KEY (shopify-content.service.ts — the ONE
 * exported map, Plan §6.1). Only aliases live here; the actual field→key
 * mapping must never be re-declared.
 */
const COLUMN_FIELD_ALIAS: Record<string, string> = {
  descriptionHtml: "description",
  seoDescription: "metaDescription",
};

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
  if (column.kind !== "field") return null;
  const field = fieldNameOfColumn(column);
  const keyMap = rowType === "policy" ? fieldTranslationKeyMap("ShopPolicy") : FIELD_TO_TRANSLATION_KEY;
  return keyMap[COLUMN_FIELD_ALIAS[field] ?? field] ?? null;
}

/** Canonical UI field name for a bulk column ("descriptionHtml" →
 * "description") — the name the AI translation prompts and the single-editor
 * paths use. */
export function canonicalFieldNameForColumn(column: ColumnDescriptor): string {
  const field = fieldNameOfColumn(column);
  return COLUMN_FIELD_ALIAS[field] ?? field;
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
};

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

export interface VerifiedWriteResult {
  /** Keys Shopify echoed back — ONLY these may be mirrored into the DB. */
  confirmedKeys: Set<string>;
  userErrors: TranslationUserError[];
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
  if (inputs.length === 0) return { confirmedKeys: new Set(), userErrors: [] };

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
  for (const input of inputs) {
    const confirmed = echoed?.some(
      (t) =>
        t.key === input.key &&
        t.locale === input.locale &&
        // When Shopify DOES echo a market, it must be the one we wrote; when
        // it doesn't (older echo shape), the app's own tracking governs.
        (!t.market?.id || !input.marketId || t.market.id === input.marketId),
    );
    if (confirmed) confirmedKeys.add(input.key);
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
  return { confirmedKeys, userErrors };
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
): Promise<VerifiedWriteResult> {
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
