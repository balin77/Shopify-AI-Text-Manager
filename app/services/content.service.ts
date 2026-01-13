import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
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
  GET_THEME_TRANSLATIONS
} from "../graphql/content.queries";

export class ContentService {
  constructor(private admin: AdminApiContext) {}

  async getShopLocales() {
    const response = await this.admin.graphql(GET_SHOP_LOCALES);
    const data = await response.json();
    return data.data.shopLocales;
  }

  async getBlogs(first: number = 50) {
    const response = await this.admin.graphql(GET_BLOGS, {
      variables: { first }
    });
    const data = await response.json();

    const blogs = data.data.blogs.edges.map((edge: any) => ({
      ...edge.node,
      articles: edge.node.articles.edges.map((a: any) => ({
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

    const collections = data.data.collections.edges.map((edge: any) => ({
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

    const pages = data.data.pages.edges.map((edge: any) => ({
      ...edge.node,
      translations: []
    }));

    return pages;
  }

  async getShopPolicies() {
    try {
      const response = await this.admin.graphql(GET_SHOP_POLICIES);
      const data = await response.json();

      console.log('=== SHOP POLICIES API RESPONSE ===');
      console.log('Raw policies data:', JSON.stringify(data, null, 2));

      const policies = data.data?.shop?.shopPolicies?.map((policy: any) => ({
        ...policy,
        translations: []
      })) || [];

      console.log(`Processed policies: ${policies.length}`);
      return policies;
    } catch (error) {
      console.error('Error fetching shop policies:', error);
      return [];
    }
  }

  async getShopMetadata() {
    try {
      const response = await this.admin.graphql(GET_SHOP_METADATA);
      const data = await response.json();

      const shop = data.data.shop;
      shop.metafields = shop.metafields?.edges?.map((edge: any) => ({
        ...edge.node,
        translations: []
      })) || [];
      shop.translations = [];

      return shop;
    } catch (error) {
      console.error('Error fetching shop metadata:', error);
      return { metafields: [], translations: [] };
    }
  }

  async getMenus(first: number = 50) {
    try {
      console.log('\n=== 🍔 MENUS: Fetching (simplified - no translations) ===');

      const response = await this.admin.graphql(GET_MENUS, {
        variables: { first }
      });
      const data = await response.json();

      const menus = data.data?.menus?.edges?.map((edge: any) => ({
        ...edge.node,
        translations: [] // Menus cannot be translated via API
      })) || [];

      console.log(`[MENUS] Found ${menus.length} menus`);
      console.log('[MENUS] ⚠️  Translation API calls disabled due to Shopify API limitation');
      console.log('[MENUS] MenuItems cannot be translated via GraphQL API');

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
      const locales = shopLocales.filter((l: any) => !l.primary).map((l: any) => l.locale);
      console.log(`[MENUS] Shop locales:`, shopLocales.map((l: any) => `${l.name} (${l.locale}${l.primary ? ' - PRIMARY' : ''})`));
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
        const logMenuItems = (items: any[], level: number = 0) => {
          for (const item of items || []) {
            const indent = '  '.repeat(level);
            console.log(`${indent}└─ "${item.title}" (${item.id})`);
            console.log(`${indent}   URL: ${item.url}`);
            console.log(`${indent}   Type: ${item.type}`);
            if (item.items && item.items.length > 0) {
              console.log(`${indent}   Sub-items: ${item.items.length}`);
              logMenuItems(item.items, level + 1);
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
              translations.forEach((t: any) => {
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
              translations.forEach((t: any) => {
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
          allTranslations.forEach((t: any) => {
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
      console.error('❌ [MENUS] Error fetching menus:', error);
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

    console.log('\n\n=== 🧪 TESTING ALL THEME RESOURCE TYPES ===\n');

    const results: Record<string, any> = {};

    for (const resourceType of THEME_RESOURCE_TYPES) {
      console.log(`\n--- Testing: ${resourceType} ---`);

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

        if (data.errors) {
          console.log(`❌ ERROR:`, data.errors[0].message);
          results[resourceType] = { status: 'ERROR', error: data.errors[0].message };
          continue;
        }

        const resources = data.data?.translatableResources?.edges || [];
        const totalContent = resources.reduce((sum: number, r: any) => sum + (r.node.translatableContent?.length || 0), 0);

        console.log(`✅ SUCCESS`);
        console.log(`   Resources found: ${resources.length}`);
        console.log(`   Total translatable content: ${totalContent}`);

        if (resources.length > 0 && totalContent > 0) {
          console.log(`   Sample keys:`, resources[0].node.translatableContent.slice(0, 3).map((c: any) => c.key));
        }

        results[resourceType] = {
          status: 'SUCCESS',
          resourceCount: resources.length,
          contentCount: totalContent,
          hasContent: totalContent > 0
        };

      } catch (error: any) {
        console.log(`❌ EXCEPTION:`, error.message);
        results[resourceType] = { status: 'EXCEPTION', error: error.message };
      }
    }

    console.log('\n\n=== 📊 SUMMARY ===\n');
    console.log('Resource Types with actual content:');

    for (const [type, result] of Object.entries(results)) {
      if (result.status === 'SUCCESS' && result.hasContent) {
        console.log(`✅ ${type}: ${result.resourceCount} resources, ${result.contentCount} translatable fields`);
      }
    }

    console.log('\nResource Types with no content:');
    for (const [type, result] of Object.entries(results)) {
      if (result.status === 'SUCCESS' && !result.hasContent) {
        console.log(`⚠️  ${type}: ${result.resourceCount} resources, but 0 translatable fields`);
      }
    }

    console.log('\nResource Types with errors:');
    for (const [type, result] of Object.entries(results)) {
      if (result.status !== 'SUCCESS') {
        console.log(`❌ ${type}: ${result.error}`);
      }
    }

    console.log('\n=== 🧪 TEST COMPLETE ===\n\n');

    return results;
  }

  async getThemes(first: number = 50) {
    try {
      console.log('\n=== 🎨 THEMES: Fetching theme translatable resources ===');

      // Define the working resource types (based on test results)
      const WORKING_RESOURCE_TYPES = [
        { type: 'ONLINE_STORE_THEME', label: 'Theme Content' },
        { type: 'ONLINE_STORE_THEME_JSON_TEMPLATE', label: 'JSON Templates' },
        { type: 'ONLINE_STORE_THEME_LOCALE_CONTENT', label: 'Locale Content' },
        { type: 'ONLINE_STORE_THEME_SECTION_GROUP', label: 'Section Groups' },
        { type: 'ONLINE_STORE_THEME_SETTINGS_CATEGORY', label: 'Settings Categories' },
      ];

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

      console.log(`[THEMES] Loading ${WORKING_RESOURCE_TYPES.length} resource types with translatable content`);

      // Get shop locales to know which languages to fetch translations for
      const shopLocales = await this.getShopLocales();
      const nonPrimaryLocales = shopLocales.filter((l: any) => !l.primary).map((l: any) => l.locale);
      console.log(`[THEMES] Non-primary locales:`, nonPrimaryLocales);

      // Collect all theme resources
      const allThemeResources = [];

      // Fetch resources for each working resource type
      for (const resourceTypeConfig of WORKING_RESOURCE_TYPES) {
        console.log(`\n--- Loading: ${resourceTypeConfig.label} (${resourceTypeConfig.type}) ---`);

        try {
          const translatableResponse = await this.admin.graphql(GET_THEME_TRANSLATABLE_RESOURCES, {
            variables: { first: 250, resourceType: resourceTypeConfig.type }
          });
          const translatableData = await translatableResponse.json();

          if (translatableData.errors) {
            console.error(`❌ Error loading ${resourceTypeConfig.type}:`, translatableData.errors[0].message);
            continue;
          }

          const resources = translatableData.data?.translatableResources?.edges?.map((edge: any) => edge.node) || [];
          const totalContent = resources.reduce((sum: number, r: any) => sum + (r.translatableContent?.length || 0), 0);

          console.log(`✅ ${resourceTypeConfig.label}: ${resources.length} resources, ${totalContent} translatable fields`);

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

              // 🔍 DEBUG: Log sample translatable content structure
              if (resource.translatableContent.length > 0) {
                console.log(`  [DEBUG] Sample translatable content (first 3):`,
                  resource.translatableContent.slice(0, 3).map((c: any) => ({
                    key: c.key,
                    value: c.value?.substring(0, 50)
                  }))
                );
              }
            }

            // Group translatable content by key patterns
            const contentByGroup: Record<string, any[]> = {};
            const unmatchedContent: any[] = [];

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
              console.log(`  [DEBUG] Found ${unmatchedContent.length} unmatched items`);
              console.log(`  [DEBUG] Sample unmatched keys:`, unmatchedContent.slice(0, 10).map(c => c.key));

              // Group unmatched content by their top-level prefix
              const unmatchedByPrefix: Record<string, any[]> = {};

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

                console.log(`  → Created group "${groupName}" (${items.length} items)`);
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
              console.log(`  → Grouped into ${Object.keys(contentByGroup).length} categories (${totalMatched} items)`);
            }
          }
        } catch (error) {
          console.error(`❌ Exception loading ${resourceTypeConfig.type}:`, error);
        }
      }

      // Consolidate all groups across all resources
      const consolidatedGroups: Record<string, any> = {};

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

      console.log(`\n=== 🎨 THEMES: Fetch complete ===`);
      console.log(`Total theme groups: ${groupedThemes.length}`);
      console.log(`Total translatable fields: ${groupedThemes.reduce((sum, g) => sum + g.contentCount, 0)}`);

      // Log group summary
      groupedThemes.forEach(group => {
        console.log(`  ${group.icon} ${group.title}: ${group.contentCount} fields`);
      });

      return groupedThemes;
    } catch (error) {
      console.error('❌ [THEMES] Error fetching themes:', error);
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
      if (data.errors && data.errors.length > 0) {
        const accessDeniedError = data.errors.find((err: any) =>
          err.message?.includes('Access denied') || err.message?.includes('metaobjectDefinitions')
        );

        if (accessDeniedError) {
          console.warn('⚠️ Metaobjects access denied - feature requires additional Shopify permissions');
          return [];
        }

        throw new Error(data.errors[0].message);
      }

      const definitions = data.data?.metaobjectDefinitions?.edges?.map((edge: any) => edge.node) || [];
      return definitions;
    } catch (error: any) {
      // Gracefully handle permission errors
      if (error.message?.includes('Access denied') || error.message?.includes('metaobjectDefinitions')) {
        console.warn('⚠️ Metaobjects access denied - feature requires additional Shopify permissions');
        return [];
      }
      console.error('Error fetching metaobject definitions:', error);
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
      const allMetaobjects = [];

      for (const definition of definitions) {
        try {
          const response = await this.admin.graphql(GET_METAOBJECTS, {
            variables: { type: definition.type, first }
          });
          const data = await response.json();

          const metaobjects = data.data?.metaobjects?.edges?.map((edge: any) => ({
            ...edge.node,
            definitionName: definition.name,
            translations: []
          })) || [];

          allMetaobjects.push(...metaobjects);
        } catch (error) {
          console.error(`Error fetching metaobjects for type ${definition.type}:`, error);
        }
      }

      return allMetaobjects;
    } catch (error) {
      console.error('Error fetching metaobjects:', error);
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

    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

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
