/**
 * Shopify Content Service
 * Centralized service for managing Shopify content via GraphQL API
 */

import { TRANSLATE_CONTENT, UPDATE_PAGE, UPDATE_ARTICLE, UPDATE_SHOP_POLICY, UPDATE_COLLECTION, UPDATE_BLOG, METAFIELDS_DELETE } from "../../app/graphql/content.mutations";
import { GET_TRANSLATIONS, GET_TRANSLATABLE_CONTENT } from "../../app/graphql/content.queries";
import { loggers } from '../../app/utils/logger.server';
import { markTranslationSaved } from '../../app/utils/translation-save-lock.server';
import { isAuthError } from './ai.service';
import type { PrismaClient } from "@prisma/client";

export interface ShopifyAdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export class ShopifyContentService {
  private admin: ShopifyAdminClient;

  constructor(admin: ShopifyAdminClient) {
    this.admin = admin;
  }

  /**
   * Load translations for a specific resource and locale
   */
  async loadTranslations(resourceId: string, locale: string) {
    const response = await this.admin.graphql(GET_TRANSLATIONS, {
      variables: { resourceId, locale }
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
  async saveTranslations(resourceId: string, translations: Array<{ key: string; value: string; locale: string }>) {
    // Fetch digest map first
    const { digestMap } = await this.loadTranslatableContent(resourceId);

    // Add digests to translations, filtering out any without a valid digest
    const translationsWithDigests = translations
      .map(t => ({
        ...t,
        translatableContentDigest: digestMap[t.key]
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
   * Deleting a metafield that doesn't exist is a no-op; userErrors are logged,
   * not thrown, so a clear that partially fails doesn't abort the whole save.
   */
  private async deleteMetafields(ownerId: string, identifiers: Array<{ namespace: string; key: string }>) {
    if (identifiers.length === 0) return;

    const response = await this.admin.graphql(METAFIELDS_DELETE, {
      variables: {
        metafields: identifiers.map((i) => ({ ownerId, namespace: i.namespace, key: i.key })),
      },
    });

    const data = await response.json();
    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in deleteMetafields: ${data.errors[0].message}`);
    }
    if (data.data?.metafieldsDelete?.userErrors?.length > 0) {
      loggers.translation('warn', '[deleteMetafields] userErrors while clearing metafields', {
        ownerId,
        identifiers,
        userErrors: data.data.metafieldsDelete.userErrors,
      });
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
  async updatePage(id: string, page: { title?: string; handle?: string; body?: string; seoTitle?: string; seoDescription?: string }) {
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
  async updateBlog(id: string, blog: { title?: string; handle?: string; seoTitle?: string; seoDescription?: string }) {
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
   */
  async updateArticle(id: string, article: { title?: string; handle?: string; body?: string; summary?: string; image?: { altText: string } | null }) {
    const response = await this.admin.graphql(UPDATE_ARTICLE, {
      variables: { id, article }
    });

    const data = await response.json();

    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in updateArticle: ${data.errors[0].message}`);
    }
    if (data.data?.articleUpdate?.userErrors?.length > 0) {
      throw new Error(data.data.articleUpdate.userErrors[0].message);
    }

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
  async updateCollection(id: string, collection: { title?: string; handle?: string; descriptionHtml?: string; seo?: { title?: string; description?: string }; image?: { altText: string } }) {
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
   * Translate the featured-image alt text of an Article or Collection.
   *
   * In Shopify, Article/Collection image alt text is a SEPARATE translatable resource
   * (CollectionImage / ArticleImage), not part of the parent's translatable content.
   * The image resource GID mirrors the parent's numeric ID:
   *   Collection gid://shopify/Collection/123 → gid://shopify/CollectionImage/123
   *   Article    gid://shopify/Article/123    → gid://shopify/ArticleImage/123
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
      // collection/article id. We must fetch image.id from the parent — using
      // the parent's numeric id constructs a non-existent GID.
      const fieldName = resourceType === 'Article' ? 'article' : 'collection';
      const imageIdResponse = await this.admin.graphql(
        `#graphql
          query getImageId($id: ID!) {
            ${fieldName}(id: $id) {
              image { id }
            }
          }`,
        { variables: { id: resourceId } }
      );
      const imageIdData = await imageIdResponse.json() as any;
      const imageResourceId: string | undefined = imageIdData.data?.[fieldName]?.image?.id;

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
          where: { shop, resourceId, resourceType, key: 'image_alt_text', locale },
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
        where: { shop_resourceId_key_locale: { shop, resourceId, key: 'image_alt_text', locale } },
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
  }) {
    const { resourceId, translationKeys, foreignLocales } = params;

    if (translationKeys.length === 0 || foreignLocales.length === 0) {
      return { success: true };
    }

    loggers.translation('info', 'Deleting translations for keys', { translationKeys, foreignLocales });

    const response = await this.admin.graphql(
      `#graphql
        mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
          translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
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
  }) {
    const { resourceId, resourceType, locale, primaryLocale, updates, db, shop, policyType, changedFields } = params;

    if (locale !== primaryLocale) {
      // Handle translations
      // Fetch digest map and source values once
      const { digestMap, valueMap } = await this.loadTranslatableContent(resourceId);

      const translationsInput: Array<{ key: string; value: string; locale: string; translatableContentDigest: string }> = [];
      const translationsToDelete: string[] = [];
      const dbOnlyTranslations: Array<{ key: string; value: string; locale: string }> = [];

      // Map UI field names to Shopify translatable content keys.
      //
      // IMPORTANT — Shopify is inconsistent with body field naming:
      //   Product, Collection, Page, Article → translation key is "body_html"
      //   ShopPolicy                         → translation key is "body"
      //
      // This is a Shopify API inconsistency: the GraphQL *mutation* input for Page
      // and Article also uses "body", but the *translatable content* key (used in
      // translationsRegister and returned by translatableContent query) is "body_html".
      // ShopPolicy is the only resource type where both mutation and translation key
      // use plain "body".
      //
      // See also: docs/SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md
      const bodyKey = resourceType === 'ShopPolicy' ? 'body' : 'body_html';
      const keyMapping: Record<string, string> = {
        title: 'title',
        description: bodyKey,
        body: bodyKey,
        handle: 'handle',
        seoTitle: 'meta_title',
        metaDescription: 'meta_description',
        productType: 'product_type',
        summary: 'summary_html',
      };

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

      // Save non-empty translations to Shopify
      if (translationsInput.length > 0) {
        const response = await this.admin.graphql(TRANSLATE_CONTENT, {
          variables: {
            resourceId,
            translations: translationsInput
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

      // Delete cleared translations from Shopify
      if (translationsToDelete.length > 0) {
        await this.deleteAllTranslationsForKeys({
          resourceId,
          translationKeys: translationsToDelete,
          foreignLocales: [locale],
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
          // Upsert translations saved to Shopify
          for (const translation of translationsInput) {
            await tx.contentTranslation.upsert({
              where: {
                shop_resourceId_key_locale: {
                  shop,
                  resourceId,
                  key: translation.key,
                  locale: translation.locale,
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
              },
            });
          }

          // Upsert DB-only translations (no digest available, not saved to Shopify)
          for (const translation of dbOnlyTranslations) {
            await tx.contentTranslation.upsert({
              where: {
                shop_resourceId_key_locale: {
                  shop,
                  resourceId,
                  key: translation.key,
                  locale: translation.locale,
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
              },
            });
          }

          // Delete cleared translations from database (single batch call)
          if (translationsToDelete.length > 0) {
            await tx.contentTranslation.deleteMany({
              where: {
                shop,
                resourceId,
                resourceType,
                locale,
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

      if (resourceType === 'Page') {
        updatedResource = await this.updatePage(resourceId, {
          title: updates.title,
          handle: updates.handle,
          body: updates.description || updates.body,
          ...(updates.seoTitle !== undefined ? { seoTitle: updates.seoTitle } : {}),
          ...(updates.metaDescription !== undefined ? { seoDescription: updates.metaDescription } : {}),
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
            lastSyncedAt: new Date(),
          },
        });
      } else if (resourceType === 'Blog') {
        updatedResource = await this.updateBlog(resourceId, {
          title: updates.title,
          handle: updates.handle,
          ...(updates.seoTitle !== undefined ? { seoTitle: updates.seoTitle } : {}),
          ...(updates.metaDescription !== undefined ? { seoDescription: updates.metaDescription } : {}),
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
          ...(updates.imageAltText !== undefined ? { image: { altText: updates.imageAltText } } : {}),
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

      // Delete translations for changed fields across ALL foreign locales
      if (changedFields && changedFields.length > 0) {
        // Map UI field names to Shopify translation keys.
        // ShopPolicy uses "body", all other resource types use "body_html".
        // See comment at line ~293 for full explanation of this Shopify inconsistency.
        const bodyKey = resourceType === 'ShopPolicy' ? 'body' : 'body_html';
        const keyMapping: Record<string, string> = {
          title: 'title',
          description: bodyKey,
          body: bodyKey,
          handle: 'handle',
          seoTitle: 'meta_title',
          metaDescription: 'meta_description',
          productType: 'product_type',
          summary: 'summary_html',
        };

        const translationKeysToDelete = changedFields
          .map(field => keyMapping[field])
          .filter(key => key !== undefined);

        if (translationKeysToDelete.length > 0) {
          // Get all foreign locales
          const { shopLocales } = await this.loadShopLocales();
          const foreignLocales = shopLocales
            .filter((l: { locale: string; primary: boolean; published: boolean }) => !l.primary && l.published)
            .map((l: { locale: string }) => l.locale);

          if (foreignLocales.length > 0) {
            // Delete from Shopify
            await this.deleteAllTranslationsForKeys({
              resourceId,
              translationKeys: translationKeysToDelete,
              foreignLocales,
            });

            // Delete from database (single batch call instead of N×M loop)
            await db.contentTranslation.deleteMany({
              where: {
                shop,
                resourceId,
                resourceType,
                key: { in: translationKeysToDelete },
                locale: { in: foreignLocales },
              },
            });

            loggers.translation('info', `Deleted translations for fields: ${changedFields.join(', ')}`);
          }
        }
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
      translateProduct: (fields: Record<string, string>, locales: string[], contentType?: string, instructions?: string) => Promise<Record<string, Record<string, string>>>;
      translateShortFieldsBatch?: (fields: Record<string, string>, sourceLocale: string, targetLocales: string[], contentType?: string, instructions?: string) => Promise<Record<string, Record<string, string>>>;
    };
    db: PrismaClient;
    targetLocales?: string[];
    contentType?: string;
    taskId?: string;
    customInstructions?: string;
    sourceLocale?: string;
  }) {
    const { resourceId, resourceType, shop, fields, translationService, db, targetLocales: customTargetLocales, contentType, customInstructions, sourceLocale = 'en' } = params;

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

    // ShopPolicy uses "body", all other resource types use "body_html".
    // See comment in updateContent() (~line 293) for full explanation of this Shopify inconsistency.
    const bodyKey = resourceType === 'ShopPolicy' ? 'body' : 'body_html';
    const keyMapping: Record<string, string> = {
      title: 'title',
      description: bodyKey,
      body: bodyKey,
      handle: 'handle',
      seoTitle: 'meta_title',
      metaDescription: 'meta_description',
      productType: 'product_type',
      summary: 'summary_html',
    };

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
              where: { shop_resourceId_key_locale: { shop, resourceId, key: p.translationKey, locale: p.locale } },
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
          customInstructions
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
            const localeTranslations = await translationService.translateProduct(shortFields, [locale], contentType, customInstructions);
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
          const localeTranslations = await translationService.translateProduct(longFields, [locale], contentType, customInstructions);
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
