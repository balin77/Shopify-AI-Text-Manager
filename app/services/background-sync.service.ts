/**
 * Background Sync Service
 *
 * Synchronizes Pages, Policies, and Themes from Shopify to local PostgreSQL database.
 * This service is used by the sync scheduler for content types without webhook support.
 */

interface ShopifyGraphQLClient {
  graphql: (query: string, options?: { variables?: any }) => Promise<any>;
}

export interface SyncStats {
  pages: number;
  policies: number;
  themes: number;
  total: number;
  duration: number;
}

export class BackgroundSyncService {
  constructor(
    private admin: ShopifyGraphQLClient,
    private shop: string
  ) {}

  // ============================================
  // PAGES SYNC
  // ============================================

  /**
   * Sync all pages with their translations
   */
  async syncAllPages(): Promise<number> {
    console.log(`[BackgroundSync] Syncing all pages for shop: ${this.shop}`);

    try {
      const { db } = await import("../db.server");

      // 1. Fetch all pages from Shopify
      const pagesResponse = await this.admin.graphql(
        `#graphql
          query getPages {
            pages(first: 250) {
              edges {
                node {
                  id
                  title
                  handle
                  body
                  updatedAt
                }
              }
            }
          }`
      );

      const pagesData = await pagesResponse.json();
      const pages = pagesData.data?.pages?.edges?.map((e: any) => e.node) || [];

      console.log(`[BackgroundSync] Found ${pages.length} pages from Shopify`);

      // 2. AGGRESSIVE CLEANUP: Delete pages that no longer exist in Shopify
      const shopifyPageIds = pages.map((p: any) => p.id);

      if (shopifyPageIds.length > 0) {
        const deletedPages = await db.page.deleteMany({
          where: {
            shop: this.shop,
            id: { notIn: shopifyPageIds }
          }
        });

        if (deletedPages.count > 0) {
          console.log(`[BackgroundSync] 🗑️ Deleted ${deletedPages.count} pages that no longer exist in Shopify`);
        }

        // Also delete orphaned translations
        const deletedTranslations = await db.contentTranslation.deleteMany({
          where: {
            resourceType: "Page",
            resourceId: { notIn: shopifyPageIds }
          }
        });

        if (deletedTranslations.count > 0) {
          console.log(`[BackgroundSync] 🗑️ Deleted ${deletedTranslations.count} orphaned page translations`);
        }
      } else {
        // No pages in Shopify - delete all local pages for this shop
        const deletedPages = await db.page.deleteMany({
          where: { shop: this.shop }
        });
        const deletedTranslations = await db.contentTranslation.deleteMany({
          where: { resourceType: "Page" }
        });
        console.log(`[BackgroundSync] 🗑️ Deleted all pages (${deletedPages.count}) and translations (${deletedTranslations.count}) - no pages in Shopify`);
        return 0;
      }

      // 3. Fetch shop locales
      const locales = await this.fetchShopLocales();
      const nonPrimaryLocales = locales.filter((l: any) => !l.primary);

      // 4. Sync each page
      for (const page of pages) {
        await this.syncSinglePage(page, nonPrimaryLocales);
      }

      console.log(`[BackgroundSync] ✓ Successfully synced ${pages.length} pages`);
      return pages.length;
    } catch (error: any) {
      console.error('[BackgroundSync] Error syncing pages:', error);
      throw error;
    }
  }

