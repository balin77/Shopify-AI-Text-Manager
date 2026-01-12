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
  GET_METAOBJECTS
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

    console.log('=== BLOGS API RESPONSE ===');
    console.log('Raw blogs data:', JSON.stringify(data, null, 2));
    console.log('Number of blogs:', data.data?.blogs?.edges?.length || 0);

    const blogs = data.data.blogs.edges.map((edge: any) => ({
      ...edge.node,
      articles: edge.node.articles.edges.map((a: any) => ({
        ...a.node,
        translations: []
      }))
    }));

    console.log('Processed blogs:', blogs.length);
    return blogs;
  }

  async getCollections(first: number = 50) {
    const response = await this.admin.graphql(GET_COLLECTIONS, {
      variables: { first }
    });
    const data = await response.json();

    console.log('=== COLLECTIONS API RESPONSE ===');
    console.log('Raw collections data:', JSON.stringify(data, null, 2));
    console.log('Number of collections:', data.data?.collections?.edges?.length || 0);

    const collections = data.data.collections.edges.map((edge: any) => ({
      ...edge.node,
      translations: []
    }));

    console.log('Processed collections:', collections.length);
    return collections;
  }

  async getPages(first: number = 50) {
    const response = await this.admin.graphql(GET_PAGES, {
      variables: { first }
    });
    const data = await response.json();

    console.log('=== PAGES API RESPONSE ===');
    console.log('Raw pages data:', JSON.stringify(data, null, 2));
    console.log('Number of pages:', data.data?.pages?.edges?.length || 0);

    const pages = data.data.pages.edges.map((edge: any) => ({
      ...edge.node,
      translations: []
    }));

    console.log('Processed pages:', pages.length);
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

      console.log('=== SHOP METADATA API RESPONSE ===');
      console.log('Raw shop metadata:', JSON.stringify(data, null, 2));

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
      // First get shop locales to know which languages to fetch
      const shopLocales = await this.getShopLocales();
      const locales = shopLocales.filter((l: any) => !l.primary).map((l: any) => l.locale);

      console.log(`[ContentService] Fetching menus with translations for locales: ${locales.join(', ')}`);

      const response = await this.admin.graphql(GET_MENUS, {
        variables: { first }
      });
      const data = await response.json();

      console.log(`[ContentService] Loaded ${data.data?.menus?.edges?.length || 0} menus`);

      // For each menu, fetch translations using both methods
      const menusWithTranslations = [];

      for (const edge of data.data?.menus?.edges || []) {
        const menu = edge.node;
        const allTranslations = [];

        // Method 1: Try translatableResource to get all translatable content for MENU
        try {
          const translatableQuery = `#graphql
            query getTranslatableMenu($id: ID!) {
              translatableResource(resourceId: $id) {
                resourceId
                translatableContent {
                  key
                  value
                  digest
                  locale
                }
                translations {
                  locale
                  key
                  value
                  outdated
                }
              }
            }
          `;

          const translatableResponse = await this.admin.graphql(translatableQuery, {
            variables: { id: menu.id }
          });
          const translatableData = await translatableResponse.json();

          const translations = translatableData.data?.translatableResource?.translations || [];
          allTranslations.push(...translations);
        } catch (error) {
          console.error(`Error fetching translatable resource for menu ${menu.id}:`, error);
        }

        // Method 2: Fetch translations for each non-primary locale
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

            // Only add if not already added by translatableResource
            for (const trans of translations) {
              if (!allTranslations.find(t => t.locale === trans.locale && t.key === trans.key)) {
                allTranslations.push(trans);
              }
            }
          } catch (error) {
            console.error(`Error fetching translations for menu ${menu.id} in locale ${locale}:`, error);
          }
        }

        // 🔥 NEW: Fetch translations for each LINK (MenuItem) recursively
        const collectAllMenuItems = (items: any[], path: string[] = []): any[] => {
          const result: any[] = [];
          if (!items) return result;

          items.forEach((item, index) => {
            const currentPath = [...path, (index + 1).toString()];
            result.push({ ...item, path: currentPath.join('.') });

            if (item.items && item.items.length > 0) {
              result.push(...collectAllMenuItems(item.items, currentPath));
            }
          });

          return result;
        };

        const allMenuItems = collectAllMenuItems(menu.items);
        console.log(`[Menu ${menu.id}] Fetching LINK translations for ${allMenuItems.length} items...`);

        let totalLinkTranslations = 0;
        let errorCount = 0;

        for (const menuItem of allMenuItems) {
          // Fetch translations for this LINK
          try {
            const linkTranslatableQuery = `#graphql
              query getTranslatableLink($id: ID!) {
                translatableResource(resourceId: $id) {
                  resourceId
                  translatableContent {
                    key
                    value
                    digest
                    locale
                  }
                  translations {
                    locale
                    key
                    value
                    outdated
                  }
                }
              }
            `;

            const linkResponse = await this.admin.graphql(linkTranslatableQuery, {
              variables: { id: menuItem.id }
            });
            const linkData = await linkResponse.json();

            const linkTranslations = linkData.data?.translatableResource?.translations || [];

            // Add link translations with a prefix to distinguish from menu translations
            for (const trans of linkTranslations) {
              allTranslations.push({
                ...trans,
                key: `link_${menuItem.path}_${trans.key}`,
                originalKey: trans.key,
                linkId: menuItem.id,
                linkPath: menuItem.path
              });
            }

            totalLinkTranslations += linkTranslations.length;
          } catch (error) {
            errorCount++;
            console.error(`[Menu ${menu.id}] Error on link ${menuItem.id}:`, error);
          }
        }

        console.log(`[Menu ${menu.id}] ✓ Loaded ${totalLinkTranslations} link translations from ${allMenuItems.length} items (${errorCount} errors)`);

        menusWithTranslations.push({
          ...menu,
          translations: allTranslations
        });
      }

      console.log('Processed menus with translations:', menusWithTranslations.length);
      return menusWithTranslations;
    } catch (error) {
      console.error('Error fetching menus:', error);
      return [];
    }
  }

  async getThemes(first: number = 50) {
    try {
      const response = await this.admin.graphql(GET_THEMES, {
        variables: { first }
      });
      const data = await response.json();

      console.log('=== THEMES API RESPONSE ===');
      console.log('Raw themes data:', JSON.stringify(data, null, 2));
      console.log('Number of themes:', data.data?.themes?.edges?.length || 0);

      const themes = data.data?.themes?.edges?.map((edge: any) => ({
        ...edge.node,
        translations: []
      })) || [];

      console.log('Processed themes:', themes.length);
      return themes;
    } catch (error) {
      console.error('Error fetching themes:', error);
      return [];
    }
  }

  async getMetaobjectDefinitions(first: number = 50) {
    try {
      const response = await this.admin.graphql(GET_METAOBJECT_DEFINITIONS, {
        variables: { first }
      });
      const data = await response.json();

      console.log('=== METAOBJECT DEFINITIONS API RESPONSE ===');
      console.log('Raw metaobject definitions:', JSON.stringify(data, null, 2));

      const definitions = data.data?.metaobjectDefinitions?.edges?.map((edge: any) => edge.node) || [];
      console.log('Processed metaobject definitions:', definitions.length);
      return definitions;
    } catch (error) {
      console.error('Error fetching metaobject definitions:', error);
      return [];
    }
  }

  async getMetaobjects(first: number = 50) {
    try {
      // First get all metaobject definitions
      const definitions = await this.getMetaobjectDefinitions(10);

      if (definitions.length === 0) {
        console.log('No metaobject definitions found');
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

          console.log(`=== METAOBJECTS (${definition.type}) API RESPONSE ===`);
          console.log('Raw metaobjects:', JSON.stringify(data, null, 2));

          const metaobjects = data.data?.metaobjects?.edges?.map((edge: any) => ({
            ...edge.node,
            definitionName: definition.name,
            translations: []
          })) || [];

          allMetaobjects.push(...metaobjects);
          console.log(`Processed ${metaobjects.length} metaobjects for type ${definition.type}`);
        } catch (error) {
          console.error(`Error fetching metaobjects for type ${definition.type}:`, error);
        }
      }

      console.log('Total metaobjects processed:', allMetaobjects.length);
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
