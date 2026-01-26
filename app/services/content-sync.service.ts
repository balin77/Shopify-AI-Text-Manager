/**
 * Content Sync Service
 *
 * Synchronizes content data (Collections, Articles) from Shopify to local PostgreSQL database
 * including all translations for all available locales.
 *
 * Note: Pages and Policies are NOT cached as they don't have webhook support and are rarely modified.
 */

interface ShopifyGraphQLClient {
  graphql: (query: string, options?: { variables?: any }) => Promise<any>;
}

export class ContentSyncService {
  constructor(
    private admin: ShopifyGraphQLClient,
    private shop: string
  ) {}

  // ============================================
  // COLLECTION SYNC
  // ============================================

  /**
   * Sync a single collection with all its translations
   */
  async syncCollection(collectionId: string): Promise<void> {
    console.log(`[ContentSync] Starting sync for collection: ${collectionId}`);

    try {
      // 1. Fetch collection data
      const collectionData = await this.fetchCollectionData(collectionId);

      if (!collectionData) {
        console.warn(`[ContentSync] Collection not found: ${collectionId}`);
        return;
      }

      // 2. Fetch all available locales
      const locales = await this.fetchShopLocales();
      console.log(`[ContentSync] Found ${locales.length} locales`);

      // 3. Fetch translations for all non-primary locales
      const allTranslations = await this.fetchAllTranslations(
        collectionId,
        locales.filter((l: any) => !l.primary),
        "Collection"
      );
      console.log(`[ContentSync] Fetched ${allTranslations.length} translations`);

      // 4. Save to database
      await this.saveCollectionToDatabase(collectionData, allTranslations);

      console.log(`[ContentSync] Successfully synced collection: ${collectionId}`);
    } catch (error) {
      console.error(`[ContentSync] Error syncing collection ${collectionId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a collection from the database
   */
  async deleteCollection(collectionId: string): Promise<void> {
    console.log(`[ContentSync] Deleting collection: ${collectionId}`);

    const { db } = await import("../db.server");

    await db.collection.delete({
      where: {
        shop_id: {
          shop: this.shop,
          id: collectionId,
        },
      },
    });

    console.log(`[ContentSync] Successfully deleted collection: ${collectionId}`);
  }

  // ============================================
  // ARTICLE (BLOG) SYNC
  // ============================================

  /**
   * Sync a single article with all its translations
   */
  async syncArticle(articleId: string): Promise<void> {
    console.log(`[ContentSync] Starting sync for article: ${articleId}`);

    try {
      // 1. Fetch article data
      const articleData = await this.fetchArticleData(articleId);

      if (!articleData) {
        console.warn(`[ContentSync] Article not found: ${articleId}`);
        return;
      }

      // 2. Fetch all available locales
      const locales = await this.fetchShopLocales();

      // 3. Fetch translations
      const allTranslations = await this.fetchAllTranslations(
        articleId,
        locales.filter((l: any) => !l.primary),
        "Article"
      );

      // 4. Save to database
      await this.saveArticleToDatabase(articleData, allTranslations);

      console.log(`[ContentSync] Successfully synced article: ${articleId}`);
    } catch (error) {
      console.error(`[ContentSync] Error syncing article ${articleId}:`, error);
      throw error;
    }
  }

  /**
   * Delete an article from the database
   */
  async deleteArticle(articleId: string): Promise<void> {
    console.log(`[ContentSync] Deleting article: ${articleId}`);

    const { db } = await import("../db.server");

    await db.article.delete({
      where: {
        shop_id: {
          shop: this.shop,
          id: articleId,
        },
      },
    });

    console.log(`[ContentSync] Successfully deleted article: ${articleId}`);
  }

  // ============================================
  // MENU SYNC
  // ============================================

  /**
   * Sync a single menu with its items structure
   */
  async syncMenu(menuId: string): Promise<void> {
    console.log(`[ContentSync] Starting sync for menu: ${menuId}`);

    try {
      // 1. Fetch menu data
      const menuData = await this.fetchMenuData(menuId);

      if (!menuData) {
        console.warn(`[ContentSync] Menu not found: ${menuId}`);
        return;
      }

      // 2. Save to database (menus don't have translations via API)
      await this.saveMenuToDatabase(menuData);

      console.log(`[ContentSync] Successfully synced menu: ${menuId}`);
    } catch (error) {
      console.error(`[ContentSync] Error syncing menu ${menuId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a menu from the database
   */
  async deleteMenu(menuId: string): Promise<void> {
    console.log(`[ContentSync] Deleting menu: ${menuId}`);

    const { db } = await import("../db.server");

    await db.menu.delete({
      where: {
        shop_id: {
          shop: this.shop,
          id: menuId,
        },
      },
    });

    console.log(`[ContentSync] Successfully deleted menu: ${menuId}`);
  }


  // ============================================
  // FETCH DATA FROM SHOPIFY
  // ============================================

  private async fetchCollectionData(collectionId: string) {
    const response = await this.admin.graphql(
      `#graphql
        query getCollection($id: ID!) {
          collection(id: $id) {
            id
            title
            handle
            descriptionHtml
            updatedAt
            seo {
              title
              description
            }
          }
        }`,
      { variables: { id: collectionId } }
    );

    const data = await response.json();
    return data.data?.collection || null;
  }

  private async fetchArticleData(articleId: string) {
    const response = await this.admin.graphql(
      `#graphql
        query getArticle($id: ID!) {
          article(id: $id) {
            id
            title
            handle
            body
            updatedAt
            blog {
              id
              title
            }
            seo {
              title
              description
            }
          }
        }`,
      { variables: { id: articleId } }
    );

    const data = await response.json();
    return data.data?.article || null;
  }

  private async fetchMenuData(menuId: string) {
    const response = await this.admin.graphql(
      `#graphql
        query getMenu($id: ID!) {
          menu(id: $id) {
            id
            title
            handle
            items {
              id
              title
              url
              type
              items {
                id
                title
                url
                type
                items {
                  id
                  title
                  url
                  type
                  items {
                    id
                    title
                    url
                    type
                  }
                }
              }
            }
          }
        }`,
      { variables: { id: menuId } }
    );

    const data = await response.json();
    return data.data?.menu || null;
  }


  private async fetchShopLocales() {
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
    return data.data?.shopLocales || [];
  }

  /**
   * Fetch translations for all locales
   *
   * IMPORTANT: Only saves ACTUAL translations from Shopify.
   * If a field has no translation in Shopify, it will NOT be stored in the database.
   * This prevents the primary language text from appearing as a "translation".
   */
  private async fetchAllTranslations(resourceId: string, locales: any[], resourceType: string) {
    const allTranslationsMap = new Map<string, any>(); // Deduplicate using key::locale

    for (const locale of locales) {
      if (!locale.published) {
        console.log(`[ContentSync] Skipping unpublished locale: ${locale.locale}`);
        continue;
      }

      console.log(`[ContentSync] Fetching translations for locale: ${locale.locale}`);

      const response = await this.admin.graphql(
        `#graphql
          query getTranslations($resourceId: ID!, $locale: String!) {
            translatableResource(resourceId: $resourceId) {
              translatableContent {
                key
                value
                digest
                locale
              }
              translations(locale: $locale) {
                key
                value
                locale
              }
            }
          }`,
        { variables: { resourceId, locale: locale.locale } }
      );

      const data = await response.json();
      const resource = data.data?.translatableResource;

      if (!resource) continue;

      const digestMap = new Map<string, string>();

      // Build digest map from translatableContent (for reference only)
      // DO NOT store these as translations - they are source language text
      if (resource.translatableContent) {
        for (const content of resource.translatableContent) {
          digestMap.set(content.key, content.digest);
        }
      }

      // ONLY save actual translations from Shopify
      // DO NOT save translatableContent values - those are the source language text
      if (resource.translations && resource.translations.length > 0) {
        console.log(`[ContentSync] Actual translations for ${locale.locale}:`,
          resource.translations.map((t: any) => t.key).join(', '));

        for (const translation of resource.translations) {
          const uniqueKey = `${translation.key}::${translation.locale}`;
          if (!allTranslationsMap.has(uniqueKey)) {
            allTranslationsMap.set(uniqueKey, {
              key: translation.key,
              value: translation.value,
              locale: translation.locale,
              digest: digestMap.get(translation.key),
              resourceType,
            });
          }
        }

        console.log(`[ContentSync] Saved ${resource.translations.length} actual translations for ${locale.locale}`);
      } else {
        console.log(`[ContentSync] No translations found for ${locale.locale} - nothing to save`);
      }
    }

    return Array.from(allTranslationsMap.values());
  }

  // ============================================
  // SAVE TO DATABASE
  // ============================================

  private async saveCollectionToDatabase(collectionData: any, translations: any[]) {
    const { db } = await import("../db.server");

    console.log(`[ContentSync] Saving collection to database: ${collectionData.id}`);

    // Prepare valid translations outside transaction
    const validTranslations = translations.filter(t => t.value != null && t.value !== undefined);
    const skippedCount = translations.length - validTranslations.length;
    if (skippedCount > 0) {
      console.log(`[ContentSync] Skipping ${skippedCount} translations with null/undefined values`);
    }

    // Use transaction to ensure all-or-nothing data consistency
    await db.$transaction(async (tx) => {
      // Upsert collection
      await tx.collection.upsert({
        where: {
          shop_id: {
            shop: this.shop,
            id: collectionData.id,
          },
        },
        create: {
          id: collectionData.id,
          shop: this.shop,
          title: collectionData.title,
          descriptionHtml: collectionData.descriptionHtml || "",
          handle: collectionData.handle,
          seoTitle: collectionData.seo?.title || null,
          seoDescription: collectionData.seo?.description || null,
          shopifyUpdatedAt: new Date(collectionData.updatedAt),
          lastSyncedAt: new Date(),
        },
        update: {
          title: collectionData.title,
          descriptionHtml: collectionData.descriptionHtml || "",
          handle: collectionData.handle,
          seoTitle: collectionData.seo?.title || null,
          seoDescription: collectionData.seo?.description || null,
          shopifyUpdatedAt: new Date(collectionData.updatedAt),
          lastSyncedAt: new Date(),
        },
      });

      // Delete old translations
      await tx.contentTranslation.deleteMany({
        where: {
          resourceId: collectionData.id,
          resourceType: "Collection",
        },
      });

      // Insert new translations
      if (validTranslations.length > 0) {
        await tx.contentTranslation.createMany({
          data: validTranslations.map(t => ({
            resourceId: collectionData.id,
            resourceType: "Collection",
            key: t.key,
            value: t.value,
            locale: t.locale,
            digest: t.digest || null,
          })),
        });
        console.log(`[ContentSync] ✓ Saved ${validTranslations.length} translations`);
      }
    });

    console.log(`[ContentSync] ✓ Transaction completed successfully for collection ${collectionData.id}`);
  }

  private async saveArticleToDatabase(articleData: any, translations: any[]) {
    const { db } = await import("../db.server");

    console.log(`[ContentSync] Saving article to database: ${articleData.id}`);

    // Prepare valid translations outside transaction
    const validTranslations = translations.filter(t => t.value != null && t.value !== undefined);
    const skippedCount = translations.length - validTranslations.length;
    if (skippedCount > 0) {
      console.log(`[ContentSync] Skipping ${skippedCount} translations with null/undefined values`);
    }

    // Use transaction to ensure all-or-nothing data consistency
    await db.$transaction(async (tx) => {
      // Upsert article
      await tx.article.upsert({
        where: {
          shop_id: {
            shop: this.shop,
            id: articleData.id,
          },
        },
        create: {
          id: articleData.id,
          shop: this.shop,
          blogId: articleData.blog?.id || "",
          blogTitle: articleData.blog?.title || "",
          title: articleData.title,
          body: articleData.body || "",
          handle: articleData.handle,
          seoTitle: articleData.seo?.title || null,
          seoDescription: articleData.seo?.description || null,
          shopifyUpdatedAt: new Date(articleData.updatedAt),
          lastSyncedAt: new Date(),
        },
        update: {
          blogId: articleData.blog?.id || "",
          blogTitle: articleData.blog?.title || "",
          title: articleData.title,
          body: articleData.body || "",
          handle: articleData.handle,
          seoTitle: articleData.seo?.title || null,
          seoDescription: articleData.seo?.description || null,
          shopifyUpdatedAt: new Date(articleData.updatedAt),
          lastSyncedAt: new Date(),
        },
      });

      // Delete old translations
      await tx.contentTranslation.deleteMany({
        where: {
          resourceId: articleData.id,
          resourceType: "Article",
        },
      });

      // Insert new translations
      if (validTranslations.length > 0) {
        await tx.contentTranslation.createMany({
          data: validTranslations.map(t => ({
            resourceId: articleData.id,
            resourceType: "Article",
            key: t.key,
            value: t.value,
            locale: t.locale,
            digest: t.digest || null,
          })),
        });
        console.log(`[ContentSync] ✓ Saved ${validTranslations.length} translations`);
      }
    });

    console.log(`[ContentSync] ✓ Transaction completed successfully for article ${articleData.id}`);
  }

  private async saveMenuToDatabase(menuData: any) {
    const { db } = await import("../db.server");

    console.log(`[ContentSync] Saving menu to database: ${menuData.id}`);

    // Upsert menu
    await db.menu.upsert({
      where: {
        shop_id: {
          shop: this.shop,
          id: menuData.id,
        },
      },
      create: {
        id: menuData.id,
        shop: this.shop,
        title: menuData.title,
        handle: menuData.handle,
        items: menuData.items || [],
        lastSyncedAt: new Date(),
      },
      update: {
        title: menuData.title,
        handle: menuData.handle,
        items: menuData.items || [],
        lastSyncedAt: new Date(),
      },
    });

    console.log(`[ContentSync] ✓ Menu saved successfully`);
  }


  // ============================================
  // BULK SYNC
  // ============================================

  /**
   * Sync all collections
   */
  async syncAllCollections(): Promise<number> {
    console.log(`[ContentSync] Syncing all collections...`);

    const response = await this.admin.graphql(
      `#graphql
        query getCollections {
          collections(first: 250) {
            edges {
              node {
                id
              }
            }
          }
        }`
    );

    const data = await response.json();
    const collections = data.data?.collections?.edges?.map((e: any) => e.node) || [];

    console.log(`[ContentSync] Found ${collections.length} collections to sync`);

    for (const collection of collections) {
      await this.syncCollection(collection.id);
    }

    return collections.length;
  }

  /**
   * Sync all articles
   */
  async syncAllArticles(): Promise<number> {
    console.log(`[ContentSync] Syncing all articles...`);

    // First, get all blogs
    const blogsResponse = await this.admin.graphql(
      `#graphql
        query getBlogs {
          blogs(first: 250) {
            edges {
              node {
                id
                articles(first: 250) {
                  edges {
                    node {
                      id
                    }
                  }
                }
              }
            }
          }
        }`
    );

    const blogsData = await blogsResponse.json();
    const blogs = blogsData.data?.blogs?.edges?.map((e: any) => e.node) || [];

    // Collect all articles
    const allArticles = [];
    for (const blog of blogs) {
      const articles = blog.articles?.edges?.map((e: any) => e.node) || [];
      allArticles.push(...articles);
    }

    console.log(`[ContentSync] Found ${allArticles.length} articles to sync`);

    for (const article of allArticles) {
      await this.syncArticle(article.id);
    }

    return allArticles.length;
  }

  /**
   * Sync all menus
   */
  async syncAllMenus(): Promise<number> {
    console.log(`[ContentSync] Syncing all menus...`);

    const response = await this.admin.graphql(
      `#graphql
        query getMenus {
          menus(first: 250) {
            edges {
              node {
                id
              }
            }
          }
        }`
    );

    const data = await response.json();
    const menus = data.data?.menus?.edges?.map((e: any) => e.node) || [];

    console.log(`[ContentSync] Found ${menus.length} menus to sync`);

    for (const menu of menus) {
      await this.syncMenu(menu.id);
    }

    return menus.length;
  }

  // ============================================
  // SINGLE RESOURCE SYNC (for manual reload)
  // ============================================

  /**
   * Sync a single collection (wrapper for manual reload)
   */
  async syncSingleCollection(collectionId: string): Promise<any> {
    const gid = collectionId.startsWith("gid://")
      ? collectionId
      : `gid://shopify/Collection/${collectionId}`;

    await this.syncCollection(gid);

    const { db } = await import("../db.server");
    const collection = await db.collection.findUnique({
      where: {
        shop_id: {
          shop: this.shop,
          id: gid,
        },
      },
    });

    const translations = await db.contentTranslation.findMany({
      where: {
        resourceId: gid,
        resourceType: "Collection",
      },
    });

    return {
      ...collection,
      translations,
    };
  }

  /**
   * Sync a single article (wrapper for manual reload)
   */
  async syncSingleArticle(articleId: string): Promise<any> {
    const gid = articleId.startsWith("gid://")
      ? articleId
      : `gid://shopify/OnlineStoreArticle/${articleId}`;

    await this.syncArticle(gid);

    const { db } = await import("../db.server");
    const article = await db.article.findUnique({
      where: {
        shop_id: {
          shop: this.shop,
          id: gid,
        },
      },
    });

    const translations = await db.contentTranslation.findMany({
      where: {
        resourceId: gid,
        resourceType: "Article",
      },
    });

    return {
      ...article,
      translations,
    };
  }

}
