import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { logger } from "~/utils/logger.server";
import {
  GET_SHOP_LOCALES,
  GET_BLOGS,
  GET_COLLECTIONS,
  GET_PAGES,
  GET_SHOP_POLICIES,
  GET_SHOP_METADATA,
  GET_MENUS,
  GET_THEMES,
  GET_METAOBJECT_DEFINITIONS,
  GET_METAOBJECTS,
  GET_THEME_TRANSLATABLE_RESOURCES,
  GET_THEME_TRANSLATIONS,
  GET_PRODUCT_METAFIELD_DEFINITIONS
} from "../graphql/content.queries";
import { METAFIELD_DEFINITION_UPDATE_TRANSLATABLE } from "../graphql/content.mutations";
import {
  categorizeMetafieldOwner,
  type MetafieldOwnerCategory,
} from "../config/known-third-party-apps";

/** Locale info returned by shopLocales query */
interface ShopLocale {
  locale: string;
  name?: string;
  primary: boolean;
  published: boolean;
}

/** GraphQL edge wrapper */
interface GraphQLEdge<T> {
  node: T;
}

/** Translatable content item from Shopify */
interface TranslatableContentItem {
  key: string;
  value: string | null;
  digest: string | null;
  locale: string;
}

/** Theme translatable content item with group metadata */
interface ThemeContentItem extends TranslatableContentItem {
  _groupId: string;
  _groupName: string;
  _groupIcon: string;
}

/** Theme resource type test result */
interface ThemeResourceTestResult {
  status: string;
  error?: string;
  resourceCount?: number;
  contentCount?: number;
  hasContent?: boolean;
}

/** A product metafield definition, categorized for the Metafields settings tab. */
export interface ProductMetafieldDef {
  id: string;
  namespace: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  /** Whether the definition's `translatable` capability is already enabled. */
  translatable: boolean;
  /** "shop" | "third-party" | "contentpilot" — drives UI grouping + patchability. */
  ownerCategory: MetafieldOwnerCategory;
  /** Display name of the owning app when known (third-party only). */
  appName?: string;
}

export class ContentService {
  constructor(private admin: AdminApiContext) {}

  async getShopLocales(): Promise<ShopLocale[]> {
    const response = await this.admin.graphql(GET_SHOP_LOCALES);
    const data = await response.json();
    const gqlErrors = (data as unknown as { errors?: Array<{ message: string }> }).errors;
    if (gqlErrors?.length) {
      throw new Error(`GraphQL error in getShopLocales: ${gqlErrors[0].message}`);
    }
    return data.data.shopLocales;
  }

  async getBlogs(first: number = 50) {
    const response = await this.admin.graphql(GET_BLOGS, {
      variables: { first }
    });
    const data = await response.json();
    const gqlErrors = (data as unknown as { errors?: Array<{ message: string }> }).errors;
    if (gqlErrors?.length) {
      throw new Error(`GraphQL error in getBlogs: ${gqlErrors[0].message}`);
    }

    const blogs = data.data.blogs.edges.map((edge: GraphQLEdge<Record<string, unknown>>) => ({
      ...edge.node,
      articles: (edge.node.articles as { edges: GraphQLEdge<Record<string, unknown>>[] }).edges.map((a: GraphQLEdge<Record<string, unknown>>) => ({
        ...a.node,
        translations: []
      }))
    }));

    return blogs;
  }

  async getCollections(first: number = 50) {
    const response = await this.admin.graphql(GET_COLLECTIONS, {
      variables: { first }
    });
    const data = await response.json();
    const gqlErrors = (data as unknown as { errors?: Array<{ message: string }> }).errors;
    if (gqlErrors?.length) {
      throw new Error(`GraphQL error in getCollections: ${gqlErrors[0].message}`);
    }

    const collections = data.data.collections.edges.map((edge: GraphQLEdge<Record<string, unknown>>) => ({
      ...edge.node,
      translations: []
    }));

    return collections;
  }

  async getPages(first: number = 50) {
    const response = await this.admin.graphql(GET_PAGES, {
      variables: { first }
    });
    const data = await response.json();
    const gqlErrors = (data as unknown as { errors?: Array<{ message: string }> }).errors;
    if (gqlErrors?.length) {
      throw new Error(`GraphQL error in getPages: ${gqlErrors[0].message}`);
    }

    const pages = data.data.pages.edges.map((edge: GraphQLEdge<Record<string, unknown>>) => ({
      ...edge.node,
      translations: []
    }));

    return pages;
  }

