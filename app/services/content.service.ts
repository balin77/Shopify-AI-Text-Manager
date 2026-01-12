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

  async getThemes(first: number = 50) {
    try {
      console.log('\n=== 🎨 THEMES: Fetching theme translatable resources ===');
      console.log('[THEMES] ⚠️  API LIMITATION: ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS returns empty content');
      console.log('[THEMES] Shopify Translation API cannot access settings_data.json (merchant inputs)');
      console.log('[THEMES] Only schema-level translations are accessible, not dynamic section content');

      // First, get all themes
      const themesResponse = await this.admin.graphql(GET_THEMES, {
        variables: { first }
      });
      const themesData = await themesResponse.json();

      const themes = themesData.data?.themes?.edges?.map((edge: any) => edge.node) || [];
      console.log(`[THEMES] Found ${themes.length} themes`);

      // Then, fetch all translatable resources for ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS
      const translatableResponse = await this.admin.graphql(GET_THEME_TRANSLATABLE_RESOURCES, {
        variables: { first: 250 }
      });
      const translatableData = await translatableResponse.json();

      const translatableResources = translatableData.data?.translatableResources?.edges?.map((edge: any) => edge.node) || [];
      console.log(`[THEMES] Found ${translatableResources.length} translatable theme resources`);

      // Log translatable content structure
      if (translatableResources.length > 0) {
        console.log('[THEMES] Translatable content sample:');
        translatableResources.slice(0, 3).forEach((resource: any, index: number) => {
          console.log(`  Resource ${index + 1}:`);
          console.log(`    ID: ${resource.resourceId}`);
          console.log(`    Translatable content count: ${resource.translatableContent?.length || 0}`);
          if (resource.translatableContent && resource.translatableContent.length > 0) {
            console.log(`    Sample keys:`, resource.translatableContent.slice(0, 3).map((c: any) => c.key));
          }
        });
      }

      // Get shop locales to know which languages to fetch translations for
      const shopLocales = await this.getShopLocales();
      const nonPrimaryLocales = shopLocales.filter((l: any) => !l.primary).map((l: any) => l.locale);
      console.log(`[THEMES] Non-primary locales to fetch translations for:`, nonPrimaryLocales);

      // For each translatable resource, fetch translations for all non-primary locales
      const themesWithContent = [];

      for (const resource of translatableResources) {
        const allTranslations = [];

        // Fetch translations for each non-primary locale
        for (const locale of nonPrimaryLocales) {
          try {
            const translationsResponse = await this.admin.graphql(GET_THEME_TRANSLATIONS, {
              variables: { resourceId: resource.resourceId, locale }
            });
            const translationsData = await translationsResponse.json();

            const translations = translationsData.data?.translatableResource?.translations || [];

            if (translations.length > 0) {
              console.log(`  [THEME-${locale}] Found ${translations.length} translations for resource ${resource.resourceId}`);
              allTranslations.push(...translations);
            }
          } catch (error) {
            console.error(`  [THEME-${locale}] Error fetching translations:`, error);
          }
        }

        // Create a theme content object
        themesWithContent.push({
          id: resource.resourceId,
          title: resource.translatableContent?.[0]?.key || `Theme Resource ${resource.resourceId.split('/').pop()}`,
          name: resource.translatableContent?.[0]?.value || 'Theme Settings',
          role: 'CONTENT',
          translatableContent: resource.translatableContent || [],
          translations: allTranslations
        });
      }

      console.log(`\n=== 🎨 THEMES: Fetch complete - ${themesWithContent.length} translatable resources loaded ===\n`);

      // Return both regular themes and translatable theme content
      return [...themes.map((t: any) => ({ ...t, translations: [] })), ...themesWithContent];
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
