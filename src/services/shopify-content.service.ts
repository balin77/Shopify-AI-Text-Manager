/**
 * Shopify Content Service
 * Centralized service for managing Shopify content via GraphQL API
 */

import { TRANSLATE_CONTENT, UPDATE_PAGE, UPDATE_ARTICLE, UPDATE_SHOP_POLICY, UPDATE_COLLECTION } from "../../app/graphql/content.mutations";
import { GET_TRANSLATIONS, GET_TRANSLATABLE_CONTENT } from "../../app/graphql/content.queries";

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

    console.log('[TRANSLATIONS-DELETE] Deleting translations for keys:', translationKeys, 'locales:', foreignLocales);

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
      console.error('[TRANSLATIONS-DELETE] Error:', data.data.translationsRemove.userErrors);
      throw new Error(data.data.translationsRemove.userErrors[0].message);
    }

    console.log('[TRANSLATIONS-DELETE] Successfully deleted translations');
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
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

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

      const translationsInput: Array<{ key: string; value: string; locale: string; translatableContentDigest?: string }> = [];

      // Map field names to Shopify translation keys
      const keyMapping: Record<string, string> = {
        title: 'title',
        description: (resourceType === 'Page' || resourceType === 'Collection') ? 'body_html' : 'body',
        body: resourceType === 'Page' ? 'body_html' : 'body',
        handle: 'handle',
        seoTitle: 'meta_title',
        metaDescription: 'meta_description',
      };

      Object.entries(updates).forEach(([field, value]) => {
        if (value && keyMapping[field]) {
          const translationKey = keyMapping[field];
          translationsInput.push({
            key: translationKey,
            value,
            locale,
            translatableContentDigest: digestMap[translationKey]
          });
        }
      });

      // Save to Shopify with digests
      if (translationsInput.length > 0) {
        const response = await this.admin.graphql(TRANSLATE_CONTENT, {
          variables: {
            resourceId,
            translations: translationsInput
          }
        });

        const data = await response.json();

        if (data.data?.translationsRegister?.userErrors?.length > 0) {
          throw new Error(data.data.translationsRegister.userErrors[0].message);
        }
      }

      // Update database - use upsert to preserve existing translations
      if (translationsInput.length > 0) {
        for (const translation of translationsInput) {
          await db.contentTranslation.upsert({
            where: {
              resourceId_resourceType_locale_key: {
                resourceId,
                resourceType,
                locale: translation.locale,
                key: translation.key,
              },
            },
            update: {
              value: translation.value,
              digest: translation.translatableContentDigest || null,
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
          description: (resourceType === 'Page' || resourceType === 'Collection') ? 'body_html' : 'body',
          body: resourceType === 'Page' ? 'body_html' : 'body',
          handle: 'handle',
          seoTitle: 'meta_title',
          metaDescription: 'meta_description',
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

            console.log(`[PRIMARY-UPDATE] Deleted translations for fields: ${changedFields.join(', ')}`);
          }
        }
      }

      return { success: true, item: updatedResource };
    }
  }

  /**
   * Batch translate all fields for all target locales
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
  }) {
    const { resourceId, resourceType, fields, translationService, db, targetLocales: customTargetLocales, contentType } = params;

    // Fetch digest map once for all translations
    const digestMap = await this.loadTranslatableContent(resourceId);

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

    // Translate to all target locales
    for (const locale of targetLocales) {
      try {
        console.log(`🔶 [translateAllContent] Translating to ${locale}, source fields:`, Object.keys(fields).map(k => `${k}: "${(fields[k] || '').substring(0, 30)}..."`));
        const localeTranslations = await translationService.translateProduct(fields, [locale], contentType);
        const translatedFields = localeTranslations[locale];
        console.log(`🔶 [translateAllContent] AI returned for ${locale}:`, translatedFields ? Object.keys(translatedFields).map(k => `${k}: "${(translatedFields[k] || '').substring(0, 30)}..."`) : 'NONE');

        if (translatedFields) {
          allTranslations[locale] = translatedFields;

          // Map to Shopify translation keys
          const translationsInput: Array<{ key: string; value: string; locale: string; translatableContentDigest?: string }> = [];

          const keyMapping: Record<string, string> = {
            title: 'title',
            description: (resourceType === 'Page' || resourceType === 'Collection') ? 'body_html' : 'body',
            body: resourceType === 'Page' ? 'body_html' : 'body',
            handle: 'handle',
            seoTitle: 'meta_title',
            metaDescription: 'meta_description',
          };

          Object.entries(translatedFields).forEach(([field, value]) => {
            if (value && keyMapping[field]) {
              // Ensure value is a string, not an object
              let stringValue: string;
              if (typeof value === 'string') {
                stringValue = value;
              } else if (typeof value === 'object' && value !== null) {
                // If value is an object, try to extract the actual string value
                console.error(`[translateAllContent] Warning: Field '${field}' has object value:`, value);
                stringValue = (value as any).value || JSON.stringify(value);
              } else {
                stringValue = String(value);
              }

              // IMPORTANT: Skip if the "translation" is the same as the source text
              // This prevents storing the source text as a translation when AI fails
              const sourceValue = fields[field];
              if (sourceValue && stringValue.trim() === sourceValue.trim()) {
                console.warn(`[translateAllContent] Skipping field '${field}' for locale '${locale}' - translation is same as source text`);
                return;
              }

              const translationKey = keyMapping[field];
              translationsInput.push({
                key: translationKey,
                value: stringValue,
                locale,
                translatableContentDigest: digestMap[translationKey]
              });
            }
          });

          // Save to Shopify - send translations directly with digests
          if (translationsInput.length > 0) {
            const response = await this.admin.graphql(TRANSLATE_CONTENT, {
              variables: {
                resourceId,
                translations: translationsInput
              }
            });

            const data = await response.json();

            if (data.data?.translationsRegister?.userErrors?.length > 0) {
              console.error(`[translateAllContent] Error saving translations for ${locale}:`,
                data.data.translationsRegister.userErrors);
            }
          }

          // Update database - use upsert to preserve existing translations
          if (translationsInput.length > 0) {
            for (const translation of translationsInput) {
              await db.contentTranslation.upsert({
                where: {
                  resourceId_resourceType_locale_key: {
                    resourceId,
                    resourceType,
                    locale: translation.locale,
                    key: translation.key,
                  },
                },
                update: {
                  value: translation.value,
                  digest: translation.translatableContentDigest || null,
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
          }
        }
      } catch (localeError: any) {
        console.error(`Failed to translate to ${locale}:`, localeError);
      }
    }

    return allTranslations;
  }
}