  async getShopPolicies() {
    try {
      const response = await this.admin.graphql(GET_SHOP_POLICIES);
      const data = await response.json();

      logger.debug('Shop policies API response', { context: 'ContentService', data });

      const policies = data.data?.shop?.shopPolicies?.map((policy: Record<string, unknown>) => ({
        ...policy,
        translations: []
      })) || [];

      logger.debug('Processed policies', { context: 'ContentService', count: policies.length });
      return policies;
    } catch (error) {
      logger.error('Error fetching shop policies', { context: 'ContentService', error });
      return [];
    }
  }

  async getShopMetadata() {
    try {
      logger.debug('Fetching shop metadata with paginated metafields', { context: 'ContentService' });

      // Fetch all metafields using pagination
      const allMetafields: Array<Record<string, unknown>> = [];
      let hasNextPage = true;
      let cursor: string | null = null;
      const pageSize = 250; // Use maximum page size for efficiency

      while (hasNextPage) {
        const response = await this.admin.graphql(GET_SHOP_METADATA, {
          variables: {
            metafieldsFirst: pageSize,
            metafieldsAfter: cursor
          }
        });
        const data = await response.json() as { data?: { shop?: { metafields?: { edges?: Array<GraphQLEdge<Record<string, unknown>>>; pageInfo?: { hasNextPage: boolean; endCursor?: string } } } } };

        const shop = data.data?.shop;
        if (!shop) {
          logger.warn('No shop data returned', { context: 'ContentService' });
          break;
        }

        const metafieldsConnection = shop.metafields;
        const metafields = metafieldsConnection?.edges?.map((edge: GraphQLEdge<Record<string, unknown>>) => ({
          ...edge.node,
          translations: []
        })) || [];

        allMetafields.push(...metafields);

        // Check if there are more pages
        hasNextPage = metafieldsConnection?.pageInfo?.hasNextPage || false;
        cursor = metafieldsConnection?.pageInfo?.endCursor || null;

        logger.debug(`Fetched ${metafields.length} metafields (page), total: ${allMetafields.length}`, {
          context: 'ContentService',
          hasNextPage,
          cursor: cursor?.substring(0, 20) + '...'
        });

        if (!hasNextPage) {
          break;
        }
      }

      logger.info(`Successfully fetched ${allMetafields.length} shop metafields`, { context: 'ContentService' });

      // Get shop data from first response (we need to fetch again without pagination to get base shop data)
      const finalResponse = await this.admin.graphql(GET_SHOP_METADATA, {
        variables: {
          metafieldsFirst: 1, // We already have all metafields, just need shop data
          metafieldsAfter: null
        }
      });
      const finalData = await finalResponse.json();
      const shop = finalData.data.shop;

      // Replace metafields with all paginated results
      shop.metafields = allMetafields;
      shop.translations = [];

      return shop;
    } catch (error) {
      logger.error('Error fetching shop metadata', { context: 'ContentService', error });
      return { metafields: [], translations: [] };
    }
  }

