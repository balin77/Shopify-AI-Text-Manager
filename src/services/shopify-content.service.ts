/**
 * Shopify Content Service
 * Centralized service for managing Shopify content via GraphQL API
 */

import { TRANSLATE_CONTENT, UPDATE_PAGE, UPDATE_ARTICLE, UPDATE_SHOP_POLICY, UPDATE_COLLECTION } from "../../app/graphql/content.mutations";
import { GET_TRANSLATIONS, GET_TRANSLATABLE_CONTENT } from "../../app/graphql/content.queries";
import { loggers } from '../../app/utils/logger.server';
import { markTranslationSaved } from '../../app/utils/translation-save-lock.server';
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
   * Update a page
   */
  async updatePage(id: string, page: { title?: string; handle?: string; body?: string }) {
    const response = await this.admin.graphql(UPDATE_PAGE, {
      variables: { id, page }
    });

    const data = await response.json();

    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in updatePage: ${data.errors[0].message}`);
    }
    if (data.data?.pageUpdate?.userErrors?.length > 0) {
      throw new Error(data.data.pageUpdate.userErrors[0].message);
    }

    return data.data?.pageUpdate?.page;
  }

  /**
   * Update an article
   */
  async updateArticle(id: string, article: { title?: string; handle?: string; body?: string; summary?: string }) {
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
   * Update a collection
   */
  async updateCollection(id: string, collection: { title?: string; handle?: string; descriptionHtml?: string; seo?: { title?: string; description?: string } }) {
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
                resourceId_key_locale: {
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
                resourceId_key_locale: {
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

      return { success: true };
    } else {
      // Update primary locale
      let updatedResource;

      if (resourceType === 'Page') {
        // Note: Pages do NOT have SEO fields (seoTitle/seoDescription) in Shopify's API — this is by design, not a bug.
        updatedResource = await this.updatePage(resourceId, {
          title: updates.title,
          handle: updates.handle,
          body: updates.description || updates.body,
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
            lastSyncedAt: new Date(),
          },
        });
      } else if (resourceType === 'Article') {
        updatedResource = await this.updateArticle(resourceId, {
          title: updates.title,
          handle: updates.handle,
          body: updates.body,
          summary: updates.summary,
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
            lastSyncedAt: new Date(),
          },
        });
      } else if (resourceType === 'Collection') {
        updatedResource = await this.updateCollection(resourceId, {
          title: updates.title,
          handle: updates.handle,
          descriptionHtml: updates.description,
          seo: {
            title: updates.seoTitle,
            description: updates.metaDescription,
          },
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
    const { resourceId, resourceType, fields, translationService, db, targetLocales: customTargetLocales, contentType, customInstructions, sourceLocale = 'en' } = params;

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
        loggers.translation('warn', `No keyMapping for field '${field}'`);
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

    // Helper: save all prepared translations for one locale in ONE Shopify API call
    const saveTranslationsBatch = async (
      locale: string,
      prepared: Array<{ field: string; translationKey: string; value: string; digest: string }>
    ): Promise<Record<string, string>> => {
      if (prepared.length === 0) return {};

      const translationsInput = prepared.map(p => ({
        key: p.translationKey,
        value: p.value,
        locale,
        translatableContentDigest: p.digest,
      }));

      loggers.translation('debug', `Batch saving ${prepared.length} fields for locale ${locale}`, {
        fields: prepared.map(p => `${p.field}->${p.translationKey}`),
      });

      try {
        const response = await this.admin.graphql(TRANSLATE_CONTENT, {
          variables: { resourceId, translations: translationsInput }
        });

        const data = await response.json();

        // On batch-level errors, fall back to individual saves
        if (data.errors?.length > 0 || data.data?.translationsRegister?.userErrors?.length > 0) {
          const errors = data.errors || data.data?.translationsRegister?.userErrors;
          loggers.translation('error', `Batch save errors for locale ${locale}, falling back to individual saves`, { errors });
          return await saveTranslationsIndividually(locale, prepared);
        }

        loggers.translation('debug', `Batch Shopify save successful for locale ${locale} (${prepared.length} fields)`);

        // Save to DB after successful Shopify batch
        const saved: Record<string, string> = {};
        for (const p of prepared) {
          try {
            await db.contentTranslation.upsert({
              where: { resourceId_key_locale: { resourceId, key: p.translationKey, locale } },
              update: { value: p.value, digest: p.digest, resourceType },
              create: { resourceId, resourceType, key: p.translationKey, value: p.value, locale, digest: p.digest },
            });
          } catch (dbError) {
            loggers.translation('error', `DB save failed for ${p.field} (${locale}) after Shopify batch`, {
              error: dbError instanceof Error ? dbError.message : String(dbError),
            });
            // Shopify has the translation; next sync will reconcile DB
          }
          saved[p.field] = p.value;
        }
        return saved;
      } catch (err) {
        loggers.translation('error', `Unexpected error in batch save for locale ${locale}, falling back to individual saves`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return await saveTranslationsIndividually(locale, prepared);
      }
    };

    // Fallback: save translations one-by-one when batch fails
    const saveTranslationsIndividually = async (
      locale: string,
      prepared: Array<{ field: string; translationKey: string; value: string; digest: string }>
    ): Promise<Record<string, string>> => {
      const saved: Record<string, string> = {};
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
            continue;
          }
          await db.contentTranslation.upsert({
            where: { resourceId_key_locale: { resourceId, key: p.translationKey, locale } },
            update: { value: p.value, digest: p.digest, resourceType },
            create: { resourceId, resourceType, key: p.translationKey, value: p.value, locale, digest: p.digest },
          });
          saved[p.field] = p.value;
        } catch (fieldError) {
          loggers.translation('error', `Failed to save ${p.field} for ${locale}`, { error: fieldError instanceof Error ? fieldError.message : String(fieldError) });
          if (!rejectedFields[locale]) rejectedFields[locale] = [];
          rejectedFields[locale].push(p.field);
        }
      }
      return saved;
    };

    // Helper: prepare and batch-save all translated fields for a locale
    const saveLocaleTranslations = async (locale: string, translatedFields: Record<string, any>): Promise<void> => {
      const prepared: Array<{ field: string; translationKey: string; value: string; digest: string }> = [];
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
          if (p) prepared.push(p);
        }
      }
      const saved = await saveTranslationsBatch(locale, prepared);
      Object.assign(allTranslations[locale], saved);
    };

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

        // Batch-save per locale (1 Shopify API call per locale instead of per field)
        for (const locale of targetLocales) {
          const localeTranslations = batchResult[locale];
          if (!localeTranslations) continue;
          await saveLocaleTranslations(locale, localeTranslations);
        }

        loggers.translation('debug', 'Batch short fields completed');
      } catch (batchError: unknown) {
        loggers.translation('error', 'Batch short fields failed', { error: batchError instanceof Error ? batchError.message : String(batchError) });
        // Fallback: translate short fields sequentially
        loggers.translation('warn', 'Falling back to sequential for short fields...');
        for (const locale of targetLocales) {
          try {
            const localeTranslations = await translationService.translateProduct(shortFields, [locale], contentType, customInstructions);
            const translatedFields = localeTranslations[locale];
            if (translatedFields) {
              await saveLocaleTranslations(locale, translatedFields);
            }
          } catch (localeError: unknown) {
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
            await saveLocaleTranslations(locale, translatedFields);
          }
        } catch (localeError: unknown) {
          loggers.translation('error', `Failed to translate long fields to ${locale}`, { error: localeError instanceof Error ? localeError.message : String(localeError) });
          if (!failedLocales.includes(locale)) failedLocales.push(locale);
        }
      }
    }

    if (failedLocales.length > 0) {
      loggers.translation('warn', `translateAllContent completed with failures`, { failedLocales, successLocales: targetLocales.filter(l => !failedLocales.includes(l)) });
    }
    loggers.translation('info', 'translateAllContent FINAL', { locales: Object.keys(allTranslations), failedLocales, rejectedFields, skippedFields });
    return { translations: allTranslations, failedLocales, rejectedFields, skippedFields };
  }
}
