/**
 * Shopify Content Service
 * Centralized service for managing Shopify content via GraphQL API
 */

import { TRANSLATE_CONTENT, UPDATE_PAGE, UPDATE_ARTICLE, UPDATE_SHOP_POLICY, UPDATE_COLLECTION, UPDATE_BLOG, METAFIELDS_DELETE } from "../../app/graphql/content.mutations";
import { GET_TRANSLATIONS, GET_TRANSLATABLE_CONTENT, GET_MARKETS } from "../../app/graphql/content.queries";
import { loggers } from '../../app/utils/logger.server';
import { markTranslationSaved } from '../../app/utils/translation-save-lock.server';
import { isAuthError, localeName } from './ai.service';
import { attributeInputFor as buildAttributeInput } from '../../app/services/content-attributes.shared';
import {
  keywordTranslationDirective,
  keywordTranslationDirectiveMulti,
  type LocaleKeywords,
} from '../../app/services/seo/keyword-translation-prompt';
import type { PrismaClient } from "@prisma/client";
import type { MarketInfo } from "../../app/types/content-editor.types";

export interface ShopifyAdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

/**
 * UI field name → Shopify translatable-content key — THE canonical map.
 *
 * IMPORTANT — Shopify is inconsistent with body field naming:
 *   Product, Collection, Page, Article → translation key is "body_html"
 *   ShopPolicy                         → translation key is "body"
 *
 * This is a Shopify API inconsistency: the GraphQL *mutation* input for Page
 * and Article also uses "body", but the *translatable content* key (used in
 * translationsRegister and returned by the translatableContent query) is
 * "body_html". ShopPolicy is the only resource type where both mutation and
 * translation key use plain "body" — resolve that one exception via
 * fieldTranslationKeyMap(resourceType).
 *
 * This constant used to exist as three inline copies inside this file (Plan
 * §6.1: "a third copy would be the bug that surfaces later") — every caller,
 * including the bulk editor (app/services/bulk-editor/translations.server.ts),
 * must use this export instead of re-declaring the mapping.
 *
 * See also: docs/reference/SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md
 */
export const FIELD_TO_TRANSLATION_KEY: Readonly<Record<string, string>> = {
  title: 'title',
  description: 'body_html',
  body: 'body_html',
  handle: 'handle',
  seoTitle: 'meta_title',
  metaDescription: 'meta_description',
  productType: 'product_type',
  summary: 'summary_html',
};

/** The field→key map with the single ShopPolicy exception applied
 * (description/body → "body" instead of "body_html"). */
export function fieldTranslationKeyMap(resourceType: string): Readonly<Record<string, string>> {
  if (resourceType !== 'ShopPolicy') return FIELD_TO_TRANSLATION_KEY;
  return { ...FIELD_TO_TRANSLATION_KEY, description: 'body', body: 'body' };
}

export class ShopifyContentService {
  private admin: ShopifyAdminClient;

  constructor(admin: ShopifyAdminClient) {
    this.admin = admin;
  }

  /**
   * Load translations for a specific resource and locale.
   *
   * @param marketId Market GID for market-specific translations; "" (default) =
   *                 global layer. Mirrors the marketId param on saveTranslations.
   */
  async loadTranslations(resourceId: string, locale: string, marketId: string = "") {
    const response = await this.admin.graphql(GET_TRANSLATIONS, {
      variables: { resourceId, locale, marketId: marketId || null }
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in loadTranslations: ${data.errors[0].message}`);
    }
    return data.data?.translatableResource?.translations || [];
  }

  /**
   * Load translatable content with digests for a resource
   */
  async loadTranslatableContent(resourceId: string) {
    const response = await this.admin.graphql(GET_TRANSLATABLE_CONTENT, {
      variables: { resourceId }
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in loadTranslatableContent: ${data.errors[0].message}`);
    }
    const content = data.data?.translatableResource?.translatableContent || [];

    // Create digest map and value map for quick lookup
    const digestMap: Record<string, string> = {};
    const valueMap: Record<string, string> = {};
    content.forEach((item: { key: string; digest: string; value?: string }) => {
      digestMap[item.key] = item.digest;
      if (item.value) valueMap[item.key] = item.value;
    });

    // Diagnostic: log all returned keys with digest presence
    loggers.translation('debug', `Resource ${resourceId} - returned ${content.length} translatable fields`, { fields: content.map((c: { key: string; digest?: string; value?: string }) => `${c.key}=${c.digest ? 'HAS_DIGEST' : 'NO_DIGEST'}(val=${c.value ? c.value.substring(0, 30) : 'EMPTY'})`) });

    return { digestMap, valueMap };
  }

