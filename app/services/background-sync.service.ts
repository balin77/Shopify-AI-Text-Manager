/**
 * Background Sync Service
 *
 * Synchronizes Pages, Policies, and Themes from Shopify to local PostgreSQL database.
 * This service is used by the sync scheduler for content types without webhook support.
 */

import { ShopifyApiGateway } from './shopify-api-gateway.service';
import { logger } from '~/utils/logger.server';
import type { ShopifyGraphQLClient, ShopLocale, ShopifyTranslation, ResolvedTranslation, ProgressCallback } from './sync-types';
import { fetchShopLocales, fetchAllTranslations } from './sync-utils';

/** A single translatable content item from Shopify */
interface TranslatableContentItem {
  key: string;
  value: string | null;
  digest: string | null;
  locale: string;
}

/** Page data from Shopify GraphQL */
interface ShopifyPageData {
  id: string;
  title: string;
  handle: string;
  body: string | null;
  updatedAt: string;
  seoTitle?: { value: string } | null;
  seoDescription?: { value: string } | null;
}

/** Policy data from Shopify GraphQL */
interface ShopifyPolicyData {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
}

/** Theme translatable content item with group metadata */
interface ThemeContentItem extends TranslatableContentItem {
  _groupId: string;
  _groupName: string;
  _groupIcon: string;
}

/** Theme translatable resource from Shopify */
interface ThemeResource {
  resourceId: string;
  translatableContent: TranslatableContentItem[];
}

// ============================================================================
// Theme key-to-group mapping (shared between initial sync and per-group reload)
// ============================================================================

interface KeyPatternConfig {
  pattern: RegExp;
  name: string;
  groupId: string;
  icon: string;
  extractSubgroup?: boolean;
}

