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

import { logger } from "../../utils/logger.server";
import {
  markTranslationSaved,
  isTranslationRecentlySaved,
  translationSavedAt,
} from "../../utils/translation-save-lock.server";
// One shape for "walk past this override", shared with every save path.
import { marketOverrideKey } from "./market-layer-purge.server";
import { ShopifyApiGateway } from "../shopify-api-gateway.service";
import type { ShopifyGraphQLClient } from "../sync-types";
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
  partitionStaleTranslations,
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
   * The merchant-facing kind, used for BOTH the AI prompt and the Task row.
   * These four strings are the ones `AIService.translateFields` recognises AND
   * the ones the Tasks tab maps to a label and a Shopify admin link — an
   * article is a "blog" to both. Passing the Shopify resource type here (the
   * capitalised one) silently degrades the prompt to "product fields" and
   * leaves the task without a link.
   */
  contentKind: "product" | "collection" | "blog" | "page";
  /**
   * What goes into `Task.resourceType`, when that is NOT the same question as
   * the AI prompt's kind. The Tasks tab maps this to a Shopify admin path and
   * deliberately yields NO link for a type its map does not list — so a
   * metaobject must not travel as "page", or the row offers
   * `/admin/pages/<metaobject id>`, the guessed broken URL that map exists to
   * prevent. Defaults to `contentKind`, which is right wherever the two agree.
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
 * Two things make it its own mirror. The row is keyed by the ProductImage CACHE
 * id, not by the MediaImage GID Shopify is addressed with, so the caller hands
 * the map between them; and the table has no `key` column at all, because a
 * MediaImage has exactly one translatable key (`alt`) — the key argument is
 * therefore accepted and ignored rather than written.
 *
 * It has no `digest` column either. That costs nothing here: the digest is only
 * needed to REGISTER on Shopify, and this path reads a fresh one for every
 * write (CLAUDE.md — the mirror's digest is a sync-side detection baseline, and
 * this surface has no sync-side detection).
 */
