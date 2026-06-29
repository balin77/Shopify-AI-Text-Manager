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
import { db } from '../db.server';
import { getSyncScope, canAccessContentType, type Plan } from '../utils/planUtils';
import { ContentSyncService } from './content-sync.service';

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

export interface KeyPatternConfig {
  pattern: RegExp;
  name: string;
  groupId: string;
  icon: string;
  extractSubgroup?: boolean;
}

// Ordering matters: more specific patterns MUST precede the generic prefix they
// share (e.g. shopify.checkout.* before shopify.*, templates.404.* before
// templates.*). The matcher takes the first hit and stops.
export const THEME_KEY_PATTERNS: KeyPatternConfig[] = [
  // ── JSON template sections (section.*) ──
  { pattern: /^section\.article\./, name: 'Article', groupId: 'article', icon: '📝' },
  { pattern: /^section\.blog\./, name: 'Blog', groupId: 'blog_theme', icon: '📝' },
  { pattern: /^section\.collection\./, name: 'Collection', groupId: 'collection', icon: '📂' },
  { pattern: /^section\.index\./, name: 'Index Page', groupId: 'index', icon: '🏠' },
  { pattern: /^section\.password\./, name: 'Password Page', groupId: 'password', icon: '🔒' },
  { pattern: /^section\.product\./, name: 'Product', groupId: 'product', icon: '🛍️' },
  { pattern: /^section\.page\.([^.]+)\./, name: 'Pages', groupId: 'pages', icon: '📄', extractSubgroup: true },

  // ── JSON template top-level keys (templates.*) ──
  { pattern: /^templates\.404\./, name: '404', groupId: 'tpl_404', icon: '🚫' },
  { pattern: /^templates\.list-collections\./, name: 'List Collections', groupId: 'tpl_list_coll', icon: '📂' },

  { pattern: /^collections\.json\./, name: 'Collections Template', groupId: 'collections_template', icon: '📋' },
  { pattern: /^group\.json\./, name: 'Theme Groups', groupId: 'groups', icon: '🎨' },
  { pattern: /^bar\./, name: 'Announcement Bars', groupId: 'bars', icon: '📢' },

  // ── shopify.* namespace (LOCALE_CONTENT: checkout + system strings, ~2590 keys) ──
  { pattern: /^shopify\.checkout\./, name: 'Checkout & System', groupId: 'shopify_checkout', icon: '🛒' },
  { pattern: /^shopify\.customer_accounts\./, name: 'Customer Accounts (Shopify)', groupId: 'shopify_customer_accounts', icon: '👥' },
  { pattern: /^shopify\.email_marketing\./, name: 'Email Marketing', groupId: 'shopify_email_marketing', icon: '✉️' },
  { pattern: /^shopify\.subscriptions\./, name: 'Subscriptions', groupId: 'shopify_subscriptions', icon: '🔁' },
  { pattern: /^shopify\.sentence\./, name: 'Sentence connectors', groupId: 'shopify_sentence', icon: '✏️' },
  { pattern: /^shopify\./, name: 'Shopify (other)', groupId: 'shopify_other', icon: '🏬' },

  // ── LOCALE_CONTENT top-level prefixes (Theme-Standardinhalte) ──
  { pattern: /^accessibility\./, name: 'Accessibility', groupId: 'accessibility', icon: '♿' },
  { pattern: /^accounts\./, name: 'Accounts', groupId: 'accounts', icon: '👤' },
  { pattern: /^announcement_bar\./, name: 'Announcement Bar', groupId: 'announcement_bar', icon: '📢' },
  { pattern: /^blogs\./, name: 'Blogs', groupId: 'blogs_theme', icon: '📝' },
  { pattern: /^customer_accounts\./, name: 'Customer Accounts', groupId: 'customer_accounts', icon: '👥' },
  { pattern: /^customer\./, name: 'Customer', groupId: 'customer', icon: '👤' },
  { pattern: /^general\./, name: 'General', groupId: 'general', icon: '🔧' },
  { pattern: /^gift_cards?\./, name: 'Gift Cards', groupId: 'gift_cards', icon: '🎁' },
  { pattern: /^localization\./, name: 'Localization', groupId: 'localization', icon: '🌍' },
  { pattern: /^newsletter\./, name: 'Newsletter', groupId: 'newsletter', icon: '📰' },
  { pattern: /^onboarding\./, name: 'Onboarding', groupId: 'onboarding', icon: '🚀' },
  { pattern: /^products\./, name: 'Products', groupId: 'products_theme', icon: '🛍️' },
  { pattern: /^recipient\./, name: 'Recipient', groupId: 'recipient', icon: '👥' },
  { pattern: /^sections\./, name: 'Sections', groupId: 'sections_theme', icon: '🧩' },
  { pattern: /^templates\./, name: 'Templates', groupId: 'templates_theme', icon: '📋' },

  { pattern: /^Settings Categories:/, name: 'Settings', groupId: 'settings', icon: '⚙️' },
];