const THEME_KEY_PATTERNS: KeyPatternConfig[] = [
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

/** Determine which groupId a translatable key belongs to (same logic as initial sync) */
function getGroupIdForKey(key: string): string {
  for (const patternConfig of THEME_KEY_PATTERNS) {
    const match = key.match(patternConfig.pattern);
    if (match) {
      if (patternConfig.extractSubgroup && match[1]) {
        return `page_${match[1]}`;
      }
      return patternConfig.groupId;
    }
  }
  // Unmatched: group by prefix (mirrors initial sync logic)
  if (key.startsWith('section.')) {
    const parts = key.split('.');
    if (parts.length >= 2 && parts[1]) {
      return `misc_section_${parts[1]}`;
    }
  } else if (key.includes('.')) {
    return `misc_${key.split('.')[0]}`;
  } else {
    return `misc_${key.split(/[:\s]/)[0] || 'other'}`;
  }
  return 'misc_other';
}

export interface SyncStats {
  pages: number;
  policies: number;
  themes: number;
  metaobjects: number;
  total: number;
  duration: number;
}

export class BackgroundSyncService {
  private gateway: ShopifyApiGateway;

  constructor(
    private admin: ShopifyGraphQLClient,
    private shop: string
  ) {
    // Initialize API gateway for rate-limited requests
    // The gateway handles:
    // - Rate limiting (10 requests/second)
    // - Automatic retry with exponential backoff
    // - Request queuing
    // - Throttle error detection (THROTTLED, 429)
    this.gateway = new ShopifyApiGateway(admin, shop);
  }

  // ============================================
  // PAGES SYNC
  // ============================================

  /**
   * Sync all pages with their translations (respects plan limit if provided)
   */
  async syncAllPages(maxCount?: number, onProgress?: ProgressCallback): Promise<number> {
    logger.debug(`[BackgroundSync] Syncing all pages for shop: ${this.shop}`);
    if (maxCount !== undefined) {
      logger.debug(`[BackgroundSync] Plan limit: ${maxCount} pages`);
    }

    // If limit is 0, skip pages entirely
    if (maxCount === 0) {
      logger.debug(`[BackgroundSync] Pages disabled for this plan, skipping`);
      return 0;
    }

    try {
      const { db } = await import("../db.server");

      // 1. Fetch all pages from Shopify
      const pagesResponse = await this.gateway.graphql(
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
                  seoTitle: metafield(namespace: "global", key: "title_tag") { value }
                  seoDescription: metafield(namespace: "global", key: "description_tag") { value }
                }
              }
            }
          }`
      );

      const pagesData = await pagesResponse.json();

      // Health check: detect API errors or malformed responses
      if (pagesData.errors || !pagesData.data?.pages) {
        logger.error('[BackgroundSync] 🔴 Shopify API returned errors for pages query, aborting to prevent data loss', {
          errors: pagesData.errors,
          hasData: !!pagesData.data,
        });
        throw new Error('Shopify API error during pages sync - aborting to prevent data loss');
      }

      let pages: ShopifyPageData[] = pagesData.data.pages.edges?.map((e: { node: ShopifyPageData }) => e.node) || [];

      logger.debug(`[BackgroundSync] Found ${pages.length} pages from Shopify`);

      // Health check: refuse to wipe local data when Shopify returns empty
      if (pages.length === 0) {
        const localPageCount = await db.page.count({ where: { shop: this.shop } });
        if (localPageCount > 0) {
          logger.error(`[BackgroundSync] 🔴 ABORTING page sync: Shopify returned 0 pages but ${localPageCount} exist locally. Possible API outage.`);
          throw new Error(`Shopify returned 0 pages but ${localPageCount} exist locally - aborting to prevent data loss`);
        }
        logger.debug(`[BackgroundSync] No pages in Shopify and none locally - nothing to do`);
        return 0;
      }

      // Apply plan limit if specified
      if (maxCount !== undefined && maxCount > 0 && pages.length > maxCount) {
        logger.debug(`[BackgroundSync] Limiting to ${maxCount} pages (found ${pages.length})`);
        pages = pages.slice(0, maxCount);
      }

      // 2. Cleanup: Delete pages that no longer exist in Shopify (using transaction)
      const shopifyPageIds = pages.map((p) => p.id);

      {
        // Use transaction to ensure both deletes succeed or fail together
        const { deletedPagesCount, deletedTranslationsCount } = await db.$transaction(async (tx) => {
          // Find stale page IDs for THIS shop before deleting
          const stalePages = await tx.page.findMany({
            where: {
              shop: this.shop,
              id: { notIn: shopifyPageIds }
            },
            select: { id: true }
          });
          const stalePageIds = stalePages.map(p => p.id);

          const deletedPages = await tx.page.deleteMany({
            where: {
              shop: this.shop,
              id: { notIn: shopifyPageIds }
            }
          });

          let translationsCount = 0;
          if (stalePageIds.length > 0) {
            const deletedTranslations = await tx.contentTranslation.deleteMany({
              where: {
                shop: this.shop,
                resourceType: "Page",
                resourceId: { in: stalePageIds }
              }
            });
            translationsCount = deletedTranslations.count;
          }

          return {
            deletedPagesCount: deletedPages.count,
            deletedTranslationsCount: translationsCount
          };
        });

        if (deletedPagesCount > 0) {
          logger.debug(`[BackgroundSync] 🗑️ Deleted ${deletedPagesCount} pages that no longer exist in Shopify`);
        }
        if (deletedTranslationsCount > 0) {
          logger.debug(`[BackgroundSync] 🗑️ Deleted ${deletedTranslationsCount} orphaned page translations`);
        }
      }

      // 3. Fetch shop locales
      const locales = await fetchShopLocales(this.gateway.graphql.bind(this.gateway));
      const nonPrimaryLocales = locales.filter((l) => !l.primary);

      // 4. Sync each page
      let pageIndex = 0;
      for (const page of pages) {
        pageIndex++;
        if (onProgress) {
          onProgress(pageIndex, pages.length, `Syncing page ${pageIndex}/${pages.length}`);
        }
        await this.syncSinglePageInternal(page, nonPrimaryLocales);
      }

      logger.debug(`[BackgroundSync] ✓ Successfully synced ${pages.length} pages`);
      return pages.length;
    } catch (error: unknown) {
      logger.error('[BackgroundSync] Error syncing pages:', error);
      throw error;
    }
  }

  /**
   * Sync a single page by ID (public method for manual reload)
   */
  async syncSinglePage(pageId: string): Promise<Record<string, unknown>> {
    const gid = pageId.startsWith("gid://")
      ? pageId
      : `gid://shopify/OnlineStorePage/${pageId}`;

    logger.debug(`[BackgroundSync] Manual sync for page: ${gid}`);

    const { db } = await import("../db.server");

    // Fetch page data from Shopify
    const pageResponse = await this.gateway.graphql(
      `#graphql
        query getPage($id: ID!) {
          page(id: $id) {
            id
            title
            handle
            body
            updatedAt
            seoTitle: metafield(namespace: "global", key: "title_tag") { value }
            seoDescription: metafield(namespace: "global", key: "description_tag") { value }
          }
        }`,
      { variables: { id: gid } }
    );

    const pageDataResponse = await pageResponse.json();
    const pageData: ShopifyPageData | undefined = pageDataResponse.data?.page;

    if (!pageData) {
      throw new Error(`Page ${gid} not found in Shopify`);
    }

    // Fetch locales
    const locales = await fetchShopLocales(this.gateway.graphql.bind(this.gateway));
    const nonPrimaryLocales = locales.filter((l) => !l.primary);

    // Sync the page
    await this.syncSinglePageInternal(pageData, nonPrimaryLocales);

    // Return fresh data from database
    const page = await db.page.findUnique({
      where: {
        shop_id: {
          shop: this.shop,
          id: gid,
        },
      },
    });

    const translations = await db.contentTranslation.findMany({
      where: {
        shop: this.shop,
        resourceId: gid,
        resourceType: "Page",
      },
    });

    return {
      ...page,
      translations,
    };
  }

  /**
   * Sync a single page with translations (internal method)
   * Uses a transaction to ensure data consistency
   */
  private async syncSinglePageInternal(pageData: ShopifyPageData, nonPrimaryLocales: ShopLocale[]): Promise<void> {
    const { db } = await import("../db.server");

    // Fetch translations for all non-primary locales (outside transaction - API calls)
    const allTranslations = await fetchAllTranslations(this.gateway.graphql.bind(this.gateway),
      pageData.id,
      nonPrimaryLocales,
      "Page"
    );

    // Prepare current keys for cleanup
    const currentKeys = allTranslations.map((t) => ({ key: t.key, locale: t.locale }));

    // Use transaction to ensure all-or-nothing data consistency
    await db.$transaction(async (tx) => {
      // Upsert page
      await tx.page.upsert({
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
          seoTitle: pageData.seoTitle?.value ?? null,
          seoDescription: pageData.seoDescription?.value ?? null,
          shopifyUpdatedAt: new Date(pageData.updatedAt),
          lastSyncedAt: new Date(),
        },
        update: {
          title: pageData.title,
          body: pageData.body || "",
          handle: pageData.handle,
          seoTitle: pageData.seoTitle?.value ?? null,
          seoDescription: pageData.seoDescription?.value ?? null,
          shopifyUpdatedAt: new Date(pageData.updatedAt),
          lastSyncedAt: new Date(),
        },
      });

      // Upsert translations instead of delete+create to prevent accumulation
      for (const t of allTranslations) {
        await tx.contentTranslation.upsert({
          where: {
            shop_resourceId_key_locale: {
              shop: this.shop,
              resourceId: pageData.id,
              key: t.key,
              locale: t.locale,
            },
          },
          create: {
            shop: this.shop,
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
      if (currentKeys.length > 0) {
        await tx.contentTranslation.deleteMany({
          where: {
            shop: this.shop,
            resourceId: pageData.id,
            resourceType: "Page",
            NOT: {
              OR: currentKeys.map(({ key, locale }) => ({ key, locale })),
            },
          },
        });
      } else {
        // No translations from Shopify - delete all
        await tx.contentTranslation.deleteMany({
          where: {
            shop: this.shop,
            resourceId: pageData.id,
            resourceType: "Page",
          },
        });
      }
    });
  }

  // ============================================
  // POLICIES SYNC
  // ============================================

  /**
   * Sync all shop policies with their translations
   */
  async syncAllPolicies(onProgress?: ProgressCallback): Promise<number> {
    logger.debug(`[BackgroundSync] Syncing all policies for shop: ${this.shop}`);

    try {
      const { db } = await import("../db.server");

      // 1. Fetch all policies from Shopify
      const policiesResponse = await this.gateway.graphql(
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

      // Health check: detect API errors or malformed responses
      if (policiesData.errors || !policiesData.data?.shop?.shopPolicies) {
        logger.error('[BackgroundSync] 🔴 Shopify API returned errors for policies query, aborting to prevent data loss', {
          errors: policiesData.errors,
          hasData: !!policiesData.data,
        });
        throw new Error('Shopify API error during policies sync - aborting to prevent data loss');
      }

      const policies: ShopifyPolicyData[] = policiesData.data.shop.shopPolicies;

      logger.debug(`[BackgroundSync] Found ${policies.length} policies from Shopify`);

      // Health check: refuse to wipe local data when Shopify returns empty
      if (policies.length === 0) {
        const localPolicyCount = await db.shopPolicy.count({ where: { shop: this.shop } });
        if (localPolicyCount > 0) {
          logger.error(`[BackgroundSync] 🔴 ABORTING policy sync: Shopify returned 0 policies but ${localPolicyCount} exist locally. Possible API outage.`);
          throw new Error(`Shopify returned 0 policies but ${localPolicyCount} exist locally - aborting to prevent data loss`);
        }
        logger.debug(`[BackgroundSync] No policies in Shopify and none locally - nothing to do`);
        return 0;
      }

      // 2. Cleanup: Delete policies that no longer exist in Shopify (using transaction)
      const shopifyPolicyIds = policies.map((p) => p.id);

      {
        // Use transaction to ensure both deletes succeed or fail together
        const { deletedPoliciesCount, deletedTranslationsCount } = await db.$transaction(async (tx) => {
          // Find stale policy IDs for THIS shop before deleting
          const stalePolicies = await tx.shopPolicy.findMany({
            where: {
              shop: this.shop,
              id: { notIn: shopifyPolicyIds }
            },
            select: { id: true }
          });
          const stalePolicyIds = stalePolicies.map(p => p.id);

          const deletedPolicies = await tx.shopPolicy.deleteMany({
            where: {
              shop: this.shop,
              id: { notIn: shopifyPolicyIds }
            }
          });

          let translationsCount = 0;
          if (stalePolicyIds.length > 0) {
            const deletedTranslations = await tx.contentTranslation.deleteMany({
              where: {
                shop: this.shop,
                resourceType: "ShopPolicy",
                resourceId: { in: stalePolicyIds }
              }
            });
            translationsCount = deletedTranslations.count;
          }

          return {
            deletedPoliciesCount: deletedPolicies.count,
            deletedTranslationsCount: translationsCount
          };
        });

        if (deletedPoliciesCount > 0) {
          logger.debug(`[BackgroundSync] 🗑️ Deleted ${deletedPoliciesCount} policies that no longer exist in Shopify`);
        }
        if (deletedTranslationsCount > 0) {
          logger.debug(`[BackgroundSync] 🗑️ Deleted ${deletedTranslationsCount} orphaned policy translations`);
        }
      }

      // 3. Fetch shop locales
      const locales = await fetchShopLocales(this.gateway.graphql.bind(this.gateway));
      const nonPrimaryLocales = locales.filter((l) => !l.primary);

      // 4. Sync each policy
      let policyIndex = 0;
      for (const policy of policies) {
        policyIndex++;
        if (onProgress) {
          onProgress(policyIndex, policies.length, `Syncing policy ${policyIndex}/${policies.length}`);
        }
        await this.syncSinglePolicyInternal(policy, nonPrimaryLocales);
      }

      logger.debug(`[BackgroundSync] ✓ Successfully synced ${policies.length} policies`);
      return policies.length;
    } catch (error: unknown) {
      logger.error('[BackgroundSync] Error syncing policies:', error);
      throw error;
    }
  }

  /**
   * Sync a single policy by ID or type (public method for manual reload)
   */
  async syncSinglePolicy(policyIdOrType: string): Promise<Record<string, unknown>> {
    // Policy can be identified by GID or by type (e.g., "PRIVACY_POLICY")
    const isType = !policyIdOrType.startsWith("gid://");

    logger.debug(`[BackgroundSync] Manual sync for policy: ${policyIdOrType}`);

    const { db } = await import("../db.server");

    // Fetch all policies to find the one we need
    const policiesResponse = await this.gateway.graphql(
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
    const policies: ShopifyPolicyData[] = policiesData.data?.shop?.shopPolicies || [];

    // Find the policy
    const policyData = isType
      ? policies.find((p) => p.type === policyIdOrType)
      : policies.find((p) => p.id === policyIdOrType);

    if (!policyData) {
      throw new Error(`Policy ${policyIdOrType} not found in Shopify`);
    }

    // Fetch locales
    const locales = await fetchShopLocales(this.gateway.graphql.bind(this.gateway));
    const nonPrimaryLocales = locales.filter((l) => !l.primary);

    // Sync the policy
    await this.syncSinglePolicyInternal(policyData, nonPrimaryLocales);

    // Return fresh data from database
    const policy = await db.shopPolicy.findUnique({
      where: {
        shop_id: {
          shop: this.shop,
          id: policyData.id,
        },
      },
    });

    const translations = await db.contentTranslation.findMany({
      where: {
        shop: this.shop,
        resourceId: policyData.id,
        resourceType: "ShopPolicy",
      },
    });

    return {
      ...policy,
      translations,
    };
  }

  /**
   * Sync a single policy with translations (internal method)
   * Uses a transaction to ensure data consistency
   */
  private async syncSinglePolicyInternal(policyData: ShopifyPolicyData, nonPrimaryLocales: ShopLocale[]): Promise<void> {
    const { db } = await import("../db.server");

    // Fetch translations for all non-primary locales (outside transaction - API calls)
    const allTranslations = await fetchAllTranslations(this.gateway.graphql.bind(this.gateway),
      policyData.id,
      nonPrimaryLocales,
      "ShopPolicy"
    );

    // Prepare current keys for cleanup
    const currentKeys = allTranslations.map((t) => ({ key: t.key, locale: t.locale }));

    // Use transaction to ensure all-or-nothing data consistency
    await db.$transaction(async (tx) => {
      // Upsert policy
      await tx.shopPolicy.upsert({
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
        await tx.contentTranslation.upsert({
          where: {
            shop_resourceId_key_locale: {
              shop: this.shop,
              resourceId: policyData.id,
              key: t.key,
              locale: t.locale,
            },
          },
          create: {
            shop: this.shop,
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
      if (currentKeys.length > 0) {
        await tx.contentTranslation.deleteMany({
          where: {
            shop: this.shop,
            resourceId: policyData.id,
            resourceType: "ShopPolicy",
            NOT: {
              OR: currentKeys.map(({ key, locale }) => ({ key, locale })),
            },
          },
        });
      } else {
        // No translations from Shopify - delete all
        await tx.contentTranslation.deleteMany({
          where: {
            shop: this.shop,
            resourceId: policyData.id,
            resourceType: "ShopPolicy",
          },
        });
      }
    });
  }

  // ============================================
  // SINGLE THEME GROUP SYNC
  // ============================================

  /**
   * Sync a single theme group by groupId (public method for manual reload)
   */
  async syncSingleThemeGroup(groupId: string): Promise<Record<string, unknown>> {
    logger.debug(`[BackgroundSync] Syncing single theme group: ${groupId}`);

    const { db } = await import("../db.server");

    // A group can span multiple Shopify resources (e.g. two product template
    // files both contribute keys to the "product" group).  Fetch ALL rows so
    // every resource is synced — using findFirst would arbitrarily pick one
    // and leave the others stale / their translations deleted.
    const existingRows = await db.themeContent.findMany({
      where: {
        shop: this.shop,
        groupId: groupId,
      },
    });

    if (existingRows.length === 0) {
      throw new Error(`Theme group not found: ${groupId}`);
    }

    const uniqueResourceIds = [...new Set(existingRows.map((r) => r.resourceId))];
    logger.debug(`[BackgroundSync] Group "${groupId}" spans ${uniqueResourceIds.length} resource(s)`);

    // Get shop locales
    const locales = await fetchShopLocales(this.gateway.graphql.bind(this.gateway));
    const nonPrimaryLocales = locales.filter((l) => !l.primary);

    // Collect translations from ALL resources
    const allTranslations: ShopifyTranslation[] = [];

    for (const resourceId of uniqueResourceIds) {
      // Fetch fresh translatable content from Shopify
      const translatableResponse = await this.gateway.graphql(
        `#graphql
          query getThemeTranslatableResource($resourceId: ID!) {
            translatableResource(resourceId: $resourceId) {
              resourceId
              translatableContent {
                key
                value
                digest
                locale
              }
            }
          }`,
        { variables: { resourceId } }
      );

      const translatableData = await translatableResponse.json();

      if (translatableData.errors) {
        logger.error('[BackgroundSync] GraphQL error for resource', { resourceId, errors: translatableData.errors });
        continue; // Skip this resource but keep syncing others
      }

      const resource = translatableData.data?.translatableResource;
      if (!resource) {
        logger.warn(`[BackgroundSync] Resource not found in Shopify: ${resourceId}, skipping`);
        continue;
      }

      // Filter content that belongs to this group using the same pattern-based
      // grouping logic as the initial sync.
      const allContent: TranslatableContentItem[] = resource.translatableContent || [];
      const groupContent = allContent.filter((item) => {
        return getGroupIdForKey(item.key) === groupId;
      });

      logger.debug(`[BackgroundSync] Resource ${resourceId}: ${groupContent.length} fields for group ${groupId}`);

      // Update this resource's ThemeContent row
      await db.themeContent.update({
        where: {
          shop_resourceId_groupId: {
            shop: this.shop,
            resourceId: resourceId,
            groupId: groupId,
          },
        },
        data: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON column accepts any JSON-serializable value
          translatableContent: groupContent as any,
          lastSyncedAt: new Date(),
        },
      });

      // Fetch translations for all non-primary locales for this resource
      for (const locale of nonPrimaryLocales) {
        try {
          const translationsResponse = await this.gateway.graphql(
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
            { variables: { resourceId, locale: locale.locale } }
          );

          const translationsData = await translationsResponse.json();

          if (!translationsData.errors) {
            const translations: ShopifyTranslation[] = translationsData.data?.translatableResource?.translations || [];
            // Filter translations that belong to this group
            const groupTranslations = translations.filter((t) =>
              groupContent.some((c) => c.key === t.key)
            );
            allTranslations.push(...groupTranslations.map((t) => ({ ...t, _resourceId: resourceId })));
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[BackgroundSync] Error fetching translations for locale ${locale.locale}`, { error: message });
        }
      }
    }

    logger.debug(`[BackgroundSync] Fetched ${allTranslations.length} translations across ${uniqueResourceIds.length} resource(s) for group ${groupId}`);

    // Delete all existing translations for this group, then re-create from Shopify
    await db.themeTranslation.deleteMany({
      where: {
        shop: this.shop,
        groupId: groupId,
      },
    });

    // Re-create translations from ALL resources
    for (const t of allTranslations) {
      const resId = (t as any)._resourceId || uniqueResourceIds[0];
      await db.themeTranslation.create({
        data: {
          shop: this.shop,
          resourceId: resId,
          groupId: groupId,
          key: t.key,
          value: t.value,
          locale: t.locale,
          outdated: t.outdated || false,
        },
      });
    }

    // Return fresh data (merged from all resources)
    const updatedThemeContent = await db.themeContent.findMany({
      where: {
        shop: this.shop,
        groupId: groupId,
      },
    });

    const updatedTranslations = await db.themeTranslation.findMany({
      where: {
        shop: this.shop,
        groupId: groupId,
      },
    });

    logger.debug(`[BackgroundSync] Successfully synced theme group ${groupId} (${updatedThemeContent.length} resource(s), ${updatedTranslations.length} translations)`);

    return {
      themeContent: updatedThemeContent,
      translations: updatedTranslations,
    };
  }

  // ============================================
  // THEMES SYNC
  // ============================================

  /**
   * Sync all theme content with translations
   * This is complex as it groups theme resources by patterns
   */
  async syncAllThemes(onProgress?: ProgressCallback): Promise<number> {
    logger.debug(`[BackgroundSync] Syncing all themes for shop: ${this.shop}`);

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

      // Use module-level THEME_KEY_PATTERNS for grouping
      const KEY_PATTERNS = THEME_KEY_PATTERNS;

      // Get shop locales
      const locales = await fetchShopLocales(this.gateway.graphql.bind(this.gateway));
      const nonPrimaryLocales = locales.filter((l) => !l.primary);

      let totalGroups = 0;

      // Track all synced theme content combinations for cleanup
      const syncedCombinations = new Set<string>();

      // Track fetched translations to avoid duplicate API calls
      const translationCache = new Map<string, ShopifyTranslation[]>();

      // Fetch resources for each working resource type
      let resourceTypeIndex = 0;
      const totalResourceTypes = WORKING_RESOURCE_TYPES.length;

      for (const resourceTypeConfig of WORKING_RESOURCE_TYPES) {
        resourceTypeIndex++;

        // Report progress at the start of each resource type
        if (onProgress) {
          const progress = Math.round((resourceTypeIndex - 1) / totalResourceTypes * 100);
          onProgress(progress, 100, `Syncing ${resourceTypeConfig.label}...`);
        }

        try {
          // Implement pagination to handle large datasets
          let hasNextPage = true;
          let cursor: string | null = null;
          const allResourcesForType: ThemeResource[] = [];
          let pageNumber = 0;

          while (hasNextPage) {
            pageNumber++;

            // Report pagination progress
            if (onProgress) {
              const progress = Math.round((resourceTypeIndex - 1) / totalResourceTypes * 100);
              onProgress(progress, 100, `Loading ${resourceTypeConfig.label}... (page ${pageNumber})`);
            }

            const translatableResponse = await this.gateway.graphql(
              `#graphql
                query getThemeTranslatableResources($first: Int!, $resourceType: TranslatableResourceType!, $after: String) {
                  translatableResources(first: $first, resourceType: $resourceType, after: $after) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    edges {
                      cursor
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
              { variables: { first: 250, resourceType: resourceTypeConfig.type, after: cursor } }
            );

            const translatableData = await translatableResponse.json();

            if (translatableData.errors) {
              logger.error(`[BackgroundSync] Error loading ${resourceTypeConfig.type}`, { error: translatableData.errors[0].message });
              break;
            }

            const pageInfo = translatableData.data?.translatableResources?.pageInfo;
            const edges = translatableData.data?.translatableResources?.edges || [];

            allResourcesForType.push(...edges.map((edge: { node: ThemeResource }) => edge.node));

            hasNextPage = pageInfo?.hasNextPage || false;
            cursor = pageInfo?.endCursor || null;

            if (hasNextPage) {
              logger.debug(`[BackgroundSync-Themes] 📄 Fetching next page for ${resourceTypeConfig.type} (cursor: ${cursor})`);
            }
          }

          const resources = allResourcesForType;

          // Skip if no resources found
          if (resources.length === 0) {
            logger.debug(`[BackgroundSync-Themes] ⚠️  No resources found for ${resourceTypeConfig.type}, skipping...`);
            continue;
          }

          logger.debug(`[BackgroundSync-Themes] ✅ Found ${resources.length} resources for ${resourceTypeConfig.type}`);

          // Process each resource
          let resourceIndex = 0;
          for (const resource of resources) {
            resourceIndex++;

            // Report detailed progress
            if (onProgress) {
              const baseProgress = Math.round((resourceTypeIndex - 1) / totalResourceTypes * 100);
              const resourceProgress = Math.round((resourceIndex / resources.length) * (100 / totalResourceTypes));
              onProgress(baseProgress + resourceProgress, 100, `${resourceTypeConfig.label}: ${resourceIndex}/${resources.length}`);
            }
            // Skip resources with no translatable content
            if (!resource.translatableContent || resource.translatableContent.length === 0) {
              logger.debug(`[BackgroundSync-Themes] ⚠️  Resource ${resource.resourceId} has no translatable content, skipping...`);
              continue;
            }
            // Group translatable content by key patterns
            const contentByGroup: Record<string, ThemeContentItem[]> = {};
            const unmatchedContent: TranslatableContentItem[] = [];

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
              const unmatchedByPrefix: Record<string, TranslatableContentItem[]> = {};

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

            // Batch-fetch ALL existing theme translations for this resource (avoids N+1 per group)
            const allExistingTranslations = await db.themeTranslation.findMany({
              where: {
                shop: this.shop,
                resourceId: resource.resourceId,
              },
              select: { key: true, locale: true, groupId: true }
            });

            const existingKeysByGroup = new Map<string, Set<string>>();
            for (const t of allExistingTranslations) {
              if (!existingKeysByGroup.has(t.groupId)) {
                existingKeysByGroup.set(t.groupId, new Set());
              }
              existingKeysByGroup.get(t.groupId)!.add(`${t.key}::${t.locale}`);
            }

            // Fetch translations for each group
            for (const [groupId, items] of Object.entries(contentByGroup)) {
              const firstItem = items[0];
              const groupName = firstItem._groupName;
              const groupIcon = firstItem._groupIcon;

              // Deduplicate translations for this group
              const allTranslations: ShopifyTranslation[] = [];
              const seenKeys = new Set<string>(); // Track seen key-locale combinations

              // Check cache first to avoid duplicate API calls
              const cacheKey = `${resource.resourceId}::${nonPrimaryLocales.map((l) => l.locale).join(',')}`;
              let resourceTranslations = translationCache.get(cacheKey);

              if (!resourceTranslations) {
                logger.debug(`[BackgroundSync-Themes] 🔍 Fetching translations for resource ${resource.resourceId} (${items.length} fields, ${nonPrimaryLocales.length} locales)`);

                // Process locales sequentially with delay to avoid rate limiting
                resourceTranslations = [];

                let localeIndex = 0;
                for (const locale of nonPrimaryLocales) {
                  localeIndex++;
                  try {
                    logger.debug(`[BackgroundSync-Themes]   🌐 Fetching locale ${locale.locale}...`);

                    // Report locale fetching progress
                    if (onProgress) {
                      const baseProgress = Math.round((resourceTypeIndex - 1) / totalResourceTypes * 100);
                      const resourceProgress = Math.round((resourceIndex / resources.length) * (100 / totalResourceTypes));
                      onProgress(
                        baseProgress + resourceProgress,
                        100,
                        `Fetching translations: ${locale.name || locale.locale} (${localeIndex}/${nonPrimaryLocales.length})`
                      );
                    }

                    // Gateway handles rate limiting and retry automatically
                    const translationsResponse = await this.gateway.graphql(
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

                    // Check for GraphQL errors
                    if (translationsData.errors) {
                      logger.error(`[BackgroundSync-Themes]   ❌ GraphQL error for locale ${locale.locale}:`, translationsData.errors[0].message);
                      continue;
                    }

                    const translations: ShopifyTranslation[] = translationsData.data?.translatableResource?.translations || [];

                    if (translations.length > 0) {
                      logger.debug(`[BackgroundSync-Themes]   ✅ Locale ${locale.locale}: ${translations.length} translations fetched`);
                      resourceTranslations.push(...translations);
                    } else {
                      logger.debug(`[BackgroundSync-Themes]   ⚠️  Locale ${locale.locale}: NO translations found (might be empty in Shopify)`);
                    }

                  } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error(`[BackgroundSync-Themes]   ❌ Exception fetching locale ${locale.locale}:`, message);
                  }
                }

                // Cache the fetched translations
                translationCache.set(cacheKey, resourceTranslations);
                logger.debug(`[BackgroundSync-Themes] 💾 Cached ${resourceTranslations.length} translations for resource ${resource.resourceId}`);
              } else {
                logger.debug(`[BackgroundSync-Themes] ⚡ Using cached translations for resource ${resource.resourceId} (${resourceTranslations.length} translations)`);
              }

              // Filter translations relevant to this group
              for (const t of resourceTranslations) {
                if (items.some(item => item.key === t.key)) {
                  const uniqueKey = `${t.key}::${t.locale}`;
                  if (!seenKeys.has(uniqueKey)) {
                    seenKeys.add(uniqueKey);
                    allTranslations.push(t);
                  }
                }
              }

              logger.debug(`[BackgroundSync-Themes] 💾 Saving ${allTranslations.length} translations for group "${groupName}" to database`);
              if (allTranslations.length === 0 && nonPrimaryLocales.length > 0) {
                logger.debug(`[BackgroundSync-Themes] ⚠️  NO TRANSLATIONS found! Either they don't exist in Shopify or the API call failed`);
              }

              // Report saving progress
              if (onProgress) {
                const baseProgress = Math.round((resourceTypeIndex - 1) / totalResourceTypes * 100);
                const resourceProgress = Math.round((resourceIndex / resources.length) * (100 / totalResourceTypes));
                onProgress(baseProgress + resourceProgress, 100, `Saving translations: ${groupName}`);
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
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON column
                  translatableContent: items as any,
                  lastSyncedAt: new Date(),
                },
                update: {
                  resourceType: resourceTypeConfig.type,
                  resourceTypeLabel: resourceTypeConfig.label,
                  groupName,
                  groupIcon,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON column
                  translatableContent: items as any,
                  lastSyncedAt: new Date(),
                },
              });

              // Use pre-fetched existing keys for this group (batch-loaded above)
              const existingKeys = existingKeysByGroup.get(groupId) || new Set<string>();

              // Batch upsert all translations in a single transaction
              if (allTranslations.length > 0) {
                await db.$transaction(
                  allTranslations.map(t =>
                    db.themeTranslation.upsert({
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
                    })
                  )
                );
              }

              // Delete translations that no longer exist in Shopify
              const currentKeys = new Set(
                allTranslations.map((t) => `${t.key}::${t.locale}`)
              );

              const keysToDelete = Array.from(existingKeys).filter(
                key => !currentKeys.has(key)
              );

              if (keysToDelete.length > 0) {
                const parsedKeysToDelete = keysToDelete.map(kl => {
                  const [key, locale] = kl.split('::');
                  return { key, locale };
                });
                await db.themeTranslation.deleteMany({
                  where: {
                    shop: this.shop,
                    resourceId: resource.resourceId,
                    groupId,
                    OR: parsedKeysToDelete.map(({ key, locale }) => ({ key, locale })),
                  },
                });
              }

              totalGroups++;
            }
          }
        } catch (error) {
          logger.error(`[BackgroundSync] Error syncing theme type ${resourceTypeConfig.type}`, { error });
        }
      }

      // Health check: refuse to wipe local data when Shopify returns 0 theme resources.
      // Same pattern as syncAllPages / syncAllPolicies.
      if (syncedCombinations.size === 0) {
        const localThemeCount = await db.themeContent.count({ where: { shop: this.shop } });
        if (localThemeCount > 0) {
          logger.error(`[BackgroundSync] 🔴 ABORTING theme sync: Shopify returned 0 theme resources but ${localThemeCount} exist locally. Possible API outage.`);
          throw new Error(`Shopify returned 0 theme resources but ${localThemeCount} exist locally - aborting to prevent data loss`);
        }
        logger.debug(`[BackgroundSync] No theme resources from Shopify and none locally - nothing to do`);
        return 0;
      }

      // AGGRESSIVE CLEANUP: Delete theme content that no longer exists in Shopify
      if (onProgress) {
        onProgress(95, 100, `Cleaning up obsolete themes...`);
      }
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
          logger.debug(`[BackgroundSync] 🗑️ Deleting ${toDelete.length} obsolete theme content groups`);

          const deleteConditions = toDelete.map(item => ({
            resourceId: item.resourceId,
            groupId: item.groupId,
          }));

          await db.$transaction([
            db.themeTranslation.deleteMany({
              where: {
                shop: this.shop,
                OR: deleteConditions,
              },
            }),
            db.themeContent.deleteMany({
              where: {
                shop: this.shop,
                OR: deleteConditions,
              },
            }),
          ]);

          logger.debug(`[BackgroundSync] 🗑️ Deleted ${toDelete.length} obsolete theme groups and their translations`);
        }
      }

      // Log final database statistics
      const finalStats = await db.themeContent.count({
        where: { shop: this.shop }
      });
      const finalTranslationStats = await db.themeTranslation.count({
        where: { shop: this.shop }
      });

      logger.debug(`[BackgroundSync] ✓ Successfully synced ${totalGroups} theme groups`);
      logger.debug(`[BackgroundSync] Database stats: ${finalStats} ThemeContent, ${finalTranslationStats} ThemeTranslations`);

      return totalGroups;
    } catch (error: unknown) {
      logger.error('[BackgroundSync] Error syncing themes:', error);
      throw error;
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  // ============================================
  // WRAPPER METHOD
  // ============================================

  /**
   * Sync all content types (Pages, Policies, Themes)
   * @returns Statistics about the sync operation
   */
  async syncAll(): Promise<SyncStats> {
    const startTime = Date.now();

    logger.debug(`[BackgroundSync] Starting full sync for shop: ${this.shop}`);

    try {
      // Run all syncs in parallel with aggressive cleanup
      const [pages, policies, themes, metaobjects] = await Promise.all([
        this.syncAllPages().catch(err => {
          logger.error('[BackgroundSync] Pages sync failed:', err);
          return 0;
        }),
        this.syncAllPolicies().catch(err => {
          logger.error('[BackgroundSync] Policies sync failed:', err);
          return 0;
        }),
        this.syncAllThemes().catch(err => {
          logger.error('[BackgroundSync] Themes sync failed:', err);
          return 0;
        }),
        this.syncAllMetaobjects().catch(err => {
          logger.error('[BackgroundSync] Metaobjects sync failed:', err);
          return 0;
        }),
      ]);

      const duration = Date.now() - startTime;
      const stats: SyncStats = {
        pages,
        policies,
        themes,
        metaobjects,
        total: pages + policies + themes + metaobjects,
        duration,
      };

      logger.debug(`[BackgroundSync] ✓ Full sync complete in ${duration}ms`);
      logger.debug(`[BackgroundSync]   Pages: ${pages}, Policies: ${policies}, Themes: ${themes}, Metaobjects: ${metaobjects}`);

      return stats;
    } catch (error: unknown) {
      logger.error('[BackgroundSync] Full sync failed:', error);
      throw error;
    }
  }

  /**
   * Sync all metaobjects
   */
  private async syncAllMetaobjects(): Promise<number> {
    try {
      const { MetaobjectSyncService } = await import('./metaobject-sync.service');
      const metaobjectSync = new MetaobjectSyncService(this.gateway, this.shop);

      const result = await metaobjectSync.syncAll();
      return result.metaobjects;
    } catch (error: unknown) {
      logger.error('[BackgroundSync] Metaobjects sync error:', error);
      return 0;
    }
  }
}