export function productImageAltMirror(
  /** MediaImage GID → ProductImage cache row id. */
  imageIdByMedia: ReadonlyMap<string, string>,
): TranslationMirror {
  const mediaByImageId = new Map([...imageIdByMedia].map(([media, image]) => [image, media]));
  return {
    async existing(refs, foreignLocales) {
      const imageIds = refs
        .map((ref) => imageIdByMedia.get(ref.resourceId))
        .filter((id): id is string => !!id);
      if (imageIds.length === 0) return [];
      const { db } = await import("../../db.server");
      const rows = await db.productImageAltTranslation.findMany({
        where: { imageId: { in: imageIds }, marketId: "", locale: { in: [...foreignLocales] } },
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
      const imageId = imageIdByMedia.get(ref.resourceId);
      if (!imageId) return;
      const { db } = await import("../../db.server");
      await db.productImageAltTranslation.deleteMany({ where: { imageId, locale, marketId: "" } });
    },
    async marketRows(refs, foreignLocales) {
      const imageIds = refs
        .map((ref) => imageIdByMedia.get(ref.resourceId))
        .filter((id): id is string => !!id);
      if (imageIds.length === 0) return [];
      const { db } = await import("../../db.server");
      const rows = await db.productImageAltTranslation.findMany({
        where: {
          imageId: { in: imageIds },
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
      const imageId = imageIdByMedia.get(ref.resourceId);
      if (!imageId) return;
      const { db } = await import("../../db.server");
      await db.productImageAltTranslation.deleteMany({ where: { imageId, locale, marketId } });
    },
    async write(ref, locale, _key, value) {
      const imageId = imageIdByMedia.get(ref.resourceId);
      if (!imageId) return;
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
 * Detect and repair stale foreign translations for ONE resource.
 *
 * BEST-EFFORT by contract: the sync it hangs off has already written the
 * cache, so every failure here is logged and swallowed. A stale row left
 * behind is the pre-existing behaviour; a thrown error would turn a working
 * webhook into a retry loop.
 */
export async function reconcileStaleTranslations(params: ReconcileParams): Promise<ReconcileResult> {
  const { shop, resourceId, resourceType, translations, primaryContent, previousDigests } = params;

  try {
    // Same guard the sync's own translation rewrite uses: right after this app
    // wrote translations for the resource, Shopify's read-back is not reliably
    // consistent yet, and acting on it could delete what the merchant just
    // saved. A genuinely stale row is caught by the next change event.
    if (isTranslationRecentlySaved(resourceId)) return NOTHING;

    // Detection runs FIRST and without the fill, because it is pure and the
    // policy read is a database round trip: a resource where nothing moved —
    // which is nearly every webhook — must not pay for one. The fill can only
    // ADD locales to keys this pass already proved, so an empty answer here is
    // an empty answer with it too.
    let stale = findStaleTranslations(translations, primaryContent, previousDigests);
    if (stale.length === 0) return NOTHING;

    const policy = await loadTranslationChangePolicy(shop);
    if (!policy.purgeOnPrimaryChange && !policy.autoTranslateExternalChanges) return NOTHING;

    // Now that the switch is known: translate the proven keys into the locales
    // that hold nothing yet as well. Same input, same gate — the second call is
    // pure and in-memory, and re-running it is what keeps the cheap exit above.
    if (policy.autoTranslateExternalChanges && params.foreignLocales?.length) {
      stale = findStaleTranslations(translations, primaryContent, previousDigests, {
        fillLocales: params.foreignLocales,
        anyKey: !!params.translateAs,
      });
    }

    logger.info("[StaleTranslations] Primary text changed outside the editor — reconciling", {
      context: "StaleTranslations",
      shop,
      resourceId,
      resourceType,
      stale: stale.length,
      purge: policy.purgeOnPrimaryChange,
      autoTranslate: policy.autoTranslateExternalChanges,
    });

    return await repairStaleTranslations(params, stale, policy, {
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
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Reconciliation failed — stale rows kept", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOTHING;
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
 * Product and Collection are deliberately ABSENT: their update webhook already
 * runs the sync-side reconciliation, and starting a second run from the save
 * would queue a duplicate AI run behind it (the in-flight map never drops one)
 * for a repair that has already happened.
 */
export const IN_APP_RETRANSLATED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "Page",
  "Article",
  "Blog",
  "ShopPolicy",
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
 */
const VALUE_BATCH = 40;

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
          if (classifyStaleTranslation(candidate, true, { anyKey: !!params.translateAs }) === "retranslate") {
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

    return await repairStaleTranslations(params, stale, policy, {
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
  const { retranslate, purge, declined } = partitionStaleTranslations(
    stale,
    policy.autoTranslateExternalChanges,
    // The content-field allowlist exists to keep `handle` out. A surface that
    // translates bare values has no `handle` and no field vocabulary at all —
    // applying the list there would re-translate nothing while reporting that
    // it had.
    { anyKey: !!target.translateAs },
  );

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
    declined
      .filter((entry) => !toPurge.includes(entry))
      .map((entry) => entry.key),
  );
  for (const entry of [...retranslate, ...toPurge]) keptDeclinedKeys.delete(entry.key);
  const marketKeys = scope.keys.filter((key) => !keptDeclinedKeys.has(key));

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

  return { removed, retranslating: startRetranslation ? retranslate.length : 0 };
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
      await mirror.remove(ref, locale, confirmed);
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
): Promise<RetranslateOutcome> {
  try {
    return await runRetranslation(gateway, params, entries, supersededByMerchant);
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Re-translation could not start — stale rows kept", {
      context: "StaleTranslations",
      shop: params.shop,
      resourceId: params.resourceId,
      entries: entries.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { registered: [], failed: [], startFailed: true };
  }
}

async function runRetranslation(
  gateway: ShopifyApiGateway,
  params: RepairTarget,
  entries: readonly StaleTranslation[],
  supersededByMerchant: (entryResourceId?: string) => boolean,
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
      shop,
      type: "translation",
      status: "running",
      // The Tasks tab maps this to a label and a Shopify admin link, and it
      // speaks the merchant-facing kind, not the Shopify resource type.
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
            failed.push(entry);
            return false;
          });
      if (translatable.length === 0) continue;

      try {
        let translatedFor: (entry: StaleTranslation, index: number) => string | undefined;
        if (asValues) {
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
          const value = translatedFor(entry, index);
          if (!value || !value.trim() || !entry.digest) {
            failed.push(entry);
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
          const { confirmedKeys } = await registerAndVerify(
            gateway,
            ref.resourceId,
            resourceWrites.map((w) => w.input),
          );
          for (const { entry, input } of resourceWrites) {
            if (!confirmedKeys.has(input.key)) {
              // Shopify did not echo it back — treat it exactly like a failed
              // translation so the stale row is purged instead of being left
              // behind on the strength of an unverified write.
              failed.push(entry);
              continue;
            }
            // Shopify has CONFIRMED this write, so the entry is registered no
            // matter what the local mirror does. A DB error here must not push
            // it into `failed` — that list is purged, and purging a translation
            // Shopify just verified because our own database blinked is the one
            // outcome that loses merchant content. The next sync re-reads it
            // from Shopify anyway.
            registered.push(entry);
            try {
              await mirror.write(ref, locale, input.key, input.value, input.translatableContentDigest);
            } catch (mirrorError: unknown) {
              logger.warn("[StaleTranslations] Registered on Shopify but not mirrored locally", {
                context: "StaleTranslations",
                shop,
                resourceId: ref.resourceId,
                locale,
                key: input.key,
                error: mirrorError instanceof Error ? mirrorError.message : String(mirrorError),
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
          if (!registered.includes(entry) && !failed.includes(entry)) failed.push(entry);
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
    const stoodDown = registered.length === 0 && failed.length === 0 && supersededByMerchant();
    await db.task.update({
      where: { id: task.id },
      data: {
        status: registered.length > 0 || stoodDown ? "completed" : "failed",
        progress: 100,
        processed: entries.length,
        completedAt: new Date(),
        ...(registered.length === 0 && !stoodDown
          ? { error: "Automatic re-translation produced no usable translation." }
          : {}),
        result: JSON.stringify({ retranslated: registered.length, purged: failed.length }),
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
      if (!registered.includes(entry) && !failed.includes(entry)) failed.push(entry);
    }
  }

  return { registered, failed };
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