  /**
   * Sync a single page with translations
   */
  private async syncSinglePage(pageData: any, nonPrimaryLocales: any[]): Promise<void> {
    const { db } = await import("../db.server");

    // Fetch translations for all non-primary locales
    const allTranslations = await this.fetchAllTranslations(
      pageData.id,
      nonPrimaryLocales,
      "Page"
    );

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

    // Upsert translations instead of delete+create to prevent accumulation
    for (const t of allTranslations) {
      await db.contentTranslation.upsert({
        where: {
          resourceId_key_locale: {
            resourceId: pageData.id,
            key: t.key,
            locale: t.locale,
          },
        },
        create: {
          resourceId: pageData.id,
          resourceType: "Page",
          key: t.key,
          value: t.value,
          locale: t.locale,
          digest: t.digest || null,
        },
        update: {
          value: t.value,
          digest: t.digest || null,
          updatedAt: new Date(),
        },
      });
    }

    // Delete translations that no longer exist
    const currentKeys = allTranslations.map((t: any) => ({ key: t.key, locale: t.locale }));
    if (currentKeys.length > 0) {
      await db.contentTranslation.deleteMany({
        where: {
          resourceId: pageData.id,
          resourceType: "Page",
          NOT: {
            OR: currentKeys.map(({ key, locale }) => ({ key, locale })),
          },
        },
      });
    } else {
      // No translations from Shopify - delete all
      await db.contentTranslation.deleteMany({
        where: {
          resourceId: pageData.id,
          resourceType: "Page",
        },
      });
    }
  }

  // ============================================
  // POLICIES SYNC
  // ============================================

  /**
   * Sync all shop policies with their translations
   */
  async syncAllPolicies(): Promise<number> {
    console.log(`[BackgroundSync] Syncing all policies for shop: ${this.shop}`);

    try {
      const { db } = await import("../db.server");

      // 1. Fetch all policies from Shopify
      const policiesResponse = await this.admin.graphql(
        `#graphql
          query getShopPolicies {
            shop {
              shopPolicies {
                id
                type
                title
                body
                url
              }
            }
          }`
      );

      const policiesData = await policiesResponse.json();
      const policies = policiesData.data?.shop?.shopPolicies || [];

      console.log(`[BackgroundSync] Found ${policies.length} policies from Shopify`);

      // 2. AGGRESSIVE CLEANUP: Delete policies that no longer exist in Shopify
      const shopifyPolicyIds = policies.map((p: any) => p.id);

      if (shopifyPolicyIds.length > 0) {
        const deletedPolicies = await db.shopPolicy.deleteMany({
          where: {
            shop: this.shop,
            id: { notIn: shopifyPolicyIds }
          }
        });

        if (deletedPolicies.count > 0) {
          console.log(`[BackgroundSync] 🗑️ Deleted ${deletedPolicies.count} policies that no longer exist in Shopify`);
        }

        // Also delete orphaned translations
        const deletedTranslations = await db.contentTranslation.deleteMany({
          where: {
            resourceType: "ShopPolicy",
            resourceId: { notIn: shopifyPolicyIds }
          }
        });

        if (deletedTranslations.count > 0) {
          console.log(`[BackgroundSync] 🗑️ Deleted ${deletedTranslations.count} orphaned policy translations`);
        }
      } else {
        // No policies in Shopify - delete all local policies for this shop
        const deletedPolicies = await db.shopPolicy.deleteMany({
          where: { shop: this.shop }
        });
        const deletedTranslations = await db.contentTranslation.deleteMany({
          where: { resourceType: "ShopPolicy" }
        });
        console.log(`[BackgroundSync] 🗑️ Deleted all policies (${deletedPolicies.count}) and translations (${deletedTranslations.count}) - no policies in Shopify`);
        return 0;
      }

      // 3. Fetch shop locales
      const locales = await this.fetchShopLocales();
      const nonPrimaryLocales = locales.filter((l: any) => !l.primary);

      // 4. Sync each policy
      for (const policy of policies) {
        await this.syncSinglePolicy(policy, nonPrimaryLocales);
      }

      console.log(`[BackgroundSync] ✓ Successfully synced ${policies.length} policies`);
      return policies.length;
    } catch (error: any) {
      console.error('[BackgroundSync] Error syncing policies:', error);
      throw error;
    }
  }

