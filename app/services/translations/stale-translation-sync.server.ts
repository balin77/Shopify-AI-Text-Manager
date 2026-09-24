/**
 * Sync-side reconciliation of stale foreign translations.
 *
 * The editors in this app already purge a field's foreign translations when
 * the merchant changes its primary value here. Nothing did when the primary
 * text changed ANYWHERE ELSE — the Shopify admin, another app, a CSV import —
 * so the storefront kept serving a translation of a text that no longer
 * exists, invisibly, until someone re-opened that item. This module closes
 * that gap: every sync that represents a CHANGE EVENT for one resource
 * (webhook, webhook retry/reconcile, an explicit single-item reload) hands its
 * freshly fetched translations here, and stale ones are removed on Shopify AND
 * locally right away.
 *
 * Three rules keep it safe:
 *
 *  - **It costs no extra API call to DETECT.** The staleness signals
 *    (`translations.outdated`, and a key missing from `translatableContent`)
 *    both ride on the query the sync already makes. Shopify is only called
 *    when something actually IS stale.
 *  - **Removal is echo-verified.** `translationsRemove` can silently no-op
 *    (CLAUDE.md), so a local row is deleted ONLY for a (locale, key) pair
 *    Shopify confirms. An unconfirmed removal keeps the row — a DB that
 *    disagrees with Shopify is worse than a stale row.
 *  - **It never runs on a FULL sync.** Callers opt in per resource. A shop's
 *    first full sync would otherwise mass-delete every translation Shopify has
 *    ever flagged outdated — including hand-written ones the merchant has not
 *    looked at yet. Change events are what the merchant asked to react to.
 *
 * Max plan (`autoTranslateExternalChanges`): instead of leaving the field
 * untranslated, the NEW primary value is re-translated into that locale and
 * registered. Anything that cannot be re-translated (cleared field, missing
 * digest, `handle`, AI error, no API key) falls back to the purge, so the
 * storefront never keeps the stale text because automation failed. That AI run
 * is DETACHED and Task-tracked — two callers await this sync inside an HTTP
 * request, and one AI request per locale does not fit in one. The purge stays
 * inline (one GraphQL call), so the storefront is corrected immediately.
 *
 * The column's name (`autoTranslateExternalChanges`) is historic rather than
 * exact: switching it on switches the PURGE off (the policy module resolves the
 * pair), so the translations survive an in-app save with their old digest and
 * the very same detection re-translates that change too — an edit made here is
 * treated exactly like one made in the Shopify admin. Deleting the rows a
 * re-translation is about to refresh is the combination that means nothing,
 * which is why it cannot be configured.
 */

import { randomUUID } from "node:crypto";
import { logger } from "../../utils/logger.server";
import {
  markTranslationSaved,
  isTranslationRecentlySaved,
  translationSavedAt,
} from "../../utils/translation-save-lock.server";
// One shape for "walk past this override", shared with every save path.
import { marketOverrideKey } from "./market-layer-purge.server";
import { TRANSLATION_BATCH } from "../../config/constants";
import { sanitizeSlug } from "../../utils/slug.utils";
import { ShopifyApiGateway } from "../shopify-api-gateway.service";
import type { ShopifyGraphQLClient } from "../sync-types";
import type {
  HandleRedirectResolver,
  TranslatedHandleContext,
} from "./handle-retranslation.server";
import {
  registerAndVerify,
  removeAndVerify,
  removeAndVerifyAcrossLocales,
  LOCALE_KEY_SEP,
} from "../bulk-editor/translations.server";
import {
  loadTranslationChangePolicy,
  type TranslationChangePolicy,
} from "./translation-change-policy.server";
import {
  classifyStaleTranslation,
  digestBaselineKey,
  findStaleTranslations,
  MANAGED_TRANSLATION_KEYS as MANAGED_KEYS_FOR_BASELINE,
  nextPrimaryDigestBaseline,
  primaryDigestBaselineTarget,
  partitionStaleTranslations,
  primaryBaselineMovedKeys,
  type PrimaryContentEntry,
  type StaleTranslation,
  type SyncedTranslation,
} from "./stale-translations.shared";

export type { PrimaryContentEntry, SyncedTranslation } from "./stale-translations.shared";

/**
 * WHO is being repaired — the part both entry points share. `ReconcileParams`
 * adds the EVIDENCE the sync-side detection needs on top of it; the in-app save
 * carries none of that, because it is the change event itself.
 */
export interface RepairTarget {
  /** Anything with `.graphql` — `admin` or an existing gateway. */
  client: ShopifyGraphQLClient;
  shop: string;
  resourceId: string;
  /** `ContentTranslation.resourceType` — "Product" | "Collection" | "Article" | "Page" | "Blog" | "ShopPolicy". */
  resourceType: string;
  /**
   * The merchant-facing kind, used for BOTH the AI prompt and the Task row's
   * badge. These four strings are the ones `AIService.translateFields`
   * recognises AND the ones the Tasks tab has a label for — an article is a
   * "blog" to both. Passing the Shopify resource type here (the capitalised
   * one) silently degrades the prompt to "product fields".
   */
  contentKind: "product" | "collection" | "blog" | "page";
  /**
   * What goes into `Task.resourceType`, when that is NOT the same question as
   * the AI prompt's kind: a metaobject, a menu or a theme group must not
   * travel as "page", or the Tasks row is BADGED as a page. Defaults to
   * `contentKind`, which is right wherever the two agree.
   *
   * It decides the badge and nothing else. The row's in-app editor link is
   * derived from the GID (`task-deep-link.shared.ts`), never from this string
   * — which is what retired the old admin-path map this used to steer around,
   * and why a metaobject or a menu now links to its own editor rather than to
   * nothing.
   */
  taskResourceType?: string;
  /**
   * The key this run CLAIMS and watches under, when that must not be the
   * resource id itself. Defaults to `resourceId`.
   *
   * Claiming is how a repair tells the sync "I am handling this resource"
   * (`isTranslationRecentlySaved`) and how two runs for the same thing queue
   * instead of racing. But a product carries SEVERAL independent repairs — its
   * own fields via the `products/update` webhook, its sub-resources and its alt
   * texts from their own saves — and if the alt repair claims the product, the
   * webhook's field reconciliation bails for 30 seconds and those field
   * translations are neither purged nor refreshed, permanently, because the
   * sync has already advanced their digest baseline. A private key keeps the
   * Task row on the product (where the merchant can recognise it) while leaving
   * the product's own lock alone.
   *
   * The WATCH list still covers the resource and every entry, so a merchant
   * save on any of them still aborts the run.
   */
  lockId?: string;
  /** Shown on the Task row when a re-translation runs. */
  resourceTitle?: string;
  /**
   * How the AI is asked for the new text.
   *
   * Omitted = the CONTENT-FIELD path: each key maps to a named field
   * (`title`, `body_html`, …) and one request per locale translates them
   * together, with the merchant's translate instructions and the SEO length
   * limits applied per field name. That only works where the keys ARE those
   * fields.
   *
   * A metafield value, an option name, a metaobject field or a theme string
   * has no field semantics at all — its key is `value`, `name` or a theme
   * key nobody can write a length limit for. Those pass `{ kind: "values" }`
   * and go through `translateBatchValues`, the same generic prompt the bulk
   * editor already uses for exactly these columns, with `context` naming what
   * the values ARE so the model has something to go on.
   */
  translateAs?: {
    kind: "values";
    context: string;
    /**
     * The language the values are written in — the shop's primary locale. Named
     * rather than "auto": the caller has just written this text, so the source
     * is known, and telling the model beats asking it to guess per value.
     */
    sourceLocale: string;
  };
  /**
   * Where the confirmed translations are mirrored locally. Omitted = the
   * `ContentTranslation` table keyed by this resourceId/resourceType, which is
   * correct for everything Shopify addresses as its own translatable resource
   * AND that this app mirrors there — including the SUB-RESOURCES, whose rows
   * sit on their own GID with resourceType "Metafield" / "ProductOption" /
   * "ProductOptionValue".
   *
   * Metaobject fields and theme content keep their translations in tables of
   * their own (`MetaobjectTranslation`, `ThemeTranslation`), so they pass a
   * mirror. The SHOPIFY side is identical everywhere — one translations API,
   * keyed by GID + key + locale — which is why only the mirror is pluggable.
   */
  mirror?: TranslationMirror;
  /**
   * May a `handle` entry move, and where does its old foreign URL go?
   *
   * A handle is a URL, so the merchant's opt-in
   * (`AISettings.autoTranslateHandles`) is only half the answer: the other half
   * is whether a redirect can be put on the address the slug is moving away
   * from, which needs the caches and Shopify, not a key and a value. This
   * resolver answers it per (resource, locale), and a `handle` it declines —
   * or that reaches a repair with NO resolver at all — is left alone entirely:
   * not translated, and NOT purged either, because deleting the translation
   * moves the foreign URL just as surely as rewriting it would.
   *
   * Both entry points build the standard one
   * (handle-retranslation.server.ts) when the policy allows handles, so no
   * caller has to remember it; the field exists so a test can answer without a
   * shop.
   */
  handleRedirect?: HandleRedirectResolver;
}

/**
 * The local half of a translation write, per surface. Three operations,
 * because that is all the repair does to the mirror: ask what is already
 * there, drop what Shopify confirmed removed, and write back what Shopify
 * confirmed stored.
 *
 * `existing` / `remove` / `write` are GLOBAL-layer only (`marketId ""` where the table has
 * the column): a market override is a deliberate separate value and survives a
 * primary change, the same rule both editors follow.
 */
export interface TranslationMirror {
  /** The (resource, locale, key) triples this store already holds, for the
   *  union in the in-app detection. */
  existing(
    refs: readonly TranslationRef[],
    foreignLocales: readonly string[],
    keys: readonly string[],
  ): Promise<Array<{ resourceId: string; locale: string; key: string }>>;
  /** Drop the rows for keys Shopify CONFIRMED it removed. */
  remove(ref: TranslationRef, locale: string, keys: readonly string[]): Promise<void>;
  /**
   * The MARKET-layer rows this store holds for those keys and locales, each
   * with the market it belongs to.
   *
   * A market override is a deliberately different wording for one market, so
   * nothing in this app ever re-translates it — but when the primary text it
   * describes moves, it is exactly as stale as the global row beside it, and
   * for a long time nothing removed it either. `purgeMarketOverrides`
   * (market-layer-purge.server.ts) is what does, and this is where it looks.
   *
   * Reported in SHOPIFY terms — the resource the removal addresses and the key
   * it sends — exactly like `existing`, because two of these stores keep their
   * rows under a different id and key than Shopify does.
   */
  marketRows(
    refs: readonly TranslationRef[],
    foreignLocales: readonly string[],
    keys: readonly string[],
  ): Promise<Array<{ resourceId: string; locale: string; key: string; marketId: string }>>;
  /** Drop ONE market layer's rows for keys Shopify CONFIRMED it removed. */
  removeMarket(
    ref: TranslationRef,
    locale: string,
    keys: readonly string[],
    marketId: string,
  ): Promise<void>;
  /** Write back one translation Shopify CONFIRMED it stored. */
  write(
    ref: TranslationRef,
    locale: string,
    key: string,
    value: string,
    digest: string,
  ): Promise<void>;
}

/** One Shopify translatable resource, as the mirror addresses it. */
export interface TranslationRef {
  resourceId: string;
  resourceType: string;
}

/**
 * The default mirror: `ContentTranslation`, keyed by the resource's own GID.
 * Correct for products, collections, pages, articles, blogs, policies, the
 * sub-resources and MediaImage alts alike — they all live in that one table,
 * distinguished by `resourceType`.
 */
export function contentTranslationMirror(shop: string): TranslationMirror {
  return {
    async existing(refs, foreignLocales, keys) {
      if (refs.length === 0) return [];
      const { db } = await import("../../db.server");
      return db.contentTranslation.findMany({
        where: {
          shop,
          marketId: "",
          key: { in: [...keys] },
          locale: { in: [...foreignLocales] },
          OR: refs.map((ref) => ({ resourceId: ref.resourceId, resourceType: ref.resourceType })),
        },
        select: { resourceId: true, key: true, locale: true },
      });
    },
    async remove(ref, locale, keys) {
      const { db } = await import("../../db.server");
      await db.contentTranslation.deleteMany({
        where: {
          shop,
          resourceId: ref.resourceId,
          resourceType: ref.resourceType,
          locale,
          marketId: "",
          key: { in: [...keys] },
        },
      });
    },
    async marketRows(refs, foreignLocales, keys) {
      if (refs.length === 0) return [];
      const { db } = await import("../../db.server");
      const byId = new Map(refs.map((ref) => [ref.resourceId, ref.resourceType] as const));
      const rows = await db.contentTranslation.findMany({
        where: {
          shop,
          marketId: { not: "" },
          OR: refs.map((ref) => ({ resourceId: ref.resourceId, resourceType: ref.resourceType })),
          key: { in: [...keys] },
          locale: { in: [...foreignLocales] },
        },
        select: { resourceId: true, key: true, locale: true, marketId: true },
      });
      return rows.filter((row: { resourceId: string }) => byId.has(row.resourceId));
    },
    async removeMarket(ref, locale, keys, marketId) {
      const { db } = await import("../../db.server");
      await db.contentTranslation.deleteMany({
        where: {
          shop,
          resourceId: ref.resourceId,
          resourceType: ref.resourceType,
          locale,
          marketId,
          key: { in: [...keys] },
        },
      });
    },
    async write(ref, locale, key, value, digest) {
      const { db } = await import("../../db.server");
      await db.contentTranslation.upsert({
        where: {
          shop_resourceId_key_locale_marketId: {
            shop,
            resourceId: ref.resourceId,
            key,
            locale,
            marketId: "",
          },
        },
        create: {
          shop,
          resourceId: ref.resourceId,
          resourceType: ref.resourceType,
          key,
          value,
          locale,
          digest,
          marketId: "",
        },
        update: { value, digest },
      });
    },
  };
}

/**
 * `MetaobjectTranslation` — a table of its own, keyed by the ENTRY's GID plus
 * the field key. A metaobject is one Shopify translatable resource carrying
 * every field of its definition, so a single entry's fields never fan out the
 * way a product's sub-resources do; one SAVE can still touch several entries,
 * which is why the refs are read rather than closed over.
 *
 * The row also carries `type` (the BARE metaobject type, CLAUDE.md) and
 * `outdated`, which the write resets: a value this app has just re-translated
 * against the current source is by definition not outdated any more.
 */
export function metaobjectTranslationMirror(
  shop: string,
  /** Entry GID → its BARE metaobject type (CLAUDE.md), for the rows this
   *  creates. One save can touch several entries of the same type. */
  typeById: ReadonlyMap<string, string>,
): TranslationMirror {
  return {
    async existing(refs, foreignLocales, keys) {
      if (refs.length === 0) return [];
      const { db } = await import("../../db.server");
      const rows = await db.metaobjectTranslation.findMany({
        where: {
          shop,
          metaobjectId: { in: refs.map((ref) => ref.resourceId) },
          marketId: "",
          key: { in: [...keys] },
          locale: { in: [...foreignLocales] },
        },
        select: { metaobjectId: true, key: true, locale: true },
      });
      return rows.map((row: { metaobjectId: string; key: string; locale: string }) => ({
        resourceId: row.metaobjectId,
        key: row.key,
        locale: row.locale,
      }));
    },
    async remove(ref, locale, keys) {
      const { db } = await import("../../db.server");
      await db.metaobjectTranslation.deleteMany({
        where: {
          shop,
          metaobjectId: ref.resourceId,
          locale,
          marketId: "",
          key: { in: [...keys] },
        },
      });
    },
    async marketRows(refs, foreignLocales, keys) {
      if (refs.length === 0) return [];
      const { db } = await import("../../db.server");
      const rows = await db.metaobjectTranslation.findMany({
        where: {
          shop,
          metaobjectId: { in: refs.map((ref) => ref.resourceId) },
          marketId: { not: "" },
          key: { in: [...keys] },
          locale: { in: [...foreignLocales] },
        },
        select: { metaobjectId: true, key: true, locale: true, marketId: true },
      });
      return rows.map(
        (row: { metaobjectId: string; key: string; locale: string; marketId: string }) => ({
          resourceId: row.metaobjectId,
          key: row.key,
          locale: row.locale,
          marketId: row.marketId,
        }),
      );
    },
    async removeMarket(ref, locale, keys, marketId) {
      const { db } = await import("../../db.server");
      await db.metaobjectTranslation.deleteMany({
        where: {
          shop,
          metaobjectId: ref.resourceId,
          locale,
          marketId,
          key: { in: [...keys] },
        },
      });
    },
    async write(ref, locale, key, value) {
      const { db } = await import("../../db.server");
      await db.metaobjectTranslation.upsert({
        where: {
          shop_metaobjectId_key_locale_marketId: {
            shop,
            metaobjectId: ref.resourceId,
            key,
            locale,
            marketId: "",
          },
        },
        create: {
          shop,
          metaobjectId: ref.resourceId,
          type: typeById.get(ref.resourceId) ?? "",
          key,
          value,
          locale,
          outdated: false,
          marketId: "",
        },
        update: { value, outdated: false },
      });
    },
  };
}