  /**
   * Save translations for a resource
   */
  async saveTranslations(
    resourceId: string,
    translations: Array<{ key: string; value: string; locale: string }>,
    /** Market GID for a market-specific override; "" (default) = global (all markets). */
    marketId: string = "",
  ) {
    // Fetch digest map first
    const { digestMap } = await this.loadTranslatableContent(resourceId);

    // Add digests to translations, filtering out any without a valid digest.
    // When a market is selected, fold marketId onto each TranslationInput so
    // Shopify stores a market-specific override (omitting it = all markets/global).
    const translationsWithDigests = translations
      .map(t => ({
        ...t,
        translatableContentDigest: digestMap[t.key],
        ...(marketId ? { marketId } : {}),
      }))
      .filter(t => {
        if (!t.translatableContentDigest) {
          loggers.translation('warn', `[saveTranslations] No digest for key '${t.key}' — skipping Shopify save for this field`);
          return false;
        }
        return true;
      });

    if (translationsWithDigests.length === 0) {
      loggers.translation('warn', '[saveTranslations] No translations with valid digests to save');
      return [];
    }

    const response = await this.admin.graphql(TRANSLATE_CONTENT, {
      variables: {
        resourceId,
        translations: translationsWithDigests
      }
    });

    const data = await response.json();

    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in saveTranslations: ${data.errors[0].message}`);
    }
    if (data.data?.translationsRegister?.userErrors?.length > 0) {
      throw new Error(data.data.translationsRegister.userErrors[0].message);
    }

    return data.data?.translationsRegister?.translations || [];
  }

  /**
   * Delete metafields by identifier.
   *
   * Setting a SEO metafield (global.title_tag / global.description_tag) to
   * `value: ""` does NOT clear it on Shopify — it must be deleted by identifier.
   * Deleting a metafield that doesn't exist is a no-op.
   *
   * NEVER throws: this runs inside updatePage/updateBlog/updateArticle AFTER the
   * main update mutation has already landed, and the caller mirrors the save to
   * the DB AFTER this returns. A thrown error here would leave Shopify updated
   * but the DB un-mirrored (and the cleared metafield still present). Instead we
   * log transport errors, GraphQL errors, and userErrors; a lingering metafield
   * self-heals on the next reload/sync. Returns true when the delete was
   * confirmed clean, false otherwise (for future partial-success surfacing).
   */
  private async deleteMetafields(ownerId: string, identifiers: Array<{ namespace: string; key: string }>): Promise<boolean> {
    if (identifiers.length === 0) return true;

    try {
      const response = await this.admin.graphql(METAFIELDS_DELETE, {
        variables: {
          metafields: identifiers.map((i) => ({ ownerId, namespace: i.namespace, key: i.key })),
        },
      });

      const data = await response.json();
      if (data.errors?.length > 0) {
        loggers.translation('warn', '[deleteMetafields] GraphQL error while clearing metafields', {
          ownerId,
          identifiers,
          error: data.errors[0].message,
        });
        return false;
      }
      if (data.data?.metafieldsDelete?.userErrors?.length > 0) {
        loggers.translation('warn', '[deleteMetafields] userErrors while clearing metafields', {
          ownerId,
          identifiers,
          userErrors: data.data.metafieldsDelete.userErrors,
        });
        return false;
      }
      return true;
    } catch (error: unknown) {
      loggers.translation('warn', '[deleteMetafields] request failed while clearing metafields', {
        ownerId,
        identifiers,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Split SEO metafields into ones to SET (non-empty) and ones to DELETE (cleared).
   * `undefined` = not sent by the client → skip entirely.
   * `""` = user cleared it → delete the metafield (set-to-empty does not clear it).
   */
  private splitSeoMetafields(seoTitle?: string, seoDescription?: string) {
    const toSet: Array<{ namespace: string; key: string; value: string; type: string }> = [];
    const toDelete: Array<{ namespace: string; key: string }> = [];

    const route = (value: string | undefined, key: string) => {
      if (value === undefined) return;
      if (value === "") {
        toDelete.push({ namespace: "global", key });
      } else {
        toSet.push({ namespace: "global", key, value, type: "single_line_text_field" });
      }
    };

    route(seoTitle, "title_tag");
    route(seoDescription, "description_tag");
    return { toSet, toDelete };
  }

  /**
   * Update a page
   * Note: Shopify Admin API Page type has no `seo` field.
   * SEO data is stored in metafields: global.title_tag and global.description_tag.
   */
  async updatePage(id: string, page: {
    title?: string; handle?: string; body?: string; seoTitle?: string; seoDescription?: string;
    // PLAN §Phase 3 merchandising attributes. Not translatable — one value per
    // page — so they only ever arrive on a primary-locale save.
    isPublished?: boolean; templateSuffix?: string | null;
  }) {
    // Separate SEO fields from the page input – they go as metafields
    const { seoTitle, seoDescription, ...pageInput } = page;
    const { toSet: metafields, toDelete } = this.splitSeoMetafields(seoTitle, seoDescription);

    const response = await this.admin.graphql(UPDATE_PAGE, {
      variables: {
        id,
        page: {
          ...pageInput,
          ...(metafields.length > 0 ? { metafields } : {}),
        },
      }
    });

    const data = await response.json();

    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in updatePage: ${data.errors[0].message}`);
    }
    if (data.data?.pageUpdate?.userErrors?.length > 0) {
      throw new Error(data.data.pageUpdate.userErrors[0].message);
    }

    // Cleared SEO fields must be deleted — set-to-empty leaves the old value on Shopify.
    await this.deleteMetafields(id, toDelete);

    return data.data?.pageUpdate?.page;
  }

  /**
   * Update a blog (container, not article)
   * Note: Like Pages, Blog SEO data is stored in metafields (global.title_tag, global.description_tag).
   */
  async updateBlog(id: string, blog: {
    title?: string; handle?: string; seoTitle?: string; seoDescription?: string;
    templateSuffix?: string | null;
  }) {
    const { seoTitle, seoDescription, ...blogInput } = blog;
    const { toSet: metafields, toDelete } = this.splitSeoMetafields(seoTitle, seoDescription);

    const response = await this.admin.graphql(UPDATE_BLOG, {
      variables: {
        id,
        blog: {
          ...blogInput,
          ...(metafields.length > 0 ? { metafields } : {}),
        },
      }
    });

    const data = await response.json();

    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in updateBlog: ${data.errors[0].message}`);
    }
    if (data.data?.blogUpdate?.userErrors?.length > 0) {
      throw new Error(data.data.blogUpdate.userErrors[0].message);
    }

    // Cleared SEO fields must be deleted — set-to-empty leaves the old value on Shopify.
    await this.deleteMetafields(id, toDelete);

    return data.data?.blogUpdate?.blog;
  }

  /**
   * Update an article
   * Note: Like Pages/Blogs, Article SEO data is stored in metafields
   * (global.title_tag, global.description_tag), not a native `seo` field.
   */
  async updateArticle(id: string, article: {
    title?: string; handle?: string; body?: string; summary?: string; seoTitle?: string;
    seoDescription?: string; image?: { altText: string } | null;
    // PLAN §Phase 3. `author` is an AuthorInput on Shopify's side, not a
    // string — the caller passes the plain name and it is wrapped below.
    author?: string; tags?: string[]; isPublished?: boolean; templateSuffix?: string | null;
  }) {
    const { seoTitle, seoDescription, author, ...articleInput } = article;
    const { toSet: metafields, toDelete } = this.splitSeoMetafields(seoTitle, seoDescription);

    const response = await this.admin.graphql(UPDATE_ARTICLE, {
      variables: {
        id,
        article: {
          ...articleInput,
          // `author` is an AuthorInput, not a string. Sending the bare name
          // fails at the schema level — a top-level `errors` array with
          // `data: null`, which never reaches `userErrors` and would make the
          // whole save read as a success while nothing was written.
          ...(author !== undefined ? { author: { name: author } } : {}),
          ...(metafields.length > 0 ? { metafields } : {}),
        },
      }
    });

    const data = await response.json();

    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in updateArticle: ${data.errors[0].message}`);
    }
    if (data.data?.articleUpdate?.userErrors?.length > 0) {
      throw new Error(data.data.articleUpdate.userErrors[0].message);
    }

    // Cleared SEO fields must be deleted — set-to-empty leaves the old value on Shopify.
    await this.deleteMetafields(id, toDelete);

    return data.data?.articleUpdate?.article;
  }

  /**
   * Build a Shopify SEOInput that preserves the sub-field the caller did NOT send.
   *
   * Shopify's productUpdate/collectionUpdate treats `seo` as a unit: sending
   * `seo: { title }` without a description CLEARS the existing seo.description
   * (and vice versa). A normal full save sends both fields, but single-field
   * primary saves — e.g. the Accept & Translate flow that translates only the
   * meta title back into the primary locale — send just one side. For that
   * partial case we fetch the current live SEO and carry the missing half over.
   *
   * `undefined` means "not sent by the client"; `""` means "user cleared it".
   * Returns `null` when neither side was sent (caller should omit `seo` entirely).
   */
  private async buildPreservedSeo(
    resourceGid: string,
    seoTitle: string | undefined,
    seoDescription: string | undefined,
  ): Promise<{ title?: string; description?: string } | null> {
    const hasTitle = seoTitle !== undefined;
    const hasDescription = seoDescription !== undefined;
    if (!hasTitle && !hasDescription) return null;

    const seo: { title?: string; description?: string } = {
      title: seoTitle,
      description: seoDescription,
    };

    // Only one side sent → preserve the other from Shopify's current value.
    if (hasTitle !== hasDescription) {
      try {
        const response = await this.admin.graphql(
          `#graphql
            query getSeo($id: ID!) {
              node(id: $id) {
                ... on Collection { seo { title description } }
                ... on Product { seo { title description } }
              }
            }`,
          { variables: { id: resourceGid } }
        );
        const data = await response.json();
        const currentSeo = data.data?.node?.seo || {};
        if (!hasTitle) seo.title = currentSeo.title ?? undefined;
        if (!hasDescription) seo.description = currentSeo.description ?? undefined;
      } catch (error: unknown) {
        // On lookup failure, drop the missing side (JSON.stringify omits undefined)
        // rather than sending "" and clearing it — Shopify then leaves it unchanged.
        loggers.translation('warn', '[buildPreservedSeo] Failed to fetch current SEO for preservation', {
          resourceGid,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!hasTitle) seo.title = undefined;
        if (!hasDescription) seo.description = undefined;
      }
    }

    return seo;
  }

  /**
   * Update a collection
   */
  async updateCollection(id: string, collection: {
    title?: string; handle?: string; descriptionHtml?: string;
    seo?: { title?: string; description?: string }; image?: { altText: string };
    sortOrder?: string; templateSuffix?: string | null;
  }) {
    const response = await this.admin.graphql(UPDATE_COLLECTION, {
      variables: {
        input: {
          id,
          ...collection
        }
      }
    });

    const data = await response.json();

    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in updateCollection: ${data.errors[0].message}`);
    }
    if (data.data?.collectionUpdate?.userErrors?.length > 0) {
      throw new Error(data.data.collectionUpdate.userErrors[0].message);
    }

    return data.data?.collectionUpdate?.collection;
  }

  /**
   * §6.6 for the FEATURED-IMAGE ALT of a Collection or Article: its primary
   * value just changed, so every foreign alt translation of it now describes a
   * text that no longer exists.
   *
   * It needs its own pass because this alt is the THIRD translation shape
   * (CLAUDE.md): Shopify stores it as key `alt` on the image's OWN
   * CollectionImage/ArticleImage GID, while the mirror row sits on the PARENT
   * under `image_alt_text`. The generic field purge can address neither half.
   *
   * Same echo rule as everywhere else — a local row is deleted ONLY for a
   * locale Shopify CONFIRMS the removal for, because `translationsRemove` can
   * silently no-op and a DB that disagrees with Shopify is worse than a stale
   * row. Best-effort: never throws, because the primary save already happened.
   */
  private async invalidateFeaturedImageAltTranslations(params: {
    resourceId: string;
    resourceType: 'Collection' | 'Article';
    shop: string;
    db: PrismaClient;
    foreignLocales: readonly string[];
  }): Promise<void> {
    const { resourceId, resourceType, shop, db, foreignLocales } = params;
    if (foreignLocales.length === 0) return;
    try {
      // Sent for EVERY published foreign locale, not only the ones the local
      // mirror knows about. An alt text translated in Shopify's own editor (or
      // by another app) has no row here, and gating on the mirror would leave
      // exactly those live on the storefront describing an alt text that no
      // longer exists — the same reasoning the field path follows, which has
      // always removed blindly across the foreign locales. The echo then says
      // what was really there, and only that is deleted locally, so asking for
      // a locale that carries nothing costs one no-op and never a wrong delete.
      const imageResourceId = await this.fetchFeaturedImageResourceId(resourceId, resourceType);
      if (!imageResourceId) return;

      const locales = [...foreignLocales];
      const { ShopifyApiGateway } = await import("../../app/services/shopify-api-gateway.service");
      const { removeAndVerifyAcrossLocales, LOCALE_KEY_SEP } = await import(
        "../../app/services/bulk-editor/translations.server"
      );
      const gateway = new ShopifyApiGateway(this.admin, shop);
      const { confirmedPairs } = await removeAndVerifyAcrossLocales(
        gateway,
        imageResourceId,
        ['alt'],
        locales,
        "",
      );
      const confirmed = locales.filter((locale) => confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}alt`));
      if (confirmed.length === 0) return;

      await db.contentTranslation.deleteMany({
        where: {
          shop,
          resourceId,
          resourceType,
          key: 'image_alt_text',
          marketId: "",
          locale: { in: confirmed },
        },
      });
      loggers.translation('info', `[updateContent] Invalidated featured image alt translations`, {
        resourceId,
        resourceType,
        locales: confirmed,
      });
    } catch (err: unknown) {
      loggers.translation('warn', `[updateContent] Featured image alt invalidation failed — rows kept`, {
        resourceId,
        resourceType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The image's OWN translatable-resource GID. Shopify keys a
   * CollectionImage/ArticleImage by the IMAGE's id, never by the parent's — the
   * two are not convertible into each other (CLAUDE.md), so it has to be read
   * off the parent.
   */
  private async fetchFeaturedImageResourceId(
    resourceId: string,
    resourceType: 'Collection' | 'Article',
  ): Promise<string | null> {
    const fieldName = resourceType === 'Article' ? 'article' : 'collection';
    const response = await this.admin.graphql(
      `#graphql
        query getFeaturedImageId($id: ID!) {
          ${fieldName}(id: $id) {
            image { id }
          }
        }`,
      { variables: { id: resourceId } },
    );
    const payload = await response.json() as {
      data?: Record<string, { image?: { id?: string | null } | null } | null>;
      errors?: Array<{ message: string }>;
    };
    if (payload.errors?.length) throw new Error(payload.errors[0].message);
    return payload.data?.[fieldName]?.image?.id ?? null;
  }

  /**
   * Translate the featured-image alt text of an Article or Collection.
   *
   * In Shopify, Article/Collection image alt text is a SEPARATE translatable resource
   * (CollectionImage / ArticleImage), not part of the parent's translatable content.
   * Its GID is the IMAGE's own and is NOT derivable from the parent's numeric id
   * (CLAUDE.md) — `fetchFeaturedImageResourceId` reads it off the parent.
   *
   * Persists to the polymorphic `contentTranslation` table under the parent's resourceId
   * with key "image_alt_text" so the editor's loader can read it back.
   *
   * Empty `altText` removes the translation (Shopify + DB).
   * Returns { saved } so callers can compute failedLocales for partial-success UI.
   */
  async saveImageAltTextTranslation(params: {
    resourceId: string;
    resourceType: 'Article' | 'Collection';
    locale: string;
    altText: string;
    shop: string;
    db: PrismaClient;
  }): Promise<{ saved: boolean; reason?: 'no-digest' | 'shopify-error' | 'error' }> {
    const { resourceId, resourceType, locale, altText, shop, db } = params;
    try {
      // Shopify's *Image translatable resource is keyed by the image's OWN id
      // (e.g. gid://shopify/CollectionImage/1825168326988), NOT by the parent
      // collection/article id — ONE lookup, shared with the §6.6 invalidation
      // of the same translation, so the two can never address different images.
      const imageResourceId = await this.fetchFeaturedImageResourceId(resourceId, resourceType);

      if (!imageResourceId) {
        loggers.translation('warn', `[saveImageAltTextTranslation] ${resourceType} has no image.id — cannot translate alt text`, { resourceId });
        return { saved: false, reason: 'no-digest' };
      }

      const { digestMap: imageDigestMap } = await this.loadTranslatableContent(imageResourceId);
      const altDigest = imageDigestMap['alt'];

      if (altText.trim() === '') {
        if (altDigest) {
          await this.deleteAllTranslationsForKeys({
            resourceId: imageResourceId,
            translationKeys: ['alt'],
            foreignLocales: [locale],
          });
        }
        await db.contentTranslation.deleteMany({
          where: { shop, resourceId, resourceType, key: 'image_alt_text', locale, marketId: "" },
        });
        return { saved: true };
      }

      // Shopify is the source of truth for alt-text translations. If the
      // ArticleImage/CollectionImage translatable resource has no digest, or
      // Shopify rejects the translation, fail loudly — do NOT write locally,
      // otherwise the editor would show a value that does not exist on the
      // storefront and the next sync would be misleading.
      if (!altDigest) {
        loggers.translation('warn', `[saveImageAltTextTranslation] No 'alt' digest on ${resourceType} image translatable resource`, { imageResourceId });
        return { saved: false, reason: 'no-digest' };
      }

      const translateResponse = await this.admin.graphql(TRANSLATE_CONTENT, {
        variables: {
          resourceId: imageResourceId,
          translations: [{
            key: 'alt',
            value: altText,
            locale,
            translatableContentDigest: altDigest,
          }],
        },
      });
      const translateData = await translateResponse.json() as any;
      const userErrors = translateData.data?.translationsRegister?.userErrors || [];
      if (userErrors.length > 0) {
        loggers.translation('error', `[saveImageAltTextTranslation] Shopify userErrors`, { resourceType, errors: userErrors });
        return { saved: false, reason: 'shopify-error' };
      }

      await db.contentTranslation.upsert({
        where: { shop_resourceId_key_locale_marketId: { shop, resourceId, key: 'image_alt_text', locale, marketId: "" } },
        update: { value: altText, digest: altDigest, resourceType },
        create: { shop, resourceId, resourceType, key: 'image_alt_text', value: altText, locale, digest: altDigest },
      });
      return { saved: true };
    } catch (err: unknown) {
      loggers.translation('error', `[saveImageAltTextTranslation] Error translating ${resourceType} image alt`, {
        resourceId, locale, error: err instanceof Error ? err.message : String(err),
      });
      return { saved: false, reason: 'error' };
    }
  }

  /**
   * Update a shop policy
   */
  async updateShopPolicy(type: string, body: string) {
    const response = await this.admin.graphql(UPDATE_SHOP_POLICY, {
      variables: {
        shopPolicy: { type, body }
      }
    });

    const data = await response.json();

    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in updateShopPolicy: ${data.errors[0].message}`);
    }
    if (data.data?.shopPolicyUpdate?.userErrors?.length > 0) {
      throw new Error(data.data.shopPolicyUpdate.userErrors[0].message);
    }

    return data.data?.shopPolicyUpdate?.shopPolicy;
  }

  /**
   * Delete all translations for specific keys across all foreign locales
   */
  async deleteAllTranslationsForKeys(params: {
    resourceId: string;
    translationKeys: string[];
    foreignLocales: string[];
    /**
     * Market scope for the removal. "" (or undefined) = remove the GLOBAL
     * translation (marketIds omitted). Non-empty = remove only the
     * market-specific override for that market (marketIds: [marketId]); the
     * global translation survives.
     */
    marketId?: string;
  }) {
    const { resourceId, translationKeys, foreignLocales } = params;
    const marketId = params.marketId || "";

    if (translationKeys.length === 0 || foreignLocales.length === 0) {
      return { success: true };
    }

    loggers.translation('info', 'Deleting translations for keys', { translationKeys, foreignLocales, marketId: marketId || '(global)' });

    const response = await this.admin.graphql(
      `#graphql
        mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!, $marketIds: [ID!]) {
          translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales, marketIds: $marketIds) {
            userErrors {
              field
              message
            }
            translations {
              key
              locale
            }
          }
        }`,
      {
        variables: {
          resourceId,
          translationKeys,
          locales: foreignLocales,
          // Omit (null) for global removal; a single-element array for a
          // market-specific removal.
          marketIds: marketId ? [marketId] : null,
        },
      }
    );

    const data = await response.json();

    if (data.errors?.length > 0) {
      loggers.translation('error', 'GraphQL error in deleteAllTranslationsForKeys', { errors: data.errors });
      throw new Error(`GraphQL error: ${data.errors[0].message}`);
    }
    if (data.data?.translationsRemove?.userErrors?.length > 0) {
      loggers.translation('error', 'Error deleting translations', { errors: data.data.translationsRemove.userErrors });
      throw new Error(data.data.translationsRemove.userErrors[0].message);
    }

    loggers.translation('info', 'Successfully deleted translations');
    return { success: true };
  }

  /**
   * Load shop locales
   */
  async loadShopLocales() {
    const response = await this.admin.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            name
            primary
            published
          }
        }`
    );

    if (!response.ok) {
      throw new Error(`Shopify API error: HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in loadShopLocales: ${data.errors[0].message}`);
    }
    const shopLocales = data.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: { locale: string; primary: boolean }) => l.primary)?.locale || "en";

    return { shopLocales, primaryLocale };
  }

  /**
   * Load the shop's markets and the locales each one serves.
   *
   * Backs the market-specific translation feature. NEVER throws: if the
   * `read_markets` scope is missing, the API errors, or the shop has no markets,
   * this returns `{ markets: [] }` so the loader can keep rendering and the UI
   * simply hides the market selector (Edge Case 10 in the plan). Only markets
   * that (a) are enabled and (b) actually serve at least one locale are returned —
   * a market with no web-presence locale can never display a market-specific
   * translation on the storefront.
   */
  async loadMarkets(): Promise<{ markets: MarketInfo[] }> {
    try {
      const response = await this.admin.graphql(GET_MARKETS, {
        variables: { first: 100 },
      });

      if (!response.ok) {
        loggers.translation('warn', `[loadMarkets] Shopify API HTTP ${response.status} — hiding market selector`);
        return { markets: [] };
      }

      const data = await response.json();
      if (data.errors?.length > 0) {
        // Most commonly a missing `read_markets` scope, or a field-name drift on
        // a different API version. Degrade gracefully rather than break the loader.
        loggers.translation('warn', `[loadMarkets] GraphQL error — hiding market selector`, { error: data.errors[0]?.message });
        return { markets: [] };
      }

      const edges = data.data?.markets?.edges || [];

      const markets: MarketInfo[] = edges
        .map((edge: any): MarketInfo | null => {
          const node = edge?.node;
          if (!node?.id) return null;
          // Keep only active markets. `enabled` is deprecated in Admin API 2025-10
          // and no longer reliable — prefer `status` (ACTIVE), falling back to the
          // legacy `enabled` if status is absent.
          const isActive = node.status ? node.status === 'ACTIVE' : node.enabled !== false;
          if (!isActive) return null;

          // Locales the market publishes via a DEDICATED web presence. Secondary
          // markets that share the primary web presence return webPresences: []
          // here — that is NOT a disqualifier: Shopify's "Translate & Adapt" lets
          // a market carry market-specific translations for ANY of the shop's
          // published locales. So an empty list means "no per-locale restriction"
          // and is handled downstream (MarketSelector offers such a market for
          // every locale). rootUrls only lists URL-split locales; defaultLocale +
          // alternateLocales are the authoritative per-web-presence language list.
          const localeSet = new Set<string>();
          for (const wpEdge of node.webPresences?.edges || []) {
            const wp = wpEdge?.node;
            if (!wp) continue;
            for (const root of wp.rootUrls || []) {
              if (root?.locale) localeSet.add(root.locale);
            }
            if (wp.defaultLocale?.locale) localeSet.add(wp.defaultLocale.locale);
            for (const alt of wp.alternateLocales || []) {
              if (alt?.locale) localeSet.add(alt.locale);
            }
          }

          return {
            id: node.id,
            name: node.name || node.handle || node.id,
            handle: node.handle || '',
            localeCodes: [...localeSet],
          };
        })
        .filter((m: MarketInfo | null): m is MarketInfo => m !== null);

      loggers.translation('info', `[loadMarkets] ${markets.length} active market(s)`, {
        markets: markets.map((m) => ({ id: m.id, name: m.name, locales: m.localeCodes })),
      });

      return { markets };
    } catch (error) {
      loggers.translation('warn', `[loadMarkets] Unexpected error — hiding market selector`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return { markets: [] };
    }
  }

  /**
   * Update content in Shopify and database
   * Handles both primary locale updates and translations
   * When updating primary locale, deletes all translations for changed fields
   */
  async updateContent(params: {
    resourceId: string;
    resourceType: string;
    locale: string;
    primaryLocale: string;
    updates: Record<string, string>;
    db: PrismaClient;
    shop: string;
    policyType?: string;
    changedFields?: string[]; // Fields that changed in primary locale - their translations will be deleted
    /**
     * Indices of the images whose alt text the MERCHANT changed in the primary
     * locale — index 0 is the featured image. The same list the product path
     * has always taken, and the same reason: a save carrying `imageAltTexts` is
     * not necessarily a merchant edit. The accept-and-translate flow submits a
     * primary save with `imageAltTexts` of its OWN making, moments after
     * writing the foreign alt it just accepted; treating that as "the primary
     * changed" would delete the translation that flow exists to create.
     */
    changedAltTextIndices?: number[];
    /** PLAN §Phase 3 — which MERCHANDISING attributes the merchant actually
     *  touched. A separate list from `changedFields` on purpose: that one is
     *  withheld by the accept-and-translate flow (it is about to write the very
     *  translations it would mark stale), and an attribute edit must not be
     *  dropped just because the save also starts a translation. */
    changedAttributeFields?: string[];
    /**
     * Market scope for this save. "" (or undefined) = global (applies to all
     * markets, legacy behaviour). Non-empty = gid://shopify/Market/<id>, saving a
     * market-specific override that layers over the global translation for the
     * same locale. Only meaningful for foreign locales — the primary locale is
     * always global (Shopify forbids market-specific primary content).
     */
    marketId?: string;
  }) {
    const { resourceId, resourceType, locale, primaryLocale, updates, db, shop, policyType, changedFields, changedAltTextIndices } = params;
    const marketId = params.marketId || "";

    if (locale !== primaryLocale) {
      // Handle translations
      // Fetch digest map and source values once
      const { digestMap, valueMap } = await this.loadTranslatableContent(resourceId);

      const translationsInput: Array<{ key: string; value: string; locale: string; translatableContentDigest: string }> = [];
      const translationsToDelete: string[] = [];
      const dbOnlyTranslations: Array<{ key: string; value: string; locale: string }> = [];

      // Map UI field names to Shopify translatable content keys — the ONE
      // canonical map (see FIELD_TO_TRANSLATION_KEY at the top of this file
      // for the body/body_html ShopPolicy nuance).
      const keyMapping = fieldTranslationKeyMap(resourceType);

      for (const [field, value] of Object.entries(updates)) {
        const translationKey = keyMapping[field];
        if (!translationKey) continue;

        // Reject handle translations that are identical to the primary locale handle —
        // duplicate slugs across locales cause Shopify routing conflicts.
        if (field === 'handle' && value && valueMap['handle'] && value.trim() === valueMap['handle'].trim()) {
          loggers.translation('warn', `[updateContent] Skipping handle for locale '${locale}' — same as primary locale handle`);
          continue;
        }

        if (value && value.trim()) {
          let digest = digestMap[translationKey];

          // If digest is missing, retry (handles race conditions / late availability)
          if (!digest) {
            loggers.translation('warn', `[updateContent] No digest for '${translationKey}' in initial digestMap. Re-fetching...`);
            const fresh = await this.loadTranslatableContent(resourceId);
            digest = fresh.digestMap[translationKey];
            if (digest) {
              digestMap[translationKey] = digest;
              loggers.translation('debug', `[updateContent] Got digest for '${translationKey}' on retry`);
            }
          }

          if (digest) {
            translationsInput.push({
              key: translationKey,
              value,
              locale,
              translatableContentDigest: digest,
            });
          } else {
            loggers.translation('warn', `[updateContent] No digest for '${translationKey}' after retry. Saving to DB only.`);
            dbOnlyTranslations.push({ key: translationKey, value, locale });
          }
        } else if (value === "") {
          // Empty string means user cleared the translation — mark for deletion
          translationsToDelete.push(translationKey);
        }
      }

      // Save non-empty translations to Shopify. When a market is selected, add
      // marketId to each TranslationInput so Shopify stores a market-specific
      // override (omitting it means "all markets" = global). Response does not
      // echo marketId back, so we track it ourselves for the DB mirror below.
      if (translationsInput.length > 0) {
        const response = await this.admin.graphql(TRANSLATE_CONTENT, {
          variables: {
            resourceId,
            translations: marketId
              ? translationsInput.map((t) => ({ ...t, marketId }))
              : translationsInput,
          }
        });

        const data = await response.json();

        // Check for top-level GraphQL errors (e.g. missing required fields)
        if (data.errors?.length > 0) {
          loggers.translation('error', `[updateContent] GraphQL errors from translationsRegister`, { errors: data.errors });
          throw new Error(data.errors[0].message);
        }

        if (data.data?.translationsRegister?.userErrors?.length > 0) {
          throw new Error(data.data.translationsRegister.userErrors[0].message);
        }
      }

      // Delete cleared translations from Shopify. Scope the removal to the
      // selected market: with marketId set, only the market-specific override is
      // removed (the global translation survives and the field falls back to it);
      // without it, the global translation is removed.
      if (translationsToDelete.length > 0) {
        await this.deleteAllTranslationsForKeys({
          resourceId,
          translationKeys: translationsToDelete,
          foreignLocales: [locale],
          marketId,
        });
      }

      // Mark this resource as recently saved so webhook syncs don't overwrite.
      // Moved before DB transaction: Shopify is already updated at this point,
      // so webhook protection must be active even if the DB transaction fails.
      markTranslationSaved(resourceId);

      // Update database using transaction for consistency.
      // If this fails, Shopify already has the correct state — retry once,
      // then return a warning so the next sync/reload reconciles.
      const runDbTransaction = async () => {
        // @ts-expect-error Prisma interactive transaction types
        await db.$transaction(async (tx: PrismaClient) => {
          // Upsert translations saved to Shopify (marketId "" = global)
          for (const translation of translationsInput) {
            await tx.contentTranslation.upsert({
              where: {
                shop_resourceId_key_locale_marketId: {
                  shop,
                  resourceId,
                  key: translation.key,
                  locale: translation.locale,
                  marketId,
                },
              },
              update: {
                value: translation.value,
                digest: translation.translatableContentDigest || null,
                resourceType,
              },
              create: {
                shop,
                resourceId,
                resourceType,
                key: translation.key,
                value: translation.value,
                locale: translation.locale,
                digest: translation.translatableContentDigest || null,
                marketId,
              },
            });
          }

          // Upsert DB-only translations (no digest available, not saved to Shopify)
          for (const translation of dbOnlyTranslations) {
            await tx.contentTranslation.upsert({
              where: {
                shop_resourceId_key_locale_marketId: {
                  shop,
                  resourceId,
                  key: translation.key,
                  locale: translation.locale,
                  marketId,
                },
              },
              update: {
                value: translation.value,
                digest: null,
                resourceType,
              },
              create: {
                shop,
                resourceId,
                resourceType,
                key: translation.key,
                value: translation.value,
                locale: translation.locale,
                digest: null,
                marketId,
              },
            });
          }

          // Delete cleared translations from database (single batch call).
          // Scoped to the current market so clearing a market-specific value does
          // not touch the global row (and vice-versa).
          if (translationsToDelete.length > 0) {
            await tx.contentTranslation.deleteMany({
              where: {
                shop,
                resourceId,
                resourceType,
                locale,
                marketId,
                key: { in: translationsToDelete },
              },
            });
          }
        });
      };

      try {
        await runDbTransaction();
      } catch (dbError) {
        loggers.translation('error', `[updateContent] DB transaction failed after Shopify update`, {
          resourceId, resourceType, locale,
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
        // Retry once — transient DB issues (locks, timeouts) are common
        try {
          await runDbTransaction();
          loggers.translation('info', `[updateContent] DB transaction succeeded on retry`, { resourceId });
        } catch (retryError) {
          loggers.translation('error', `[updateContent] DB transaction failed on retry — Shopify/DB inconsistent`, {
            resourceId,
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
          // Shopify has the data but DB is out of sync — report as failure so caller knows
          return {
            success: false,
            error: 'Translation saved to Shopify but local database update failed. Reload to sync.',
          };
        }
      }

      // Article/Collection image alt-text translations live on a separate translatable
      // resource (ArticleImage / CollectionImage). Best-effort: failures don't fail the save.
      if (updates.imageAltText !== undefined && (resourceType === 'Collection' || resourceType === 'Article')) {
        await this.saveImageAltTextTranslation({
          resourceId,
          resourceType,
          locale,
          altText: updates.imageAltText,
          shop,
          db,
        });
      }

      if (dbOnlyTranslations.length > 0) {
        const fieldNames = dbOnlyTranslations.map((t) => t.key).join(", ");
        return {
          success: true,
          warning: `Some fields (${fieldNames}) could not be sent to Shopify because no digest was available and were saved locally only. They may be overwritten on the next sync — please re-save after a page refresh.`,
        };
      }

      return { success: true };
    } else {
      // Update primary locale
      let updatedResource;

      // ── PLAN §Phase 3 merchandising attributes ──────────────────────────
      // Built ONCE, from the same flat update map as everything else, and
      // filtered to the keys this resource actually has — a `sortOrder` on a
      // page is not a harmless extra, Shopify rejects the whole input.
      // `rejected` is peeled off here so it can never reach a GraphQL input:
      // it names the enum values that failed validation, and those are
      // reported as a warning instead of being sent and coming back as a
      // schema error the caller would read as a success.
      const { rejected: rejectedAttributes, ...attributeInput } = buildAttributeInput(
        resourceType as Parameters<typeof buildAttributeInput>[0],
        updates,
        // Presence is not intent — see the module's own note. A primary save
        // carries every field, so without this a title edit would rewrite the
        // merchandising block from whatever the cache happened to hold.
        params.changedAttributeFields,
      );

      /**
       * The attribute half of the DB mirror, taken from what Shopify ECHOED
       * back rather than from what was sent. Shopify normalises tags and can
       * refuse a template suffix, so mirroring the input would leave the cache
       * claiming something the shop does not hold — and the §2.2 attribute
       * checklist reads exactly that cache.
       *
       * A key is written only when the merchant actually sent it AND Shopify
       * answered for it: a missing echo must not be mirrored as `null`/`[]`,
       * which would read as "the merchant cleared this".
       */
      const attributeMirror = (echo: Record<string, unknown> | null | undefined) => {
        const data: Record<string, unknown> = {};
        if (!echo) return data;
        if (attributeInput.templateSuffix !== undefined && 'templateSuffix' in echo) {
          data.templateSuffix = (echo.templateSuffix as string | null) ?? null;
        }
        if (attributeInput.isPublished !== undefined && typeof echo.isPublished === 'boolean') {
          data.isPublished = echo.isPublished;
        }
        if (attributeInput.sortOrder !== undefined && typeof echo.sortOrder === 'string') {
          data.sortOrder = echo.sortOrder;
        }
        if (attributeInput.author !== undefined) {
          const name = (echo.author as { name?: string } | null | undefined)?.name;
          if (name) data.author = name;
        }
        if (attributeInput.tags !== undefined && Array.isArray(echo.tags)) {
          data.tags = echo.tags as string[];
        }
        return data;
      };

      if (resourceType === 'Page') {
        updatedResource = await this.updatePage(resourceId, {
          title: updates.title,
          handle: updates.handle,
          body: updates.description || updates.body,
          ...(updates.seoTitle !== undefined ? { seoTitle: updates.seoTitle } : {}),
          ...(updates.metaDescription !== undefined ? { seoDescription: updates.metaDescription } : {}),
          ...attributeInput,
        });

        // Update database
        await db.page.update({
          where: {
            shop_id: { shop, id: resourceId },
          },
          data: {
            title: updates.title,
            handle: updates.handle,
            body: updates.description || updates.body,
            ...(updates.seoTitle !== undefined ? { seoTitle: updates.seoTitle } : {}),
            ...(updates.metaDescription !== undefined ? { seoDescription: updates.metaDescription } : {}),
            ...attributeMirror(updatedResource),
            lastSyncedAt: new Date(),
          },
        });
      } else if (resourceType === 'Blog') {
        updatedResource = await this.updateBlog(resourceId, {
          title: updates.title,
          handle: updates.handle,
          ...(updates.seoTitle !== undefined ? { seoTitle: updates.seoTitle } : {}),
          ...(updates.metaDescription !== undefined ? { seoDescription: updates.metaDescription } : {}),
          ...attributeInput,
        });

        // Update blogTitle on all articles belonging to this blog
        if (updates.title) {
          await db.article.updateMany({
            where: { shop, blogId: resourceId },
            data: { blogTitle: updates.title },
          });
        }
      } else if (resourceType === 'Article') {
        updatedResource = await this.updateArticle(resourceId, {
          title: updates.title,
          handle: updates.handle,
          body: updates.body,
          summary: updates.summary,
          ...(updates.seoTitle !== undefined ? { seoTitle: updates.seoTitle } : {}),
          ...(updates.metaDescription !== undefined ? { seoDescription: updates.metaDescription } : {}),
          ...(updates.imageAltText !== undefined ? { image: { altText: updates.imageAltText } } : {}),
          ...attributeInput,
        });

        // Update database
        await db.article.update({
          where: {
            shop_id: { shop, id: resourceId },
          },
          data: {
            title: updates.title,
            handle: updates.handle,
            body: updates.body,
            summary: updates.summary,
            seoTitle: updates.seoTitle,
            seoDescription: updates.metaDescription,
            ...(updates.imageAltText !== undefined ? { imageAltText: updates.imageAltText || null } : {}),
            ...attributeMirror(updatedResource),
            lastSyncedAt: new Date(),
          },
        });
      } else if (resourceType === 'Collection') {
        // Preserve the untouched SEO half on partial saves (see buildPreservedSeo).
        const preservedSeo = await this.buildPreservedSeo(resourceId, updates.seoTitle, updates.metaDescription);
        updatedResource = await this.updateCollection(resourceId, {
          title: updates.title,
          handle: updates.handle,
          descriptionHtml: updates.description,
          ...(preservedSeo ? { seo: preservedSeo } : {}),
          ...(updates.imageAltText !== undefined ? { image: { altText: updates.imageAltText } } : {}),
          ...attributeInput,
        });

        // Update database
        await db.collection.update({
          where: {
            shop_id: { shop, id: resourceId },
          },
          data: {
            title: updates.title,
            handle: updates.handle,
            descriptionHtml: updates.description,
            seoTitle: updates.seoTitle,
            seoDescription: updates.metaDescription,
            ...(updates.imageAltText !== undefined ? { imageAltText: updates.imageAltText || null } : {}),
            ...attributeMirror(updatedResource),
            lastSyncedAt: new Date(),
          },
        });
      } else if (resourceType === 'ShopPolicy' && policyType) {
        updatedResource = await this.updateShopPolicy(policyType, updates.body);

        // Update database
        await db.shopPolicy.upsert({
          where: {
            shop_id: { shop, id: updatedResource.id },
          },
          create: {
            id: updatedResource.id,
            shop,
            title: updatedResource.title,
            body: updatedResource.body,
            type: updatedResource.type,
            url: updatedResource.url,
            lastSyncedAt: new Date(),
          },
          update: {
            title: updatedResource.title,
            body: updatedResource.body,
            type: updatedResource.type,
            url: updatedResource.url,
            lastSyncedAt: new Date(),
          },
        });
      } else {
        throw new Error(`Unsupported resource type for primary locale update: ${resourceType}`);
      }

      // What a changed PRIMARY value does to its foreign translations — the
      // merchant switch (Settings → Übersetzungen). Read ONCE: the fields, the
      // featured-image alt and the re-translation below all ask it, and three
      // separate lookups are three chances for one save to answer the same
      // question differently. Fails OPEN — see
      // services/translations/translation-change-policy.server.ts.
      const { loadTranslationChangePolicy } = await import(
        "../../app/services/translations/translation-change-policy.server"
      );
      const fieldsChanged = !!changedFields && changedFields.length > 0;
      // Did the MERCHANT change the featured alt in the primary locale? The
      // presence of `updates.imageAltText` is not enough: the
      // accept-and-translate flow submits its own primary save carrying
      // `imageAltTexts`, right after writing the foreign alt it accepted, and
      // purging on that would delete exactly what it just created (and what its
      // translate-to-all-locales step is about to write). `changedAltTextIndices`
      // is the merchant signal — the editor sends it only from a real save, the
      // translate flow never does — and index 0 is the featured image. It is
      // the same discriminator the product path has always used, for the same
      // reason `changedFields` exists beside it.
      const featuredAltChanged =
        updates.imageAltText !== undefined &&
        !!changedAltTextIndices?.includes(0) &&
        (resourceType === 'Collection' || resourceType === 'Article');
      const changePolicy =
        fieldsChanged || featuredAltChanged
          ? await loadTranslationChangePolicy(shop, db)
          : null;

      // Does an automatic re-translation reach THIS resource's own fields?
      //  - Collection: yes, through the collections/update webhook.
      //  - Page / Article / Blog / ShopPolicy: no webhook exists, so the only
      //    event that will ever notice is the save happening right now. With
      //    auto-translate on, that repair is `reconcileAfterPrimarySave` below
      //    — which is what makes them reconciled BY THIS SAVE and lets the
      //    deletion stand down. Without it they were deleted and nothing ever
      //    refreshed them, so a Max shop got the new text on a product and a
      //    blank field on a page for the very same edit.
      const { IN_APP_RETRANSLATED_RESOURCE_TYPES } = await import(
        "../../app/services/translations/stale-translation-sync.server"
      );
      const selfRetranslated =
        !!changePolicy?.autoTranslateExternalChanges &&
        IN_APP_RETRANSLATED_RESOURCE_TYPES.has(resourceType);
      const purgeChangedFields = !!changePolicy && (
        selfRetranslated || resourceType === 'Collection'
          ? changePolicy.purgeOnPrimaryChange
          : changePolicy.purgeUnreconciledSurfaces
      );

      // Map UI field names to Shopify translation keys — the ONE canonical map
      // (FIELD_TO_TRANSLATION_KEY, top of this file).
      const changedTranslationKeys = fieldsChanged
        ? [...new Set(
            changedFields!
              .map(field => fieldTranslationKeyMap(resourceType)[field])
              .filter((key): key is string => key !== undefined),
          )]
        : [];

      // Published foreign locales, resolved ONCE for the three passes below and
      // only when one of them can actually run — a save that changed no
      // translatable text must not pay for a shopLocales query.
      //
      // A FAILED lookup yields [] and skips all three rather than throwing. The
      // primary write has already gone through at this point, so an exception
      // here reports a save that succeeded as failed, and the merchant re-saves
      // — repeating the write. A stale translation is visible and repairable;
      // "your text was not saved" about text that was is neither.
      const needsForeignLocales =
        (purgeChangedFields && changedTranslationKeys.length > 0) ||
        (selfRetranslated && changedTranslationKeys.length > 0) ||
        (featuredAltChanged && !!changePolicy?.purgeUnreconciledSurfaces);
      let foreignLocales: string[] = [];
      if (needsForeignLocales) {
        try {
          const { shopLocales } = await this.loadShopLocales();
          foreignLocales = shopLocales
            .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
            .map((l: { locale: string }) => l.locale);
        } catch (localeError: unknown) {
          loggers.translation('warn', '[updateContent] Could not load shop locales — translations left untouched', {
            resourceId,
            error: localeError instanceof Error ? localeError.message : String(localeError),
          });
        }
      }

      // Delete translations for changed fields across ALL foreign locales.
      // With the purge off the old translations stay and Shopify flags them
      // "outdated" in its own editor instead.
      if (purgeChangedFields && changedTranslationKeys.length > 0 && foreignLocales.length > 0) {
        // Delete from Shopify
        await this.deleteAllTranslationsForKeys({
          resourceId,
          translationKeys: changedTranslationKeys,
          foreignLocales,
        });

        // Delete from database (single batch call instead of N×M loop).
        // Scoped to global (marketId "") to mirror the global-only Shopify
        // removal above: market-specific overrides survive both sides (Shopify
        // flags them outdated), matching the plan's market-independence rule.
        await db.contentTranslation.deleteMany({
          where: {
            shop,
            resourceId,
            resourceType,
            marketId: "",
            key: { in: changedTranslationKeys },
            locale: { in: foreignLocales },
          },
        });

        loggers.translation('info', `Deleted translations for fields: ${changedFields!.join(', ')}`);
      }

      // §6.6 for the FEATURED-IMAGE ALT — the third translation shape
      // (CLAUDE.md). Its Shopify target is the image's own
      // CollectionImage/ArticleImage GID while its DB row sits on the PARENT
      // under `image_alt_text`, and `imageAltText` is not in
      // FIELD_TO_TRANSLATION_KEY at all — so neither half of the generic purge
      // above can reach it, and a changed primary alt used to leave its
      // translations live for good. The bulk editor has run this pass since
      // Phase 4b; this is the single editor's missing copy of the same rule.
      //
      // UNRECONCILED by nature and therefore NOT covered by `selfRetranslated`:
      // no sync and no re-translation in this app ever looks at a
      // CollectionImage, so auto-translate does not stand its deletion down.
      if (featuredAltChanged && changePolicy?.purgeUnreconciledSurfaces && foreignLocales.length > 0) {
        await this.invalidateFeaturedImageAltTranslations({
          resourceId,
          resourceType: resourceType as 'Collection' | 'Article',
          shop,
          db,
          foreignLocales,
        });
      }

      // The repair that replaces the deletion for the webhook-less types.
      // Best-effort by contract: the primary write has already happened, so a
      // failure here costs a stale translation, never the merchant's text.
      if (selfRetranslated && changedTranslationKeys.length > 0 && foreignLocales.length > 0) {
        try {
          // Read the primary values BACK — the re-translation needs the NEW
          // text and, to register at all, the NEW digest. A key Shopify no
          // longer lists is a cleared field, which the reconciliation routes to
          // the removal by itself.
          const { valueMap, digestMap } = await this.loadTranslatableContent(resourceId);
          const primaryContent: Record<string, { value: string; digest?: string | null }> = {};
          for (const [key, digest] of Object.entries(digestMap)) {
            primaryContent[key] = { value: valueMap[key] ?? "", digest };
          }
          const { reconcileAfterPrimarySave } = await import(
            "../../app/services/translations/stale-translation-sync.server"
          );
          await reconcileAfterPrimarySave({
            client: this.admin,
            shop,
            resourceId,
            resourceType,
            // The merchant-facing kind the AI prompt and the Tasks tab speak —
            // an article and its blog are both "blog"; a policy has no kind of
            // its own and rides with "page", the same choice the policy sync
            // makes.
            contentKind: resourceType === 'Article' || resourceType === 'Blog' ? 'blog' : 'page',
            resourceTitle: (updatedResource as { title?: string } | undefined)?.title,
            primaryContent,
            changedKeys: changedTranslationKeys,
            foreignLocales,
            // The policy read ONCE at the top of this block. A second read
            // inside would fail open to "auto-translate off" and return without
            // doing anything, while the purge above has already stood down.
            policy: changePolicy!,
          });
        } catch (retranslateError: unknown) {
          loggers.translation('warn', '[updateContent] Re-translation after primary save failed — translations kept', {
            resourceId,
            resourceType,
            error: retranslateError instanceof Error ? retranslateError.message : String(retranslateError),
          });
        }
      }

      // A rejected attribute is NOT a failed save — everything else went
      // through — but it is not a silent drop either. Saying nothing is how a
      // merchant discovers weeks later that a sort order never took.
      if (rejectedAttributes && rejectedAttributes.length > 0) {
        return {
          success: true,
          item: updatedResource,
          warning: `Saved, but these details could not be applied because their value was not recognised: ${rejectedAttributes.join(", ")}.`,
        };
      }
      return { success: true, item: updatedResource };
    }
  }

  /**
   * Batch translate all fields for all target locales
   * Uses hybrid approach:
   * - Short fields (title, seoTitle, handle): 1 batch AI request for all locales
   * - Long fields (description, body, metaDescription): 1 AI request per locale
   */
  async translateAllContent(params: {
    resourceId: string;
    resourceType: string;
    shop: string;
    fields: Record<string, string>;
    translationService: {
      translateProduct: (fields: Record<string, string>, locales: string[], contentType?: string, instructions?: string, keywordDirective?: string) => Promise<Record<string, Record<string, string>>>;
      translateShortFieldsBatch?: (fields: Record<string, string>, sourceLocale: string, targetLocales: string[], contentType?: string, instructions?: string, keywordDirective?: string) => Promise<Record<string, Record<string, string>>>;
    };
    db: PrismaClient;
    targetLocales?: string[];
    contentType?: string;
    taskId?: string;
    customInstructions?: string;
    sourceLocale?: string;
    /**
     * Phrase each locale's translation so THAT locale's own tracked keyword
     * survives (AISettings.keywordAwareTranslation). Off = the previous
     * literal behaviour, untouched.
     */
    keywordAwareTranslation?: boolean;
  }) {
    const { resourceId, resourceType, shop, fields, translationService, db, targetLocales: customTargetLocales, contentType, customInstructions, sourceLocale = 'en', keywordAwareTranslation = false } = params;

    // Fetch digest map once for all translations
    const { digestMap } = await this.loadTranslatableContent(resourceId);
    loggers.translation('debug', `translateAllContent resourceType: ${resourceType}`);
    loggers.translation('debug', 'translateAllContent fields received', { fields: Object.keys(fields) });
    loggers.translation('debug', 'translateAllContent fields values', { values: Object.entries(fields).map(([k, v]) => `${k}=${v ? v.substring(0, 50) + '...' : 'EMPTY'}`) });
    loggers.translation('debug', `translateAllContent digestMap keys for ${resourceId}`, { keys: Object.keys(digestMap) });
    loggers.translation('debug', 'translateAllContent has summary_html digest', { hasSummaryHtmlDigest: !!digestMap['summary_html'] });

    // Get target locales (use custom list if provided, otherwise all published locales)
    let targetLocales: string[];
    if (customTargetLocales) {
      targetLocales = customTargetLocales;
    } else {
      const { shopLocales } = await this.loadShopLocales();
      targetLocales = shopLocales
        .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
        .map((l: { locale: string }) => l.locale);
    }

    // Keyword-aware translation: each target locale's OWN tracked keywords, so
    // the translated text is phrased to carry them instead of being a literal
    // rendering of the primary value. A locale that tracks nothing gets no
    // clause and is translated exactly as before.
    const keywordsByLocale = new Map<string, LocaleKeywords>();
    if (keywordAwareTranslation && resourceId) {
      const { getItemKeywords } = await import('../../app/services/seo/keywords.service');
      await Promise.all(
        targetLocales.map(async (locale) => {
          try {
            const rows = await getItemKeywords(db, shop, resourceId, locale);
            if (rows.length === 0) return;
            const primary = rows.find((r) => r.role === 'primary')?.keyword ?? null;
            if (!primary) return;
            keywordsByLocale.set(locale, {
              locale,
              localeName: localeName(locale),
              primary,
              secondaries: rows.filter((r) => r.role === 'secondary').map((r) => r.keyword),
            });
          } catch (err) {
            // A keyword lookup must never cost the merchant the translation —
            // worst case this locale is translated the old, literal way.
            loggers.translation('warn', `Keyword lookup failed for ${locale}, translating without it`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    }

    /** The clause for ONE locale, empty when it tracks nothing. */
    const keywordDirectiveFor = (locale: string): string | undefined => {
      const entry = keywordsByLocale.get(locale);
      if (!entry) return undefined;
      return keywordTranslationDirective(entry) || undefined;
    };

    const allTranslations: Record<string, Record<string, string>> = {};
    const failedLocales: string[] = [];
    const rejectedFields: Record<string, string[]> = {};
    const skippedFields: Record<string, string[]> = {};

    // Initialize translations structure
    for (const locale of targetLocales) {
      allTranslations[locale] = {};
    }

    // Separate short and long fields
    const SHORT_FIELD_KEYS = ['title', 'seoTitle', 'handle', 'productType'];
    const shortFields: Record<string, string> = {};
    const longFields: Record<string, string> = {};

    for (const [key, value] of Object.entries(fields)) {
      if (value) {
        if (SHORT_FIELD_KEYS.includes(key)) {
          shortFields[key] = value;
        } else {
          longFields[key] = value;
        }
      }
    }

    const hasShortFields = Object.keys(shortFields).length > 0;
    const hasLongFields = Object.keys(longFields).length > 0;

    loggers.translation('debug', 'Using hybrid approach', { shortFields: Object.keys(shortFields), longFields: Object.keys(longFields) });

    // ShopPolicy uses "body", all other resource types use "body_html" — the
    // ONE canonical map (FIELD_TO_TRANSLATION_KEY, top of this file).
    const keyMapping = fieldTranslationKeyMap(resourceType);

    // Track which translation keys have already had a digest retry to avoid
    // redundant loadTranslatableContent calls for the same missing key.
    const digestRetried = new Set<string>();

    // Helper: validate and prepare a single field for batching (no Shopify API call)
    const prepareField = async (locale: string, field: string, value: string): Promise<{ field: string; translationKey: string; value: string; digest: string } | null> => {
      const translationKey = keyMapping[field];
      if (!translationKey) {
        loggers.translation('warn', `No keyMapping for field '${field}' — translation NOT saved`);
        if (!rejectedFields[locale]) rejectedFields[locale] = [];
        rejectedFields[locale].push(field);
        return null;
      }

      // Reject handle translations identical to primary locale handle
      if (field === 'handle') {
        const sourceHandle = fields['handle'];
        if (sourceHandle && value.trim() === sourceHandle.trim()) {
          loggers.translation('warn', `Skipping handle for locale '${locale}' — same as primary locale handle`);
          if (!skippedFields[locale]) skippedFields[locale] = [];
          skippedFields[locale].push(field);
          return null;
        }
      }

      // Resolve digest, retrying once per key (not per locale)
      let digest = digestMap[translationKey] || null;
      if (!digest && !digestRetried.has(translationKey)) {
        digestRetried.add(translationKey);
        loggers.translation('warn', `No digest for '${translationKey}' in initial digestMap. Re-fetching translatableContent...`);
        const fresh = await this.loadTranslatableContent(resourceId);
        digest = fresh.digestMap[translationKey] || null;
        if (digest) {
          digestMap[translationKey] = digest;
          loggers.translation('debug', `Got digest for '${translationKey}' on retry`);
        } else {
          loggers.translation('warn', `Still no digest for '${translationKey}' after retry.`, { availableKeys: Object.keys(fresh.digestMap).join(', ') });
        }
      }

      if (!digest) {
        loggers.translation('warn', `No digest for '${translationKey}'. Translation NOT saved.`);
        if (!rejectedFields[locale]) rejectedFields[locale] = [];
        rejectedFields[locale].push(field);
        return null;
      }

      return { field, translationKey, value, digest };
    };

    // Prepared translation type (includes locale for cross-locale batching)
    type PreparedTranslation = {
      locale: string;
      field: string;
      translationKey: string;
      value: string;
      digest: string;
    };

    // Helper: chunk an array into groups of `size`
    const chunkArray = <T>(arr: T[], size: number): T[][] => {
      const chunks: T[][] = [];
      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }
      return chunks;
    };

    // Helper: collect prepared translations for a locale (NO Shopify call)
    const collectLocaleTranslations = async (locale: string, translatedFields: Record<string, any>): Promise<PreparedTranslation[]> => {
      const prepared: PreparedTranslation[] = [];
      for (const [field, value] of Object.entries(translatedFields)) {
        if (value) {
          let stringValue: string;
          if (typeof value === 'string') {
            stringValue = value;
          } else if (typeof value === 'object' && value !== null) {
            stringValue = ('value' in value && typeof value.value === 'string') ? value.value : JSON.stringify(value);
          } else {
            stringValue = String(value);
          }
          const p = await prepareField(locale, field, stringValue);
          if (p) prepared.push({ ...p, locale });
        } else {
          // AI returned empty/null for this field — report as rejected so the user is informed
          loggers.translation('warn', `AI returned empty value for field '${field}' in locale '${locale}' — not saved`);
          if (!rejectedFields[locale]) rejectedFields[locale] = [];
          rejectedFields[locale].push(field);
        }
      }
      return prepared;
    };

    // Tier 3 fallback: save translations one-by-one (Shopify only, no DB)
    const saveFieldsIndividually = async (
      locale: string,
      prepared: PreparedTranslation[]
    ): Promise<{ saved: PreparedTranslation[]; failed: PreparedTranslation[] }> => {
      const saved: PreparedTranslation[] = [];
      const failed: PreparedTranslation[] = [];
      for (const p of prepared) {
        try {
          const response = await this.admin.graphql(TRANSLATE_CONTENT, {
            variables: {
              resourceId,
              translations: [{ key: p.translationKey, value: p.value, locale, translatableContentDigest: p.digest }]
            }
          });
          const data = await response.json();
          if (data.errors?.length > 0 || data.data?.translationsRegister?.userErrors?.length > 0) {
            loggers.translation('error', `Shopify rejected ${p.field} for ${locale}`, { errors: data.errors || data.data?.translationsRegister?.userErrors });
            if (!rejectedFields[locale]) rejectedFields[locale] = [];
            rejectedFields[locale].push(p.field);
            failed.push(p);
            continue;
          }
          saved.push(p);
        } catch (fieldError) {
          loggers.translation('error', `Failed to save ${p.field} for ${locale}`, { error: fieldError instanceof Error ? fieldError.message : String(fieldError) });
          if (!rejectedFields[locale]) rejectedFields[locale] = [];
          rejectedFields[locale].push(p.field);
          failed.push(p);
        }
      }
      return { saved, failed };
    };

    // Tier 2 fallback: save per-locale batch with smart error handling
    const savePerLocaleBatch = async (
      locale: string,
      prepared: PreparedTranslation[]
    ): Promise<{ saved: PreparedTranslation[]; failed: PreparedTranslation[] }> => {
      if (prepared.length === 0) return { saved: [], failed: [] };

      const translationsInput = prepared.map(p => ({
        key: p.translationKey,
        value: p.value,
        locale,
        translatableContentDigest: p.digest,
      }));

      loggers.translation('debug', `Per-locale batch saving ${prepared.length} fields for ${locale}`, {
        fields: prepared.map(p => `${p.field}->${p.translationKey}`),
      });

      try {
        const response = await this.admin.graphql(TRANSLATE_CONTENT, {
          variables: { resourceId, translations: translationsInput }
        });
        const data = await response.json();

        // Top-level errors (schema/network) — can't identify individual failures
        if (data.errors?.length > 0) {
          loggers.translation('error', `Per-locale batch errors for ${locale}, falling back to individual`, { errors: data.errors });
          return await saveFieldsIndividually(locale, prepared);
        }

        const userErrors = data.data?.translationsRegister?.userErrors || [];
        if (userErrors.length > 0) {
          // Parse which items in the input array failed via userErrors[].field path
          const failedIndices = new Set<number>();
          for (const err of userErrors) {
            const idx = parseInt(err.field?.[1], 10);
            if (!isNaN(idx)) failedIndices.add(idx);
          }

          if (failedIndices.size > 0 && failedIndices.size < prepared.length) {
            // Partial failure: some succeeded, only retry failed ones individually
            const succeeded = prepared.filter((_: PreparedTranslation, i: number) => !failedIndices.has(i));
            const failedItems = prepared.filter((_: PreparedTranslation, i: number) => failedIndices.has(i));
            loggers.translation('warn', `Partial batch failure for ${locale}: ${succeeded.length} ok, ${failedItems.length} failed`, {
              failedFields: failedItems.map(p => p.field), errors: userErrors,
            });
            const retried = await saveFieldsIndividually(locale, failedItems);
            return { saved: [...succeeded, ...retried.saved], failed: retried.failed };
          } else {
            // All failed or can't parse indices — retry all individually
            loggers.translation('error', `Per-locale batch all-fail for ${locale}, falling back to individual`, { errors: userErrors });
            return await saveFieldsIndividually(locale, prepared);
          }
        }

        loggers.translation('debug', `Per-locale batch Shopify save successful for ${locale} (${prepared.length} fields)`);
        return { saved: [...prepared], failed: [] };
      } catch (err) {
        loggers.translation('error', `Per-locale batch error for ${locale}, falling back to individual`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return await saveFieldsIndividually(locale, prepared);
      }
    };

    // Helper: persist saved translations to DB in a single transaction (with 1 retry)
    const persistToDb = async (saved: PreparedTranslation[]): Promise<void> => {
      if (saved.length === 0) return;

      const runDbTransaction = async () => {
        // @ts-expect-error Prisma interactive transaction types
        await db.$transaction(async (tx: PrismaClient) => {
          for (const p of saved) {
            await tx.contentTranslation.upsert({
              where: { shop_resourceId_key_locale_marketId: { shop, resourceId, key: p.translationKey, locale: p.locale, marketId: "" } },
              update: { value: p.value, digest: p.digest, resourceType },
              create: { shop, resourceId, resourceType, key: p.translationKey, value: p.value, locale: p.locale, digest: p.digest },
            });
          }
        });
      };

      try {
        await runDbTransaction();
      } catch (dbError) {
        loggers.translation('error', `DB transaction failed after Shopify save (${saved.length} items)`, {
          resourceId, error: dbError instanceof Error ? dbError.message : String(dbError),
        });
        try {
          await runDbTransaction();
          loggers.translation('info', `DB transaction succeeded on retry`, { resourceId });
        } catch (retryError) {
          loggers.translation('error', `DB transaction failed on retry — Shopify/DB inconsistent. Next sync will reconcile.`, {
            resourceId, error: retryError instanceof Error ? retryError.message : String(retryError),
          });
        }
      }
    };

    // Collect all prepared translations across all locales (no Shopify calls yet)
    const allPrepared: PreparedTranslation[] = [];

    // === Grouped-field cache lookup for productType (consistent shop-wide categories) ===
    // Done BEFORE the AI batch so we know which locales already have a cached value.
    let groupedCacheHits: Map<string, string> = new Map();
    const sourceProductType = shortFields['productType'];
    const isProductResource = resourceType === 'Product';
    if (sourceProductType && isProductResource) {
      try {
        const { GroupedFieldTranslationService } = await import('./grouped-field-translation.service');
        const groupedService = new GroupedFieldTranslationService(db);
        const lookup = await groupedService.lookup({
          shop,
          fieldKey: 'productType',
          sourceLocale,
          sourceValue: sourceProductType,
          targetLocales,
        });
        groupedCacheHits = new Map(Object.entries(lookup.hits));
        if (groupedCacheHits.size > 0) {
          loggers.translation('info', `Grouped-field cache hits for productType in ${groupedCacheHits.size} locales`, { hits: Array.from(groupedCacheHits.keys()) });
        }
      } catch (cacheErr) {
        loggers.translation('error', 'Grouped-field cache lookup failed', { error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr) });
      }
    }

    // === STEP 1: Batch translate short fields (1 AI request for all locales) ===
    if (hasShortFields && translationService.translateShortFieldsBatch) {
      try {
        loggers.translation('debug', `Batch translating short fields to ${targetLocales.length} locales`, { shortFields: Object.keys(shortFields) });

        const batchResult = await translationService.translateShortFieldsBatch(
          shortFields,
          sourceLocale,
          targetLocales,
          contentType || 'product',
          customInstructions,
          keywordTranslationDirectiveMulti(Array.from(keywordsByLocale.values())) || undefined,
        );

        // Track new productType translations to persist after the loop.
        const newProductTypeEntries: Record<string, string> = {};

        for (const locale of targetLocales) {
          const localeTranslations = batchResult[locale];
          if (!localeTranslations) continue;
          // Override productType with cached value if the shop already has one for this
          // (sourceValue, targetLocale) pair — keeps category labels consistent.
          if (groupedCacheHits.has(locale) && 'productType' in localeTranslations) {
            localeTranslations.productType = groupedCacheHits.get(locale)!;
          } else if (sourceProductType && isProductResource && localeTranslations.productType) {
            // Newly translated productType for an uncached locale → schedule persist.
            newProductTypeEntries[locale] = String(localeTranslations.productType);
          }
          const prepared = await collectLocaleTranslations(locale, localeTranslations);
          allPrepared.push(...prepared);
        }

        // Persist new productType translations for future reuse.
        if (Object.keys(newProductTypeEntries).length > 0 && sourceProductType) {
          try {
            const { GroupedFieldTranslationService } = await import('./grouped-field-translation.service');
            const groupedService = new GroupedFieldTranslationService(db);
            await groupedService.upsertMany({
              shop,
              fieldKey: 'productType',
              sourceLocale,
              sourceValue: sourceProductType,
              entries: newProductTypeEntries,
              source: 'ai',
            });
          } catch (persistErr) {
            loggers.translation('error', 'Failed to persist grouped-field productType translations', { error: persistErr instanceof Error ? persistErr.message : String(persistErr) });
          }
        }

        loggers.translation('debug', 'Batch short fields completed');
      } catch (batchError: unknown) {
        // Invalid API key: the sequential fallback would fail for every locale
        // too — surface it so the caller reports failure instead of success.
        if (isAuthError(batchError)) throw batchError;
        loggers.translation('error', 'Batch short fields failed', { error: batchError instanceof Error ? batchError.message : String(batchError) });
        loggers.translation('warn', 'Falling back to sequential for short fields...');
        for (const locale of targetLocales) {
          try {
            const localeTranslations = await translationService.translateProduct(shortFields, [locale], contentType, customInstructions, keywordDirectiveFor(locale));
            const translatedFields = localeTranslations[locale];
            if (translatedFields) {
              const prepared = await collectLocaleTranslations(locale, translatedFields);
              allPrepared.push(...prepared);
            }
          } catch (localeError: unknown) {
            // Invalid key: abort — every remaining locale would fail identically.
            if (isAuthError(localeError)) throw localeError;
            loggers.translation('error', `Fallback failed for ${locale}`, { error: localeError instanceof Error ? localeError.message : String(localeError) });
            if (!failedLocales.includes(locale)) failedLocales.push(locale);
          }
        }
      }
    }

    // === STEP 2: Sequential translate long fields (1 AI request per locale) ===
    if (hasLongFields) {
      for (const locale of targetLocales) {
        try {
          loggers.translation('debug', `Translating long fields to ${locale}`, { longFields: Object.keys(longFields) });
          const localeTranslations = await translationService.translateProduct(longFields, [locale], contentType, customInstructions, keywordDirectiveFor(locale));
          const translatedFields = localeTranslations[locale];

          if (translatedFields) {
            const prepared = await collectLocaleTranslations(locale, translatedFields);
            allPrepared.push(...prepared);
          } else {
            // AI returned no translations for this locale without throwing — treat as failure
            loggers.translation('error', `AI returned no long-field translations for ${locale} (no exception thrown)`);
            if (!failedLocales.includes(locale)) failedLocales.push(locale);
          }
        } catch (localeError: unknown) {
          // Invalid key: abort — every remaining locale would fail identically.
          if (isAuthError(localeError)) throw localeError;
          loggers.translation('error', `Failed to translate long fields to ${locale}`, { error: localeError instanceof Error ? localeError.message : String(localeError) });
          if (!failedLocales.includes(locale)) failedLocales.push(locale);
        }
      }
    }

    // === STEP 3: Save all translations to Shopify (3-tier: mega-batch → per-locale → individual) ===
    if (allPrepared.length > 0) {
      const MAX_TRANSLATIONS_PER_CALL = 200;
      const allSaved: PreparedTranslation[] = [];

      // Tier 1: Mega-batch — all locales × fields in as few calls as possible
      const chunks = chunkArray(allPrepared, MAX_TRANSLATIONS_PER_CALL);
      let megaBatchFailed = false;

      loggers.translation('debug', `Saving ${allPrepared.length} translations via mega-batch (${chunks.length} chunk(s))`);

      for (const chunk of chunks) {
        try {
          const translationsInput = chunk.map(p => ({
            key: p.translationKey,
            value: p.value,
            locale: p.locale,
            translatableContentDigest: p.digest,
          }));

          const response = await this.admin.graphql(TRANSLATE_CONTENT, {
            variables: { resourceId, translations: translationsInput }
          });
          const data = await response.json();

          if (data.errors?.length > 0 || data.data?.translationsRegister?.userErrors?.length > 0) {
            loggers.translation('warn', 'Mega-batch chunk failed, falling back to per-locale batches', {
              errors: data.errors || data.data?.translationsRegister?.userErrors,
            });
            megaBatchFailed = true;
            break;
          }

          allSaved.push(...chunk);
        } catch (err) {
          loggers.translation('warn', 'Mega-batch chunk threw, falling back to per-locale batches', {
            error: err instanceof Error ? err.message : String(err),
          });
          megaBatchFailed = true;
          break;
        }
      }

      if (megaBatchFailed) {
        // Tier 2+3: Per-locale batches with smart fallback to individual saves
        allSaved.length = 0; // Clear partial mega-batch results (idempotent re-send is safe)

        const byLocale = new Map<string, PreparedTranslation[]>();
        for (const p of allPrepared) {
          if (!byLocale.has(p.locale)) byLocale.set(p.locale, []);
          byLocale.get(p.locale)!.push(p);
        }

        for (const [locale, localePrepared] of byLocale) {
          const result = await savePerLocaleBatch(locale, localePrepared);
          allSaved.push(...result.saved);
        }
      }

      // Populate allTranslations from saved
      for (const p of allSaved) {
        if (!allTranslations[p.locale]) allTranslations[p.locale] = {};
        allTranslations[p.locale][p.field] = p.value;
      }

      // Persist all saved translations to DB in one transaction
      await persistToDb(allSaved);

      loggers.translation('debug', `Shopify+DB save complete: ${allSaved.length}/${allPrepared.length} translations saved`);
    }

    // Prevent webhook-triggered syncs from overwriting these fresh translations
    markTranslationSaved(resourceId);

    if (failedLocales.length > 0) {
      loggers.translation('warn', `translateAllContent completed with failures`, { failedLocales, successLocales: targetLocales.filter(l => !failedLocales.includes(l)) });
    }
    loggers.translation('info', 'translateAllContent FINAL', { locales: Object.keys(allTranslations), failedLocales, rejectedFields, skippedFields });
    return { translations: allTranslations, failedLocales, rejectedFields, skippedFields };
  }
}
