/**
 * Shopify Content Service
 * Centralized service for managing Shopify content via GraphQL API
 */

import { TRANSLATE_CONTENT, UPDATE_PAGE, UPDATE_ARTICLE, UPDATE_SHOP_POLICY, UPDATE_COLLECTION } from "../../app/graphql/content.mutations";
import { GET_TRANSLATIONS, GET_TRANSLATABLE_CONTENT } from "../../app/graphql/content.queries";
import { loggers } from '../../app/utils/logger.server';

export interface ShopifyAdminClient {
  graphql: (query: string, options?: { variables?: Record<string, any> }) => Promise<Response>;
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

    const data = await response.json();
    return data.data?.translatableResource?.translations || [];
  }

  /**
   * Load translatable content with digests for a resource
   */
  async loadTranslatableContent(resourceId: string) {
    const response = await this.admin.graphql(GET_TRANSLATABLE_CONTENT, {
      variables: { resourceId }
    });

    const data = await response.json();
    const content = data.data?.translatableResource?.translatableContent || [];

    // Create digest map for quick lookup
    const digestMap: Record<string, string> = {};
    content.forEach((item: any) => {
      digestMap[item.key] = item.digest;
    });

    // Diagnostic: log all returned keys with digest presence
    loggers.translation('debug', `Resource ${resourceId} - returned ${content.length} translatable fields`, { fields: content.map((c: any) => `${c.key}=${c.digest ? 'HAS_DIGEST' : 'NO_DIGEST'}(val=${c.value ? c.value.substring(0, 30) : 'EMPTY'})`) });

    return digestMap;
  }

  /**
   * Save translations for a resource
   */
  async saveTranslations(resourceId: string, translations: Array<{ key: string; value: string; locale: string }>) {
    // Fetch digest map first
    const digestMap = await this.loadTranslatableContent(resourceId);

    // Add digests to translations
    const translationsWithDigests = translations.map(t => ({
      ...t,
      translatableContentDigest: digestMap[t.key]
    }));

    const response = await this.admin.graphql(TRANSLATE_CONTENT, {
      variables: {
        resourceId,
        translations: translationsWithDigests
      }
    });

    const data = await response.json();

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

    if (data.data?.pageUpdate?.userErrors?.length > 0) {
      throw new Error(data.data.pageUpdate.userErrors[0].message);
    }

    return data.data?.pageUpdate?.page;
  }

  /**
   * Update an article
   */
  async updateArticle(id: string, article: { title?: string; handle?: string; body?: string }) {
    const response = await this.admin.graphql(UPDATE_ARTICLE, {
      variables: { id, article }
    });

    const data = await response.json();

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

    const data = await response.json();
    const shopLocales = data.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "en";

    return { shopLocales, primaryLocale };
  }

  /**
   * Update content in Shopify and database
   * Handles both primary locale updates and translations
   * When updating primary locale, deletes all translations for changed fields
   */
  async updateContent(params: {
    resourceId: string;
    resourceType: 'Page' | 'Article' | 'ShopPolicy' | 'Collection';
    locale: string;
    primaryLocale: string;
    updates: Record<string, string>;
    db: any;
    shop: string;
    policyType?: string;
    changedFields?: string[]; // Fields that changed in primary locale - their translations will be deleted
  }) {
    const { resourceId, resourceType, locale, primaryLocale, updates, db, shop, policyType, changedFields } = params;

    if (locale !== primaryLocale) {
      // Handle translations
      // Fetch digest map once
      const digestMap = await this.loadTranslatableContent(resourceId);

      const translationsInput: Array<{ key: string; value: string; locale: string; translatableContentDigest: string }> = [];
      const translationsToDelete: string[] = [];
      const dbOnlyTranslations: Array<{ key: string; value: string; locale: string }> = [];

      // Map field names to Shopify translation keys
      // Note: ShopPolicy uses 'body' (not 'body_html') as its translatable content key
      const bodyKey = resourceType === 'ShopPolicy' ? 'body' : 'body_html';
      const keyMapping: Record<string, string> = {
        title: 'title',
        description: bodyKey,
        body: bodyKey,
        handle: 'handle',
        seoTitle: 'meta_title',
        metaDescription: 'meta_description',
        productType: 'product_type',
        summary: 'summary_html',   // Article excerpt/summary
      };

      for (const [field, value] of Object.entries(updates)) {
        const translationKey = keyMapping[field];
        if (!translationKey) continue;

        if (value && value.trim()) {
          let digest = digestMap[translationKey];

          // If digest is missing, retry (handles race conditions / late availability)
          if (!digest) {
            loggers.translation('warn', `[updateContent] No digest for '${translationKey}' in initial digestMap. Re-fetching...`);
            const freshDigestMap = await this.loadTranslatableContent(resourceId);
            digest = freshDigestMap[translationKey];
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

      // Update database using transaction for consistency
      await db.$transaction(async (tx: any) => {
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

        // Delete cleared translations from database
        for (const key of translationsToDelete) {
          await tx.contentTranslation.deleteMany({
            where: {
              resourceId,
              resourceType,
              locale,
              key,
            },
          });
        }
      });

      return { success: true };
    } else {
      // Update primary locale
      let updatedResource;

      if (resourceType === 'Page') {
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
      }

      // Delete translations for changed fields across ALL foreign locales
      if (changedFields && changedFields.length > 0) {
        // Map UI field names to Shopify translation keys
        const keyMapping: Record<string, string> = {
          title: 'title',
          description: 'body_html',  // Always body_html for all resource types
          body: 'body_html',         // Always body_html for all resource types
          handle: 'handle',
          seoTitle: 'meta_title',
          metaDescription: 'meta_description',
          productType: 'product_type',
          summary: 'summary_html',   // Article excerpt/summary
        };

        const translationKeysToDelete = changedFields
          .map(field => keyMapping[field])
          .filter(key => key !== undefined);

        if (translationKeysToDelete.length > 0) {
          // Get all foreign locales
          const { shopLocales } = await this.loadShopLocales();
          const foreignLocales = shopLocales
            .filter((l: any) => !l.primary && l.published)
            .map((l: any) => l.locale);

          if (foreignLocales.length > 0) {
            // Delete from Shopify
            await this.deleteAllTranslationsForKeys({
              resourceId,
              translationKeys: translationKeysToDelete,
              foreignLocales,
            });

            // Delete from database
            for (const key of translationKeysToDelete) {
              for (const locale of foreignLocales) {
                await db.contentTranslation.deleteMany({
                  where: {
                    resourceId,
                    resourceType,
                    key,
                    locale,
                  },
                });
              }
            }

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
    resourceType: 'Page' | 'Article' | 'ShopPolicy' | 'Collection';
    fields: Record<string, string>;
    translationService: any;
    db: any;
    targetLocales?: string[];
    contentType?: string;
    taskId?: string;
    customInstructions?: string;
    sourceLocale?: string;
  }) {
    const { resourceId, resourceType, fields, translationService, db, targetLocales: customTargetLocales, contentType, customInstructions, sourceLocale = 'de' } = params;

    // Fetch digest map once for all translations
    const digestMap = await this.loadTranslatableContent(resourceId);
    loggers.translation('debug', `translateAllContent resourceType: ${resourceType}`);
    loggers.translation('debug', 'translateAllContent fields received', { fields: Object.keys(fields) });
    loggers.translation('debug', 'translateAllContent fields values', { values: Object.entries(fields).map(([k, v]) => `${k}=${v ? (v as string).substring(0, 50) + '...' : 'EMPTY'}`) });
    loggers.translation('debug', `translateAllContent digestMap keys for ${resourceId}`, { keys: Object.keys(digestMap) });
    loggers.translation('debug', 'translateAllContent has summary_html digest', { hasSummaryHtmlDigest: !!digestMap['summary_html'] });

    // Get target locales (use custom list if provided, otherwise all published locales)
    let targetLocales: string[];
    if (customTargetLocales) {
      targetLocales = customTargetLocales;
    } else {
      const { shopLocales } = await this.loadShopLocales();
      targetLocales = shopLocales
        .filter((l: any) => !l.primary && l.published)
        .map((l: any) => l.locale);
    }

    const allTranslations: Record<string, any> = {};

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

    const keyMapping: Record<string, string> = {
      title: 'title',
      description: 'body_html',
      body: 'body_html',
      handle: 'handle',
      seoTitle: 'meta_title',
      metaDescription: 'meta_description',
      productType: 'product_type',
      summary: 'summary_html',   // Article excerpt/summary
    };

    // Helper function to save translations to Shopify and DB
    const saveTranslation = async (locale: string, field: string, value: string) => {
      const translationKey = keyMapping[field];
      if (!translationKey) {
        loggers.translation('warn', `No keyMapping for field '${field}'`);
        return;
      }

      // Skip if translation is same as source
      const sourceValue = fields[field];
      if (sourceValue && value.trim() === sourceValue.trim()) {
        loggers.translation('warn', `Skipping field '${field}' for locale '${locale}' - same as source`);
        return;
      }

      let digest = digestMap[translationKey];

      // If digest is missing, try to re-fetch (handles race conditions / late availability)
      if (!digest) {
        loggers.translation('warn', `No digest for '${translationKey}' in initial digestMap. Re-fetching translatableContent...`);
        const freshDigestMap = await this.loadTranslatableContent(resourceId);
        digest = freshDigestMap[translationKey];
        if (digest) {
          // Cache the fresh digest for subsequent saves
          digestMap[translationKey] = digest;
          loggers.translation('debug', `Got digest for '${translationKey}' on retry`);
        } else {
          loggers.translation('warn', `Still no digest for '${translationKey}' after retry. Shopify may not support translating this field. Saving to DB only.`, { availableKeys: Object.keys(freshDigestMap).join(', ') });
        }
      }

      // Save to Shopify and DB (requires digest)
      if (digest) {
        loggers.translation('debug', `Saving ${field} -> ${translationKey} for locale ${locale}`);
        const response = await this.admin.graphql(TRANSLATE_CONTENT, {
          variables: {
            resourceId,
            translations: [{
              key: translationKey,
              value,
              locale,
              translatableContentDigest: digest
            }]
          }
        });

        const data = await response.json();
        if (data.data?.translationsRegister?.userErrors?.length > 0) {
          loggers.translation('error', `Shopify error saving ${field} for ${locale}`, { errors: data.data.translationsRegister.userErrors });
        } else {
          loggers.translation('debug', `Shopify save successful for ${field} -> ${translationKey} (${locale})`);
        }

        // Save to database (only after successful Shopify save)
        await db.contentTranslation.upsert({
          where: {
            resourceId_key_locale: {
              resourceId,
              key: translationKey,
              locale,
            },
          },
          update: {
            value,
            digest,
            resourceType,
          },
          create: {
            resourceId,
            resourceType,
            key: translationKey,
            value,
            locale,
            digest,
          },
        });
      } else {
        loggers.translation('warn', `No digest for '${translationKey}' after retry. Translation NOT saved. Shopify translatableContent does not include this field - is the primary locale value set in Shopify?`);
      }
    };

    // === STEP 1: Batch translate short fields (1 AI request for all locales) ===
    if (hasShortFields) {
      try {
        loggers.translation('debug', `Batch translating short fields to ${targetLocales.length} locales`, { shortFields: Object.keys(shortFields) });

        const batchResult = await translationService.translateShortFieldsBatch(
          shortFields,
          sourceLocale,
          targetLocales,
          contentType || 'product'
        );

        // Save all short field translations
        for (const locale of targetLocales) {
          const localeTranslations = batchResult[locale];
          if (!localeTranslations) continue;

          for (const [field, value] of Object.entries(localeTranslations)) {
            if (value) {
              allTranslations[locale][field] = value;
              await saveTranslation(locale, field, value as string);
            }
          }
        }

        loggers.translation('debug', 'Batch short fields completed');
      } catch (batchError: any) {
        loggers.translation('error', 'Batch short fields failed', { error: batchError?.message || String(batchError) });
        // Fallback: translate short fields sequentially
        loggers.translation('warn', 'Falling back to sequential for short fields...');
        for (const locale of targetLocales) {
          try {
            const localeTranslations = await translationService.translateProduct(shortFields, [locale], contentType, customInstructions);
            const translatedFields = localeTranslations[locale];
            if (translatedFields) {
              for (const [field, value] of Object.entries(translatedFields)) {
                if (value) {
                  allTranslations[locale][field] = value;
                  await saveTranslation(locale, field, value as string);
                }
              }
            }
          } catch (localeError: any) {
            loggers.translation('error', `Fallback failed for ${locale}`, { error: localeError?.message || String(localeError) });
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
            for (const [field, value] of Object.entries(translatedFields)) {
              if (value) {
                // Ensure value is a string
                let stringValue: string;
                if (typeof value === 'string') {
                  stringValue = value;
                } else if (typeof value === 'object' && value !== null) {
                  stringValue = (value as any).value || JSON.stringify(value);
                } else {
                  stringValue = String(value);
                }

                allTranslations[locale][field] = stringValue;
                await saveTranslation(locale, field, stringValue);
              }
            }
          }
        } catch (localeError: any) {
          loggers.translation('error', `Failed to translate long fields to ${locale}`, { error: localeError?.message || String(localeError) });
        }
      }
    }

    loggers.translation('info', 'translateAllContent FINAL', { locales: Object.keys(allTranslations) });
    return allTranslations;
  }
}
