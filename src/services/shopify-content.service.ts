/**
 * Shopify Content Service
 * Centralized service for managing Shopify content via GraphQL API
 */

import { TRANSLATE_CONTENT, UPDATE_PAGE, UPDATE_ARTICLE, UPDATE_SHOP_POLICY } from "../../app/graphql/content.mutations";
import { GET_TRANSLATIONS } from "../../app/graphql/content.queries";

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
   * Save translations for a resource
   */
  async saveTranslations(resourceId: string, translations: Array<{ key: string; value: string; locale: string }>) {
    const response = await this.admin.graphql(TRANSLATE_CONTENT, {
      variables: {
        resourceId,
        translations
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
   */
  async updateContent(params: {
    resourceId: string;
    resourceType: 'Page' | 'Article' | 'ShopPolicy';
    locale: string;
    primaryLocale: string;
    updates: Record<string, string>;
    db: any;
    shop: string;
    policyType?: string;
  }) {
    const { resourceId, resourceType, locale, primaryLocale, updates, db, shop, policyType } = params;

    if (locale !== primaryLocale) {
      // Handle translations
      const translationsInput: Array<{ key: string; value: string; locale: string }> = [];

      // Map field names to Shopify translation keys
      const keyMapping: Record<string, string> = {
        title: 'title',
        description: resourceType === 'Page' ? 'body_html' : 'body',
        body: 'body',
        handle: 'handle',
        seoTitle: 'meta_title',
        metaDescription: 'meta_description',
      };

      Object.entries(updates).forEach(([field, value]) => {
        if (value && keyMapping[field]) {
          translationsInput.push({
            key: keyMapping[field],
            value,
            locale
          });
        }
      });

      // Save to Shopify (one field at a time to avoid conflicts)
      for (const translation of translationsInput) {
        await this.saveTranslations(resourceId, [translation]);
      }

      // Update database
      await db.contentTranslation.deleteMany({
        where: { resourceId, resourceType, locale },
      });

      if (translationsInput.length > 0) {
        await db.contentTranslation.createMany({
          data: translationsInput.map(t => ({
            resourceId,
            resourceType,
            key: t.key,
            value: t.value,
            locale: t.locale,
            digest: null,
          })),
          skipDuplicates: true,
        });
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

      return { success: true, item: updatedResource };
    }
  }

  /**
   * Batch translate all fields for all target locales
   */
  async translateAllContent(params: {
    resourceId: string;
    resourceType: 'Page' | 'Article' | 'ShopPolicy';
    fields: Record<string, string>;
    translationService: any;
    db: any;
    targetLocales?: string[];
    aiInstructions?: any;
    contentType?: string;
  }) {
    const { resourceId, resourceType, fields, translationService, db, targetLocales: customTargetLocales, aiInstructions, contentType } = params;

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
        const localeTranslations = await translationService.translateProduct(fields, [locale], aiInstructions, contentType);
        const translatedFields = localeTranslations[locale];

        if (translatedFields) {
          allTranslations[locale] = translatedFields;

          // Map to Shopify translation keys
          const translationsInput: Array<{ key: string; value: string; locale: string }> = [];

          const keyMapping: Record<string, string> = {
            title: 'title',
            description: resourceType === 'Page' ? 'body_html' : 'body',
            body: 'body',
            handle: 'handle',
            seoTitle: 'meta_title',
            metaDescription: 'meta_description',
          };

          Object.entries(translatedFields).forEach(([field, value]) => {
            if (value && keyMapping[field]) {
              translationsInput.push({
                key: keyMapping[field],
                value: value as string,
                locale
              });
            }
          });

          // Save to Shopify (one at a time to avoid conflicts)
          for (const translation of translationsInput) {
            await this.saveTranslations(resourceId, [translation]);
          }

          // Update database
          await db.contentTranslation.deleteMany({
            where: { resourceId, resourceType, locale },
          });

          if (translationsInput.length > 0) {
            await db.contentTranslation.createMany({
              data: translationsInput.map(t => ({
                resourceId,
                resourceType,
                key: t.key,
                value: t.value,
                locale: t.locale,
                digest: null,
              })),
              skipDuplicates: true,
            });
          }
        }
      } catch (localeError: any) {
        console.error(`Failed to translate to ${locale}:`, localeError);
      }
    }

    return allTranslations;
  }
}