/**
 * `ProductImageAltTranslation` — the store for a PRODUCT medium's alt text.
 *
 * Three things make it its own mirror. The row is keyed by the ProductImage
 * CACHE row, not by the MediaImage GID Shopify is addressed with, so every
 * operation here translates between the two; the table has no `key` column at
 * all, because a MediaImage has exactly one translatable key (`alt`) — the key
 * argument is therefore accepted and ignored rather than written; and it has no
 * `digest` column either, which costs nothing because the digest is only needed
 * to REGISTER on Shopify and this path reads a fresh one for every write
 * (CLAUDE.md — the mirror's digest is a sync-side detection baseline, and this
 * surface has no sync-side detection).
 *
 * THE CACHE ROW ID IS RESOLVED FRESH, ON EVERY OPERATION, and that is the whole
 * point of the (shop, productId) pair this takes instead of a captured map.
 * `syncProduct` and `syncAllProducts` do not UPDATE a product's `ProductImage`
 * rows — they `deleteMany` and recreate them, minting a new cuid per image and
 * re-attaching the alt translations by `mediaId`. The bulk editor's own alt
 * write goes through `productUpdateMedia`, which fires `products/update`, so
 * that sync lands seconds later — while the repair this mirror belongs to is a
 * DETACHED AI run that takes far longer. A cuid captured when the group was
 * collected is therefore dangling by the time the run writes, and the upsert
 * under it does not fail loudly: `create` violates the FK, the repair's
 * per-entry catch records "registered on Shopify but not mirrored locally", and
 * the loader — which reads by the CURRENT cache row — shows the merchant an
 * empty field for a translation Shopify is serving. Permanently, because
 * nothing revisits it.
 *
 * `(productId, mediaId)` is the stable address, and the table's own
 * `@@unique([productId, mediaId])` is exactly that pair. An image the lookup
 * cannot resolve is REPORTED, never written under a guessed id and never
 * silently skipped: `write` throws so the caller's mirror-failure bookkeeping
 * sees it (a translation on Shopify with no local row is the merchant-visible
 * defect above, and it may not be invisible in the Tasks tab as well).
 */
export function productImageAltMirror(shop: string, productId: string): TranslationMirror {
  /**
   * MediaImage GID → the CURRENT ProductImage cache row id, read now. Never
   * memoised: a product sync can land between two locales of one run, and a
   * memo would carry the pre-sync ids across exactly that boundary.
   */
  const resolve = async (mediaIds: readonly string[]): Promise<Map<string, string>> => {
    const wanted = [...new Set(mediaIds.filter(Boolean))];
    if (wanted.length === 0) return new Map();
    const { db } = await import("../../db.server");
    // `productId` scopes the lookup onto the unique index; `product: { shop }`
    // is the tenancy check every read in this file carries.
    const rows = await db.productImage.findMany({
      where: { productId, mediaId: { in: wanted }, product: { shop } },
      select: { id: true, mediaId: true },
    });
    const byMedia = new Map<string, string>();
    for (const row of rows as Array<{ id: string; mediaId: string | null }>) {
      if (row.mediaId) byMedia.set(row.mediaId, row.id);
    }
    return byMedia;
  };

  return {
    async existing(refs, foreignLocales) {
      const byMedia = await resolve(refs.map((ref) => ref.resourceId));
      if (byMedia.size === 0) return [];
      const mediaByImageId = new Map([...byMedia].map(([media, image]) => [image, media]));
      const { db } = await import("../../db.server");
      const rows = await db.productImageAltTranslation.findMany({
        where: {
          imageId: { in: [...mediaByImageId.keys()] },
          marketId: "",
          locale: { in: [...foreignLocales] },
        },
        select: { imageId: true, locale: true },
      });
      return rows
        .map((row: { imageId: string; locale: string }) => ({
          resourceId: mediaByImageId.get(row.imageId) ?? "",
          locale: row.locale,
          key: "alt",
        }))
        .filter((row: { resourceId: string }) => !!row.resourceId);
    },
    async remove(ref, locale) {
      const imageId = (await resolve([ref.resourceId])).get(ref.resourceId);
      // No cache row ⇒ no rows to drop: `ProductImageAltTranslation` cascades
      // on `ProductImage`, so an image that is gone took its translations with
      // it. A true no-op, unlike the write below, which would lose data.
      if (!imageId) return;
      const { db } = await import("../../db.server");
      await db.productImageAltTranslation.deleteMany({ where: { imageId, locale, marketId: "" } });
    },
    async marketRows(refs, foreignLocales) {
      const byMedia = await resolve(refs.map((ref) => ref.resourceId));
      if (byMedia.size === 0) return [];
      const mediaByImageId = new Map([...byMedia].map(([media, image]) => [image, media]));
      const { db } = await import("../../db.server");
      const rows = await db.productImageAltTranslation.findMany({
        where: {
          imageId: { in: [...mediaByImageId.keys()] },
          marketId: { not: "" },
          locale: { in: [...foreignLocales] },
        },
        select: { imageId: true, locale: true, marketId: true },
      });
      return rows
        .map((row: { imageId: string; locale: string; marketId: string }) => ({
          resourceId: mediaByImageId.get(row.imageId) ?? "",
          locale: row.locale,
          key: "alt",
          marketId: row.marketId,
        }))
        .filter((row: { resourceId: string }) => !!row.resourceId);
    },
    async removeMarket(ref, locale, _keys, marketId) {
      const imageId = (await resolve([ref.resourceId])).get(ref.resourceId);
      if (!imageId) return;
      const { db } = await import("../../db.server");
      await db.productImageAltTranslation.deleteMany({ where: { imageId, locale, marketId } });
    },
    async write(ref, locale, _key, value) {
      const imageId = (await resolve([ref.resourceId])).get(ref.resourceId);
      // LOUD, never a silent return. Shopify has already confirmed this
      // translation by the time a mirror write runs, so "no row here" means the
      // storefront serves a value this app cannot show — the one outcome the
      // merchant reports as "the field stays empty".
      if (!imageId) {
        throw new Error(
          `No cached ProductImage row for ${ref.resourceId} on ${productId} — the alt translation is live on Shopify but could not be mirrored. Resync the product.`,
        );
      }
      const { db } = await import("../../db.server");
      await db.productImageAltTranslation.upsert({
        where: { imageId_locale_marketId: { imageId, locale, marketId: "" } },
        create: { imageId, locale, altText: value, marketId: "" },
        update: { altText: value },
      });
    },
  };
}

/**
 * A collection's / article's FEATURED-image alt — the third translation shape
 * (CLAUDE.md), and the only mirror where BOTH halves of the address differ from
 * Shopify's: Shopify stores key `alt` on the image's own
 * CollectionImage/ArticleImage GID, while the row sits on the PARENT under
 * `image_alt_text`. Both editors read that row, so the rewrite happens here
 * rather than in a second row nobody else looks at.
 */
export function featuredImageAltMirror(
  shop: string,
  parentId: string,
  parentType: string,
): TranslationMirror {
  const DB_KEY = "image_alt_text";
  return {
    async existing(refs, foreignLocales) {
      if (refs.length === 0) return [];
      const { db } = await import("../../db.server");
      const rows = await db.contentTranslation.findMany({
        where: {
          shop,
          resourceId: parentId,
          resourceType: parentType,
          key: DB_KEY,
          marketId: "",
          locale: { in: [...foreignLocales] },
        },
        select: { locale: true },
      });
      // Reported under the IMAGE's id and Shopify's key, because that is what
      // the detection, the removal and the register all address.
      return rows.map((row: { locale: string }) => ({
        resourceId: refs[0].resourceId,
        locale: row.locale,
        key: "alt",
      }));
    },
    async remove(_ref, locale) {
      const { db } = await import("../../db.server");
      await db.contentTranslation.deleteMany({
        where: { shop, resourceId: parentId, resourceType: parentType, key: DB_KEY, locale, marketId: "" },
      });
    },
    async marketRows(refs, foreignLocales) {
      if (refs.length === 0) return [];
      const { db } = await import("../../db.server");
      const rows = await db.contentTranslation.findMany({
        where: {
          shop,
          resourceId: parentId,
          resourceType: parentType,
          key: DB_KEY,
          marketId: { not: "" },
          locale: { in: [...foreignLocales] },
        },
        select: { locale: true, marketId: true },
      });
      // The IMAGE's id and Shopify's key, for the same reason `existing` does.
      return rows.map((row: { locale: string; marketId: string }) => ({
        resourceId: refs[0].resourceId,
        locale: row.locale,
        key: "alt",
        marketId: row.marketId,
      }));
    },
    async removeMarket(_ref, locale, _keys, marketId) {
      const { db } = await import("../../db.server");
      await db.contentTranslation.deleteMany({
        where: { shop, resourceId: parentId, resourceType: parentType, key: DB_KEY, locale, marketId },
      });
    },
    async write(_ref, locale, _key, value, digest) {
      const { db } = await import("../../db.server");
      await db.contentTranslation.upsert({
        where: {
          shop_resourceId_key_locale_marketId: {
            shop,
            resourceId: parentId,
            key: DB_KEY,
            locale,
            marketId: "",
          },
        },
        create: {
          shop,
          resourceId: parentId,
          resourceType: parentType,
          key: DB_KEY,
          value,
          locale,
          digest,
          marketId: "",
        },
        update: { value, digest },
      });
    },
  };
}

/**
 * `ThemeTranslation` — the only mirror whose unique key folds BOTH the theme and
 * the market (CLAUDE.md), so it needs the group and the domain the caller is
 * saving as well as the resource.
 *
 * `themeId` is DERIVED from the resource id with the same helper the save path
 * uses, never passed in: the two must agree on which theme a row belongs to,
 * and a group can legitimately span resources of different themes.
 */
export function themeTranslationMirror(
  shop: string,
  groupId: string,
  domain: string,
): TranslationMirror {
  return {
    async existing(refs, foreignLocales, keys) {
      if (refs.length === 0) return [];
      const { db } = await import("../../db.server");
      const rows = await db.themeTranslation.findMany({
        where: {
          shop,
          groupId,
          domain,
          marketId: "",
          resourceId: { in: refs.map((ref) => ref.resourceId) },
          key: { in: [...keys] },
          locale: { in: [...foreignLocales] },
        },
        select: { resourceId: true, key: true, locale: true },
      });
      return rows;
    },
    async remove(ref, locale, keys) {
      const { db } = await import("../../db.server");
      await db.themeTranslation.deleteMany({
        where: {
          shop,
          groupId,
          domain,
          marketId: "",
          resourceId: ref.resourceId,
          locale,
          key: { in: [...keys] },
        },
      });
    },
    async marketRows(refs, foreignLocales, keys) {
      if (refs.length === 0) return [];
      const { db } = await import("../../db.server");
      return db.themeTranslation.findMany({
        where: {
          shop,
          groupId,
          domain,
          marketId: { not: "" },
          resourceId: { in: refs.map((ref) => ref.resourceId) },
          key: { in: [...keys] },
          locale: { in: [...foreignLocales] },
        },
        select: { resourceId: true, key: true, locale: true, marketId: true },
      });
    },
    async removeMarket(ref, locale, keys, marketId) {
      const { db } = await import("../../db.server");
      await db.themeTranslation.deleteMany({
        where: {
          shop,
          groupId,
          domain,
          marketId,
          resourceId: ref.resourceId,
          locale,
          key: { in: [...keys] },
        },
      });
    },
    async write(ref, locale, key, value) {
      const { db } = await import("../../db.server");
      const { extractThemeIdFromResourceId } = await import("../../utils/theme-id");
      const themeId = extractThemeIdFromResourceId(ref.resourceId) ?? "";
      await db.themeTranslation.upsert({
        where: {
          shop_resourceId_groupId_key_locale_themeId_marketId: {
            shop,
            resourceId: ref.resourceId,
            groupId,
            key,
            locale,
            themeId,
            marketId: "",
          },
        },
        create: {
          shop,
          resourceId: ref.resourceId,
          domain,
          groupId,
          key,
          value,
          locale,
          outdated: false,
          themeId,
          marketId: "",
        },
        // `outdated` goes back to false: a value just re-translated against the
        // current source is not older than it by definition.
        update: { value, outdated: false },
      });
    },
  };
}

/**
 * The rate-limited client for a repair. A caller that already holds a gateway
 * hands it over as `client`, and wrapping it a second time would give this run
 * its own queue and its own retry budget on top of the caller's — two schedulers
 * pacing the same shop, inside the merchant's save request.
 */
function gatewayFor(client: ShopifyGraphQLClient, shop: string): ShopifyApiGateway {
  return client instanceof ShopifyApiGateway ? client : new ShopifyApiGateway(client, shop);
}

/** The mirror a target asks for, or the ContentTranslation default. */
function mirrorOf(target: RepairTarget): TranslationMirror {
  return target.mirror ?? contentTranslationMirror(target.shop);
}

/** Which resource an entry belongs to — its own, or the group's. */
function refOf(target: RepairTarget, entry: StaleTranslation): TranslationRef {
  return {
    resourceId: entry.resourceId ?? target.resourceId,
    resourceType: entry.resourceType ?? target.resourceType,
  };
}

export interface ReconcileParams extends RepairTarget {
  /** Every translation row this sync fetched (all market layers). */
  translations: readonly SyncedTranslation[];
  /** `translatableContent` of the resource: key → { value, digest }. */
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>;
  /**
   * `digestBaselineKey(locale, key)` → the source digest that row was written
   * against, from `loadPreviousTranslationDigests`. MUST be captured BEFORE the
   * sync overwrites the cache, and is what proves the primary text moved in
   * THIS sync rather than at some unknown point in the past. Absent ⇒ nothing
   * is considered stale.
   */
  previousDigests: Readonly<Record<string, string | null | undefined>>;
  /**
   * The shop's PUBLISHED foreign locales, for the fill: a key this sync proved
   * moved is translated into every one of them, not only into the ones that
   * already carried a translation (see `findStaleTranslations`' `fillLocales`).
   * Only used when the merchant's auto-translation is really in force.
   *
   * Optional because it is the caller's knowledge, not this function's, and a
   * caller that cannot supply it keeps the older "refresh what is there"
   * behaviour rather than guessing a locale list out of the rows it happens to
   * hold — those are exactly the locales the fill is supposed to look past.
   */
  foreignLocales?: readonly string[];
  /**
   * The PRIMARY digest baseline of this resource (`PrimaryDigestBaseline`), for
   * the gate's second entrance. Omitted ⇒ read here, BEFORE anything is
   * written; the drift sweep passes the map it already loaded for the whole
   * type in one query. `{}` means "no row" (no evidence), and is what makes the
   * first look harmless. Either way this function writes the NEXT baseline
   * after it has decided — never before, or it would compare against its own
   * write.
   */
  previousPrimaryDigests?: Readonly<Record<string, string>>;
}

export interface ReconcileResult {
  /** (locale, key) pairs removed on Shopify AND locally, inline. */
  removed: number;
  /**
   * (locale, key) pairs handed to the DETACHED re-translation run (Max). They
   * are not finished when this resolves — the run is Task-tracked and the
   * merchant follows it in the Tasks tab, exactly like every other AI
   * operation in this app.
   */
  retranslating: number;
  /**
   * The `Task` row that detached run will report under — minted HERE, before
   * the run is spawned, so a caller that answers an HTTP request can hand the
   * id back with the save.
   *
   * The row itself does not exist yet when this resolves (and will not until
   * the run reaches the head of its in-flight queue), so a reader must treat
   * "no such task" as NOT-YET rather than as finished. That is the price of the
   * id being knowable at all: the alternative is a caller that has just written
   * a row it cannot tell the merchant anything about.
   */
  taskId?: string;
}

const NOTHING: ReconcileResult = { removed: 0, retranslating: 0 };

/**
 * Resources whose DETACHED re-translation run is still going, so a second
 * change event for the same resource does not start a duplicate run against
 * the same entries. Shopify emits several `products/update` webhooks for one
 * admin save, and without this each one would spawn its own AI run, its own
 * Task row, and race the others' writes. In-process only — that is enough,
 * because the runs it guards are themselves in-process.
 */
const retranslationsInFlight = new Map<string, Promise<void>>();
/** Separator for the in-flight key — written as an escape, never as a literal
 * control byte (a NUL in the source makes git treat the file as binary). */
const IN_FLIGHT_SEP = "\u0000";

/**
 * Test seam: resolve once every detached re-translation currently running has
 * finished. Production code never calls this — the runs are deliberately not
 * awaited (see the header) — but a test that cannot observe them can only
 * assert the inline half, which is how the "a confirmed write must never be
 * purged because the DB blinked" bug stayed invisible.
 */
export async function awaitDetachedRetranslations(): Promise<void> {
  await Promise.allSettled([...retranslationsInFlight.values()]);
}

/**
 * The source digest each of this resource's GLOBAL translation rows was last
 * written against, keyed by `digestBaselineKey(locale, key)`. Must be read
 * BEFORE the sync overwrites them; comparing them to the freshly fetched
 * digests is what tells "the primary text moved in this sync" apart from
 * "Shopify still flags this translation outdated from some edit years ago".
 *
 * PER ROW, not per key: a digest describes the source a PARTICULAR translation
 * was written against, and two locales legitimately hold different ones
 * (translate DE, the merchant edits the source, translate FR). One baseline per
 * key made which row got repaired depend on the order Postgres returned them
 * in.
 *
 * Best-effort: on error we return {} , which makes the reconciliation a no-op
 * rather than acting on an unknown baseline.
 */
