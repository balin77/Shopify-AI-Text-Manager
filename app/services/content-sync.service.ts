/**
 * Content Sync Service
 *
 * Synchronizes content data (Collections, Articles, Pages) from Shopify to local PostgreSQL database
 * including all translations for all available locales.
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
        locales.filter(l => !l.primary),
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
        locales.filter(l => !l.primary),
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
  // PAGE SYNC
  // ============================================

  /**
   * Sync a single page with all its translations
   */
  async syncPage(pageId: string): Promise<void> {
    console.log(`[ContentSync] Starting sync for page: ${pageId}`);

    try {
      // 1. Fetch page data
      const pageData = await this.fetchPageData(pageId);

      if (!pageData) {
        console.warn(`[ContentSync] Page not found: ${pageId}`);
        return;
      }

      // 2. Fetch all available locales
      const locales = await this.fetchShopLocales();

      // 3. Fetch translations
      const allTranslations = await this.fetchAllTranslations(
        pageId,
        locales.filter(l => !l.primary),
        "Page"
      );

      // 4. Save to database
      await this.savePageToDatabase(pageData, allTranslations);

      console.log(`[ContentSync] Successfully synced page: ${pageId}`);
    } catch (error) {
      console.error(`[ContentSync] Error syncing page ${pageId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a page from the database
   */
  async deletePage(pageId: string): Promise<void> {
    console.log(`[ContentSync] Deleting page: ${pageId}`);

    const { db } = await import("../db.server");

    await db.page.delete({
      where: {
        shop_id: {
          shop: this.shop,
          id: pageId,
        },
      },
    });

    console.log(`[ContentSync] Successfully deleted page: ${pageId}`);
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

  private async fetchPageData(pageId: string) {
    const response = await this.admin.graphql(
      `#graphql
        query getPage($id: ID!) {
          page(id: $id) {
            id
            title
            handle
            body
            updatedAt
          }
        }`,
      { variables: { id: pageId } }
    );

    const data = await response.json();
    return data.data?.page || null;
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

  private async fetchAllTranslations(resourceId: string, locales: any[], resourceType: string) {
    const allTranslations = [];

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

      const translatableFieldsMap = new Map<string, any>();
      const digestMap = new Map<string, string>();

      // Build translatable fields map
      if (resource.translatableContent) {
        for (const content of resource.translatableContent) {
          digestMap.set(content.key, content.digest);
          translatableFieldsMap.set(content.key, {
            key: content.key,
            value: content.value,
            locale: locale.locale,
            digest: content.digest,
            resourceType,
          });
        }
      }

      // Override with actual translations
      if (resource.translations) {
        for (const translation of resource.translations) {
          translatableFieldsMap.set(translation.key, {
            key: translation.key,
            value: translation.value,
            locale: translation.locale,
            digest: digestMap.get(translation.key),
            resourceType,
          });
        }
      }

      allTranslations.push(...translatableFieldsMap.values());
    }

    return allTranslations;
  }

  // ============================================
  // SAVE TO DATABASE
  // ============================================

  private async saveCollectionToDatabase(collectionData: any, translations: any[]) {
    const { db } = await import("../db.server");

    console.log(`[ContentSync] Saving collection to database: ${collectionData.id}`);

    // Upsert collection
    await db.collection.upsert({
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
    await db.contentTranslation.deleteMany({
      where: {
        resourceId: collectionData.id,
        resourceType: "Collection",
      },
    });

    // Insert new translations
    if (translations.length > 0) {
      await db.contentTranslation.createMany({
        data: translations.map(t => ({
          resourceId: collectionData.id,
          resourceType: "Collection",
          key: t.key,
          value: t.value,
          locale: t.locale,
          digest: t.digest || null,
        })),
      });
      console.log(`[ContentSync] ✓ Saved ${translations.length} translations`);
    }
  }

  private async saveArticleToDatabase(articleData: any, translations: any[]) {
    const { db } = await import("../db.server");

    console.log(`[ContentSync] Saving article to database: ${articleData.id}`);

    // Upsert article
    await db.article.upsert({
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
    await db.contentTranslation.deleteMany({
      where: {
        resourceId: articleData.id,
        resourceType: "Article",
      },
    });

    // Insert new translations
    if (translations.length > 0) {
      await db.contentTranslation.createMany({
        data: translations.map(t => ({
          resourceId: articleData.id,
          resourceType: "Article",
          key: t.key,
          value: t.value,
          locale: t.locale,
          digest: t.digest || null,
        })),
      });
      console.log(`[ContentSync] ✓ Saved ${translations.length} translations`);
    }
  }

  private async savePageToDatabase(pageData: any, translations: any[]) {
    const { db } = await import("../db.server");

    console.log(`[ContentSync] Saving page to database: ${pageData.id}`);

    // Upsert page
    await db.page.upsert({
      where: {
        shop_id: {
          shop: this.shop,
          id: pageData.id,
        },
      },
      create: {
        id: pageData.id,
        shop: this.shop,
        title: pageData.title,
        body: pageData.body || "",
        handle: pageData.handle,
        shopifyUpdatedAt: new Date(pageData.updatedAt),
        lastSyncedAt: new Date(),
      },
      update: {
        title: pageData.title,
        body: pageData.body || "",
        handle: pageData.handle,
        shopifyUpdatedAt: new Date(pageData.updatedAt),
        lastSyncedAt: new Date(),
      },
    });

    // Delete old translations
    await db.contentTranslation.deleteMany({
      where: {
        resourceId: pageData.id,
        resourceType: "Page",
      },
    });

    // Insert new translations
    if (translations.length > 0) {
      await db.contentTranslation.createMany({
        data: translations.map(t => ({
          resourceId: pageData.id,
          resourceType: "Page",
          key: t.key,
          value: t.value,
          locale: t.locale,
          digest: t.digest || null,
        })),
      });
      console.log(`[ContentSync] ✓ Saved ${translations.length} translations`);
    }
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
   * Sync all pages
   */
  async syncAllPages(): Promise<number> {
    console.log(`[ContentSync] Syncing all pages...`);

    const response = await this.admin.graphql(
      `#graphql
        query getPages {
          pages(first: 250) {
            edges {
              node {
                id
              }
            }
          }
        }`
    );

    const data = await response.json();
    const pages = data.data?.pages?.edges?.map((e: any) => e.node) || [];

    console.log(`[ContentSync] Found ${pages.length} pages to sync`);

    for (const page of pages) {
      await this.syncPage(page.id);
    }

    return pages.length;
  }
}