  /**
   * Sync a single policy with translations
   */
  private async syncSinglePolicy(policyData: any, nonPrimaryLocales: any[]): Promise<void> {
    const { db } = await import("../db.server");

    // Fetch translations for all non-primary locales
    const allTranslations = await this.fetchAllTranslations(
      policyData.id,
      nonPrimaryLocales,
      "ShopPolicy"
    );

    // Upsert policy
    await db.shopPolicy.upsert({
      where: {
        shop_id: {
          shop: this.shop,
          id: policyData.id,
        },
      },
      create: {
        id: policyData.id,
        shop: this.shop,
        title: policyData.title,
        body: policyData.body || "",
        type: policyData.type,
        url: policyData.url || null,
        lastSyncedAt: new Date(),
      },
      update: {
        title: policyData.title,
        body: policyData.body || "",
        type: policyData.type,
        url: policyData.url || null,
        lastSyncedAt: new Date(),
      },
    });

    // Upsert translations instead of delete+create to prevent accumulation
    for (const t of allTranslations) {
      await db.contentTranslation.upsert({
        where: {
          resourceId_key_locale: {
            resourceId: policyData.id,
            key: t.key,
            locale: t.locale,
          },
        },
        create: {
          resourceId: policyData.id,
          resourceType: "ShopPolicy",
          key: t.key,
          value: t.value,
          locale: t.locale,
          digest: t.digest || null,
        },
        update: {
          value: t.value,
          digest: t.digest || null,
          updatedAt: new Date(),
        },
      });
    }

    // Delete translations that no longer exist
    const currentKeys = allTranslations.map((t: any) => ({ key: t.key, locale: t.locale }));
    if (currentKeys.length > 0) {
      await db.contentTranslation.deleteMany({
        where: {
          resourceId: policyData.id,
          resourceType: "ShopPolicy",
          NOT: {
            OR: currentKeys.map(({ key, locale }) => ({ key, locale })),
          },
        },
      });
    } else {
      // No translations from Shopify - delete all
      await db.contentTranslation.deleteMany({
        where: {
          resourceId: policyData.id,
          resourceType: "ShopPolicy",
        },
      });
    }
  }

  // ============================================
  // THEMES SYNC
  // ============================================