export async function loadPreviousTranslationDigests(
  shop: string,
  resourceId: string,
  resourceType: string,
): Promise<Record<string, string | null>> {
  try {
    const { db } = await import("../../db.server");
    const rows = await db.contentTranslation.findMany({
      where: { shop, resourceId, resourceType, marketId: "" },
      select: { key: true, locale: true, digest: true },
    });
    const out: Record<string, string | null> = {};
    for (const row of rows) out[digestBaselineKey(row.locale, row.key)] = row.digest;
    return out;
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Could not read previous digests — skipping reconciliation", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * The PRIMARY digest baseline of one resource — key → the digest
 * `translatableContent` reported the last time a change-event sync or the drift
 * sweep looked (`PrimaryDigestBaseline`). The gate's second entrance compares
 * against it, and unlike `loadPreviousTranslationDigests` it exists for a
 * resource with no translation at all.
 *
 * `{}` = no row = no evidence (rule one). `null` = the read FAILED, which is
 * different: the caller then neither acts on the second entrance nor writes a
 * new baseline, because overwriting an unknown baseline would erase the evidence
 * of a move it never compared against.
 */
export async function loadPrimaryDigestBaseline(
  shop: string,
  resourceId: string,
  dbClient?: typeof import("../../db.server").db,
): Promise<Record<string, string> | null> {
  try {
    const db = dbClient ?? (await import("../../db.server")).db;
    const row = await db.primaryDigestBaseline.findUnique({
      where: { shop_resourceId: { shop, resourceId } },
      select: { digests: true },
    });
    return primaryDigestMap(row?.digests);
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Could not read the primary digest baseline", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Overlay the text a SAVE just read back onto the resource's primary baseline
 * (see the call in `reconcileAfterPrimarySave`). Best-effort, and it never
 * creates evidence from nothing in the dangerous direction: it records what is
 * there now, which can only make a later look prove LESS.
 */
async function advancePrimaryBaselineAfterSave(
  shop: string,
  resourceId: string,
  resourceType: string,
  content: Readonly<Record<string, PrimaryContentEntry>>,
): Promise<void> {
  const previous = await loadPrimaryDigestBaseline(shop, resourceId);
  // A failed read: writing over a row we could not see would discard held
  // keys — leave it, the next look costs at most one repeated proof.
  if (previous === null) return;
  const next = nextPrimaryDigestBaseline(previous, content);
  if (!next) return;
  try {
    const { db } = await import("../../db.server");
    await db.primaryDigestBaseline.upsert({
      where: { shop_resourceId: { shop, resourceId } },
      create: { shop, resourceId, resourceType, digests: next },
      update: { digests: next },
    });
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Could not advance the primary baseline after a save", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The stored JSON as a key → digest map; anything that is not a string entry
 *  is dropped (it can only be a digest we did not write). */
export function primaryDigestMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, digest] of Object.entries(value as Record<string, unknown>)) {
    if (typeof digest === "string" && digest) out[key] = digest;
  }
  return out;
}

/**
 * Write the NEXT primary baseline — only when it differs from `previous`
 * (`nextPrimaryDigestBaseline` answers `null` otherwise), so a sync where no
 * text moved costs no write. Best-effort: a failed write leaves the old
 * baseline, which at worst proves the same move once more on the next look —
 * the direction that costs a translation, never one that loses a change.
 */
async function persistPrimaryDigestBaseline(
  shop: string,
  resourceId: string,
  resourceType: string,
  baseline: BaselineState,
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>,
): Promise<boolean> {
  if (baseline.original === null) return false;
  // The target is built from the ORIGINAL (so a held key reverts to the digest
  // it had before a claim advanced it) and compared with what the row holds
  // NOW — only a difference costs a write.
  const target = primaryDigestBaselineTarget(baseline.original, primaryContent, baseline.held);
  if (!target || sameDigestMap(target, baseline.stored ?? {})) return false;
  try {
    const db = baseline.db ?? (await import("../../db.server")).db;
    await db.primaryDigestBaseline.upsert({
      where: { shop_resourceId: { shop, resourceId } },
      create: { shop, resourceId, resourceType, digests: target },
      // `resourceType` is set on create only: the writers do not all spell it
      // the same way, and a baseline row is found by its resource id.
      update: { digests: target },
    });
    return true;
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Could not write the primary digest baseline", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function sameDigestMap(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * The compare-and-swap that makes a second-entrance move ONE run's work: the
 * row is advanced to the digests this reconciliation saw ONLY if it still holds
 * exactly what this reconciliation read. `false` = someone else got there
 * first (or the write failed) — the caller then drops its fill, because the
 * winner's run is translating the same keys. A row must exist for the entrance
 * to have fired at all (rule one), so `count: 0` is never "no row yet".
 */
async function claimPrimaryBaseline(
  shop: string,
  resourceId: string,
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>,
  baseline: BaselineState,
): Promise<boolean> {
  if (baseline.original === null) return false;
  const claimed = primaryDigestBaselineTarget(baseline.original, primaryContent);
  if (!claimed) return false;
  try {
    const db = baseline.db ?? (await import("../../db.server")).db;
    const { count } = await db.primaryDigestBaseline.updateMany({
      where: { shop, resourceId, digests: { equals: baseline.original } },
      data: { digests: claimed },
    });
    if (count !== 1) {
      // Lost: the winner owns this move and its baseline write.
      baseline.skipWrite = true;
      return false;
    }
    baseline.stored = claimed;
    return true;
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Could not claim the primary baseline — not filling", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Nothing was claimed and nothing is proven lost: keep the evidence.
    baseline.skipWrite = true;
    return false;
  }
}

/**
 * Which of these locales hold a VALUE for any key on Shopify right now, as
 * `${locale}${IN_FLIGHT_SEP}${key}` — one query, one alias per locale. `null`
 * when the answer is not conclusive (a thrown call, `errors`, a missing
 * resource): the caller must then act on nothing, never on "empty".
 */
async function translatedOnShopify(
  gateway: ShopifyApiGateway,
  resourceId: string,
  locales: readonly string[],
): Promise<Set<string> | null> {
  if (locales.length === 0) return new Set();
  try {
    const variableDefs = locales.map((_, i) => `$loc${i}: String!`).join(", ");
    const selections = locales.map((_, i) => `l${i}: translations(locale: $loc${i}) { key value }`).join("\n");
    const variables: Record<string, unknown> = { id: resourceId };
    locales.forEach((locale, i) => {
      variables[`loc${i}`] = locale;
    });
    const response = await gateway.graphql(
      `#graphql
        query fillTargetsPresent($id: ID!, ${variableDefs}) {
          translatableResource(resourceId: $id) {
            ${selections}
          }
        }`,
      { variables },
    );
    const payload = (await response.json()) as {
      data?: { translatableResource?: Record<string, Array<{ key: string; value: string | null }> | null> | null };
      errors?: Array<{ message?: string }>;
    };
    if (payload.errors?.length) throw new Error(payload.errors[0]?.message || "GraphQL error");
    const resource = payload.data?.translatableResource;
    if (!resource) return null;
    const present = new Set<string>();
    for (let i = 0; i < locales.length; i++) {
      const rows = resource[`l${i}`];
      // A null list is not "nothing translated" — it is no answer.
      if (!Array.isArray(rows)) return null;
      for (const row of rows) {
        if (row.value && row.value.trim()) present.add(`${locales[i]}${IN_FLIGHT_SEP}${row.key}`);
      }
    }
    return present;
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Could not confirm the fill targets are empty — not filling", {
      context: "StaleTranslations",
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * SEED baselines from a full sync — CREATE-ONLY, never an update.
 *
 * A full sync does not reconcile, so it must never ADVANCE a baseline: that
 * would compare nothing and swallow a move the next change event could still
 * have proven (the same reason `syncAll*` does not opt into the reconciliation).
 * What it may do is give a resource its FIRST baseline, which is pure gain: a
 * product whose first change event would otherwise only establish one — the
 * merchant's first admin edit after the deploy doing nothing — is provable from
 * that first edit on. `skipDuplicates` is the create-only rule, enforced by the
 * unique key rather than by a read.
 *
 * `translatableContent` only lists keys that HAVE a primary value, so a digest
 * here is a filled field. Best-effort: a failed seed is a later first baseline.
 */
export async function seedPrimaryDigestBaselines(
  shop: string,
  resourceType: string,
  resources: ReadonlyArray<{ resourceId: string; content: ReadonlyArray<{ key: string; digest?: string | null }> }>,
): Promise<number> {
  const data = resources.flatMap((resource) => {
    const digests: Record<string, string> = {};
    for (const entry of resource.content) {
      if (MANAGED_KEYS_FOR_BASELINE.has(entry.key) && entry.digest) digests[entry.key] = entry.digest;
    }
    return Object.keys(digests).length > 0
      ? [{ shop, resourceId: resource.resourceId, resourceType, digests }]
      : [];
  });
  if (data.length === 0) return 0;
  try {
    const { db } = await import("../../db.server");
    const { count } = await db.primaryDigestBaseline.createMany({ data, skipDuplicates: true });
    return count;
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Could not seed primary digest baselines", {
      context: "StaleTranslations",
      shop,
      resourceType,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Resources per shop and UTC day whose auto-translation may rest on the PRIMARY
 * baseline alone — the brake on the gate's second entrance (see the call site).
 *
 * Sized so no realistic day of editing reaches it (a merchant rewriting a
 * hundred items in the Shopify admin in one day is already an import), while an
 * import rewriting a 5000-product catalogue is stopped at 2% of it. Resources,
 * not entries: one resource is one detached run with one AI request per locale,
 * which is the unit the merchant's key pays for.
 */
export const AUTO_TRANSLATE_FIRST_FILL_DAILY_CAP = 100;

function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Take one unit of today's budget. ATOMIC — a conditional increment, so a
 * burst of webhooks from one import cannot all read "99 used" and pass.
 * FAILS CLOSED: a database error answers "no", because refusing costs a
 * deferred translation and granting blindly is the expensive direction.
 */
async function reserveFirstFillBudget(
  shop: string,
  resourceId: string,
  dbClient: typeof import("../../db.server").db | null,
): Promise<"granted" | "spent" | "error"> {
  try {
    const db = dbClient ?? (await import("../../db.server")).db;
    const day = utcDay();
    // INSERT … ON CONFLICT DO NOTHING: the first webhooks of a day arrive
    // together, and an upsert racing its own create would throw a unique
    // violation — which this function answers with a refusal.
    await db.autoTranslateFillBudget.createMany({ data: [{ shop, day }], skipDuplicates: true });
    const { count } = await db.autoTranslateFillBudget.updateMany({
      where: { shop, day, used: { lt: AUTO_TRANSLATE_FIRST_FILL_DAILY_CAP } },
      data: { used: { increment: 1 } },
    });
    return count === 1 ? "granted" : "spent";
  } catch (error: unknown) {
    // Fails CLOSED — but it is not the daily limit, and must not be reported
    // as one: telling the merchant "100 reached" over a DB blink is a false
    // statement about their shop. The keys are held either way.
    logger.warn("[StaleTranslations] Could not reserve the daily first-translation budget — refusing", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
}

/**
 * Is today's budget already SPENT? A cheap read asked before anything costs a
 * Shopify call: during exactly the mass edit the brake exists for, every
 * further webhook would otherwise still pay the existence query, the claim and
 * its revert before learning it is refused — burning the shop's API bucket on
 * work that cannot happen. `false` on any doubt (no row, a failed read): the
 * reservation afterwards is the authority and fails closed on its own.
 */
async function firstFillBudgetSpent(
  shop: string,
  dbClient: typeof import("../../db.server").db | null,
): Promise<boolean> {
  try {
    const db = dbClient ?? (await import("../../db.server")).db;
    const row = await db.autoTranslateFillBudget.findUnique({
      where: { shop_day: { shop, day: utcDay() } },
      select: { used: true },
    });
    return (row?.used ?? 0) >= AUTO_TRANSLATE_FIRST_FILL_DAILY_CAP;
  } catch {
    return false;
  }
}

/**
 * Make a refusal VISIBLE. One Task row per shop and day (a deterministic id, so
 * a burst of refusals updates it instead of flooding the Tasks tab), whose error
 * is a CODE (`auto_translate_daily_limit:<refused>:<cap>`) that `taskErrorText`
 * renders in the merchant's language — the refusal happens in a webhook with no
 * locale. A brake a merchant cannot see is work swallowed; this one says how
 * much, why, and that it is deferred.
 */
async function reportFirstFillRefused(
  shop: string,
  resourceId: string,
  dbClient: typeof import("../../db.server").db | null,
): Promise<void> {
  logger.warn("[StaleTranslations] Daily first-translation budget spent — this resource is deferred", {
    context: "StaleTranslations",
    shop,
    resourceId,
    cap: AUTO_TRANSLATE_FIRST_FILL_DAILY_CAP,
  });
  try {
    const db = dbClient ?? (await import("../../db.server")).db;
    const { getTaskExpirationDate } = await import("../../config/constants");
    const day = utcDay();
    // RESOURCES, not events: a held product is refused again on every later
    // webhook that day (a price edit is enough) and a held page on every
    // sweep, so counting calls would overstate what is waiting. `push` is an
    // atomic array append; a duplicate from a race is removed by the Set.
    //
    // ONE statement, and the array never travels: reading it back to check
    // membership made a 5000-product import cost O(N²) bytes on one hot row.
    // The append is conditional on the id being absent, and only the COUNT is
    // returned. COALESCE because the column is nullable on a table created by
    // the first cut of this migration.
    const rows = await db.$queryRaw<Array<{ refused: number }>>`
      UPDATE "AutoTranslateFillBudget"
      SET "refusedIds" = CASE
        WHEN ${resourceId} = ANY(COALESCE("refusedIds", ARRAY[]::TEXT[])) THEN "refusedIds"
        ELSE array_append(COALESCE("refusedIds", ARRAY[]::TEXT[]), ${resourceId})
      END
      WHERE "shop" = ${shop} AND "day" = ${day}
      RETURNING cardinality("refusedIds")::int AS "refused"`;
    const refused = Math.max(1, Number(rows[0]?.refused ?? 1));
    const error = `auto_translate_daily_limit:${refused}:${AUTO_TRANSLATE_FIRST_FILL_DAILY_CAP}`;
    const now = new Date();
    await db.task.upsert({
      where: { id: firstFillLimitTaskId(shop, day) },
      create: {
        id: firstFillLimitTaskId(shop, day),
        shop,
        type: "translation",
        status: "completed_with_errors",
        fieldType: "autoTranslateExternalChange",
        progress: 100,
        total: refused,
        processed: 0,
        error,
        completedAt: now,
        expiresAt: getTaskExpirationDate(),
      },
      update: { error, total: refused, completedAt: now },
    });
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Could not record the first-translation refusal", {
      context: "StaleTranslations",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The one Task row per shop and day that reports refused first translations. */
export function firstFillLimitTaskId(shop: string, day: string = utcDay()): string {
  return `autofill-limit-${day}-${shop}`;
}

/**
 * Detect and repair stale foreign translations for ONE resource.
 *
 * BEST-EFFORT by contract: the sync it hangs off has already written the
 * cache, so every failure here is logged and swallowed. A stale row left
 * behind is the pre-existing behaviour; a thrown error would turn a working
 * webhook into a retry loop.
 */
export async function reconcileStaleTranslations(params: ReconcileParams): Promise<ReconcileResult> {
  const { shop, resourceId, primaryContent } = params;
  // The PRIMARY baseline is read FIRST — before this function decides anything
  // and before it writes the next one — the same order that
  // `loadPreviousTranslationDigests` exists for. Only a content surface keeps
  // one: a value surface (`translateAs`) names keys the baseline never records.
  //
  // The client is resolved ONCE, before the detached run is spawned, and used
  // for the read, the claim and the write: a dynamic import racing that run's
  // own imports is not a place to find out which client answered.
  const baselineDb = params.translateAs
    ? null
    : await import("../../db.server").then((module) => module.db).catch(() => null);
  const primaryBaseline: Record<string, string> | null = params.translateAs
    ? null
    : (params.previousPrimaryDigests ??
      (await loadPrimaryDigestBaseline(shop, resourceId, baselineDb ?? undefined)));
  const baseline: BaselineState = {
    original: primaryBaseline,
    stored: primaryBaseline,
    held: new Set<string>(),
    skipWrite: false,
    db: baselineDb,
  };

  let outcome: ReconcileResult;
  try {
    outcome = await reconcileDetected(params, baseline);
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Reconciliation failed — stale rows kept", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    // The baseline is NOT advanced on this path (beyond a claim that already
    // won, see `claimPrimaryBaseline`): whatever failed (the policy read, the
    // repair itself) may have been the only chance to act on this move, and
    // keeping the old digest keeps the evidence for the next look.
    return NOTHING;
  }

  // AFTER the decision, on every path that reached one — including "nothing
  // stale" and "the switch is off": the baseline records what we SAW, and a
  // change seen while the switch was off must not be replayed as fresh
  // evidence the day it is switched on (a price edit would then translate a
  // text edited months ago). Skipped where the decision said so (the
  // merchant's own save is in flight; another run claimed this move), and a
  // failed read (`null`) writes nothing, for the same reason as the catch.
  if (baseline.original !== null && !baseline.skipWrite) {
    await persistPrimaryDigestBaseline(params.shop, params.resourceId, params.resourceType, baseline, primaryContent);
  }
  return outcome;
}

/**
 * What one reconciliation knows about its resource's PRIMARY baseline:
 * `original` as read before anything happened, `stored` as the row holds it
 * NOW (it moves when `claimPrimaryBaseline` wins), the keys the brake HELD,
 * and whether the final write must stand down.
 */
interface BaselineState {
  original: Record<string, string> | null;
  stored: Record<string, string> | null;
  held: Set<string>;
  skipWrite: boolean;
  db: typeof import("../../db.server").db | null;
}

async function reconcileDetected(params: ReconcileParams, baseline: BaselineState): Promise<ReconcileResult> {
  const { shop, resourceId, resourceType, translations, primaryContent, previousDigests } = params;
  const primaryBaseline = baseline.original;
  const held = baseline.held;
  {
    // Same guard the sync's own translation rewrite uses: right after this app
    // wrote translations for the resource, Shopify's read-back is not reliably
    // consistent yet, and acting on it could delete what the merchant just
    // saved. A genuinely stale row is caught by the next change event.
    if (isTranslationRecentlySaved(resourceId)) {
      // …and the primary baseline stays where it was. A save of ours for this
      // resource is in flight; advancing the baseline here would swallow an
      // admin edit made in the same window for good, while leaving it costs at
      // most one look that finds the locales already filled by that save.
      baseline.skipWrite = true;
      return NOTHING;
    }

    // Detection runs FIRST and without the fill, because it is pure and the
    // policy read is a database round trip: a resource where nothing moved —
    // which is nearly every webhook, a price edit included (a price moves no
    // text digest) — must not pay for one. The fill can only ADD locales to
    // keys one of the two entrances proved, so if neither found anything there
    // is nothing to do with it either.
    let stale = findStaleTranslations(translations, primaryContent, previousDigests);
    // `handle` is left out: the second entrance only FILLS, and a handle is
    // refreshed, never filled — so a handle-only move could never do anything
    // and must not cost a policy read.
    const movedByBaseline = primaryBaseline
      ? primaryBaselineMovedKeys(primaryContent, primaryBaseline).filter((key) => key !== "handle")
      : [];
    if (stale.length === 0 && movedByBaseline.length === 0) return NOTHING;

    const policy = await loadTranslationChangePolicy(shop);
    if (!policy.purgeOnPrimaryChange && !policy.autoTranslateExternalChanges) return NOTHING;

    // Now that the switch is known: translate the proven keys into the locales
    // that hold nothing yet as well. Same input, same gate — the second call is
    // pure and in-memory, and re-running it is what keeps the cheap exit above.
    // The PRIMARY baseline rides along here and only here: all its entrance can
    // produce is a fill, and a fill only exists under auto-translate.
    if (policy.autoTranslateExternalChanges && params.foreignLocales?.length) {
      stale = findStaleTranslations(translations, primaryContent, previousDigests, {
        fillLocales: params.foreignLocales,
        anyKey: !!params.translateAs,
        ...(primaryBaseline ? { previousPrimaryDigests: primaryBaseline } : {}),
      });
    }

    // THE BRAKE. The second entrance can reach resources that never had a
    // translation, so ONE external mass edit (an import rewriting every title)
    // could translate a whole catalogue into every language on the merchant's
    // key — before it, that was bounded by what was already translated. A
    // resource whose repair rests on that entrance spends one unit of a per-shop
    // daily budget; past it, those entries are dropped, their keys' baseline is
    // HELD (so the move is still provable next time) and the refusal is written
    // to a Task row the merchant can read. Everything the first entrance found
    // is untouched by it: that work existed before this entrance did.
    //
    // Two checks run BEFORE the budget, so it is never spent on nothing:
    //
    //  - SHOPIFY is asked whether those locales really hold nothing. The rows
    //    the caller handed in are not proof of absence: a sync whose read of
    //    one locale failed (a throttle, a GraphQL error) logs it and carries on
    //    with that locale simply MISSING, and filling it would overwrite a
    //    translation that exists — a hand-written one included. A read that
    //    fails here drops the entries and HOLDS their keys (no evidence either
    //    way ⇒ no action, and the move stays provable).
    //  - The move is CLAIMED on the baseline row with a compare-and-swap. One
    //    admin save fires several `products/update` webhooks within a second;
    //    each reads the old baseline, and without the claim each would prove
    //    the same move, spend a budget unit and queue a duplicate run that
    //    translates every locale twice. The loser drops its fill and leaves the
    //    baseline to the winner.
    if (stale.some((entry) => entry.baselineFill) && (await firstFillBudgetSpent(shop, baseline.db))) {
      // Spent before we even asked: refuse, report, and pay no Shopify call.
      // The row is left exactly as it is rather than written with HELD keys:
      // this event never claimed anything, and a write here (holding the fill
      // keys, advancing the rest) could land over another webhook's won claim
      // and revert it — that one then being proven again. Untouched, the move
      // stays provable all the same.
      baseline.skipWrite = true;
      stale = stale.filter((entry) => !entry.baselineFill);
      await reportFirstFillRefused(shop, resourceId, baseline.db);
    }
    if (stale.some((entry) => entry.baselineFill)) {
      const fills = stale.filter((entry) => entry.baselineFill);
      const present = await translatedOnShopify(
        gatewayFor(params.client, shop),
        resourceId,
        [...new Set(fills.map((entry) => entry.locale))],
      );
      if (present === null) {
        for (const entry of fills) held.add(entry.key);
        stale = stale.filter((entry) => !entry.baselineFill);
      } else {
        stale = stale.filter(
          (entry) => !entry.baselineFill || !present.has(`${entry.locale}${IN_FLIGHT_SEP}${entry.key}`),
        );
      }
    }
    if (stale.some((entry) => entry.baselineFill)) {
      const won = await claimPrimaryBaseline(shop, resourceId, primaryContent, baseline);
      if (!won) {
        stale = stale.filter((entry) => !entry.baselineFill);
      } else {
        const granted = await reserveFirstFillBudget(shop, resourceId, baseline.db);
        if (granted !== "granted") {
          // The claim already advanced the row; the final write puts the held
          // keys back to their ORIGINAL digests.
          for (const entry of stale) if (entry.baselineFill) held.add(entry.key);
          stale = stale.filter((entry) => !entry.baselineFill);
          if (granted === "spent") await reportFirstFillRefused(shop, resourceId, baseline.db);
        }
      }
    }
    if (stale.length === 0) return NOTHING;

    logger.info("[StaleTranslations] Primary text changed outside the editor — reconciling", {
      context: "StaleTranslations",
      shop,
      resourceId,
      resourceType,
      stale: stale.length,
      purge: policy.purgeOnPrimaryChange,
      autoTranslate: policy.autoTranslateExternalChanges,
    });

    return await repairStaleTranslations(await withHandleResolver(params, policy), stale, policy, {
      keys: [...new Set(stale.map((entry) => entry.key))],
      // Every locale this shop could hold an override in: the rows the sync
      // fetched (all layers, so a market-only locale is in there) plus the
      // published ones the caller named, which is what the fill translates into.
      locales: [
        ...new Set([
          ...translations.map((row) => row.locale),
          ...(params.foreignLocales ?? []),
        ]),
      ],
      // A market override Shopify reports as NOT outdated was re-translated
      // against the new source after the change: it is current, and the purge
      // must walk past it. This is the only path that HAS that evidence — the
      // sync fetches every market layer with its own `outdated` flag.
      currentOverrides: new Set(
        translations
          .filter((row) => (row.marketId ?? "") !== "" && row.outdated === false)
          .map((row) => marketOverrideKey(resourceId, row.marketId ?? "", row.locale, row.key)),
      ),
    });
  }
}

/**
 * Resource types whose primary text this app can edit but NO automatic event
 * re-translates: pages, articles, blogs and policies have no Shopify webhook,
 * so the only moment anything knows they changed is the save that changed them
 * (CLAUDE.md). Until `reconcileAfterPrimarySave` existed they were therefore
 * "unreconciled" in the strict sense — their translations were DELETED and
 * nothing ever refreshed them, so on a Max shop the same edit produced the new
 * text on a product and a blank field on a page.
 *
 * PRODUCT and COLLECTION are on this list too, and they were deliberately off
 * it until a merchant showed why they cannot be. The argument for excluding
 * them was that their update webhook runs the sync-side reconciliation anyway,
 * so a run started from the save would queue a duplicate behind a repair that
 * has already happened. True — but only for a resource that HAS translations.
 * The sync-side gate proves the primary text moved by comparing digests stored
 * ON TRANSLATION ROWS, so a product nobody has ever translated carries no
 * baseline, nothing can be proven about it, and the webhook's repair is not
 * "already happening": it can never happen. That is exactly the state a
 * merchant is in when they switch the feature on, which made "translate
 * automatically" do nothing at all on the content they most wanted it for.
 *
 * The duplicate the exclusion protected against is prevented by the CLAIM
 * instead: `reconcileAfterPrimarySave` marks the resource before it starts and
 * `reconcileStaleTranslations` bails wholesale on that mark, so the webhook
 * arriving seconds later stands down. The bulk editor claims the row where it
 * WRITES it rather than where it repairs it, because its flush is the last
 * thing a save does and the first row's webhook arrives long before that. A webhook that arrives after
 * the window finds the digests the repair has just written and proves nothing,
 * which is the same answer by a different route.
 */
export const IN_APP_RETRANSLATED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "Page",
  "Article",
  "Blog",
  "ShopPolicy",
  "Product",
  "Collection",
]);

/** Separator of a `${locale}\u0000${key}` pair — the same shape
 * `digestBaselineKey` produces, so the two can be mixed in one set. */
const PAIR_SEP = "\u0000";

/**
 * The (resource, locale, key) triples Shopify actually holds a GLOBAL
 * translation for, restricted to the keys the caller changed.
 *
 * One query PER LOCALE — but over EVERY resource of the group at once
 * (`translatableResourcesByIds`, the same batched door the product sync uses),
 * because a product save moves its options, option values and metafields too
 * and one query per sub-resource per locale would be dozens of calls for a
 * single save. `translations(locale:)` still takes exactly one locale, so the
 * locales are what remains to iterate.
 *
 * `marketId` is deliberately omitted, which returns the GLOBAL layer only
 * (CLAUDE.md) — a market override is a separate deliberate value and survives.
 *
 * A locale whose query fails contributes NOTHING rather than throwing: the
 * caller unions this with the local mirror, so a failed read degrades to the
 * mirror-only reach instead of losing the whole repair. It goes through the
 * GATEWAY, not the raw admin client: this runs inside the merchant's save
 * request, and an unthrottled burst there would answer a rate limit with
 * exactly that silent degradation.
 *
 * Sequential and DEADLINED, which are one decision. `ShopifyApiGateway` drains
 * its queue with a single serial consumer whose retry sleeps block every other
 * queued call, so firing the locales concurrently changes nothing about the
 * wall clock — it only takes away the one place a budget can be checked. This
 * whole sweep sits behind a primary write that has ALREADY succeeded, so past
 * the budget the remaining locales are simply left to the mirror: a repair
 * narrowed to what this app itself wrote is the documented fallback, and a save
 * that hangs for a minute is not.
 */
const DETECTION_BUDGET_MS = 5_000;

/** `translatableResourcesByIds` caps its page at 250. The queries ask for
 *  `ids.length`, never this constant: `first` is what the Admin API prices the
 *  query at, so a single-resource save asking for 250 pays ~125× its cost and
 *  meets the throttle that much sooner — where this path degrades silently to
 *  mirror-only detection. */
const RESOURCE_BATCH = 250;

/**
 * How many bare values go into ONE `translateBatchValues` prompt. They are
 * numbered into a single request, so an unbounded group — a product with sixty
 * metafields, an option with fifty values — would build one oversized prompt
 * and get back a truncated list.
 *
 * Read from the shared constant rather than stated here: the BATCHED value path
 * has to honour the same cap, and two copies of it is how one of them came to
 * ask for 760 numbered strings in a single request.
 */
const VALUE_BATCH = TRANSLATION_BATCH.VALUE_BATCH_MAX_ITEMS;

/** `${resourceId}\u0000${locale}\u0000${key}` — one triple of the detection set. */
function tripleKey(resourceId: string, locale: string, key: string): string {
  return `${resourceId}${PAIR_SEP}${locale}${PAIR_SEP}${key}`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function foreignTranslationTriples(
  gateway: ShopifyApiGateway,
  resourceIds: readonly string[],
  foreignLocales: readonly string[],
  wantedKeys: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Set<string>> {
  const triples = new Set<string>();
  const deadline = Date.now() + DETECTION_BUDGET_MS;
  for (const locale of foreignLocales) {
    if (Date.now() > deadline) {
      logger.warn("[StaleTranslations] Detection budget spent — remaining locales left to the mirror", {
        context: "StaleTranslations",
        resources: resourceIds.length,
        reached: triples.size,
        skippedFrom: locale,
      });
      break;
    }
    for (const ids of chunk(resourceIds, RESOURCE_BATCH)) {
      try {
        const response = await gateway.graphql(
          `#graphql
            query staleTranslationTargets($resourceIds: [ID!]!, $locale: String!, $first: Int!) {
              translatableResourcesByIds(resourceIds: $resourceIds, first: $first) {
                edges {
                  node {
                    resourceId
                    translations(locale: $locale) {
                      key
                      locale
                      value
                    }
                  }
                }
              }
            }`,
          { variables: { resourceIds: ids, locale, first: ids.length } },
        );
        const data = (await response.json()) as {
          data?: {
            translatableResourcesByIds?: {
              edges?: Array<{
                node?: {
                  resourceId?: string;
                  translations?: Array<{ key: string; locale: string; value: string | null }> | null;
                } | null;
              }> | null;
            } | null;
          };
          errors?: Array<{ message: string }>;
        };
        if (data.errors?.length) throw new Error(data.errors[0].message);
        for (const edge of data.data?.translatableResourcesByIds?.edges ?? []) {
          const resourceId = edge?.node?.resourceId;
          if (!resourceId) continue;
          const wanted = wantedKeys.get(resourceId);
          if (!wanted) continue;
          for (const row of edge?.node?.translations ?? []) {
            if (!wanted.has(row.key)) continue;
            // A row with NO value is not a translation. Shopify answers this
            // query with one row per translatable key and `value: null` where
            // the locale has nothing — the same reason every sync in this repo
            // filters `t.value != null` before mirroring. Without it every
            // changed key in every published locale would look translated, and
            // the run would not repair anything: it would CREATE translations
            // into locales the merchant deliberately never translated,
            // unattended and on their own API key.
            if (!row.value || !row.value.trim()) continue;
            // Shopify answers with the requested locale, but trust the row's
            // own — it is what the removal and the register are addressed by.
            triples.add(tripleKey(resourceId, row.locale, row.key));
          }
        }
      } catch (error: unknown) {
        logger.warn("[StaleTranslations] Could not read translations for a locale — mirror only", {
          context: "StaleTranslations",
          locale,
          resources: ids.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return triples;
}

/**
 * The CURRENT primary value and digest of every (resource, key) the caller
 * changed, read back from Shopify after the write.
 *
 * The digest is the load-bearing half: `translationsRegister` refuses without
 * one, and it must be the digest of the text that is there NOW — the caller's
 * own write invalidated whatever was cached. `translatableContent` omits a key
 * with no value at all, which is exactly how a CLEARED field announces itself.
 *
 * A resource this could not read is ABSENT from the result, and the caller
 * skips it entirely rather than treating it as "everything cleared". The
 * distinction is the `translatableContent` trap in reverse: a failed read and a
 * resource whose fields were all emptied look identical in the DATA, and only
 * one of them may lose its translations. Answering our own failed lookup with a
 * deletion is the same mistake `startFailed` exists to prevent — the next
 * change event repairs what is genuinely stale, and a translation that survived
 * one blink is visible and recoverable while a deleted one is not.
 *
 * A resource that IS in the result but has no entry for a key is the real
 * cleared field: Shopify omits a key with no value at all.
 */
async function currentPrimaryContent(
  gateway: ShopifyApiGateway,
  resourceIds: readonly string[],
): Promise<Map<string, Record<string, PrimaryContentEntry>>> {
  const out = new Map<string, Record<string, PrimaryContentEntry>>();
  for (const ids of chunk(resourceIds, RESOURCE_BATCH)) {
    try {
      const response = await gateway.graphql(
        `#graphql
          query stalePrimaryContent($resourceIds: [ID!]!, $first: Int!) {
            translatableResourcesByIds(resourceIds: $resourceIds, first: $first) {
              edges {
                node {
                  resourceId
                  translatableContent {
                    key
                    value
                    digest
                  }
                }
              }
            }
          }`,
        { variables: { resourceIds: ids, first: ids.length } },
      );
      const data = (await response.json()) as {
        data?: {
          translatableResourcesByIds?: {
            edges?: Array<{
              node?: {
                resourceId?: string;
                translatableContent?: Array<{
                  key: string;
                  value: string | null;
                  digest: string | null;
                }> | null;
              } | null;
            }> | null;
          } | null;
        };
        errors?: Array<{ message: string }>;
      };
      if (data.errors?.length) throw new Error(data.errors[0].message);
      for (const edge of data.data?.translatableResourcesByIds?.edges ?? []) {
        const resourceId = edge?.node?.resourceId;
        if (!resourceId) continue;
        const map: Record<string, PrimaryContentEntry> = {};
        for (const item of edge?.node?.translatableContent ?? []) {
          map[item.key] = { value: item.value ?? "", digest: item.digest };
        }
        out.set(resourceId, map);
      }
    } catch (error: unknown) {
      logger.warn("[StaleTranslations] Could not read primary content — those resources are left alone", {
        context: "StaleTranslations",
        resources: ids.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/**
 * The in-app counterpart of `reconcileStaleTranslations`: the merchant just
 * rewrote a resource's PRIMARY text in this app, and this is the only event
 * that will ever notice for the types above.
 *
 * It does NO detection, and that is the point. The sync-side entry point must
 * prove the primary text moved — it did not author the change and Shopify's
 * `outdated` flag alone says nothing about WHEN. Here the caller performed the
 * write, and `changedKeys` is the list it computed against the baseline the
 * editor loaded from. Running the digest gate over that would only ADD a way to
 * miss: a row whose local mirror carries no digest (a DB-only write, an older
 * cache) would pass no gate, and the translation would then be neither
 * re-translated nor removed — live on the storefront, describing text that no
 * longer exists.
 *
 * AUTO-TRANSLATE ONLY, re-checked here on the policy the caller HANDS IN (never
 * a second read of its own — see `policy`). Without that switch the caller's own
 * purge loop is the repair; running this one as well would send a second
 * `translationsRemove` for rows that are already gone, which echoes nothing back
 * and logs as an unconfirmed removal. The two paths are mutually exclusive at
 * BOTH ends on purpose.
 *
 * BEST-EFFORT: the primary write has already happened, so every failure is
 * logged and swallowed. The merchant's text is saved either way.
 */
export async function reconcileAfterPrimarySave(params: RepairTarget & {
  /**
   * What this save rewrote, as (resource, key) pairs. `resourceId` /
   * `resourceType` default to the group's own, which is every content-type
   * entry; a product's OPTIONS, OPTION VALUES and METAFIELDS name their own,
   * because each is its own Shopify translatable resource — one merchant
   * action, one group, one Task row.
   *
   * The caller does NOT supply the new values or their digests: this reads them
   * back from Shopify itself, batched over the whole group. The digest has to
   * be the one of the text that is there NOW, and the caller's own write is
   * what invalidated the last one it saw.
   */
  changed: ReadonlyArray<{
    resourceId?: string;
    resourceType?: string;
    key: string;
    /** `false` = remove this one rather than re-translate it; see
     *  `StaleTranslation.retranslatable`. */
    retranslatable?: boolean;
    /**
     * What the caller just wrote, for a surface whose write does not land in
     * Shopify's translatable content SYNCHRONOUSLY.
     *
     * Theme content is written as a FILE (`themeFilesUpsert`) and re-indexed
     * afterwards, so a read-back can still answer with the previous text — and
     * with a digest that registers cleanly, which would produce an
     * echo-confirmed translation of text the merchant has just replaced, with
     * the deletion already stood down. When this is set and the read-back does
     * not match it, the entry is DECLINED: never translated, and removed only
     * if the merchant's stored deletion answer says so. Skipping it outright
     * would leave a foreign value live on a surface nothing else revisits.
     */
    expectedValue?: string;
  }>;
  /** Published foreign locales — the primary locale never holds a translation row. */
  foreignLocales: readonly string[];
  /**
   * (resource, locale, key) triples this SAVE wrote a FOREIGN value for itself
   * — left alone entirely: not re-translated, not removed.
   *
   * The merchant typed that value, in this very save, for this very key. It is
   * the same rule as `isTranslationRecentlySaved`, at the granularity the
   * situation actually has: a bulk save that changes a product's primary title
   * AND its German one has said something about German and nothing about
   * French, so aborting the whole run would leave French stale while acting on
   * German would overwrite what they just typed. `resourceId` defaults to the
   * group's own.
   */
  alreadyWritten?: ReadonlyArray<{ resourceId?: string; locale: string; key: string }>;
  /**
   * The policy the CALLER already read to decide it was skipping its own purge.
   * Passing it is not an optimisation: a second read fails OPEN to
   * "auto-translate off", which returns NOTHING — and the caller has by then
   * already stood its deletion down, so a transient DB error would leave the
   * resource with neither the purge nor the repair, on a type nothing else
   * notices. One read, one decision.
   */
  policy: TranslationChangePolicy;
}): Promise<ReconcileResult> {
  const { shop, resourceId, resourceType, changed, foreignLocales, policy } = params;

  try {
    if (changed.length === 0 || foreignLocales.length === 0) return NOTHING;
    if (!policy.autoTranslateExternalChanges) return NOTHING;

    // The group's resources, and which keys were changed on each.
    const refs = new Map<string, TranslationRef>();
    const wantedKeys = new Map<string, Set<string>>();
    /** `${resourceId}\u0000${key}` of the entries the caller marked
     *  remove-only, so the flag survives into the stale set below. */
    const removeOnly = new Set<string>();
    /** `${resourceId}\u0000${key}` → what the caller says it wrote. */
    const expected = new Map<string, string>();
    for (const item of changed) {
      const ref = refOf(params, item as StaleTranslation);
      refs.set(ref.resourceId, ref);
      const keys = wantedKeys.get(ref.resourceId) ?? new Set<string>();
      keys.add(item.key);
      wantedKeys.set(ref.resourceId, keys);
      const id = `${ref.resourceId}${PAIR_SEP}${item.key}`;
      if (item.retranslatable === false) removeOnly.add(id);
      if (item.expectedValue !== undefined) expected.set(id, item.expectedValue);
    }
    const resourceIds = [...refs.keys()];

    const gateway = gatewayFor(params.client, shop);

    // The CURRENT primary text of everything this save changed. It is read
    // FIRST because it decides everything below: the digest a register needs is
    // the one of the text that is there NOW, and the caller's own write is what
    // invalidated the last digest it saw.
    const primaryByResource = await currentPrimaryContent(gateway, resourceIds);

    const untouchable = new Set(
      (params.alreadyWritten ?? []).map((item) =>
        tripleKey(item.resourceId ?? resourceId, item.locale, item.key),
      ),
    );

    // Every (resource, key, locale) this save could owe a translation for — the
    // FULL cross product of what changed and the shop's published foreign
    // locales, NOT the pairs that already carry a translation.
    //
    // That is the difference between "refresh" and "translate". Asking which
    // pairs are translated already answers a question about the PAST, and a
    // shop with the auto-translation on read it as the feature being off: the
    // merchant rewrote a page, the two languages that happened to have a
    // translation got the new text, and the six that had none stayed empty
    // forever — while the same switch on a product filled nothing either.
    //
    // Existence still decides ONE thing, below: whether a REMOVAL is worth
    // sending. There is nothing to remove where nothing exists, and the
    // unechoed no-op would be logged as an unconfirmed removal for every locale
    // the merchant never translated.
    const stale: StaleTranslation[] = [];
    /** Candidates that would be REMOVED or DECLINED rather than translated —
     *  only worth keeping if a translation is really there. */
    const needEvidence: StaleTranslation[] = [];
    let unreadableResources = 0;
    let declinedByReadBack = 0;
    for (const [itemResourceId, ref] of refs) {
      const resourcePrimary = primaryByResource.get(itemResourceId);
      // Could not read this resource's current text at all — skip it. An absent
      // read is not evidence that the field was cleared, and answering our own
      // failed lookup by deleting the merchant's translation is the one
      // direction this module never errs in.
      if (!resourcePrimary) {
        unreadableResources++;
        continue;
      }
      for (const key of wantedKeys.get(itemResourceId) ?? []) {
        const entry = resourcePrimary[key];
        const primaryValue = entry?.value ?? "";
        // The read-back does not agree with what the caller says it wrote, so
        // Shopify has not caught up with the write yet. Translating this would
        // register an echo-confirmed translation of the OLD text — so it is a
        // DECLINE: we refuse to try, and the merchant's stored answer decides
        // whether the stale translation goes. Skipping it outright would leave
        // a foreign value live on a surface nothing else ever revisits.
        const expectedValue = expected.get(`${itemResourceId}${PAIR_SEP}${key}`);
        const staleReadBack = expectedValue !== undefined && expectedValue !== primaryValue;
        // Counted per (resource, KEY), never per locale: this number is read
        // when diagnosing a theme write that Shopify had not re-indexed yet,
        // and multiplying it by the locale count says nothing about how many
        // writes were behind.
        if (staleReadBack) declinedByReadBack++;
        for (const locale of foreignLocales) {
          // The caller wrote this exact translation in this exact save. Neither
          // list: re-translating it would overwrite what the merchant just
          // typed, and removing it would delete it.
          if (untouchable.has(tripleKey(itemResourceId, locale, key))) continue;
          const candidate: StaleTranslation = {
            key,
            locale,
            resourceId: ref.resourceId,
            resourceType: ref.resourceType,
            // The two reasons this module already knows, decided from the value
            // we just wrote: text there ⇒ the translation is out of date,
            // nothing there ⇒ the merchant cleared the field.
            // `partitionStaleTranslations` routes the second one to the removal
            // by itself (no source, no translation), so this is a label rather
            // than a second decision.
            reason: primaryValue.trim() ? "outdated" : "primary-empty",
            primaryValue,
            digest: entry?.digest ?? null,
            retranslatable: !staleReadBack && !removeOnly.has(`${itemResourceId}${PAIR_SEP}${key}`),
          };
          // The verdict comes from the SAME classifier the repair partitions
          // with, so "will this be translated" cannot drift from what actually
          // happens to it.
          if (
            classifyStaleTranslation(candidate, true, {
              anyKey: !!params.translateAs,
              // The SAME options the partition uses, or the two answers drift:
              // without this a handle reads as a removal here, pays the
              // per-locale evidence sweep this branch exists to avoid, and is
              // then re-translated by the partition anyway.
              translateHandles: policy.autoTranslateHandles,
            }) === "retranslate"
          ) {
            stale.push(candidate);
          } else {
            needEvidence.push(candidate);
          }
        }
      }
    }

    // Only now, and only for the candidates that would be REMOVED: does a
    // translation exist to remove? The answer is the UNION of what Shopify
    // reports and what the local mirror holds, and both halves are
    // load-bearing.
    //
    // Shopify is the one that knows: a translation written in the Shopify admin
    // or by another app has no mirror row here, and the code this path replaces
    // reached it anyway because it removed BLINDLY across every foreign locale.
    // Asking only the mirror would have traded "deleted" for "left live on the
    // storefront" for exactly those rows — the direction this project never
    // errs in, and on types with no webhook to catch it later.
    //
    // The mirror is the fallback: a locale whose read failed answers nothing,
    // and dropping it would silently do less than before. A pair we once wrote
    // is evidence enough to repair it.
    //
    // It is asked for the narrowed set, and on the common save — a text edit
    // with a value in it — for nothing at all: every candidate is translated,
    // so the whole per-locale sweep is skipped rather than paid for.
    if (needEvidence.length > 0) {
      const evidenceKeys = new Map<string, Set<string>>();
      const evidenceLocales = new Set<string>();
      for (const candidate of needEvidence) {
        const id = candidate.resourceId ?? resourceId;
        const keys = evidenceKeys.get(id) ?? new Set<string>();
        keys.add(candidate.key);
        evidenceKeys.set(id, keys);
        evidenceLocales.add(candidate.locale);
      }
      const evidenceRefs = [...evidenceKeys.keys()].map((id) => refs.get(id)!).filter(Boolean);
      const locales = [...evidenceLocales];
      const existing = await foreignTranslationTriples(
        gateway,
        [...evidenceKeys.keys()],
        locales,
        evidenceKeys,
      );
      // Its Shopify half degrades per locale by design; this half has to as
      // well. `stale` already holds every entry that will be TRANSLATED and
      // never needed the mirror at all, so letting a DB blink escape to the
      // function's catch would discard them — and the caller has by then stood
      // its own purge down, so those keys would be neither refreshed nor
      // removed, on a type with no webhook to notice later.
      const evidenceKeyList = [
        ...new Set([...evidenceKeys.values()].flatMap((keys) => [...keys])),
      ];
      try {
        for (const row of await mirrorOf(params).existing(evidenceRefs, locales, evidenceKeyList)) {
          if (evidenceKeys.get(row.resourceId)?.has(row.key)) {
            existing.add(tripleKey(row.resourceId, row.locale, row.key));
          }
        }
      } catch (error: unknown) {
        logger.warn("[StaleTranslations] Mirror evidence lookup failed — Shopify's answer stands alone", {
          context: "StaleTranslations",
          shop,
          resourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      for (const candidate of needEvidence) {
        if (existing.has(tripleKey(candidate.resourceId ?? resourceId, candidate.locale, candidate.key))) {
          stale.push(candidate);
        }
      }
    }

    // This save IS the change event, so it advances the resource's PRIMARY
    // baseline itself — from the text it just read back. Without it the row
    // kept the digest from before the save (the webhook of that same save
    // bails on our claim and writes nothing), so any change event after the
    // 30-second claim — a price edit, a delayed webhook, the nightly sweep —
    // proved the SAME move again, found locales this run had not registered
    // yet, won the claim and queued a second run: those locales translated and
    // registered twice. A content surface only; the value surfaces' keys are
    // not the resource's managed fields.
    if (!params.translateAs) {
      const ownContent = primaryByResource.get(resourceId);
      if (ownContent) await advancePrimaryBaselineAfterSave(shop, resourceId, resourceType, ownContent);
    }

    if (unreadableResources > 0 || declinedByReadBack > 0) {
      logger.warn("[StaleTranslations] Some entries could not be read back as written", {
        context: "StaleTranslations",
        shop,
        resourceId,
        // Skipped entirely — a resource we could not read at all.
        unreadableResources,
        // Read, but not yet showing what the caller wrote: declined, so the
        // merchant's stored deletion answer decides.
        staleReadBack: declinedByReadBack,
      });
    }
    if (stale.length === 0) return NOTHING;

    logger.info("[StaleTranslations] Primary text changed in the editor — re-translating", {
      context: "StaleTranslations",
      shop,
      resourceId,
      resourceType,
      stale: stale.length,
    });

    // Claim the resource BEFORE the repair starts. The sync-side entry point
    // bails on `isTranslationRecentlySaved`, and without this mark nothing sets
    // it on a save whose entries are ALL re-translatable (there is no inline
    // purge to do it): the merchant presses reload while the AI is working, the
    // digest mirror has not advanced yet, so the sync re-detects the very same
    // entries and `retranslationsInFlight` QUEUES a second identical run —
    // every locale translated and registered twice, the second overwriting the
    // first. It lands before the detached run reads its own baseline, which is
    // the ordering the inline purge already relies on, so the run cannot mistake
    // this for a merchant write and abandon itself.
    markTranslationSaved(params.lockId ?? resourceId);

    return await repairStaleTranslations(await withHandleResolver(params, policy), stale, policy, {
      // The caller's OWN change, not what the detection found: an override can
      // sit on a (locale, key) that has no global translation at all.
      keys: [...new Set(changed.map((item) => item.key))],
      locales: [...foreignLocales],
    });
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Post-save re-translation failed — translations kept", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOTHING;
  }
}

/**
 * Repair entries ALREADY established as stale: purge them, re-translate them,
 * or both. Both entry points share it, because everything delicate lives here
 * — the in-flight queue, the "did the merchant write while we worked"
 * timestamp, the "a confirmed write is never taken back" rule and the fallback
 * purge for what the AI could not deliver. A second copy of that would drift
 * within one release.
 *
 * What each caller does to ESTABLISH staleness is its own business, and the two
 * differ on purpose: the sync above has to PROVE the primary text moved (digest
 * baseline plus Shopify's `outdated` flag, neither of which it authored), while
 * the in-app save below IS the change event and knows exactly which keys it
 * just rewrote.
 *
 * NOTHING escapes it either — both callers wrap it, and the sync's contract
 * is that a stale row left behind must never fail the save or the webhook.
 */
/**
 * The standard handle-redirect resolver, attached by BOTH entry points rather
 * than by every caller.
 *
 * There are two dozen call sites into this module and a handle that reaches one
 * of them without a resolver is simply left alone — so forgetting it costs a
 * refreshed slug, never a broken URL. Building it here instead means no caller
 * has to know about it at all, and the one that wants to answer differently (a
 * test) still can, because an explicit resolver is kept.
 *
 * A failure to even build it resolves to "no resolver", i.e. no handle moves.
 */
async function withHandleResolver<T extends RepairTarget>(
  target: T,
  policy: TranslationChangePolicy,
): Promise<T> {
  // No opt-in, a value surface (whose keys are field names, not URLs), or a
  // caller that already answered: nothing to attach.
  if (!policy.autoTranslateHandles || target.translateAs || target.handleRedirect) return target;
  try {
    const { db } = await import("../../db.server");
    const { makeHandleRedirectResolver } = await import("./handle-retranslation.server");
    return {
      ...target,
      handleRedirect: makeHandleRedirectResolver({
        db,
        shop: target.shop,
        client: target.client,
      }),
    };
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] No handle-redirect resolver — handles left alone", {
      context: "StaleTranslations",
      shop: target.shop,
      resourceId: target.resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return target;
  }
}

/**
 * The old foreign URL's redirect, created AFTER the register Shopify confirmed.
 *
 * The order is not a preference. Register first and a failed redirect leaves
 * the old address dead while the page is reachable at its new one; redirect
 * first and a failed register leaves a 301 sitting on the page's OWN live URL,
 * because Shopify serves a redirect in preference to a page — the resource
 * unreachable at its own address. The first is the recoverable half, and it is
 * the residual every redirect call site in this app already carries: a redirect
 * never fails the write it accompanies. It is REPORTED, though: this runs
 * unattended, the mirror has already advanced to the new slug (so no later run
 * will ever rebuild this redirect), and a log line is invisible to the
 * merchant — the answer is `false`, which the run counts into its Task row.
 *
 * `nextHandle` is what Shopify STORED, not what was submitted.
 */
async function createHandleRedirect(
  gateway: ShopifyApiGateway,
  target: RepairTarget,
  context: TranslatedHandleContext | undefined,
  nextHandle: string,
): Promise<boolean> {
  // Reserved before the AI ran; an entry without a context never reached the
  // write. Belt and braces, because the alternative is a moved URL with no row.
  if (!context) return false;
  try {
    const { applyTranslatedHandleRedirect } = await import("../seo/handle-redirect.server");
    const result = await applyTranslatedHandleRedirect(gateway as never, target.shop, {
      resource: context.resource,
      // GLOBAL layer only, like everything this repair writes: a market
      // override is not a shop-wide path and the decision refuses one anyway.
      marketId: "",
      previousTranslatedHandle: context.previousTranslatedHandle,
      nextTranslatedHandle: nextHandle,
      primaryHandle: context.primaryHandle,
      otherLocaleHandles: context.otherLocaleHandles,
      previousHandleTakenElsewhere: context.previousHandleTakenElsewhere,
      wanted: true,
      previouslyLive: context.previouslyLive,
      blogHandle: context.blogHandle,
      blogHandleTranslatedInLocale: context.blogHandleTranslatedInLocale,
    });
    if (result.created) return true;
    // "unchanged" is the AI answering with the slug that was already there —
    // routine, and the reason nothing had to be written. Anything else means
    // the old URL is NOT covered.
    if (result.skippedReason === "unchanged") return true;
    logger.warn("[StaleTranslations] Handle re-translated but the old URL was not redirected", {
      context: "StaleTranslations",
      shop: target.shop,
      resourceId: target.resourceId,
      reason: result.skippedReason,
      noteCode: result.noteCode,
    });
    return false;
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Handle redirect failed", {
      context: "StaleTranslations",
      shop: target.shop,
      resourceId: target.resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Record that a `handle` this repair deliberately LEFT ALONE was looked at
 * against the CURRENT primary slug — by advancing its mirror digest, and
 * nothing else (the value stays exactly as it is, on Shopify and here).
 *
 * Without this a kept handle is a loop. The digest gate proves staleness by
 * comparing that mirror digest against the primary one; keeping writes
 * nothing, so the digest stays old, Shopify's row stays `outdated`, and the
 * same resource is proven stale again at the next look — every night, on the
 * drift sweep, taking one of its per-type handover slots each time and (for an
 * answer we discard) one AI request on the merchant's key. Removal ended that
 * loop before the opt-in existed; the opt-in removed the removal.
 *
 * Only for DETERMINISTIC keeps — a redirect that cannot be written, an answer
 * the slug rules throw away. A transient one (a provider error, an unechoed
 * write) stays unacknowledged, so the next change event tries again. The next
 * real move of the primary handle is still provable: it changes the digest
 * again. GLOBAL layer only, like every write this repair makes.
 */
async function acknowledgeKeptHandles(
  target: RepairTarget,
  entries: readonly StaleTranslation[],
): Promise<void> {
  if (target.translateAs) return;
  const handles = entries.filter((entry) => entry.key === "handle" && entry.digest);
  if (handles.length === 0) return;
  try {
    const { db } = await import("../../db.server");
    for (const entry of handles) {
      await db.contentTranslation.updateMany({
        where: {
          shop: target.shop,
          resourceId: refOf(target, entry).resourceId,
          locale: entry.locale,
          key: "handle",
          marketId: "",
          NOT: { digest: entry.digest },
        },
        data: { digest: entry.digest },
      });
    }
  } catch (error: unknown) {
    // Bookkeeping after a decision that already stands: the cost of failing
    // here is one more look at the next sweep, never a wrong write.
    logger.warn("[StaleTranslations] Could not record kept handles", {
      context: "StaleTranslations",
      shop: target.shop,
      resourceId: target.resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Decide, BEFORE any AI request, which `handle` entries may actually move.
 *
 * Split from the partition because the two questions are different in kind.
 * `classifyStaleTranslation` is pure and answers "did the merchant switch
 * handle re-translation on"; this one asks the caches and Shopify whether the
 * address this particular slug would move away from can be redirected at all —
 * the five refusals in `decideTranslatedHandleRedirect`, every one of which is
 * a URL that would otherwise break.
 *
 * It runs FIRST, not after the translation, for two reasons: a refused handle
 * must not cost an AI request, and — the load-bearing one — the alternative is
 * to translate it and then decide, which leaves only two bad options (write the
 * slug without a redirect, or throw away a value we already paid for).
 *
 * A repair with NO resolver declines every handle. That is the structural half
 * of the rule: a new entry point cannot produce a broken foreign URL by
 * forgetting to wire this up, it can only fail to refresh a slug.
 */
async function reserveHandleRedirects(
  target: RepairTarget,
  retranslate: readonly StaleTranslation[],
  declined: readonly StaleTranslation[],
): Promise<{
  retranslate: StaleTranslation[];
  declined: StaleTranslation[];
  /** Handles left untouched: neither translated nor purged — see the caller. */
  keptHandles: StaleTranslation[];
  /** `tripleKey(resourceId, locale, "handle")` → the old state its redirect
   *  needs, captured before the write. */
  handleContexts: Map<string, TranslatedHandleContext>;
}> {
  const keptHandles: StaleTranslation[] = [];
  const handleContexts = new Map<string, TranslatedHandleContext>();
  // A value surface has no content `handle` key at all — its keys are field
  // names — so nothing here applies and nothing is looked up.
  if (target.translateAs || !retranslate.some((entry) => entry.key === "handle")) {
    return { retranslate: [...retranslate], declined: [...declined], keptHandles, handleContexts };
  }

  const kept: StaleTranslation[] = [];
  for (const entry of retranslate) {
    if (entry.key !== "handle") {
      kept.push(entry);
      continue;
    }
    const ref = refOf(target, entry);
    const context = target.handleRedirect
      ? await target.handleRedirect(ref, entry.locale)
      : null;
    if (!context) {
      keptHandles.push(entry);
      continue;
    }
    handleContexts.set(tripleKey(ref.resourceId, entry.locale, entry.key), context);
    kept.push(entry);
  }

  if (keptHandles.length > 0) {
    logger.info("[StaleTranslations] Handle translations left untouched — no redirect possible", {
      context: "StaleTranslations",
      shop: target.shop,
      resourceId: target.resourceId,
      entries: keptHandles.length,
    });
  }
  return { retranslate: kept, declined: [...declined], keptHandles, handleContexts };
}

async function repairStaleTranslations(
  target: RepairTarget,
  stale: readonly StaleTranslation[],
  policy: TranslationChangePolicy,
  /**
   * The FULL change, for the market-override purge — every key the primary
   * write touched and every published foreign locale, not the subset the
   * detection found a GLOBAL translation for.
   *
   * The two differ in exactly the case that matters: a merchant can hold a
   * market override for a locale they never translated globally. That pair is
   * absent from `stale` by construction, so a purge driven by `stale` would
   * walk straight past the override it exists to remove.
   */
  scope: {
    keys: readonly string[];
    locales: readonly string[];
    /** Overrides the purge must walk past (`marketOverrideKey`) — see
     *  `purgeMarketOverrides`. */
    currentOverrides?: ReadonlySet<string>;
  },
): Promise<ReconcileResult> {
  const { client, shop, resourceId, resourceType } = target;
  const lockId = target.lockId ?? resourceId;
  const gateway = gatewayFor(client, shop);
  const mirror = mirrorOf(target);
  const partitioned = partitionStaleTranslations(
    stale,
    policy.autoTranslateExternalChanges,
    // The content-field allowlist exists to keep `handle` out. A surface that
    // translates bare values has no `handle` and no field vocabulary at all —
    // applying the list there would re-translate nothing while reporting that
    // it had.
    {
      anyKey: !!target.translateAs,
      // The merchant's opt-in, already ANDed with the parent switch and the
      // plan. It only says a handle MAY move; whether THIS URL may is asked
      // below, where the old address can be looked at.
      translateHandles: policy.autoTranslateHandles,
    },
  );
  const purge = partitioned.purge;
  // A handle the app cannot put a redirect on is left ALONE — not translated,
  // and deliberately not purged either. That is the one place this module
  // departs from "what the automation cannot deliver is removed": for every
  // other key a stale translation describes text that no longer exists, while a
  // stale HANDLE is still a working URL. Deleting it would move the foreign
  // address to the primary slug with no redirect, i.e. produce exactly the
  // silently broken link the opt-in exists to avoid — and it is the merchant's
  // own slug, which the automation was never asked to remove.
  const { retranslate, declined, keptHandles, handleContexts } =
    await reserveHandleRedirects(target, partitioned.retranslate, partitioned.declined);
  // A refused redirect is a property of the resource, not of this moment —
  // recorded, or the same refusal is re-proven at every later look.
  await acknowledgeKeptHandles(target, keptHandles);

  // May a stale translation be REMOVED here? Not the same question as the
  // merchant's purge switch, which auto-translate forces off (the two are
  // alternatives — translation-change-policy.server.ts). A shop that asked
  // for "always give it the new text" is asking for the opposite of stale,
  // so whatever the AI cannot deliver — a CLEARED source with nothing to
  // translate, a `handle`, a provider error — is removed rather than left
  // describing text that no longer exists. Only with BOTH switches off does
  // nothing get touched, and that case never reaches this line.
  const mayPurge = policy.purgeOnPrimaryChange || policy.autoTranslateExternalChanges;

  // The INLINE purge runs FIRST: one GraphQL call, so the storefront is
  // corrected immediately — and its `markTranslationSaved` then lands BEFORE
  // the detached run captures its baseline below. The other order made the
  // run read our own mark as "the merchant saved" and abandon itself.
  // What WE declined to translate keeps the merchant's stored answer: we chose
  // not to try, so "don't delete" still means don't delete. `mayPurge` is about
  // what the automation could not deliver, which is a different promise.
  const toPurge =
    declined.length > 0 && policy.purgeUnreconciledSurfaces ? [...purge, ...declined] : purge;

  // The MARKET layer of everything this change touches, BEFORE the global
  // decisions below — and over the re-translated entries as well as the purged
  // ones. Nothing in this app re-translates an override (the repair writes
  // global rows only, deliberately), so when the primary text moves it is
  // exactly as stale as the global row beside it and nothing else would ever
  // notice: it kept describing text that no longer exists, on the storefront,
  // for good. `declined` is NOT in the set — there we refused to try, so the
  // merchant's stored "don't delete" still stands, on both layers.
  //
  // Best-effort and mirror-driven: on a shop with no overrides it is one DB
  // query and no Shopify call at all (market-layer-purge.server.ts).
  // A key we DECLINED to translate and are not purging keeps the merchant's
  // stored answer — on BOTH layers. Driving the market purge off the caller's
  // full key list deleted the override of exactly those keys while their global
  // row was deliberately kept, which is the richtext-theme bug CLAUDE.md already
  // records, one layer down. So the scope is the change MINUS what stood down.
  const keptDeclinedKeys = new Set(
    [...declined.filter((entry) => !toPurge.includes(entry)), ...keptHandles].map(
      (entry) => entry.key,
    ),
  );
  for (const entry of [...retranslate, ...toPurge]) keptDeclinedKeys.delete(entry.key);
  // A `handle` whose GLOBAL row this repair did NOT delete keeps its MARKET
  // override as well. The rule beside it — "the market layer goes when
  // something happens to the global layer" — is about a wording that no longer
  // describes its source; an override handle is a URL, and nothing can ever
  // re-translate it (the redirect decision refuses a market-scoped path
  // outright, because one shop-wide row cannot express a per-market address).
  // Deleting it would move that market's URL with no redirect, which is the
  // breakage this whole option exists to avoid. A handle that IS purged still
  // takes its override with it — unchanged behaviour. On a VALUE surface
  // `handle` is an ordinary field key, not an address, so none of this applies.
  const purgesHandle = toPurge.some((entry) => entry.key === "handle");
  const marketKeys = scope.keys.filter((key) => {
    if (keptDeclinedKeys.has(key)) return false;
    if (!target.translateAs && key === "handle" && !purgesHandle) return false;
    return true;
  });

  if (mayPurge && marketKeys.length > 0 && (retranslate.length > 0 || toPurge.length > 0)) {
    try {
      const { purgeMarketOverrides } = await import("./market-layer-purge.server");
      const refsById = new Map<string, TranslationRef>();
      for (const entry of [...retranslate, ...toPurge]) {
        const ref = refOf(target, entry);
        refsById.set(ref.resourceId, ref);
      }
      await purgeMarketOverrides({
        gateway,
        mirror,
        refs: [...refsById.values()],
        locales: scope.locales,
        keys: marketKeys,
        ...(scope.currentOverrides ? { currentOverrides: scope.currentOverrides } : {}),
        context: resourceType,
      });
    } catch (error: unknown) {
      logger.warn("[StaleTranslations] Market-override purge could not run", {
        context: "StaleTranslations",
        shop,
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let removed = 0;
  if (mayPurge && toPurge.length > 0) {
    removed = await purgeStaleEntries(gateway, target, mirror, toPurge);
    // Protect what we just changed from a racing webhook sync that re-fetches
    // Shopify before it is consistent again — under the SAME key as every other
    // claim in this module. Marking the bare `resourceId` here made a
    // private-lock repair claim the product after all as soon as one of its
    // entries was a cleared value, which is exactly what `lockId` exists to
    // stop.
    markTranslationSaved(lockId);
  }

  // The AI re-translation is DETACHED. Two of the callers (the single-item
  // reload routes) await this sync inside an HTTP request, and one AI request
  // per locale does not fit in a request the browser abandons after 30
  // seconds. It is Task-tracked, so nothing is lost by not waiting.
  const inFlightKey = `${shop}${IN_FLIGHT_SEP}${resourceId}`;
  const startRetranslation = retranslate.length > 0;
  // Minted before the run is spawned rather than read off the row it creates:
  // the run is detached by design, so by the time `db.task.create` returns the
  // HTTP request that started it is long gone. A caller that wants to tell the
  // merchant "this is still working" needs the id NOW.
  const taskId = startRetranslation ? randomUUID() : undefined;
  if (startRetranslation) {
    const runWork = async () => {
      // "Has someone written since I started?" — a TIMESTAMP, not the
      // boolean, and captured HERE rather than at spawn. The boolean cannot
      // tell a merchant save from this module's own mark (the purge above
      // marks the resource, and so does a finishing run), and a snapshot
      // taken at spawn is already minutes stale for a run that was QUEUED
      // behind another — the run it waited for marks the resource on its way
      // out, and the queued one then abandons itself before touching a
      // single locale. Its entries end up in neither list, so nothing
      // re-translates and nothing removes them, permanently, because the
      // sync has already advanced their digest baseline.
      // Watched per RESOURCE, not only per group: a sub-resource translation is
      // saved on the OPTION's or the METAFIELD's own GID, so a run watching
      // only the product would never see the merchant's hand-written value land
      // — the one rule that is supposed to protect it would not fire, and the
      // AI would overwrite it minutes later.
      // What a merchant write on would make this run stand down: our own lock,
      // plus every resource whose translations this run is about to replace.
      //
      // The group's `resourceId` is included ONLY when it is the lock too. With
      // a private lock that id belongs to a DIFFERENT repair — an article save
      // runs the content repair and the featured-alt repair on one id — and its
      // inline claim would abort this run mid-locale, leaving the rest of the
      // entries in neither list: neither refreshed nor purged, on a surface
      // nothing else revisits. A sibling of ours is not the merchant.
      const watched = [
        ...new Set([lockId, ...retranslate.map((entry) => entry.resourceId ?? resourceId)]),
      ];
      const savedAtStart = new Map(watched.map((id) => [id, translationSavedAt(id)]));
      const changedSince = (id: string) => {
        const now = translationSavedAt(id);
        return now !== null && now !== savedAtStart.get(id);
      };
      // PER RESOURCE, not per run. A merchant who renames two menu items and
      // types one of them's English title has said nothing about the other —
      // and an all-or-nothing abort left that other item's entries in neither
      // list, so nothing refreshed them and nothing removed them, on a surface
      // with no webhook to notice later. A claim on the run's own LOCK still
      // stops everything: that is the group-level "someone else is writing
      // here".
      const supersededByMerchant = (entryResourceId?: string) =>
        changedSince(lockId) || (!!entryResourceId && changedSince(entryResourceId));
      try {
        const outcome = await retranslateStaleEntries(
          gateway,
          target,
          retranslate,
          supersededByMerchant,
          taskId!,
          handleContexts,
        );
        // Entries the AI path could not deliver still have to lose their
        // stale translation — a failed automation must never leave the old
        // text on the storefront. UNLESS the merchant edited this resource's
        // translations while the AI was working: the run took minutes, their
        // hand-written value is newer than everything decided here, and
        // deleting it would be the one unrecoverable outcome. The next change
        // event repairs whatever is genuinely still stale.
        if (
          mayPurge &&
          !outcome.startFailed &&
          outcome.failed.length > 0 &&
          !supersededByMerchant()
        ) {
          await purgeStaleEntries(gateway, target, mirror, outcome.failed);
        }
        if (outcome.registered.length > 0) markTranslationSaved(lockId);
      } catch (error: unknown) {
        logger.warn("[StaleTranslations] Detached re-translation run failed", {
          context: "StaleTranslations",
          shop,
          resourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // A run already going for this resource is WAITED FOR, never a reason to
    // drop this one: these entries were detected against a baseline this sync
    // has already overwritten, so discarding them loses them for good. Two
    // admin edits a minute apart are exactly that case. The several webhooks
    // of ONE save never reach here — by then the digests match and
    // `retranslate` is empty.
    const previous = retranslationsInFlight.get(inFlightKey);
    const run: Promise<void> = (previous ? previous.then(runWork, runWork) : runWork()).finally(
      () => {
        if (retranslationsInFlight.get(inFlightKey) === run) {
          retranslationsInFlight.delete(inFlightKey);
        }
      },
    );
    retranslationsInFlight.set(inFlightKey, run);
    void run;
  }

  if (removed > 0 || startRetranslation) {
    logger.info("[StaleTranslations] Reconciled", {
      context: "StaleTranslations",
      shop,
      resourceId,
      removed,
      retranslating: startRetranslation ? retranslate.length : 0,
    });
  }

  return {
    removed,
    retranslating: startRetranslation ? retranslate.length : 0,
    ...(taskId ? { taskId } : {}),
  };
}

// ─── Purge ────────────────────────────────────────────────────────────────

/**
 * Echo-verified removal on Shopify, then the local mirror for CONFIRMED pairs
 * only. Global layer (`marketId ""`) exclusively — a market override is a
 * deliberate separate value and survives, exactly as in both editors.
 *
 * ONE call PER LOCALE with exactly that locale's stale keys. `translationsRemove`
 * takes keys × locales as a cross product, and this set is genuinely per
 * (locale, key): a locale that was re-translated after the primary change is
 * not stale, and a key can be stale in one locale while another holds a
 * current translation of it. Sending the union would delete a translation
 * nobody flagged — on Shopify, where the local row we kept could no longer
 * mirror it.
 */
async function purgeStaleEntries(
  gateway: ShopifyApiGateway,
  target: RepairTarget,
  mirror: TranslationMirror,
  entries: readonly StaleTranslation[],
): Promise<number> {
  // Per (RESOURCE, locale) first, because `translationsRemove` addresses exactly
  // one resource and this set is genuinely per (locale, key): a locale that was
  // re-translated after the primary change is not stale, and a key can be stale
  // in one locale while another holds a current translation. Sending the union
  // would delete a translation nobody flagged.
  const byResourceLocale = new Map<string, { ref: TranslationRef; locale: string; keys: string[] }>();
  for (const entry of entries) {
    // A FILL has no translation to remove — it exists to create one. It reaches
    // here through the fallback purge after a failed AI run, and sending the
    // removal anyway echoes nothing back, costs a gap re-read per locale, and
    // reports removals for translations the merchant never had.
    if (entry.filled) continue;
    const ref = refOf(target, entry);
    const id = `${ref.resourceId}${PAIR_SEP}${entry.locale}`;
    const group = byResourceLocale.get(id) ?? { ref, locale: entry.locale, keys: [] };
    if (!group.keys.includes(entry.key)) group.keys.push(entry.key);
    byResourceLocale.set(id, group);
  }
  if (byResourceLocale.size === 0) return 0;

  // ...then FOLDED by identical key set, which is the common case by far: the
  // same fields went stale in every locale. `translationsRemove` takes keys ×
  // locales as a cross product, so folding only locales that ask for exactly
  // the same keys keeps the per-(locale, key) precision above while turning
  // twelve metafields on an eight-locale shop back into twelve calls instead of
  // ninety-six — sequential ones, inside the merchant's save request.
  const folded = new Map<string, { ref: TranslationRef; locales: string[]; keys: string[] }>();
  for (const { ref, locale, keys } of byResourceLocale.values()) {
    const signature = `${ref.resourceId}${PAIR_SEP}${[...keys].sort().join(PAIR_SEP)}`;
    const group = folded.get(signature) ?? { ref, locales: [], keys };
    group.locales.push(locale);
    folded.set(signature, group);
  }

  let removed = 0;
  for (const { ref, locales, keys } of folded.values()) {
    const { confirmedPairs } = await removeAndVerifyAcrossLocales(
      gateway,
      ref.resourceId,
      keys,
      locales,
      "",
    );
    for (const locale of locales) {
      let confirmed = keys.filter((key) => confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}${key}`));

      // A GAP is not a failure, and the multi-locale call cannot tell the
      // difference on its own. `translationsRemove` echoes what it DELETED, so
      // a key that carried nothing on Shopify in the first place — a mirror row
      // written when the register found no digest, the case CLAUDE.md creates
      // by design — comes back empty and its local row would survive forever,
      // with the editor still serving a foreign value for a cleared field and
      // every later save repeating the same no-op.
      //
      // `removeAndVerify` is the path that RE-READS on a gap, so the unechoed
      // keys go through it — one extra call per locale that actually had one,
      // which is the rare case; the common case stays the single folded call
      // above. The §6.6 sweep skips this re-read because it runs per row AND
      // per sub-resource across a whole bulk save; here the group is one
      // merchant action, so the cost argument does not apply.
      const unconfirmed = keys.filter((key) => !confirmed.includes(key));
      if (unconfirmed.length > 0) {
        const { confirmedKeys } = await removeAndVerify(
          gateway,
          ref.resourceId,
          unconfirmed,
          locale,
          "",
        );
        confirmed = [...confirmed, ...unconfirmed.filter((key) => confirmedKeys.has(key))];
      }

      if (confirmed.length === 0) continue;
      // Shopify has already CONFIRMED the removal by this line, so a failing
      // local delete may not take the run with it: this purge is inline, ahead
      // of the detached re-translation, and a throw here would abort the whole
      // repair after the caller stood its own deletion down — the stale rows
      // then survive with nothing left to refresh them. A local row the delete
      // did not reach is corrected by the next sync; that is the cheap half.
      try {
        await mirror.remove(ref, locale, confirmed);
      } catch (mirrorError: unknown) {
        logger.warn("[StaleTranslations] Removed on Shopify but not in the local cache", {
          context: "StaleTranslations",
          resourceId: ref.resourceId,
          locale,
          keys: confirmed,
          error: mirrorError instanceof Error ? mirrorError.message : String(mirrorError),
        });
      }
      // Counted from Shopify's confirmations, not from the DB result: a row
      // the cache never held (or already dropped) is still a translation that
      // is gone from the storefront, and that is what this number reports.
      removed += confirmed.length;
    }
  }
  return removed;
}

// ─── Re-translate (Max) ───────────────────────────────────────────────────

interface RetranslateOutcome {
  registered: StaleTranslation[];
  /** Entries the AI could not deliver — they must still be purged. */
  failed: StaleTranslation[];
  /** Undelivered `handle` entries, which are deliberately NOT purged. Reported
   *  for the log; see the list's note inside the run. */
  kept?: StaleTranslation[];
  /**
   * The run could not START (a DB error on the settings read or the Task row).
   * NOT the same as "the AI failed": the entries are untouched and the fallback
   * purge must be skipped — see the wrapper.
   */
  startFailed?: boolean;
}

/**
 * Re-translate the NEW primary values into every affected locale and register
 * them, Task-tracked so the run shows up in the Tasks tab like every other AI
 * operation. One AI request per locale (the same granularity the editor's
 * "translate all fields" uses).
 *
 * NOTHING may escape this function. Its SETUP — the dynamic imports, the AI
 * settings read, creating the Task row — sits outside the inner try, and a
 * throw there used to travel up as an unhandled run failure.
 *
 * It comes back as `startFailed`, deliberately NOT as `failed`. The realistic
 * trigger is a DATABASE error (`task.create`), and answering it with the purge
 * would remove the translations on Shopify while the local mirror delete fails
 * for the very same reason — storefront content gone because our own database
 * blinked, which is the exact rule the mirror-write below is built on, in
 * reverse. A stale text left standing is visible and repairable on the next
 * change event; a deleted one is neither.
 */
async function retranslateStaleEntries(
  gateway: ShopifyApiGateway,
  params: RepairTarget,
  entries: readonly StaleTranslation[],
  /** "Did a save land after this run started?" — for the RUN when called bare,
   *  for one resource when given its id. See the caller. */
  supersededByMerchant: (entryResourceId?: string) => boolean,
  /** The id the caller already handed to the merchant — see ReconcileResult. */
  taskId: string,
  /** Redirect contexts reserved for the `handle` entries — see
   *  `reserveHandleRedirects`. An entry without one never got this far. */
  handleContexts: ReadonlyMap<string, TranslatedHandleContext>,
): Promise<RetranslateOutcome> {
  try {
    return await runRetranslation(
      gateway,
      params,
      entries,
      supersededByMerchant,
      taskId,
      handleContexts,
    );
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Re-translation could not start — stale rows kept", {
      context: "StaleTranslations",
      shop: params.shop,
      resourceId: params.resourceId,
      entries: entries.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { registered: [], failed: [], kept: [], startFailed: true };
  }
}

async function runRetranslation(
  gateway: ShopifyApiGateway,
  params: RepairTarget,
  entries: readonly StaleTranslation[],
  supersededByMerchant: (entryResourceId?: string) => boolean,
  taskId: string,
  handleContexts: ReadonlyMap<string, TranslatedHandleContext>,
): Promise<RetranslateOutcome> {
  const { shop, resourceId, resourceType, contentKind, resourceTitle } = params;
  const { db } = await import("../../db.server");
  const mirror = mirrorOf(params);

  const byLocale = new Map<string, StaleTranslation[]>();
  for (const entry of entries) {
    const list = byLocale.get(entry.locale) ?? [];
    list.push(entry);
    byLocale.set(entry.locale, list);
  }

  const registered: StaleTranslation[] = [];
  const failed: StaleTranslation[] = [];
  /**
   * Translations Shopify CONFIRMED but the local mirror refused.
   *
   * It is deliberately NOT a failure of the entry — the storefront serves the
   * new value, and pushing it into `failed` would purge it because our own
   * database blinked. But it is not nothing either: every surface in this app
   * RENDERS from the mirror, so such a translation is live and invisible, and
   * the merchant's report is "the field stays empty after the background run".
   * The run therefore ends `completed_with_errors` and says so in its result,
   * rather than reporting a clean success over a half-written repair.
   */
  const notMirrored: Array<{ resourceId: string; locale: string; key: string; error: string }> = [];
  /**
   * Handle entries this run could not deliver — a provider error, an answer the
   * slug sanitiser could not use, a write Shopify did not echo back.
   *
   * They go into a list of their OWN rather than into `failed`, because the
   * caller PURGES that one. For every other key a stale translation describes
   * text that no longer exists, so removing it is the safe fallback; a stale
   * HANDLE is a working URL, and deleting it moves the foreign address to the
   * primary slug with no redirect — the broken link the merchant switched this
   * on to avoid. Left alone, the next change event tries again.
   */
  const keptHandles: StaleTranslation[] = [];
  /** A content-surface `handle`. A value surface's keys are field names, and a
   *  metaobject field called "handle" is not a URL. */
  const isHandleEntry = (entry: StaleTranslation) => !params.translateAs && entry.key === "handle";
  const undelivered = (entry: StaleTranslation) => {
    if (isHandleEntry(entry)) keptHandles.push(entry);
    else failed.push(entry);
  };
  /** Kept handles whose answer the slug rules threw away — a DECISION about
   *  this primary slug, recorded at the end of the run (`acknowledgeKeptHandles`)
   *  so it is not paid for again at every later look. */
  const discardedHandles: StaleTranslation[] = [];
  /** Handles written whose OLD foreign URL got no redirect — reported on the
   *  Task row, because nothing will ever rebuild it (see createHandleRedirect). */
  let redirectsMissing = 0;

  // Only the content-field path needs the key→field map; the generic value path
  // has no field semantics to look up (see RepairTarget.translateAs).
  const asValues = params.translateAs;
  const { fieldTranslationKeyMap } = await import("../../../src/services/shopify-content.service");
  const keyToField = asValues ? {} : invertFieldMap(fieldTranslationKeyMap(resourceType));

  const { getTaskExpirationDate } = await import("../../config/constants");
  const { toValidProvider } = await import("../../../src/services/ai.service");
  const { TranslationService } = await import("../../../src/services/translation.service");
  const { tryDecryptApiKey } = await import("../../utils/encryption.server");
  const { getInstructionWithDefault } = await import("../../utils/ai-instructions.utils");
  const { buildTranslateInstructions } = await import("../../utils/character-limits");
  // The hybrid batching rule — how many languages of this payload fit one AI
  // response. Dynamic like the import above, to keep this module's static graph
  // as it is.
  const { planLocaleChunks } = await import("../ai/translation-budget.shared");

  const aiSettings = await db.aISettings.findUnique({ where: { shop } });
  const provider = toValidProvider(aiSettings?.preferredProvider);
  const aiConfig = {
    huggingfaceApiKey: tryDecryptApiKey(aiSettings?.huggingfaceApiKey, "huggingface") || undefined,
    geminiApiKey: tryDecryptApiKey(aiSettings?.geminiApiKey, "gemini") || undefined,
    claudeApiKey: tryDecryptApiKey(aiSettings?.claudeApiKey, "claude") || undefined,
    openaiApiKey: tryDecryptApiKey(aiSettings?.openaiApiKey, "openai") || undefined,
    grokApiKey: tryDecryptApiKey(aiSettings?.grokApiKey, "grok") || undefined,
    deepseekApiKey: tryDecryptApiKey(aiSettings?.deepseekApiKey, "deepseek") || undefined,
    selectedModel: aiSettings?.selectedModel || undefined,
  };

  const task = await db.task.create({
    data: {
      // The caller minted it before spawning this run and has already told the
      // merchant about it — so the row has to carry that id, not a fresh one.
      id: taskId,
      shop,
      type: "translation",
      status: "running",
      // The Tasks tab maps this to the row's BADGE, so it speaks the
      // merchant-facing kind, not the Shopify resource type. (The row's link
      // comes from `resourceId` below — see `task-deep-link.shared.ts`.)
      resourceType: params.taskResourceType ?? contentKind,
      resourceId,
      resourceTitle: resourceTitle || resourceId,
      fieldType: "autoTranslateExternalChange",
      targetLocale: [...byLocale.keys()].join(", "),
      provider,
      progress: 10,
      total: entries.length,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const aiInstructions = await db.aIInstructions.findUnique({ where: { shop } });
    const translationMode: "exact" | "seo_optimized" =
      aiSettings?.translationMode === "seo_optimized" ? "seo_optimized" : "exact";
    const translationService = new TranslationService(provider, aiConfig, shop, task.id);
    // ONE string for the value path, read by the cross-locale prefetch AND by the
    // per-locale fallback below. Built once because they must not disagree: with
    // it on only one of them, the same repair produced instructed or uninstructed
    // translations depending on which branch happened to answer. No field keys —
    // a bare value has no named field for an SEO cap to attach to.
    const valueInstructions = buildTranslateInstructions(
      getInstructionWithDefault(aiInstructions, "translateInstructions"),
      translationMode,
      [],
      { limits: (aiSettings?.seoLimits ?? null) as Record<string, number> | null },
    );

    // ── ONE AI pass for every language, before the write loop ──────────────
    //
    // The loop below is per LOCALE because the writes are: `translationsRegister`
    // takes one locale, the merchant-superseded checks are per locale and per
    // entry, and a failure has to be attributable to the language it happened
    // in. None of that is a reason to ASK per locale, and it used to: a product
    // whose text changed in the Shopify admin paid one AI request per published
    // language, unattended, on the merchant's own key — the single most
    // expensive per-locale loop left in the app, precisely because nobody is
    // watching it.
    //
    // The prefetch is a SNAPSHOT and the loop keeps every check it had. Its
    // candidate set is computed here at t0; an entry the merchant writes while
    // the AI works drops out of the loop's own filter later and its prefetched
    // value is simply never used. The sets only ever shrink, so a hoisted
    // candidate can never smuggle an entry past a check.
    //
    // A locale the prefetch could not answer is NOT lost either: the loop falls
    // back to the per-locale call it always made. So a throttled batch degrades
    // to the old behaviour rather than to a purge.
    const prefetched = new Map<string, Map<string, string>>();
    /** Stable identity of an entry within its locale — its own resource + key. */
    const entryId = (entry: StaleTranslation): string =>
      `${entry.resourceId ?? resourceId}\u0000${entry.key}`;
    try {
      const candidates = new Map<string, StaleTranslation[]>();
      for (const [locale, localeEntries] of byLocale) {
        const list = localeEntries
          .filter((entry) => !supersededByMerchant(entry.resourceId ?? resourceId))
          // The keyToField filter is REPEATED in the loop rather than moved
          // here, because that one also records a `failed` entry — doing it
          // twice would report the same entry to the merchant twice.
          .filter((entry) => asValues || !!keyToField[entry.key]);
        if (list.length > 0) candidates.set(locale, list);
      }

      if (candidates.size > 1) {
        if (asValues) {
          // Every locale of this run translates the SAME primary values (the
          // entries differ only in which locale they are missing from), so the
          // batch is asked once over the union and read back per locale. Mapped
          // by entry identity, never by position: the per-locale candidate lists
          // can have different lengths.
          const union = new Map<string, StaleTranslation>();
          for (const list of candidates.values()) {
            for (const entry of list) if (!union.has(entryId(entry))) union.set(entryId(entry), entry);
          }
          const ids = [...union.keys()];
          const perLocale = await translationService.translateValuesToLocales(
            ids.map((id) => union.get(id)!.primaryValue),
            asValues.sourceLocale,
            [...candidates.keys()],
            asValues.context,
            { instructions: valueInstructions },
          );
          for (const [locale, translated] of Object.entries(perLocale)) {
            const byEntry = new Map<string, string>();
            ids.forEach((id, index) => {
              const value = translated[index];
              if (value && value.trim()) byEntry.set(id, value);
            });
            if (byEntry.size > 0) prefetched.set(locale, byEntry);
          }
        } else {
          // The FIELD path. Its prompt is keyed by field name, so the locales
          // that need the same field set are asked together; a locale whose set
          // differs gets its own call rather than a merged payload that would
          // write a field into a language that did not ask for it.
          const bySignature = new Map<string, { locales: string[]; fields: Record<string, string> }>();
          for (const [locale, list] of candidates) {
            const fields: Record<string, string> = {};
            for (const entry of list) fields[keyToField[entry.key]] = entry.primaryValue;
            const signature = Object.keys(fields).sort().join("\u0000");
            const group = bySignature.get(signature) ?? { locales: [], fields };
            group.locales.push(locale);
            bySignature.set(signature, group);
          }
          for (const group of bySignature.values()) {
            if (group.locales.length < 2) continue;
            const instructions = buildTranslateInstructions(
              getInstructionWithDefault(aiInstructions, "translateInstructions"),
              translationMode,
              Object.keys(group.fields),
              { limits: (aiSettings?.seoLimits ?? null) as Record<string, number> | null },
            );
            // A locale that tracks its OWN keywords keeps its own request, and
            // is simply left out of the batch. `translateProduct` takes ONE
            // keyword clause for the whole call and that clause is phrased for a
            // single language ("phrase the translation so this keyword
            // appears"), so sending it with several languages would either
            // apply one language's keywords to all of them or drop them. The
            // loop below still asks per locale for those — and they are the
            // minority, because most locales track nothing.
            const plain: string[] = [];
            await Promise.all(
              group.locales.map(async (locale) => {
                const clause = await keywordDirectiveFor(
                  shop,
                  resourceId,
                  locale,
                  aiSettings?.keywordAwareTranslation ?? true,
                );
                if (!clause) plain.push(locale);
              }),
            );
            if (plain.length < 2) continue;

            // `translateProduct` is the SAME call the loop below makes, with the
            // full locale list instead of `[locale]`: its prompt already builds
            // a nested JSON skeleton for every requested language and says "from
            // the source language", so nothing about the wording changes and no
            // source locale has to be invented here (the field path never had
            // one). What it does NOT have is chunking, so the locales are cut
            // with the shared planner — one request for a short field set, one
            // per language for a long one, groups of two or three in between.
            const groupChars = Object.values(group.fields).reduce((a, v) => a + v.length, 0);
            for (const localeChunk of planLocaleChunks(plain, groupChars)) {
              const batched = await translationService.translateProduct(
                group.fields,
                localeChunk,
                contentKind,
                instructions,
              );
              for (const locale of localeChunk) {
                const fields = batched[locale];
                if (!fields) continue;
                const byEntry = new Map<string, string>();
                for (const entry of candidates.get(locale) ?? []) {
                  const value = fields[keyToField[entry.key]];
                  if (value && value.trim()) byEntry.set(entryId(entry), value);
                }
                if (byEntry.size > 0) prefetched.set(locale, byEntry);
              }
            }
          }
        }
      }
    } catch (prefetchError: unknown) {
      // Never fatal: the loop below still has its per-locale path, which is
      // exactly what this replaced. An auth error surfaces there instead, on the
      // first locale, the way it always did.
      logger.warn("[StaleTranslations] Cross-locale batch failed — falling back to per-locale", {
        context: "StaleTranslations",
        shop,
        resourceId,
        error: prefetchError instanceof Error ? prefetchError.message : String(prefetchError),
      });
    }

    let processed = 0;
    for (const [locale, localeEntries] of byLocale) {
      // The merchant edited this resource's translations while we were
      // working: their value is newer than anything this run decided. Abandon
      // the remaining locales — the untouched entries stay out of BOTH lists,
      // so nothing re-translates them and nothing purges them.
      if (supersededByMerchant()) {
        logger.info("[StaleTranslations] Re-translation abandoned — merchant saved in the meantime", {
          context: "StaleTranslations",
          shop,
          resourceId,
        });
        break;
      }
      // The generic path keys the AI's answer by ENTRY INDEX, not by a field
      // name: two option values can legitimately hold the same text, and a
      // name-keyed map would silently collapse them into one write.
      // An entry whose OWN resource the merchant has written since this run
      // started is left alone entirely — not translated, and not pushed into
      // `failed`, because that list is purged and their value is newer than
      // anything decided here.
      const untouched = localeEntries.filter(
        (entry) => !supersededByMerchant(entry.resourceId ?? resourceId),
      );
      const translatable = asValues
        ? untouched
        : untouched.filter((entry) => {
            if (keyToField[entry.key]) return true;
            undelivered(entry);
            return false;
          });
      if (translatable.length === 0) continue;

      try {
        let translatedFor: (entry: StaleTranslation, index: number) => string | undefined;
        // The cross-locale batch above already answered this locale — read it
        // back per ENTRY and make no request at all. A locale it could not
        // answer (its chunk failed, it carries its own keywords, it was the
        // only candidate) falls through to the per-locale paths below, which is
        // exactly what this replaced.
        const ready = prefetched.get(locale);
        if (ready && translatable.every((entry) => ready.has(entryId(entry)))) {
          translatedFor = (entry) => ready.get(entryId(entry));
        } else if (asValues) {
          // CHUNKED: `translateBatchValues` numbers every value into ONE
          // prompt, and a product can carry sixty metafields. A single
          // oversized request is the failure this avoids — and because the
          // answer is mapped back by index, the chunks have to be concatenated
          // in order, never merged by value.
          const values: string[] = [];
          for (const group of chunk(translatable, VALUE_BATCH)) {
            let part: string[] = [];
            try {
              part = await translationService.translateValues(
                group.map((entry) => entry.primaryValue),
                asValues.sourceLocale,
                locale,
                asValues.context,
                valueInstructions,
              );
            } catch (chunkError: unknown) {
              // Caught PER CHUNK. `translateBatchValues` throws on a length
              // mismatch, and letting that reach the locale's own catch would
              // discard every chunk already translated and purge all of them —
              // ninety-five translations lost over one malformed reply instead
              // of forty. This chunk's entries stay empty, which routes exactly
              // them to the removal.
              logger.warn("[StaleTranslations] A value chunk failed — its entries fall to removal", {
                context: "StaleTranslations",
                shop,
                resourceId,
                locale,
                entries: group.length,
                error: chunkError instanceof Error ? chunkError.message : String(chunkError),
              });
            }
            // A short answer would silently shift every later chunk's mapping,
            // so it is padded to the length it was asked for; the missing ones
            // read as untranslated and fall through to the removal.
            for (let i = 0; i < group.length; i++) values.push(part[i] ?? "");
          }
          translatedFor = (_entry, index) => values[index];
        } else {
          const fields: Record<string, string> = {};
          for (const entry of translatable) fields[keyToField[entry.key]] = entry.primaryValue;
          const instructions = buildTranslateInstructions(
            getInstructionWithDefault(aiInstructions, "translateInstructions"),
            translationMode,
            Object.keys(fields),
            { limits: (aiSettings?.seoLimits ?? null) as Record<string, number> | null },
          );
          const result = await translationService.translateProduct(
            fields,
            [locale],
            contentKind,
            instructions,
            await keywordDirectiveFor(shop, resourceId, locale, aiSettings?.keywordAwareTranslation ?? true),
          );
          const translated = result[locale] || {};
          translatedFor = (entry) => translated[keyToField[entry.key]];
        }

        const writes: Array<{
          entry: StaleTranslation;
          input: { key: string; value: string; locale: string; translatableContentDigest: string };
        }> = [];
        for (const [index, entry] of translatable.entries()) {
          let value = translatedFor(entry, index);
          if (isHandleEntry(entry)) {
            // The generic translate prompt writes PROSE — "Kumiko Schatulle",
            // possibly with an article, a capital and an umlaut. A handle is a
            // slug, so every value goes through the same sanitiser the bulk
            // translate page uses, and one that cannot be normalised at all
            // (a non-Latin answer collapses to "" under an ASCII sanitiser) is
            // DISCARDED rather than written.
            value = sanitizeSlug(value ?? "");
            // The duplicate-slug guard both other write paths carry (the single
            // editor skips such a value, the bulk editor fails the cell): a
            // handle translation identical to the primary handle causes routing
            // conflicts across locales. The AI answering with the primary slug
            // is the likeliest way one gets written unattended — and the entry
            // then falls to the kept list, so the working old handle stays.
            const primaryHandle =
              handleContexts.get(tripleKey(refOf(params, entry).resourceId, locale, entry.key))
                ?.primaryHandle ?? "";
            if (primaryHandle && value === sanitizeSlug(primaryHandle)) value = "";
            if (!value && entry.digest) discardedHandles.push(entry);
          }
          if (!value || !value.trim() || !entry.digest) {
            undelivered(entry);
            continue;
          }
          writes.push({
            entry,
            input: {
              key: entry.key,
              value,
              locale,
              translatableContentDigest: entry.digest,
            },
          });
        }
        if (writes.length === 0) continue;

        // `translationsRegister` addresses ONE resource, so a group spanning
        // several (a product's options, option values and metafields) writes
        // once per resource — still one AI request for the whole locale.
        const byResource = new Map<string, { ref: TranslationRef; writes: typeof writes }>();
        for (const write of writes) {
          const ref = refOf(params, write.entry);
          const group = byResource.get(ref.resourceId) ?? { ref, writes: [] };
          group.writes.push(write);
          byResource.set(ref.resourceId, group);
        }

        for (const { ref, writes: resourceWrites } of byResource.values()) {
          // Re-checked HERE, not only at the top of the locale: a translation
          // save can land while the AI request for this very locale is in
          // flight — a menu rename plus its English title in one save is
          // exactly that — and with one locale the outer check never runs
          // again. Stopping before the write is the whole point of the rule.
          if (supersededByMerchant(ref.resourceId)) {
            logger.info("[StaleTranslations] Merchant saved mid-locale — not registering this resource", {
              context: "StaleTranslations",
              shop,
              resourceId: ref.resourceId,
              locale,
            });
            continue;
          }
          const { confirmedKeys, confirmedValues } = await registerAndVerify(
            gateway,
            ref.resourceId,
            resourceWrites.map((w) => w.input),
          );
          for (const { entry, input } of resourceWrites) {
            if (!confirmedKeys.has(input.key)) {
              // Shopify did not echo it back — treat it exactly like a failed
              // translation so the stale row is purged instead of being left
              // behind on the strength of an unverified write.
              undelivered(entry);
              continue;
            }
            // Shopify has CONFIRMED this write, so the entry is registered no
            // matter what the local mirror does. A DB error here must not push
            // it into `failed` — that list is purged, and purging a translation
            // Shopify just verified because our own database blinked is the one
            // outcome that loses merchant content. The next sync re-reads it
            // from Shopify anyway.
            registered.push(entry);
            // What Shopify STORED. For a `handle` that is load-bearing beyond
            // this write: the mirror row is where the NEXT repair reads the
            // "previous translated handle" its redirect is built from, so a
            // value Shopify normalised differently would later produce a
            // redirect FROM a path that was never live.
            const stored = confirmedValues.get(input.key) ?? input.value;
            if (isHandleEntry(entry)) {
              // The old foreign URL owes a redirect, and it is created from the
              // slug Shopify STORED, never the one submitted — the generic
              // write path silently skips a handle translation equal to the
              // primary handle, so a submitted value can describe an edit that
              // never happened (CLAUDE.md).
              const covered = await createHandleRedirect(
                gateway,
                params,
                handleContexts.get(tripleKey(ref.resourceId, locale, input.key)),
                stored,
              );
              if (!covered) redirectsMissing++;
            }
            try {
              await mirror.write(
                ref,
                locale,
                input.key,
                isHandleEntry(entry) ? stored : input.value,
                input.translatableContentDigest,
              );
            } catch (mirrorError: unknown) {
              const message =
                mirrorError instanceof Error ? mirrorError.message : String(mirrorError);
              notMirrored.push({
                resourceId: ref.resourceId,
                locale,
                key: input.key,
                error: message,
              });
              logger.warn("[StaleTranslations] Registered on Shopify but not mirrored locally", {
                context: "StaleTranslations",
                shop,
                resourceId: ref.resourceId,
                locale,
                key: input.key,
                error: message,
              });
            }
          }
        }
      } catch (error: unknown) {
        logger.warn("[StaleTranslations] Auto-translation failed — falling back to removal", {
          context: "StaleTranslations",
          shop,
          resourceId,
          locale,
          error: error instanceof Error ? error.message : String(error),
        });
        for (const entry of localeEntries) {
          if (registered.includes(entry) || failed.includes(entry) || keptHandles.includes(entry)) {
            continue;
          }
          // Through `undelivered`, so a `handle` lands in the kept list rather
          // than in the one the caller purges: a provider error must not delete
          // a working foreign URL.
          undelivered(entry);
        }
      }

      processed += localeEntries.length;
      await db.task
        .update({
          where: { id: task.id },
          data: {
            processed,
            progress: Math.min(99, 10 + Math.round((processed / entries.length) * 89)),
          },
        })
        .catch(() => undefined);
    }

    // A run that could not register a single translation (no API key, provider
    // down, nothing echoed back) is a FAILED run — reporting it as completed
    // would hide the reason the merchant's fields came back untranslated. The
    // entries themselves are already queued for the purge either way.
    //
    // Standing down because the MERCHANT wrote is not that: the run did exactly
    // what it should, and a red task blaming it for their own save is a defect
    // report about nothing.
    const stoodDown =
      registered.length === 0 &&
      failed.length === 0 &&
      keptHandles.length === 0 &&
      supersededByMerchant();
    // A run whose only undelivered entries are handles the slug rules threw
    // away ON PURPOSE did what it should: leaving the working old URL alone is
    // the designed outcome, and a red task for it is a defect report about
    // nothing. A handle kept for a TRANSIENT reason still counts as a failure.
    const onlyDeliberateDiscards =
      registered.length === 0 &&
      failed.length === 0 &&
      keptHandles.length > 0 &&
      keptHandles.every((entry) => discardedHandles.includes(entry));
    await acknowledgeKeptHandles(params, discardedHandles);
    const succeeded = registered.length > 0 || stoodDown || onlyDeliberateDiscards;
    // A run that registered on Shopify but could not write some of those rows
    // locally is NOT a clean success: every editor in this app reads the
    // mirror, so those translations are live and invisible.
    const status = succeeded
      ? notMirrored.length > 0 || redirectsMissing > 0
        ? "completed_with_errors"
        : "completed"
      : "failed";
    await db.task.update({
      where: { id: task.id },
      data: {
        status,
        progress: 100,
        processed: entries.length,
        completedAt: new Date(),
        ...(registered.length === 0 && !stoodDown && !onlyDeliberateDiscards
          ? // A CODE, like its sibling below: this runs detached from the
            // request that started it and has no merchant locale, so an
            // English sentence stored here reaches a German merchant in
            // English. `taskErrorText` renders it.
            { error: "translations_none_usable" }
          : redirectsMissing > 0
            ? // Before the mirror code: a dead link on the storefront outranks
              // a field this app shows empty until the next reload.
              { error: `handle_redirects_missing:${redirectsMissing}` }
          : notMirrored.length > 0
            ? // A machine CODE, not a sentence: this runs detached from the
              // request that started it and has no merchant locale, and the
              // raw exception behind it (a Prisma message, a GID) is for the
              // log, never for the Tasks tab. `taskErrorText` renders it.
              { error: `translations_not_mirrored:${notMirrored.length}` }
            : {}),
        result: JSON.stringify({
          retranslated: registered.length,
          purged: failed.length,
          // Reported rather than folded into `purged`: these are the opposite
          // of a purge — a handle translation deliberately left standing.
          ...(keptHandles.length > 0 ? { handlesKept: keptHandles.length } : {}),
          ...(notMirrored.length > 0 ? { notMirrored: notMirrored.length } : {}),
          ...(redirectsMissing > 0 ? { redirectsMissing } : {}),
        }),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: message.substring(0, 1000) },
      })
      .catch(() => undefined);
    logger.warn("[StaleTranslations] Auto-translation run failed", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: message,
    });
    for (const entry of entries) {
      if (registered.includes(entry) || failed.includes(entry) || keptHandles.includes(entry)) {
        continue;
      }
      // Through `undelivered`, not straight into `failed`: this sweep is what
      // decides the fate of everything the run did not reach, and a `handle`
      // swept into the purge is the broken foreign URL the whole option exists
      // to avoid.
      undelivered(entry);
    }
  }

  return { registered, failed, kept: keptHandles };
}

/**
 * The keyword-aware clause for ONE target locale, or undefined when the shop
 * switched that off or tracks no keyword for it. Without this the auto
 * re-translation would be the ONE translate path in the app that ignores
 * `AISettings.keywordAwareTranslation` — and the glossary (applied inside
 * translateFields) would be honoured while the keywords silently were not.
 */
async function keywordDirectiveFor(
  shop: string,
  resourceId: string,
  locale: string,
  keywordAwareTranslation: boolean,
): Promise<string | undefined> {
  if (!keywordAwareTranslation) return undefined;
  try {
    const { db } = await import("../../db.server");
    const { getItemKeywords } = await import("../seo/keywords.service");
    const { keywordTranslationDirective } = await import("../seo/keyword-translation-prompt");
    const { localeName } = await import("../../../src/services/ai.service");
    const rows = await getItemKeywords(db, shop, resourceId, locale);
    const primary = rows.find((r) => r.role === "primary")?.keyword ?? null;
    if (!primary) return undefined;
    return (
      keywordTranslationDirective({
        locale,
        localeName: localeName(locale),
        primary,
        secondaries: rows.filter((r) => r.role === "secondary").map((r) => r.keyword),
      }) || undefined
    );
  } catch {
    // A keyword lookup must never cost the merchant the translation — worst
    // case this locale is translated the literal way (same rule as
    // shopify-content.service.ts).
    return undefined;
  }
}

/**
 * translation key → UI field name, first field wins. `body_html` maps back to
 * `description` (and ShopPolicy's `body` likewise) because the AI prompt
 * labels fields by that name and `sanitizePromptInput` allows newlines for it.
 */
function invertFieldMap(map: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, key] of Object.entries(map)) {
    if (out[key] === undefined) out[key] = field;
  }
  return out;
}