/** Determine which groupId a translatable key belongs to (same logic as initial sync) */
export function getGroupIdForKey(key: string): string {
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

/**
 * App-embed translatable keys look like `block.<blockId>.<setting>`. All keys
 * within one ONLINE_STORE_THEME_APP_EMBED resource share the same <blockId>,
 * which matches an entry under `current.blocks` in settings_data.json. Returns
 * the first blockId found, or null when the keys don't follow this shape.
 */
export function extractAppEmbedBlockId(content: { key: string }[]): string | null {
  for (const item of content) {
    const m = item.key.match(/^block\.([^.]+)\./);
    if (m) return m[1];
  }
  return null;
}

/** "contentpilot-ai" / "language_and_currency" → "Contentpilot Ai" / "Language And Currency". */
function titleizeHandle(handle: string): string {
  return handle
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Turn an app-block `type` (`shopify://apps/<app>/blocks/<block>/<uuid>`) into a
 * human label like "Contentpilot Ai – Language And Currency". Names are derived
 * from handles (the storefront-pretty title lives in the app's extension schema,
 * not in the Admin API), so they're recognizable but not pixel-perfect. Returns
 * null when the type isn't an app block.
 */
export function prettifyAppEmbedType(type: unknown): string | null {
  if (typeof type !== 'string') return null;
  const m = type.match(/^shopify:\/\/apps\/([^/]+)\/blocks\/([^/]+)\//);
  if (!m) return null;
  const app = titleizeHandle(m[1]);
  const block = titleizeHandle(m[2]);
  return block ? `${app} – ${block}` : app;
}

export interface SyncStats {
  pages: number;
  policies: number;
  themes: number;
  metaobjects: number;
  articles: number;
  menus: number;
  system: number;
  delivery: number;
  onlineStoreExtras: number;
  sellingPlans: number;
  cookieBanner: number;
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
   * Build a blockId → display-name map for theme app embeds by reading the main
   * theme's config/settings_data.json (requires read_themes). App embeds live
   * under `current.blocks`, keyed by the same blockId that prefixes their
   * translatable keys. Best-effort: returns an empty map on any error so the
   * sync falls back to generic names.
   */
  private async fetchAppEmbedNameMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      // Mirror the proven GET_THEME_FILES shape (content.queries.ts): `files`
      // is a connection and REQUIRES `first`/`last`, and we filter to the MAIN
      // theme by `role` rather than the `roles:` arg for maximum compatibility.
      const resp = await this.gateway.graphql(
        `#graphql
          query themeSettingsData {
            themes(first: 20) {
              nodes {
                role
                files(filenames: ["config/settings_data.json"], first: 1) {
                  nodes {
                    body { ... on OnlineStoreThemeFileBodyText { content } }
                  }
                }
              }
            }
          }`
      );
      const data = await resp.json();
      if (data.errors) {
        logger.warn(`[BackgroundSync] settings_data.json query error`, { error: data.errors[0]?.message });
        return map;
      }
      const nodes: Array<{ role?: string; files?: { nodes?: Array<{ body?: { content?: string } }> } }> =
        data.data?.themes?.nodes ?? [];
      const mainTheme = nodes.find((n) => String(n.role).toUpperCase() === "MAIN") ?? nodes[0];
      const content = mainTheme?.files?.nodes?.[0]?.body?.content;
      if (!content) {
        logger.warn(`[BackgroundSync] settings_data.json not found on main theme (themes: ${nodes.length})`);
        return map;
      }
      const parsed = JSON.parse(content);
      const blocks = parsed?.current?.blocks;
      if (blocks && typeof blocks === 'object') {
        for (const [blockId, block] of Object.entries(blocks)) {
          const name = prettifyAppEmbedType((block as { type?: unknown })?.type);
          if (name) map.set(blockId, name);
        }
      }
      logger.debug(`[BackgroundSync] app-embed name map built: ${map.size} block(s) named (current.blocks: ${blocks ? Object.keys(blocks).length : 0})`);
    } catch (err) {
      logger.warn(`[BackgroundSync] Could not derive app-embed names from settings_data.json`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return map;
  }

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
        // Defense-in-depth: this per-group reload is theme-only. New-domain
        // groupIds never collide today, but the unique constraint omits domain
        // so we scope explicitly.
        domain: "theme",
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
      // App-embed groups are keyed per resource (groupId = app_embed_<id>), not
      // by key pattern — every field of the resource belongs to the group.
      const groupContent = groupId.startsWith('app_embed_')
        ? allContent
        : allContent.filter((item) => getGroupIdForKey(item.key) === groupId);

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

    // Differential sync: only write rows that are new or actually changed, and
    // delete rows that disappeared. Re-creating every row on each sync produced
    // tens of thousands of dead tuples per run -> table bloat + WAL explosion.
    const desired = allTranslations.map((t) => ({
      resourceId: (t as any)._resourceId || uniqueResourceIds[0],
      key: t.key,
      value: t.value,
      locale: t.locale,
      outdated: t.outdated || false,
    }));

    const existing = await db.themeTranslation.findMany({
      where: { shop: this.shop, groupId: groupId, domain: "theme" },
      select: { id: true, resourceId: true, key: true, locale: true, value: true, outdated: true },
    });

    const rowKey = (r: { resourceId: string; key: string; locale: string }) =>
      `${r.resourceId} ${r.key} ${r.locale}`;
    const existingByKey = new Map(existing.map((r) => [rowKey(r), r]));
    const desiredKeys = new Set(desired.map(rowKey));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ops: any[] = [];

    for (const d of desired) {
      const prev = existingByKey.get(rowKey(d));
      if (!prev) {
        ops.push(
          db.themeTranslation.create({
            data: {
              shop: this.shop,
              resourceId: d.resourceId,
              groupId: groupId,
              domain: "theme",
              key: d.key,
              value: d.value,
              locale: d.locale,
              outdated: d.outdated,
            },
          })
        );
      } else if (prev.value !== d.value || prev.outdated !== d.outdated) {
        ops.push(
          db.themeTranslation.update({
            where: { id: prev.id },
            data: { value: d.value, outdated: d.outdated, updatedAt: new Date() },
          })
        );
      }
      // else: identical -> no write, no dead tuple
    }

    const staleIds = existing.filter((r) => !desiredKeys.has(rowKey(r))).map((r) => r.id);
    if (staleIds.length > 0) {
      ops.push(db.themeTranslation.deleteMany({ where: { id: { in: staleIds } } }));
    }

    if (ops.length > 0) {
      await db.$transaction(ops);
    }

    // Return fresh data (merged from all resources)
    const updatedThemeContent = await db.themeContent.findMany({
      where: {
        shop: this.shop,
        groupId: groupId,
        domain: "theme",
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

      // Define the working resource types (based on ContentService).
      // ONLINE_STORE_THEME is intentionally dropped — it is a ~99% duplicate of
      // ONLINE_STORE_THEME_LOCALE_CONTENT. APP_EMBED and SETTINGS_DATA_SECTIONS
      // are now included (previously excluded) for full Theme rubric coverage.
      const WORKING_RESOURCE_TYPES = [
        { type: 'ONLINE_STORE_THEME_JSON_TEMPLATE', label: 'JSON Templates' },
        { type: 'ONLINE_STORE_THEME_LOCALE_CONTENT', label: 'Locale Content' },
        { type: 'ONLINE_STORE_THEME_SECTION_GROUP', label: 'Section Groups' },
        { type: 'ONLINE_STORE_THEME_SETTINGS_CATEGORY', label: 'Settings Categories' },
        { type: 'ONLINE_STORE_THEME_APP_EMBED', label: 'App Embeds' },
        { type: 'ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS', label: 'Shared Sections' },
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

      // App-embed naming: blockId→name map from settings_data.json (lazily
      // fetched on the first APP_EMBED resource), plus a counter for embeds we
      // can't resolve a name for.
      let appEmbedNames: Map<string, string> | null = null;
      let appEmbedFallbackCount = 0;

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
            // Group translatable content into nav groups.
            const contentByGroup: Record<string, ThemeContentItem[]> = {};

            if (resourceTypeConfig.type === 'ONLINE_STORE_THEME_APP_EMBED') {
              // App embeds: ONE group per resource (one per installed embed),
              // named from the theme's settings_data.json instead of collapsing
              // every embed into a single key-pattern "block" bucket. Mirrors how
              // Translate & Adapt lists one entry per app.
              if (appEmbedNames === null) {
                appEmbedNames = await this.fetchAppEmbedNameMap();
              }
              const blockId = extractAppEmbedBlockId(resource.translatableContent || []);
              const shortId = resource.resourceId.split('/').pop()?.split('?')[0] || resource.resourceId;
              const appEmbedGroupId = `app_embed_${shortId}`;
              const derivedName = blockId ? appEmbedNames.get(blockId) : undefined;
              const appEmbedGroupName = derivedName || `App-Einbettung ${++appEmbedFallbackCount}`;
              contentByGroup[appEmbedGroupId] = (resource.translatableContent || []).map((item) => ({
                ...item,
                _groupId: appEmbedGroupId,
                _groupName: appEmbedGroupName,
                _groupIcon: '🔌',
              }));
            } else {
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
            }

            // Batch-fetch ALL existing theme translations for this resource (avoids N+1 per group).
            // Include id/value/outdated so the write step below can skip rows that did not
            // change, instead of blindly re-upserting every row on every 60s sync cycle.
            const allExistingTranslations = await db.themeTranslation.findMany({
              where: {
                shop: this.shop,
                resourceId: resource.resourceId,
              },
              select: { id: true, key: true, locale: true, groupId: true, value: true, outdated: true }
            });

            const existingRowsByGroup = new Map<string, Map<string, { id: string; value: string; outdated: boolean }>>();
            for (const t of allExistingTranslations) {
              if (!existingRowsByGroup.has(t.groupId)) {
                existingRowsByGroup.set(t.groupId, new Map());
              }
              existingRowsByGroup.get(t.groupId)!.set(`${t.key}::${t.locale}`, { id: t.id, value: t.value, outdated: t.outdated });
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
                  domain: 'theme',
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
                  domain: 'theme',
                  groupName,
                  groupIcon,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON column
                  translatableContent: items as any,
                  lastSyncedAt: new Date(),
                },
              });

              // Use pre-fetched existing rows for this group (batch-loaded above)
              const existingRows =
                existingRowsByGroup.get(groupId) ||
                new Map<string, { id: string; value: string; outdated: boolean }>();

              // Partition into genuine creates/updates and skip rows that did not change.
              // An unconditional upsert here rewrote *every* row on *every* 60s sync
              // cycle -> MVCC dead tuples + WAL growth that scales with the total row
              // count instead of the number of actual changes (this is what filled the
              // Postgres volume). Mirrors the incremental logic in syncSingleThemeGroup.
              const toCreate: {
                shop: string; resourceId: string; domain: string; groupId: string;
                key: string; value: string; locale: string; outdated: boolean;
              }[] = [];
              const toUpdate: { id: string; value: string; outdated: boolean }[] = [];

              for (const t of allTranslations) {
                const outdated = t.outdated || false;
                const prev = existingRows.get(`${t.key}::${t.locale}`);
                if (!prev) {
                  toCreate.push({
                    shop: this.shop,
                    resourceId: resource.resourceId,
                    domain: 'theme',
                    groupId,
                    key: t.key,
                    value: t.value,
                    locale: t.locale,
                    outdated,
                  });
                } else if (prev.value !== t.value || prev.outdated !== outdated) {
                  toUpdate.push({ id: prev.id, value: t.value, outdated });
                }
                // else: identical -> no write, no dead tuple, no WAL
              }

              // Chunk writes so a large shop generates WAL incrementally instead of
              // one giant atomic transaction (long locks + single huge WAL burst).
              const CHUNK = 500;

              for (let i = 0; i < toCreate.length; i += CHUNK) {
                await db.themeTranslation.createMany({
                  data: toCreate.slice(i, i + CHUNK),
                  skipDuplicates: true,
                });
              }

              for (let i = 0; i < toUpdate.length; i += CHUNK) {
                const batch = toUpdate.slice(i, i + CHUNK);
                await db.$transaction(
                  batch.map(u =>
                    db.themeTranslation.update({
                      where: { id: u.id },
                      data: { value: u.value, outdated: u.outdated },
                    })
                  )
                );
              }

              // Delete translations that no longer exist in Shopify
              const currentKeys = new Set(
                allTranslations.map((t) => `${t.key}::${t.locale}`)
              );

              const keysToDelete = Array.from(existingRows.keys()).filter(
                key => !currentKeys.has(key)
              );

              if (keysToDelete.length > 0) {
                const parsedKeysToDelete = keysToDelete.map(kl => {
                  const [key, locale] = kl.split('::');
                  return { key, locale };
                });
                for (let i = 0; i < parsedKeysToDelete.length; i += CHUNK) {
                  const batch = parsedKeysToDelete.slice(i, i + CHUNK);
                  await db.themeTranslation.deleteMany({
                    where: {
                      shop: this.shop,
                      resourceId: resource.resourceId,
                      groupId,
                      OR: batch.map(({ key, locale }) => ({ key, locale })),
                    },
                  });
                }
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
        const localThemeCount = await db.themeContent.count({ where: { shop: this.shop, domain: 'theme' } });
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
        // Get all existing theme content for this shop (scoped to the theme
        // domain so the System / Online-Store-Extras / Selling-Plans rubrics,
        // which share this table, are never swept by a theme-only sync).
        const existingThemeContent = await db.themeContent.findMany({
          where: { shop: this.shop, domain: 'theme' },
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
                domain: 'theme',
                OR: deleteConditions,
              },
            }),
            db.themeContent.deleteMany({
              where: {
                shop: this.shop,
                domain: 'theme',
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
  // FLAT-DOMAIN SYNC (System / Online-Store-Extras / Selling-Plans)
  // ============================================

  /**
   * Sync one or more translatable resource types into the shared ThemeContent /
   * ThemeTranslation tables under a non-"theme" domain.
   *
   * Unlike syncAllThemes (which splits one resource type's keys into many groups
   * by key prefix), these domains use ONE GROUP PER RESOURCE: every Shopify
   * resource (e.g. each EMAIL_TEMPLATE) becomes its own nav group. This is the
   * only model that renders correctly because resources of the same type share
   * key names (title/body_html) — collapsing them into a single shared group
   * would dedupe-by-key and lose every resource but the first.
   *
   * Orphan cleanup and the empty-result health check are scoped to `domain`, so
   * these never interfere with each other or with the theme domain.
   */
  private async syncFlatDomain(
    domain: string,
    resourceTypes: { type: string; label: string; icon: string; groupPrefix: string; skipIfEmpty?: boolean }[],
    onProgress?: ProgressCallback
  ): Promise<number> {
    logger.debug(`[BackgroundSync] Syncing domain "${domain}" for shop: ${this.shop}`);
    const { db } = await import("../db.server");

    const locales = await fetchShopLocales(this.gateway.graphql.bind(this.gateway));
    const nonPrimaryLocales = locales.filter((l) => !l.primary);

    // Preference order for deriving a human group name from a resource's primary
    // content; falls back to the resource-type label (covers SHOP, whose keys are
    // meta_title/meta_description rather than a name).
    const NAME_KEYS = ["title", "name", "label", "subject"];
    const deriveName = (content: TranslatableContentItem[], fallback: string): string => {
      for (const nk of NAME_KEYS) {
        const hit = content.find((c) => c.key === nk && c.value && c.value.trim());
        if (hit?.value) return hit.value.length > 80 ? `${hit.value.slice(0, 77)}…` : hit.value;
      }
      return fallback;
    };

    const syncedCombinations = new Set<string>();
    let totalGroups = 0;
    let typeIndex = 0;
    // When any resource type fails (GraphQL error or thrown exception) we have an
    // INCOMPLETE view of Shopify for this domain. Running orphan cleanup in that
    // state would delete the failed type's rows (they're absent from
    // syncedCombinations) — silent data loss on a transient API blip. So we skip
    // cleanup for this run and let the next successful cycle reconcile.
    let anySourceFailed = false;

    for (const rt of resourceTypes) {
      typeIndex++;
      if (onProgress) {
        onProgress(Math.round((typeIndex - 1) / resourceTypes.length * 100), 100, `Syncing ${rt.label}...`);
      }

      try {
        // Paginate translatableResources for this type
        const resources: ThemeResource[] = [];
        let hasNextPage = true;
        let cursor: string | null = null;
        while (hasNextPage) {
          const resp = await this.gateway.graphql(
            `#graphql
              query getDomainTranslatableResources($first: Int!, $resourceType: TranslatableResourceType!, $after: String) {
                translatableResources(first: $first, resourceType: $resourceType, after: $after) {
                  pageInfo { hasNextPage endCursor }
                  edges { node { resourceId translatableContent { key value digest locale } } }
                }
              }`,
            { variables: { first: 250, resourceType: rt.type, after: cursor } }
          );
          const data = await resp.json();
          if (data.errors) {
            logger.error(`[BackgroundSync] Error loading ${rt.type} (domain=${domain})`, { error: data.errors[0]?.message });
            anySourceFailed = true;
            break;
          }
          const pageInfo = data.data?.translatableResources?.pageInfo;
          const edges = data.data?.translatableResources?.edges || [];
          resources.push(...edges.map((e: { node: ThemeResource }) => e.node));
          hasNextPage = pageInfo?.hasNextPage || false;
          cursor = pageInfo?.endCursor || null;
        }

        if (resources.length === 0) {
          logger.debug(`[BackgroundSync] No resources for ${rt.type} (domain=${domain})${rt.skipIfEmpty ? " — skipIfEmpty" : ""}`);
          continue;
        }

        for (const resource of resources) {
          const content = (resource.translatableContent || []).filter((c) => c.key);
          if (content.length === 0) continue;

          const shortId = resource.resourceId.split("/").pop() || resource.resourceId;
          const groupId = `${rt.groupPrefix}_${shortId}`;
          const groupName = deriveName(content, rt.label);
          syncedCombinations.add(`${resource.resourceId}::${groupId}`);

          await db.themeContent.upsert({
            where: { shop_resourceId_groupId: { shop: this.shop, resourceId: resource.resourceId, groupId } },
            create: {
              shop: this.shop,
              resourceId: resource.resourceId,
              resourceType: rt.type,
              resourceTypeLabel: rt.label,
              domain,
              groupId,
              groupName,
              groupIcon: rt.icon,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON column
              translatableContent: content as any,
              lastSyncedAt: new Date(),
            },
            update: {
              resourceType: rt.type,
              resourceTypeLabel: rt.label,
              domain,
              groupName,
              groupIcon: rt.icon,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON column
              translatableContent: content as any,
              lastSyncedAt: new Date(),
            },
          });

          // Fetch + persist foreign-locale translations for this resource.
          const existingRows = await db.themeTranslation.findMany({
            // domain-scoped: each rubric's sync only ever considers its own rows
            // (defense-in-depth; the unique key omits domain).
            where: { shop: this.shop, resourceId: resource.resourceId, groupId, domain },
            select: { id: true, key: true, locale: true, value: true, outdated: true },
          });
          const existingByKeyLocale = new Map(existingRows.map((r) => [`${r.key}::${r.locale}`, r]));

          const fetched: ShopifyTranslation[] = [];
          for (const locale of nonPrimaryLocales) {
            try {
              const tResp = await this.gateway.graphql(
                `#graphql
                  query getDomainTranslations($resourceId: ID!, $locale: String!) {
                    translatableResource(resourceId: $resourceId) {
                      translations(locale: $locale) { key value locale outdated }
                    }
                  }`,
                { variables: { resourceId: resource.resourceId, locale: locale.locale } }
              );
              const tData = await tResp.json();
              if (tData.errors) continue;
              const translations: ShopifyTranslation[] = tData.data?.translatableResource?.translations || [];
              fetched.push(...translations);
            } catch (err) {
              logger.error(`[BackgroundSync] Exception fetching ${domain} translations for ${locale.locale}`, { err });
            }
          }

          const seen = new Set<string>();
          const relevant = fetched.filter((t) => {
            // ThemeTranslation.value is non-null; Shopify can return null values
            // for an unset translation — skip those rather than crash the insert.
            if (t.value == null) return false;
            const uk = `${t.key}::${t.locale}`;
            if (seen.has(uk)) return false;
            seen.add(uk);
            return content.some((c) => c.key === t.key);
          });

          const toCreate: { shop: string; resourceId: string; domain: string; groupId: string; key: string; value: string; locale: string; outdated: boolean }[] = [];
          const toUpdate: { id: string; value: string; outdated: boolean }[] = [];
          for (const t of relevant) {
            const outdated = t.outdated || false;
            const prev = existingByKeyLocale.get(`${t.key}::${t.locale}`);
            if (!prev) {
              toCreate.push({ shop: this.shop, resourceId: resource.resourceId, domain, groupId, key: t.key, value: t.value, locale: t.locale, outdated });
            } else if (prev.value !== t.value || prev.outdated !== outdated) {
              toUpdate.push({ id: prev.id, value: t.value, outdated });
            }
          }

          const CHUNK = 500;
          for (let i = 0; i < toCreate.length; i += CHUNK) {
            await db.themeTranslation.createMany({ data: toCreate.slice(i, i + CHUNK), skipDuplicates: true });
          }
          for (let i = 0; i < toUpdate.length; i += CHUNK) {
            await db.$transaction(
              toUpdate.slice(i, i + CHUNK).map((u) =>
                db.themeTranslation.update({ where: { id: u.id }, data: { value: u.value, outdated: u.outdated } })
              )
            );
          }

          // Delete locale rows no longer present in Shopify.
          const currentKeys = new Set(relevant.map((t) => `${t.key}::${t.locale}`));
          const keysToDelete = existingRows.filter((r) => !currentKeys.has(`${r.key}::${r.locale}`)).map((r) => ({ key: r.key, locale: r.locale }));
          for (let i = 0; i < keysToDelete.length; i += CHUNK) {
            await db.themeTranslation.deleteMany({
              where: { shop: this.shop, resourceId: resource.resourceId, groupId, domain, OR: keysToDelete.slice(i, i + CHUNK) },
            });
          }

          totalGroups++;
        }
      } catch (error) {
        anySourceFailed = true;
        logger.error(`[BackgroundSync] Error syncing ${rt.type} (domain=${domain})`, { error });
      }
    }

    // Health check: do not wipe local rows on an empty Shopify response (outage).
    if (syncedCombinations.size === 0) {
      const localCount = await db.themeContent.count({ where: { shop: this.shop, domain } });
      if (localCount > 0) {
        logger.error(`[BackgroundSync] 🔴 ABORTING ${domain} sync: Shopify returned 0 resources but ${localCount} exist locally.`);
        throw new Error(`Shopify returned 0 ${domain} resources but ${localCount} exist locally - aborting to prevent data loss`);
      }
      return 0;
    }

    // Orphan cleanup, scoped to this domain only. Skipped on partial failure so
    // a transient error never deletes the failed type's still-valid rows.
    if (anySourceFailed) {
      logger.warn(`[BackgroundSync] Skipping ${domain} orphan cleanup — a resource type failed this run (incomplete view).`);
      logger.debug(`[BackgroundSync] ✓ Synced ${totalGroups} groups for domain "${domain}" (cleanup deferred)`);
      return totalGroups;
    }
    const existing = await db.themeContent.findMany({ where: { shop: this.shop, domain }, select: { resourceId: true, groupId: true } });
    const toDelete = existing.filter((i) => !syncedCombinations.has(`${i.resourceId}::${i.groupId}`));
    if (toDelete.length > 0) {
      const conditions = toDelete.map((i) => ({ resourceId: i.resourceId, groupId: i.groupId }));
      await db.$transaction([
        db.themeTranslation.deleteMany({ where: { shop: this.shop, domain, OR: conditions } }),
        db.themeContent.deleteMany({ where: { shop: this.shop, domain, OR: conditions } }),
      ]);
      logger.debug(`[BackgroundSync] 🗑️ Deleted ${toDelete.length} obsolete ${domain} groups`);
    }

    logger.debug(`[BackgroundSync] ✓ Synced ${totalGroups} groups for domain "${domain}"`);
    return totalGroups;
  }

  /** System rubric (Pro+): notifications, payment, packing slips. */
  async syncSystemContent(onProgress?: ProgressCallback): Promise<number> {
    return this.syncFlatDomain("system", [
      { type: "EMAIL_TEMPLATE", label: "Benachrichtigung", icon: "✉️", groupPrefix: "email" },
      { type: "PAYMENT_GATEWAY", label: "Zahlungsanbieter", icon: "💳", groupPrefix: "payment", skipIfEmpty: true },
      { type: "PACKING_SLIP_TEMPLATE", label: "Lieferschein", icon: "📦", groupPrefix: "packing", skipIfEmpty: true },
    ], onProgress);
  }

  /** Delivery rubric (Basic+): checkout-facing shipping/delivery method names. */
  async syncDeliveryContent(onProgress?: ProgressCallback): Promise<number> {
    return this.syncFlatDomain("delivery", [
      { type: "DELIVERY_METHOD_DEFINITION", label: "Versandmethode", icon: "🚚", groupPrefix: "delivery" },
    ], onProgress);
  }

  /** Online-Store extras: storefront filters + shop SEO metadata. */
  async syncOnlineStoreExtras(onProgress?: ProgressCallback): Promise<number> {
    return this.syncFlatDomain("online_store_extras", [
      { type: "FILTER", label: "Filter", icon: "🔍", groupPrefix: "filter" },
      { type: "SHOP", label: "Shop-Metadaten", icon: "🏪", groupPrefix: "shop_metadata" },
    ], onProgress);
  }

  /** Selling plans (subscriptions) — conditional, empty on shops without them. */
  async syncSellingPlans(onProgress?: ProgressCallback): Promise<number> {
    return this.syncFlatDomain("selling_plans", [
      { type: "SELLING_PLAN_GROUP", label: "Abo-Gruppe", icon: "📚", groupPrefix: "splan_group", skipIfEmpty: true },
      { type: "SELLING_PLAN", label: "Abo-Plan", icon: "🔁", groupPrefix: "splan", skipIfEmpty: true },
    ], onProgress);
  }

  /**
   * Cookie-Banner rubric — distinct from syncFlatDomain because COOKIE_BANNER
   * lives only in Shopify's `unstable` TranslatableResourceType enum (the rest of
   * the ThemeContent domains use the pinned stable enum). The reads therefore go
   * through a raw fetch against /admin/api/unstable/graphql.json. Persistence is
   * under domain="customer_privacy" (Shopify's own term — chosen to keep the
   * substring "cookie_banner" out of every URL so Brave Shields / EasyPrivacy
   * filters do not silently drop the API calls). The editor renders via the
   * standard ThemeContentDomainPage.
   *
   * Degrades silently to a no-op return 0 when the resource is unreachable on
   * this shop (e.g. region without Customer-Privacy cookie banner enabled, or
   * Shopify schema drift) — matches the original page's "Coming Soon" behaviour
   * without the bespoke UI: the loader simply finds no themeContent rows.
   */
  async syncCookieBanner(onProgress?: ProgressCallback): Promise<number> {
    logger.debug(`[BackgroundSync] Syncing customer_privacy (cookie banner) for shop: ${this.shop}`);
    const { db } = await import("../db.server");

    // One-shot cleanup of legacy rows from the pre-rename sync (domain was
    // "cookie_banner" until we renamed it to dodge ad-blocker filter lists).
    // Idempotent: the deletes are domain-scoped and no other code touches that
    // domain anymore, so once the table has no "cookie_banner" rows this is a
    // no-op forever. Cheaper than a one-shot migration script.
    await db.$transaction([
      db.themeTranslation.deleteMany({ where: { shop: this.shop, domain: "cookie_banner" } }),
      db.themeContent.deleteMany({ where: { shop: this.shop, domain: "cookie_banner" } }),
    ]);
    const {
      getCookieBannerAvailability,
      getCookieBannerResources,
      getCookieBannerTranslations,
    } = await import("../utils/cookie-banner-availability.server");

    // Resolve the access token via the encrypted session storage — the
    // BackgroundSyncService constructor only receives `admin` (stable gateway),
    // not the session, but the unstable endpoint needs the raw token.
    const { sessionStorage } = await import("../shopify.server");
    const sessions = await sessionStorage.findSessionsByShop(this.shop);
    const session = sessions.find((s) => !!s.accessToken);
    if (!session?.accessToken) {
      logger.debug(`[BackgroundSync] No session token for ${this.shop} — skipping cookie_banner sync`);
      return 0;
    }
    const cbSession = { shop: this.shop, accessToken: session.accessToken };

    if (onProgress) onProgress(5, 100, "Probing cookie-banner availability…");
    const availability = await getCookieBannerAvailability(cbSession);
    if (availability !== "available") {
      logger.debug(`[BackgroundSync] cookie_banner unavailable for ${this.shop} — sync no-op`);
      // Mirror the orphan-cleanup safety: if rows exist locally but Shopify now
      // says unavailable, we leave them in place. The next successful probe
      // reconciles. (A "Shopify deleted the cookie banner" event is not a thing
      // we should infer from a probe error.)
      return 0;
    }

    if (onProgress) onProgress(15, 100, "Fetching cookie-banner content…");
    const resources = await getCookieBannerResources(cbSession);
    if (resources === null) {
      logger.debug(`[BackgroundSync] cookie_banner content fetch failed for ${this.shop} — sync no-op`);
      return 0;
    }

    const locales = await fetchShopLocales(this.gateway.graphql.bind(this.gateway));
    const nonPrimaryLocales = locales.filter((l) => !l.primary);

    const NAME_KEYS = ["title", "name", "label"];
    const deriveName = (content: TranslatableContentItem[], fallback: string): string => {
      for (const nk of NAME_KEYS) {
        const hit = content.find((c) => c.key === nk && c.value && c.value.trim());
        if (hit?.value) return hit.value.length > 80 ? `${hit.value.slice(0, 77)}…` : hit.value;
      }
      return fallback;
    };

    const syncedCombinations = new Set<string>();
    let totalGroups = 0;
    let resIdx = 0;

    for (const resource of resources) {
      resIdx++;
      if (onProgress) {
        onProgress(20 + Math.round((resIdx / Math.max(resources.length, 1)) * 70), 100,
          `Syncing cookie-banner ${resIdx}/${resources.length}`);
      }

      // CookieBannerResource's translatableContent uses {key,value,digest,locale}
      // where value/digest are nullable. ThemeContent's JSON column treats
      // these as opaque, so the cast preserves the shape without losing nulls.
      const content = (resource.translatableContent || []).filter((c) => c.key);
      if (content.length === 0) continue;

      const shortId = resource.resourceId.split("/").pop() || resource.resourceId;
      const groupId = `customer_privacy_${shortId}`;
      const groupName = deriveName(
        content as unknown as TranslatableContentItem[],
        "Cookie banner"
      );
      syncedCombinations.add(`${resource.resourceId}::${groupId}`);

      await db.themeContent.upsert({
        where: { shop_resourceId_groupId: { shop: this.shop, resourceId: resource.resourceId, groupId } },
        create: {
          shop: this.shop,
          resourceId: resource.resourceId,
          resourceType: "COOKIE_BANNER",
          resourceTypeLabel: "Cookie banner",
          domain: "customer_privacy",
          groupId,
          groupName,
          groupIcon: "🍪",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON column
          translatableContent: content as any,
          lastSyncedAt: new Date(),
        },
        update: {
          resourceType: "COOKIE_BANNER",
          resourceTypeLabel: "Cookie banner",
          domain: "customer_privacy",
          groupName,
          groupIcon: "🍪",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma JSON column
          translatableContent: content as any,
          lastSyncedAt: new Date(),
        },
      });

      // Fetch + persist foreign-locale translations (raw unstable fetch — the
      // gateway can't reach the unstable endpoint).
      const existingRows = await db.themeTranslation.findMany({
        where: { shop: this.shop, resourceId: resource.resourceId, groupId, domain: "customer_privacy" },
        select: { id: true, key: true, locale: true, value: true, outdated: true },
      });
      const existingByKeyLocale = new Map(existingRows.map((r) => [`${r.key}::${r.locale}`, r]));

      const fetched: ShopifyTranslation[] = [];
      for (const locale of nonPrimaryLocales) {
        const translations = await getCookieBannerTranslations(cbSession, resource.resourceId, locale.locale);
        for (const t of translations) {
          if (t.value == null) continue;
          fetched.push({ key: t.key, value: t.value, locale: t.locale, outdated: t.outdated });
        }
      }

      const seen = new Set<string>();
      const relevant = fetched.filter((t) => {
        const uk = `${t.key}::${t.locale}`;
        if (seen.has(uk)) return false;
        seen.add(uk);
        return content.some((c) => c.key === t.key);
      });

      const toCreate: { shop: string; resourceId: string; domain: string; groupId: string; key: string; value: string; locale: string; outdated: boolean }[] = [];
      const toUpdate: { id: string; value: string; outdated: boolean }[] = [];
      for (const t of relevant) {
        const outdated = t.outdated || false;
        const prev = existingByKeyLocale.get(`${t.key}::${t.locale}`);
        if (!prev) {
          toCreate.push({ shop: this.shop, resourceId: resource.resourceId, domain: "customer_privacy", groupId, key: t.key, value: t.value, locale: t.locale, outdated });
        } else if (prev.value !== t.value || prev.outdated !== outdated) {
          toUpdate.push({ id: prev.id, value: t.value, outdated });
        }
      }

      const CHUNK = 500;
      for (let i = 0; i < toCreate.length; i += CHUNK) {
        await db.themeTranslation.createMany({ data: toCreate.slice(i, i + CHUNK), skipDuplicates: true });
      }
      for (let i = 0; i < toUpdate.length; i += CHUNK) {
        await db.$transaction(
          toUpdate.slice(i, i + CHUNK).map((u) =>
            db.themeTranslation.update({ where: { id: u.id }, data: { value: u.value, outdated: u.outdated } })
          )
        );
      }

      const currentKeys = new Set(relevant.map((t) => `${t.key}::${t.locale}`));
      const keysToDelete = existingRows.filter((r) => !currentKeys.has(`${r.key}::${r.locale}`)).map((r) => ({ key: r.key, locale: r.locale }));
      for (let i = 0; i < keysToDelete.length; i += CHUNK) {
        await db.themeTranslation.deleteMany({
          where: { shop: this.shop, resourceId: resource.resourceId, groupId, domain: "customer_privacy", OR: keysToDelete.slice(i, i + CHUNK) },
        });
      }

      totalGroups++;
    }

    // Orphan cleanup, scoped to this domain only. Skipping the cleanup when
    // Shopify returned 0 resources is essential — that path is taken when the
    // unstable endpoint is reachable but the shop has no cookie banner today.
    // We must NOT use it to wipe rows on a shop that had a banner before; the
    // upstream availability guard means we only reach here on a confirmed
    // "available" probe, so an empty resources[] is authoritative.
    const existing = await db.themeContent.findMany({
      where: { shop: this.shop, domain: "customer_privacy" },
      select: { resourceId: true, groupId: true },
    });
    const toDelete = existing.filter((i) => !syncedCombinations.has(`${i.resourceId}::${i.groupId}`));
    if (toDelete.length > 0) {
      const conditions = toDelete.map((i) => ({ resourceId: i.resourceId, groupId: i.groupId }));
      await db.$transaction([
        db.themeTranslation.deleteMany({ where: { shop: this.shop, domain: "customer_privacy", OR: conditions } }),
        db.themeContent.deleteMany({ where: { shop: this.shop, domain: "customer_privacy", OR: conditions } }),
      ]);
      logger.debug(`[BackgroundSync] 🗑️ Deleted ${toDelete.length} obsolete customer_privacy groups`);
    }

    logger.debug(`[BackgroundSync] ✓ Synced ${totalGroups} customer_privacy (cookie-banner) groups`);
    return totalGroups;
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  // ============================================
  // WRAPPER METHOD
  // ============================================

  /**
   * Recurring incremental sync for webhook-less content types.
   *
   * Plan-aware via the central getSyncScope (same source of truth as the
   * initial sync) so it only fetches what the plan entitles and stays correct
   * if the plan config changes. Covers the webhook-less types: pages, policies,
   * themes, metaobjects, and — added because Shopify offers no article/menu
   * webhooks and they would otherwise go permanently stale after the initial
   * sync — articles and menus. Products/collections are intentionally NOT here
   * (kept fresh by their Shopify webhooks). Disabled phases are skipped (not
   * fetched); pruning no-longer-entitled data stays planCacheCleanup's job.
   *
   * @returns Statistics about the sync operation
   */
  async syncAll(): Promise<SyncStats> {
    const startTime = Date.now();

    logger.debug(`[BackgroundSync] Starting full sync for shop: ${this.shop}`);

    try {
      // Resolve the plan scope (BackgroundSyncService otherwise reads no plan).
      const settings = await db.aISettings.findUnique({
        where: { shop: this.shop },
        select: { subscriptionPlan: true },
      });
      const plan = (settings?.subscriptionPlan || 'free') as Plan;
      const scope = getSyncScope(plan);

      const contentSync = new ContentSyncService(this.gateway, this.shop);

      // Run all entitled syncs in parallel; disabled phases resolve to 0.
      // Gating for the new domains (until they get their own SyncPhase entries
      // in Phase 4): system + selling_plans mirror the themes (Pro+) entitlement;
      // online_store_extras is small + high-value and runs on every tier.
      const [pages, policies, themes, metaobjects, articles, menus, system, delivery, onlineStoreExtras, sellingPlans, cookieBanner] = await Promise.all([
        scope.pages.enabled
          ? this.syncAllPages(scope.pages.max).catch(err => {
              logger.error('[BackgroundSync] Pages sync failed:', err);
              return 0;
            })
          : Promise.resolve(0),
        scope.policies.enabled
          ? this.syncAllPolicies().catch(err => {
              logger.error('[BackgroundSync] Policies sync failed:', err);
              return 0;
            })
          : Promise.resolve(0),
        scope.themes.enabled
          ? this.syncAllThemes().catch(err => {
              logger.error('[BackgroundSync] Themes sync failed:', err);
              return 0;
            })
          : Promise.resolve(0),
        scope.metaobjects.enabled
          ? this.syncAllMetaobjects().catch(err => {
              logger.error('[BackgroundSync] Metaobjects sync failed:', err);
              return 0;
            })
          : Promise.resolve(0),
        scope.articles.enabled
          ? contentSync.syncAllArticles(scope.articles.max).catch(err => {
              logger.error('[BackgroundSync] Articles sync failed:', err);
              return 0;
            })
          : Promise.resolve(0),
        scope.menus.enabled
          ? contentSync.syncAllMenus().catch(err => {
              logger.error('[BackgroundSync] Menus sync failed:', err);
              return 0;
            })
          : Promise.resolve(0),
        // System (notifications/payment/packing) entitled Pro+ — gate directly
        // off the entitlement source so it can't drift from canAccessContentType.
        canAccessContentType(plan, 'system')
          ? this.syncSystemContent().catch(err => {
              logger.error('[BackgroundSync] System sync failed:', err);
              return 0;
            })
          : Promise.resolve(0),
        // Delivery (checkout shipping names) entitled Basic+ — gate directly off
        // the entitlement source so it can't drift from canAccessContentType.
        canAccessContentType(plan, 'delivery')
          ? this.syncDeliveryContent().catch(err => {
              logger.error('[BackgroundSync] Delivery sync failed:', err);
              return 0;
            })
          : Promise.resolve(0),
        // Online-Store extras (Filter + Shop-Metadaten) entitled on every tier.
        this.syncOnlineStoreExtras().catch(err => {
          logger.error('[BackgroundSync] Online-Store-Extras sync failed:', err);
          return 0;
        }),
        // Selling plans (subscriptions) entitled Pro+ — gate directly off the
        // entitlement source so it can't drift from canAccessContentType.
        canAccessContentType(plan, 'sellingPlans')
          ? this.syncSellingPlans().catch(err => {
              logger.error('[BackgroundSync] Selling-Plans sync failed:', err);
              return 0;
            })
          : Promise.resolve(0),
        // Cookie banner shares the onlineStoreExtras entitlement (every tier) —
        // gracefully no-ops when the unstable endpoint is unreachable, so it's
        // safe to run unconditionally.
        this.syncCookieBanner().catch(err => {
          logger.error('[BackgroundSync] Cookie-Banner sync failed:', err);
          return 0;
        }),
      ]);

      const duration = Date.now() - startTime;
      const stats: SyncStats = {
        pages,
        policies,
        themes,
        metaobjects,
        articles,
        menus,
        system,
        delivery,
        onlineStoreExtras,
        sellingPlans,
        cookieBanner,
        total: pages + policies + themes + metaobjects + articles + menus + system + delivery + onlineStoreExtras + sellingPlans + cookieBanner,
        duration,
      };

      logger.debug(`[BackgroundSync] ✓ Full sync complete in ${duration}ms (plan=${plan})`);
      logger.debug(`[BackgroundSync]   Pages: ${pages}, Policies: ${policies}, Themes: ${themes}, Metaobjects: ${metaobjects}, Articles: ${articles}, Menus: ${menus}, System: ${system}, Delivery: ${delivery}, Extras: ${onlineStoreExtras}, SellingPlans: ${sellingPlans}, CookieBanner: ${cookieBanner}`);

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