  /**
   * List ALL product metafield definitions in the shop (paginated), each
   * categorized by owner. This is the scanner backing the Metafields settings
   * tab — it surfaces third-party app definitions that `translatableContent`
   * never returns. Pattern mirrors getShopMetadata() pagination above.
   */
  async getProductMetafieldDefinitions(): Promise<ProductMetafieldDef[]> {
    const definitions: ProductMetafieldDef[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;
    const pageSize = 250;

    while (hasNextPage) {
      const response = await this.admin.graphql(GET_PRODUCT_METAFIELD_DEFINITIONS, {
        variables: { first: pageSize, after: cursor },
      });
      const data = await response.json() as {
        data?: {
          metafieldDefinitions?: {
            edges?: Array<{ node: {
              id: string;
              namespace: string;
              key: string;
              name: string;
              description: string | null;
              type: { name: string };
              access?: { storefront?: string | null };
            } }>;
            pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
          };
        };
        errors?: Array<{ message: string }>;
      };

      if (data.errors?.length) {
        throw new Error(`GraphQL error in getProductMetafieldDefinitions: ${data.errors[0].message}`);
      }

      const connection = data.data?.metafieldDefinitions;
      const edges = connection?.edges ?? [];

      for (const edge of edges) {
        const node = edge.node;
        const owner = categorizeMetafieldOwner(node.namespace);
        definitions.push({
          id: node.id,
          namespace: node.namespace,
          key: node.key,
          name: node.name,
          description: node.description ?? null,
          type: node.type?.name ?? "",
          // Translatable iff publicly readable on the storefront.
          translatable: node.access?.storefront === "PUBLIC_READ",
          ownerCategory: owner.category,
          appName: owner.appName,
        });
      }

      hasNextPage = connection?.pageInfo?.hasNextPage ?? false;
      cursor = connection?.pageInfo?.endCursor ?? null;
      if (!hasNextPage) break;
    }

    logger.info(`Fetched ${definitions.length} product metafield definitions`, { context: "ContentService" });
    return definitions;
  }

  /**
   * Make a product metafield definition translatable by setting its storefront
   * access to PUBLIC_READ (the only lever Shopify exposes for metafield
   * translatability). NOTE: this publishes the metafield's values to the public
   * Storefront API. Returns ok:false (with the Shopify error) for definitions
   * owned by another app — the caller treats that as "cannot enable" rather
   * than throwing.
   */
  async updateMetafieldDefinitionTranslatable(
    namespace: string,
    key: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.admin.graphql(METAFIELD_DEFINITION_UPDATE_TRANSLATABLE, {
        variables: {
          definition: {
            namespace,
            key,
            ownerType: "PRODUCT",
            access: { storefront: "PUBLIC_READ" },
          },
        },
      });
      const data = await response.json() as {
        data?: { metafieldDefinitionUpdate?: { userErrors?: Array<{ message: string }> } };
        errors?: Array<{ message: string }>;
      };

      if (data.errors?.length) {
        return { ok: false, error: data.errors[0].message };
      }
      const userErrors = data.data?.metafieldDefinitionUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { ok: false, error: userErrors[0].message };
      }
      return { ok: true };
    } catch (error) {
      logger.error("Error updating metafield definition translatable", { context: "ContentService", namespace, key, error });
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getMenus(first: number = 50) {
    try {
      logger.debug('Fetching menus (simplified - no translations)', { context: 'ContentService' });

      const response = await this.admin.graphql(GET_MENUS, {
        variables: { first }
      });
      const data = await response.json();

      const menus = data.data?.menus?.edges?.map((edge: GraphQLEdge<Record<string, unknown>>) => ({
        ...edge.node,
        translations: [] // Menus cannot be translated via API
      })) || [];

      logger.debug('Menus fetched', { context: 'ContentService', count: menus.length });
      logger.debug('Translation API calls disabled due to Shopify API limitation', { context: 'ContentService' });

      return menus;

      /* ========================================================================
       * COMMENTED OUT: Full translation implementation for when Shopify fixes API
       * ========================================================================
       *
       * DO NOT DELETE THIS CODE!
       * This implementation should be restored when Shopify adds proper API support
       * for MenuItem translations.
       *
       * Current issues (as of 2025):
       * - MenuItem does not have a 'translations' field
       * - MenuItem IDs cannot be queried as translatableResources
       * - See: https://github.com/Shopify/storefront-api-feedback/discussions/156
       * - See: https://community.shopify.dev/t/translation-api-menuitem/6227
       *
       * ========================================================================

      // First get shop locales to know which languages to fetch
      const shopLocales = await this.getShopLocales();
      const locales = shopLocales.filter((l: ShopLocale) => !l.primary).map((l: ShopLocale) => l.locale);
      console.log(`[MENUS] Shop locales:`, shopLocales.map((l: ShopLocale) => `${l.name} (${l.locale}${l.primary ? ' - PRIMARY' : ''})`));
      console.log(`[MENUS] Non-primary locales to fetch translations for:`, locales);

      const response = await this.admin.graphql(GET_MENUS, {
        variables: { first }
      });
      const data = await response.json();

      console.log(`[MENUS] Found ${data.data?.menus?.edges?.length || 0} menus`);

      // For each menu, fetch translations using both methods
      const menusWithTranslations = [];

      for (const edge of data.data?.menus?.edges || []) {
        const menu = edge.node;
        console.log(`\n--- Menu: "${menu.title}" (${menu.id}) ---`);
        console.log(`[MENU] Handle: ${menu.handle}`);
        console.log(`[MENU] Items count: ${menu.items?.length || 0}`);

        // Log menu items structure recursively
        const logMenuItems = (items: Record<string, unknown>[], level: number = 0) => {
          for (const item of items || []) {
            const indent = '  '.repeat(level);
            console.log(`${indent}└─ "${item.title}" (${item.id})`);
            console.log(`${indent}   URL: ${item.url}`);
            console.log(`${indent}   Type: ${item.type}`);
            if (item.items && (item.items as Record<string, unknown>[]).length > 0) {
              console.log(`${indent}   Sub-items: ${(item.items as Record<string, unknown>[]).length}`);
              logMenuItems(item.items as Record<string, unknown>[], level + 1);
            }
          }
        };

        if (menu.items && menu.items.length > 0) {
          console.log('[MENU] Menu items structure:');
          logMenuItems(menu.items);
        }

        const allTranslations = [];

        // Method 1: Fetch MENU translations for each locale using translatableResource
        console.log(`[MENU] Fetching translations using translatableResource API...`);
        for (const locale of locales) {
          try {
            const translatableQuery = `#graphql
              query getTranslatableMenu($id: ID!, $locale: String!) {
                translatableResource(resourceId: $id) {
                  resourceId
                  translatableContent {
                    key
                    value
                    digest
                    locale
                  }
                  translations(locale: $locale) {
                    locale
                    key
                    value
                    outdated
                  }
                }
              }
            `;

            const translatableResponse = await this.admin.graphql(translatableQuery, {
              variables: { id: menu.id, locale }
            });
            const translatableData = await translatableResponse.json();

            const translations = translatableData.data?.translatableResource?.translations || [];
            const translatableContent = translatableData.data?.translatableResource?.translatableContent || [];

            console.log(`  [TRANSLATABLE-${locale}] Translatable content:`, translatableContent);
            console.log(`  [TRANSLATABLE-${locale}] Found ${translations.length} translations`);

            if (translations.length > 0) {
              translations.forEach((t: { key: string; value: string; outdated: boolean }) => {
                console.log(`    - key: "${t.key}", value: "${t.value}", outdated: ${t.outdated}`);
              });
            }

            // Only add if not already present
            for (const trans of translations) {
              if (!allTranslations.find(t => t.locale === trans.locale && t.key === trans.key)) {
                allTranslations.push(trans);
              }
            }
          } catch (error) {
            console.error(`  [TRANSLATABLE-${locale}] Error:`, error);
          }
        }

        // Method 2: Fetch translations for each non-primary locale using menu.translations
        console.log(`[MENU] Fetching translations using menu.translations API...`);
        for (const locale of locales) {
          try {
            const translationsQuery = `#graphql
              query getMenuTranslations($id: ID!, $locale: String!) {
                menu(id: $id) {
                  translations(locale: $locale) {
                    locale
                    key
                    value
                    outdated
                  }
                }
              }
            `;

            const transResponse = await this.admin.graphql(translationsQuery, {
              variables: { id: menu.id, locale }
            });
            const transData = await transResponse.json();

            const translations = transData.data?.menu?.translations || [];

            console.log(`  [MENU-TRANS-${locale}] Found ${translations.length} translations`);

            if (translations.length > 0) {
              translations.forEach((t: { key: string; value: string; outdated: boolean }) => {
                console.log(`    - key: "${t.key}", value: "${t.value}", outdated: ${t.outdated}`);
              });
            }

            // Only add if not already added by translatableResource
            for (const trans of translations) {
              if (!allTranslations.find(t => t.locale === trans.locale && t.key === trans.key)) {
                allTranslations.push(trans);
              }
            }
          } catch (error) {
            console.error(`  [MENU-TRANS-${locale}] Error:`, error);
          }
        }

        console.log(`[MENU] Total translations collected: ${allTranslations.length}`);
        if (allTranslations.length > 0) {
          console.log('[MENU] All translations:');
          allTranslations.forEach((t: { locale: string; key: string; value: string }) => {
            console.log(`  - [${t.locale}] ${t.key} = "${t.value}"`);
          });
        }

        menusWithTranslations.push({
          ...menu,
          translations: allTranslations
        });
      }

      console.log(`\n=== 🍔 MENUS: Fetch complete - ${menusWithTranslations.length} menus loaded ===\n`);
      return menusWithTranslations;

       * ======================================================================== */
    } catch (error) {
      logger.error('Error fetching menus', { context: 'ContentService', error });
      return [];
    }
  }

  async testAllThemeResourceTypes() {
    const THEME_RESOURCE_TYPES = [
      'ONLINE_STORE_THEME',
      'ONLINE_STORE_THEME_APP_EMBED',
      'ONLINE_STORE_THEME_JSON_TEMPLATE',
      'ONLINE_STORE_THEME_LOCALE_CONTENT',
      'ONLINE_STORE_THEME_SECTION_GROUP',
      'ONLINE_STORE_THEME_SETTINGS_CATEGORY',
      'ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS',
    ];

    logger.debug('Testing all theme resource types', { context: 'ContentService' });

    const results: Record<string, ThemeResourceTestResult> = {};

    for (const resourceType of THEME_RESOURCE_TYPES) {
      logger.debug('Testing resource type', { context: 'ContentService', resourceType });

      try {
        const query = `#graphql
          query testThemeResource($first: Int!, $resourceType: TranslatableResourceType!) {
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
          }
        `;

        const response = await this.admin.graphql(query, {
          variables: { first: 10, resourceType }
        });

        const data = await response.json();

        if ((data as Record<string, unknown>).errors) {
          const errors = (data as Record<string, unknown>).errors as Array<{ message: string }>;
          logger.warn('Theme resource type error', { context: 'ContentService', resourceType, error: errors[0].message });
          results[resourceType] = { status: 'ERROR', error: errors[0].message };
          continue;
        }

        const resources = (data as Record<string, unknown>).data
          ? ((data as Record<string, unknown>).data as Record<string, unknown>)?.translatableResources
            ? (((data as Record<string, unknown>).data as Record<string, unknown>).translatableResources as Record<string, unknown>)?.edges as Array<{ node: { translatableContent?: TranslatableContentItem[] } }> || []
            : []
          : [];
        const totalContent = (resources as Array<{ node: { translatableContent?: TranslatableContentItem[] } }>).reduce((sum: number, r) => sum + (r.node.translatableContent?.length || 0), 0);

        logger.debug('Theme resource type success', {
          context: 'ContentService',
          resourceType,
          resourceCount: (resources as Array<unknown>).length,
          contentCount: totalContent,
          sampleKeys: (resources as Array<{ node: { translatableContent?: TranslatableContentItem[] } }>).length > 0 && totalContent > 0 ? (resources as Array<{ node: { translatableContent: TranslatableContentItem[] } }>)[0].node.translatableContent.slice(0, 3).map((c) => c.key) : []
        });

        results[resourceType] = {
          status: 'SUCCESS',
          resourceCount: (resources as Array<unknown>).length,
          contentCount: totalContent,
          hasContent: totalContent > 0
        };

      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Theme resource type exception', { context: 'ContentService', resourceType, error: message });
        results[resourceType] = { status: 'EXCEPTION', error: message };
      }
    }

    const withContent = Object.entries(results).filter(([, r]) => r.status === 'SUCCESS' && r.hasContent);
    const withoutContent = Object.entries(results).filter(([, r]) => r.status === 'SUCCESS' && !r.hasContent);
    const withErrors = Object.entries(results).filter(([, r]) => r.status !== 'SUCCESS');

    logger.debug('Theme resource types test summary', {
      context: 'ContentService',
      withContent: withContent.map(([type, r]) => ({ type, resources: r.resourceCount, fields: r.contentCount })),
      withoutContent: withoutContent.map(([type, r]) => ({ type, resources: r.resourceCount })),
      withErrors: withErrors.map(([type, r]) => ({ type, error: r.error }))
    });

    return results;
  }

  async getThemes(first: number = 250) {
    try {
      logger.debug('Fetching theme translatable resources', { context: 'ContentService' });

      // Define the working resource types (based on test results)
      const WORKING_RESOURCE_TYPES = [
        { type: 'ONLINE_STORE_THEME', label: 'Theme Content' },
        { type: 'ONLINE_STORE_THEME_JSON_TEMPLATE', label: 'JSON Templates' },
        { type: 'ONLINE_STORE_THEME_LOCALE_CONTENT', label: 'Locale Content' },
        { type: 'ONLINE_STORE_THEME_SECTION_GROUP', label: 'Section Groups' },
        { type: 'ONLINE_STORE_THEME_SETTINGS_CATEGORY', label: 'Settings Categories' },
      ];

      // Limit to prevent memory issues - Shopify max is 250 per query
      const safeLimit = Math.min(first, 250);

      // Define key patterns to filter and group by
      // Each pattern creates a separate navigation item on the left
      const KEY_PATTERNS = [
        // Article pages
        { pattern: /^section\.article\./, name: 'Article', groupId: 'article', icon: '📝' },

        // Collection pages
        { pattern: /^section\.collection\./, name: 'Collection', groupId: 'collection', icon: '📂' },

        // Homepage/Index
        { pattern: /^section\.index\./, name: 'Index Page', groupId: 'index', icon: '🏠' },

        // Password page
        { pattern: /^section\.password\./, name: 'Password Page', groupId: 'password', icon: '🔒' },

        // Product pages
        { pattern: /^section\.product\./, name: 'Product', groupId: 'product', icon: '🛍️' },

        // Individual page sections (e.g., About, Contact, etc.)
        // These will be further sub-grouped by page name
        { pattern: /^section\.page\.([^.]+)\./, name: 'Pages', groupId: 'pages', icon: '📄', extractSubgroup: true },

        // Collections template
        { pattern: /^collections\.json\./, name: 'Collections Template', groupId: 'collections_template', icon: '📋' },

        // Theme groups
        { pattern: /^group\.json\./, name: 'Theme Groups', groupId: 'groups', icon: '🎨' },

        // Announcement bars
        { pattern: /^bar\./, name: 'Announcement Bars', groupId: 'bars', icon: '📢' },

        // Settings
        { pattern: /^Settings Categories:/, name: 'Settings', groupId: 'settings', icon: '⚙️' },
      ];

      logger.debug('Loading theme resource types', { context: 'ContentService', count: WORKING_RESOURCE_TYPES.length });

      // Get shop locales to know which languages to fetch translations for
      const shopLocales = await this.getShopLocales();
      const nonPrimaryLocales = shopLocales.filter((l) => !l.primary).map((l) => l.locale);
      logger.debug('Non-primary locales for themes', { context: 'ContentService', locales: nonPrimaryLocales });

      // Collect all theme resources
      const allThemeResources: Array<{
        id: string;
        title: string;
        name: string;
        role: string;
        resourceType: string;
        resourceTypeLabel: string;
        translatableContent: TranslatableContentItem[];
        contentByGroup: Record<string, ThemeContentItem[]>;
        contentCount: number;
        keyPatterns: typeof KEY_PATTERNS;
      }> = [];

      // Fetch resources for each working resource type
      for (const resourceTypeConfig of WORKING_RESOURCE_TYPES) {
        logger.debug('Loading theme resource', { context: 'ContentService', label: resourceTypeConfig.label, type: resourceTypeConfig.type });

        try {
          const translatableResponse = await this.admin.graphql(GET_THEME_TRANSLATABLE_RESOURCES, {
            variables: { first: safeLimit, resourceType: resourceTypeConfig.type }
          });
          const translatableData = await translatableResponse.json();

          if ((translatableData as Record<string, unknown>).errors) {
            const errors = (translatableData as Record<string, unknown>).errors as Array<{ message: string }>;
            logger.error('Error loading theme resource type', { context: 'ContentService', type: resourceTypeConfig.type, error: errors[0].message });
            continue;
          }

          const resources: Array<{ resourceId: string; translatableContent: TranslatableContentItem[] }> =
            (translatableData as Record<string, unknown>).data
              ? (((translatableData as Record<string, unknown>).data as Record<string, unknown>)?.translatableResources as Record<string, unknown>)?.edges
                ? ((((translatableData as Record<string, unknown>).data as Record<string, unknown>).translatableResources as Record<string, unknown>).edges as GraphQLEdge<{ resourceId: string; translatableContent: TranslatableContentItem[] }>[]).map((edge) => edge.node)
                : []
              : [];
          const totalContent = resources.reduce((sum: number, r) => sum + (r.translatableContent?.length || 0), 0);

          logger.debug('Theme resource loaded', { context: 'ContentService', label: resourceTypeConfig.label, resources: resources.length, fields: totalContent });

          // Process each resource
          for (const resource of resources) {
            // OPTIMIZATION: Skip fetching translations from Shopify API during sync
            // Translations are already stored in database and loaded on-demand
            // This dramatically reduces sync time (from 150+ API calls to 0)

            // Determine a good title for this resource
            let resourceTitle = resourceTypeConfig.label;
            if (resource.translatableContent && resource.translatableContent.length > 0) {
              // Use the first translatable content's key as a more specific title
              const firstKey = resource.translatableContent[0].key;
              if (firstKey && firstKey.length < 100) {
                resourceTitle = `${resourceTypeConfig.label}: ${firstKey}`;
              }

              // Log sample translatable content structure
              if (resource.translatableContent.length > 0) {
                logger.debug('Sample translatable content', {
                  context: 'ContentService',
                  samples: resource.translatableContent.slice(0, 3).map((c) => ({
                    key: c.key,
                    value: c.value?.substring(0, 50)
                  }))
                });
              }
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

                  // Handle sub-grouping for pages (e.g., section.page.about, section.page.contact)
                  if (patternConfig.extractSubgroup && match[1]) {
                    groupId = `page_${match[1]}`; // e.g., "page_about", "page_contact"
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

            // Instead of lumping all unmatched content into one group,
            // create intelligent sub-groups based on key prefixes
            if (unmatchedContent.length > 0) {
              logger.debug('Found unmatched items', { context: 'ContentService', count: unmatchedContent.length, sampleKeys: unmatchedContent.slice(0, 10).map(c => c.key) });

              // Group unmatched content by their top-level prefix
              const unmatchedByPrefix: Record<string, TranslatableContentItem[]> = {};

              for (const item of unmatchedContent) {
                // Extract the first meaningful part of the key
                let prefix = 'other';
                const key = item.key;

                // Try to extract a meaningful prefix
                if (key.startsWith('section.')) {
                  // e.g., "section.cart" -> "cart"
                  const parts = key.split('.');
                  if (parts.length >= 2 && parts[1]) {
                    prefix = `section_${parts[1]}`;
                  }
                } else if (key.includes('.')) {
                  // Take the first part before the dot
                  prefix = key.split('.')[0];
                } else {
                  // Single-word keys
                  prefix = key.split(/[:\s]/)[0] || 'other';
                }

                if (!unmatchedByPrefix[prefix]) {
                  unmatchedByPrefix[prefix] = [];
                }
                unmatchedByPrefix[prefix].push(item);
              }

              // Create separate groups for each prefix
              for (const [prefix, items] of Object.entries(unmatchedByPrefix)) {
                // Generate a human-readable group name
                let groupName = prefix
                  .replace(/^section_/, '')
                  .replace(/_/g, ' ')
                  .split(' ')
                  .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                  .join(' ');

                const groupId = `misc_${prefix}`;

                // Choose an appropriate icon
                let icon = '📦';
                if (prefix.includes('cart')) icon = '🛒';
                else if (prefix.includes('search')) icon = '🔍';
                else if (prefix.includes('footer')) icon = '🦶';
                else if (prefix.includes('header')) icon = '🎯';
                else if (prefix.includes('nav')) icon = '🧭';
                else if (prefix.includes('blog')) icon = '📝';
                else if (prefix.includes('list')) icon = '📋';
                else if (prefix.includes('form')) icon = '📝';
                else if (prefix.includes('contact')) icon = '📧';
                else if (prefix.includes('image')) icon = '🖼️';
                else if (prefix.includes('video')) icon = '🎥';
                else if (prefix.includes('slideshow')) icon = '🎞️';
                else if (prefix.includes('featured')) icon = '⭐';

                contentByGroup[groupId] = items.map(item => ({
                  ...item,
                  _groupId: groupId,
                  _groupName: groupName,
                  _groupIcon: icon
                }));

                logger.debug('Created theme group', { context: 'ContentService', groupName, itemCount: items.length });
              }
            }

            // Store grouped content for this resource
            if (Object.keys(contentByGroup).length > 0) {
              allThemeResources.push({
                id: resource.resourceId,
                title: resourceTitle,
                name: resourceTitle,
                role: 'CONTENT',
                resourceType: resourceTypeConfig.type,
                resourceTypeLabel: resourceTypeConfig.label,
                translatableContent: resource.translatableContent || [], // Keep all for reference
                contentByGroup, // New: grouped content
                contentCount: Object.values(contentByGroup).reduce((sum, arr) => sum + arr.length, 0),
                keyPatterns: KEY_PATTERNS
              });

              const totalMatched = Object.values(contentByGroup).reduce((sum, arr) => sum + arr.length, 0);
              logger.debug('Content grouped', { context: 'ContentService', categories: Object.keys(contentByGroup).length, items: totalMatched });
            }
          }
        } catch (error) {
          // NOTE (review MEDIUM "sync bypasses gateway throttling"): a THROTTLED
          // error here is logged and this resource type is skipped (partial
          // data), because content discovery uses this.admin.graphql directly
          // rather than ShopifyApiGateway's throttle-aware retry queue. This is
          // a KNOWN, ACCEPTED tradeoff for now: theme/content discovery is a
          // read-only, fully re-runnable operation (the user can re-open the
          // section / re-trigger sync, and the next pass picks up what was
          // skipped), so a transient skip is self-healing and never corrupts
          // stored data. Routing every sync path through the gateway is a
          // cross-cutting refactor with real regression risk and is
          // intentionally deferred rather than done piecemeal here.
          logger.error('Exception loading theme resource type', { context: 'ContentService', type: resourceTypeConfig.type, error });
        }
      }

      // Consolidate all groups across all resources
      const consolidatedGroups: Record<string, {
        id: string;
        title: string;
        name: string;
        icon: string;
        groupId: string;
        role: string;
        translatableContent: ThemeContentItem[];
        contentCount: number;
      }> = {};

      for (const resource of allThemeResources) {
        for (const [groupId, items] of Object.entries(resource.contentByGroup)) {
          if (!consolidatedGroups[groupId]) {
            // Use metadata from first item in group
            const firstItem = items[0];
            consolidatedGroups[groupId] = {
              id: `group_${groupId}`,
              title: firstItem._groupName,
              name: firstItem._groupName,
              icon: firstItem._groupIcon,
              groupId,
              role: 'THEME_GROUP',
              translatableContent: [],
              contentCount: 0
            };
          }

          // Merge items into consolidated group
          consolidatedGroups[groupId].translatableContent.push(...items);
          consolidatedGroups[groupId].contentCount += items.length;
        }
      }

      const groupedThemes = Object.values(consolidatedGroups);

      logger.info('Themes fetch complete', {
        context: 'ContentService',
        totalGroups: groupedThemes.length,
        totalFields: groupedThemes.reduce((sum, g) => sum + g.contentCount, 0),
        groups: groupedThemes.map(g => ({ title: g.title, fields: g.contentCount }))
      });

      return groupedThemes;
    } catch (error) {
      logger.error('Error fetching themes', { context: 'ContentService', error });
      return [];
    }
  }

  async getMetaobjectDefinitions(first: number = 50) {
    try {
      const response = await this.admin.graphql(GET_METAOBJECT_DEFINITIONS, {
        variables: { first }
      });
      const data = await response.json();

      // Check for GraphQL errors (like access denied)
      if ('errors' in data && data.errors && Array.isArray(data.errors) && data.errors.length > 0) {
        const errors = data.errors as Array<{ message: string }>;
        const accessDeniedError = errors.find((err) =>
          err.message?.includes('Access denied') || err.message?.includes('metaobjectDefinitions')
        );

        if (accessDeniedError) {
          logger.warn('Metaobjects access denied - feature requires additional Shopify permissions', { context: 'ContentService' });
          return [];
        }

        throw new Error(errors[0].message);
      }

      const definitions = data.data?.metaobjectDefinitions?.edges?.map((edge: GraphQLEdge<Record<string, unknown>>) => edge.node) || [];
      return definitions;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Gracefully handle permission errors
      if (message?.includes('Access denied') || message?.includes('metaobjectDefinitions')) {
        logger.warn('Metaobjects access denied - feature requires additional Shopify permissions', { context: 'ContentService' });
        return [];
      }
      logger.error('Error fetching metaobject definitions', { context: 'ContentService', error });
      return [];
    }
  }

  async getMetaobjects(first: number = 50) {
    try {
      // First get all metaobject definitions
      const definitions = await this.getMetaobjectDefinitions(10);

      if (definitions.length === 0) {
        return [];
      }

      // Then fetch metaobjects for each type
      const allMetaobjects: Array<Record<string, unknown>> = [];

      for (const definition of definitions) {
        try {
          const response = await this.admin.graphql(GET_METAOBJECTS, {
            variables: { type: definition.type, first }
          });
          const data = await response.json();

          const metaobjects = data.data?.metaobjects?.edges?.map((edge: GraphQLEdge<Record<string, unknown>>) => ({
            ...edge.node,
            definitionName: definition.name,
            translations: []
          })) || [];

          allMetaobjects.push(...metaobjects);
        } catch (error) {
          logger.error('Error fetching metaobjects for type', { context: 'ContentService', type: definition.type, error });
        }
      }

      return allMetaobjects;
    } catch (error) {
      logger.error('Error fetching metaobjects', { context: 'ContentService', error });
      return [];
    }
  }

  async getAllContent() {
    const [shopLocales, blogs, collections, pages, policies, metadata, menus, themes, metaobjects] = await Promise.all([
      this.getShopLocales(),
      this.getBlogs(),
      this.getCollections(),
      this.getPages(),
      this.getShopPolicies(),
      this.getShopMetadata(),
      this.getMenus(),
      this.getThemes(),
      this.getMetaobjects()
    ]);

    const primaryLocale = shopLocales.find((l) => l.primary)?.locale || "en";

    return {
      shopLocales,
      blogs,
      collections,
      pages,
      policies,
      metadata,
      menus,
      themes,
      metaobjects,
      primaryLocale
    };
  }
}