  /**
   * Sync all theme content with translations
   * This is complex as it groups theme resources by patterns
   */
  async syncAllThemes(): Promise<number> {
    console.log(`[BackgroundSync] Syncing all themes for shop: ${this.shop}`);

    try {
      const { db } = await import("../db.server");

      // Define the working resource types (based on ContentService)
      const WORKING_RESOURCE_TYPES = [
        { type: 'ONLINE_STORE_THEME', label: 'Theme Content' },
        { type: 'ONLINE_STORE_THEME_JSON_TEMPLATE', label: 'JSON Templates' },
        { type: 'ONLINE_STORE_THEME_LOCALE_CONTENT', label: 'Locale Content' },
        { type: 'ONLINE_STORE_THEME_SECTION_GROUP', label: 'Section Groups' },
        { type: 'ONLINE_STORE_THEME_SETTINGS_CATEGORY', label: 'Settings Categories' },
      ];

      // Define key patterns to filter and group by (same as ContentService)
      const KEY_PATTERNS = [
        { pattern: /^section\.article\./, name: 'Article', groupId: 'article', icon: '📝' },
        { pattern: /^section\.collection\./, name: 'Collection', groupId: 'collection', icon: '📂' },
        { pattern: /^section\.index\./, name: 'Index Page', groupId: 'index', icon: '🏠' },
        { pattern: /^section\.password\./, name: 'Password Page', groupId: 'password', icon: '🔒' },
        { pattern: /^section\.product\./, name: 'Product', groupId: 'product', icon: '🛍️' },
        { pattern: /^section\.page\.([^.]+)\./, name: 'Pages', groupId: 'pages', icon: '📄', extractSubgroup: true },
        { pattern: /^collections\.json\./, name: 'Collections Template', groupId: 'collections_template', icon: '📋' },
        { pattern: /^group\.json\./, name: 'Theme Groups', groupId: 'groups', icon: '🎨' },
        { pattern: /^bar\./, name: 'Announcement Bars', groupId: 'bars', icon: '📢' },
        { pattern: /^Settings Categories:/, name: 'Settings', groupId: 'settings', icon: '⚙️' },
      ];

      // Get shop locales
      const locales = await this.fetchShopLocales();
      const nonPrimaryLocales = locales.filter((l: any) => !l.primary);

      let totalGroups = 0;

      // Track all synced theme content combinations for cleanup
      const syncedCombinations = new Set<string>();

      // Fetch resources for each working resource type
      for (const resourceTypeConfig of WORKING_RESOURCE_TYPES) {
        try {
          const translatableResponse = await this.admin.graphql(
            `#graphql
              query getThemeTranslatableResources($first: Int!, $resourceType: TranslatableResourceType!) {
                translatableResources(first: $first, resourceType: $resourceType) {
                  edges {
                    node {
                      resourceId
                      translatableContent {
                        key
                        value
                        digest
                        locale
                      }
                    }
                  }
                }
              }`,
            { variables: { first: 250, resourceType: resourceTypeConfig.type } }
          );

          const translatableData = await translatableResponse.json();

          if (translatableData.errors) {
            console.error(`[BackgroundSync] Error loading ${resourceTypeConfig.type}:`, translatableData.errors[0].message);
            continue;
          }

          const resources = translatableData.data?.translatableResources?.edges?.map((edge: any) => edge.node) || [];

          // Process each resource
          for (const resource of resources) {
            // Group translatable content by key patterns
            const contentByGroup: Record<string, any[]> = {};
            const unmatchedContent: any[] = [];

            for (const item of resource.translatableContent || []) {
              let matched = false;

              for (const patternConfig of KEY_PATTERNS) {
                const match = item.key.match(patternConfig.pattern);
                if (match) {
                  let groupId = patternConfig.groupId;

                  // Handle sub-grouping for pages
                  if (patternConfig.extractSubgroup && match[1]) {
                    groupId = `page_${match[1]}`;
                  }

                  if (!contentByGroup[groupId]) {
                    contentByGroup[groupId] = [];
                  }
                  contentByGroup[groupId].push({
                    ...item,
                    _groupId: groupId,
                    _groupName: patternConfig.extractSubgroup && match[1] ?
                      `Page: ${match[1].charAt(0).toUpperCase() + match[1].slice(1)}` :
                      patternConfig.name,
                    _groupIcon: patternConfig.icon
                  });
                  matched = true;
                  break;
                }
              }

              if (!matched) {
                unmatchedContent.push(item);
              }
            }

            // Group unmatched content by prefix
            if (unmatchedContent.length > 0) {
              const unmatchedByPrefix: Record<string, any[]> = {};

              for (const item of unmatchedContent) {
                let prefix = 'other';
                const key = item.key;

                if (key.startsWith('section.')) {
                  const parts = key.split('.');
                  if (parts.length >= 2 && parts[1]) {
                    prefix = `section_${parts[1]}`;
                  }
                } else if (key.includes('.')) {
                  prefix = key.split('.')[0];
                } else {
                  prefix = key.split(/[:\s]/)[0] || 'other';
                }

                if (!unmatchedByPrefix[prefix]) {
                  unmatchedByPrefix[prefix] = [];
                }
                unmatchedByPrefix[prefix].push(item);
              }

              // Add unmatched groups to contentByGroup
              for (const [prefix, items] of Object.entries(unmatchedByPrefix)) {
                let groupName = prefix
                  .replace(/^section_/, '')
                  .replace(/_/g, ' ')
                  .split(' ')
                  .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                  .join(' ');

                const groupId = `misc_${prefix}`;

                // Choose icon
                let icon = '📦';
                if (prefix.includes('cart')) icon = '🛒';
                else if (prefix.includes('search')) icon = '🔍';
                else if (prefix.includes('footer')) icon = '🦶';
                else if (prefix.includes('header')) icon = '🎯';

                contentByGroup[groupId] = items.map(item => ({
                  ...item,
                  _groupId: groupId,
                  _groupName: groupName,
                  _groupIcon: icon
                }));
              }
            }

            // Fetch translations for each group
            for (const [groupId, items] of Object.entries(contentByGroup)) {
              const firstItem = items[0];
              const groupName = firstItem._groupName;
              const groupIcon = firstItem._groupIcon;

              // Fetch translations for this resource
              const allTranslations = [];
              const seenKeys = new Set<string>(); // Track seen key-locale combinations

              for (const locale of nonPrimaryLocales) {
                try {
                  const translationsResponse = await this.admin.graphql(
                    `#graphql
                      query getThemeTranslations($resourceId: ID!, $locale: String!) {
                        translatableResource(resourceId: $resourceId) {
                          translations(locale: $locale) {
                            key
                            value
                            locale
                            outdated
                          }
                        }
                      }`,
                    { variables: { resourceId: resource.resourceId, locale: locale.locale } }
                  );

                  const translationsData = await translationsResponse.json();
                  const translations = translationsData.data?.translatableResource?.translations || [];

                  // Filter translations for this group only and deduplicate
                  for (const t of translations) {
                    if (items.some(item => item.key === t.key)) {
                      const uniqueKey = `${t.key}::${t.locale}`;
                      if (!seenKeys.has(uniqueKey)) {
                        seenKeys.add(uniqueKey);
                        allTranslations.push(t);
                      }
                    }
                  }
                } catch (error) {
                  console.error(`[BackgroundSync] Error fetching theme translations for locale ${locale.locale}:`, error);
                }
              }

              // Track this combination for cleanup
              const combinationKey = `${resource.resourceId}::${groupId}`;
              syncedCombinations.add(combinationKey);

              // Upsert theme content
              await db.themeContent.upsert({
                where: {
                  shop_resourceId_groupId: {
                    shop: this.shop,
                    resourceId: resource.resourceId,
                    groupId,
                  },
                },
                create: {
                  shop: this.shop,
                  resourceId: resource.resourceId,
                  resourceType: resourceTypeConfig.type,
                  resourceTypeLabel: resourceTypeConfig.label,
                  groupId,
                  groupName,
                  groupIcon,
                  translatableContent: items,
                  lastSyncedAt: new Date(),
                },
                update: {
                  resourceType: resourceTypeConfig.type,
                  resourceTypeLabel: resourceTypeConfig.label,
                  groupName,
                  groupIcon,
                  translatableContent: items,
                  lastSyncedAt: new Date(),
                },
              });

              // First, get all existing translation keys for this group
              const existingTranslations = await db.themeTranslation.findMany({
                where: {
                  shop: this.shop,
                  resourceId: resource.resourceId,
                  groupId,
                },
                select: { key: true, locale: true }
              });

              const existingKeys = new Set(
                existingTranslations.map(t => `${t.key}::${t.locale}`)
              );

              // Upsert translations (update existing, create new)
              for (const t of allTranslations) {
                await db.themeTranslation.upsert({
                  where: {
                    shop_resourceId_groupId_key_locale: {
                      shop: this.shop,
                      resourceId: resource.resourceId,
                      groupId,
                      key: t.key,
                      locale: t.locale,
                    },
                  },
                  create: {
                    shop: this.shop,
                    resourceId: resource.resourceId,
                    groupId,
                    key: t.key,
                    value: t.value,
                    locale: t.locale,
                    outdated: t.outdated || false,
                  },
                  update: {
                    value: t.value,
                    outdated: t.outdated || false,
                    updatedAt: new Date(),
                  },
                });
              }

              // Delete translations that no longer exist in Shopify
              const currentKeys = new Set(
                allTranslations.map((t: any) => `${t.key}::${t.locale}`)
              );

              const keysToDelete = Array.from(existingKeys).filter(
                key => !currentKeys.has(key)
              );

              if (keysToDelete.length > 0) {
                for (const keyLocale of keysToDelete) {
                  const [key, locale] = keyLocale.split('::');
                  await db.themeTranslation.deleteMany({
                    where: {
                      shop: this.shop,
                      resourceId: resource.resourceId,
                      groupId,
                      key,
                      locale,
                    },
                  });
                }
              }

              totalGroups++;
            }
          }
        } catch (error) {
          console.error(`[BackgroundSync] Error syncing theme type ${resourceTypeConfig.type}:`, error);
        }
      }

      // AGGRESSIVE CLEANUP: Delete theme content that no longer exists in Shopify
      if (syncedCombinations.size > 0) {
        // Get all existing theme content for this shop
        const existingThemeContent = await db.themeContent.findMany({
          where: { shop: this.shop },
          select: { resourceId: true, groupId: true }
        });

        // Find combinations that should be deleted
        const toDelete = existingThemeContent.filter(item => {
          const combinationKey = `${item.resourceId}::${item.groupId}`;
          return !syncedCombinations.has(combinationKey);
        });

        if (toDelete.length > 0) {
          console.log(`[BackgroundSync] 🗑️ Deleting ${toDelete.length} obsolete theme content groups`);

          // Delete in batches
          for (const item of toDelete) {
            await db.themeContent.deleteMany({
              where: {
                shop: this.shop,
                resourceId: item.resourceId,
                groupId: item.groupId
              }
            });

            await db.themeTranslation.deleteMany({
              where: {
                shop: this.shop,
                resourceId: item.resourceId,
                groupId: item.groupId
              }
            });
          }

          console.log(`[BackgroundSync] 🗑️ Deleted ${toDelete.length} obsolete theme groups and their translations`);
        }
      }

      // Log final database statistics
      const finalStats = await db.themeContent.count({
        where: { shop: this.shop }
      });
      const finalTranslationStats = await db.themeTranslation.count({
        where: { shop: this.shop }
      });

      console.log(`[BackgroundSync] ✓ Successfully synced ${totalGroups} theme groups`);
      console.log(`[BackgroundSync] Database stats: ${finalStats} ThemeContent, ${finalTranslationStats} ThemeTranslations`);

      return totalGroups;
    } catch (error: any) {
      console.error('[BackgroundSync] Error syncing themes:', error);
      throw error;
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================

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
    const allTranslationsMap = new Map<string, any>(); // Deduplicate using key::locale

    for (const locale of locales) {
      if (!locale.published) {
        continue;
      }

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

      // Add to global map with deduplication
      for (const [key, translation] of translatableFieldsMap) {
        const uniqueKey = `${translation.key}::${translation.locale}`;
        if (!allTranslationsMap.has(uniqueKey)) {
          allTranslationsMap.set(uniqueKey, translation);
        }
      }
    }

    return Array.from(allTranslationsMap.values());
  }

  // ============================================
  // WRAPPER METHOD
  // ============================================

  /**
   * Sync all content types (Pages, Policies, Themes)
   * @returns Statistics about the sync operation
   */
  async syncAll(): Promise<SyncStats> {
    const startTime = Date.now();

    console.log(`[BackgroundSync] Starting full sync for shop: ${this.shop}`);

    try {
      // Run all syncs in parallel with aggressive cleanup
      const [pages, policies, themes] = await Promise.all([
        this.syncAllPages().catch(err => {
          console.error('[BackgroundSync] Pages sync failed:', err);
          return 0;
        }),
        this.syncAllPolicies().catch(err => {
          console.error('[BackgroundSync] Policies sync failed:', err);
          return 0;
        }),
        this.syncAllThemes().catch(err => {
          console.error('[BackgroundSync] Themes sync failed:', err);
          return 0;
        }),
      ]);

      const duration = Date.now() - startTime;
      const stats: SyncStats = {
        pages,
        policies,
        themes,
        total: pages + policies + themes,
        duration,
      };

      console.log(`[BackgroundSync] ✓ Full sync complete in ${duration}ms`);
      console.log(`[BackgroundSync]   Pages: ${pages}, Policies: ${policies}, Themes: ${themes}`);

      return stats;
    } catch (error: any) {
      console.error('[BackgroundSync] Full sync failed:', error);
      throw error;
    }
  }
}
