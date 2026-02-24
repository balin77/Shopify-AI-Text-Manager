/**
 * Metaobject Sync Service
 *
 * Synchronizes Metaobject Definitions and Metaobjects from Shopify to local PostgreSQL database.
 * This service is used by the sync scheduler and installation process.
 */

import { db } from '../db.server';
import { logger } from '~/utils/logger.server';
import type { ShopifyGraphQLClient } from './sync-types';
import { fetchShopLocales } from './sync-utils';

interface MetaobjectDefinition {
  id: string;
  type: string;
  name: string;
  description?: string | null;
  fieldDefinitions: Array<{
    key: string;
    name: string;
    type: {
      name: string;
    };
  }>;
}

interface Metaobject {
  id: string;
  handle: string;
  displayName: string;
  type: string;
  updatedAt: string;
  fields: Array<{
    key: string;
    value: string | null;
    type: string;
  }>;
}

interface MetaobjectTranslation {
  key: string;
  value: string;
  locale: string;
}

export class MetaobjectSyncService {
  constructor(
    private admin: ShopifyGraphQLClient,
    private shop: string
  ) {}

  /**
   * Full sync: Sync all metaobject definitions and metaobjects
   */
  async syncAll(): Promise<{ definitions: number; metaobjects: number; translations: number }> {
    logger.info('[MetaobjectSync] Starting full sync', { context: 'MetaobjectSync', shop: this.shop });

    // 1. Sync definitions
    const definitions = await this.syncDefinitions();
    logger.info(`[MetaobjectSync] Synced ${definitions.length} definitions`, {
      context: 'MetaobjectSync',
      count: definitions.length
    });

    // 2. Sync metaobjects for each definition
    let totalMetaobjects = 0;
    let totalTranslations = 0;

    for (const def of definitions) {
      const result = await this.syncMetaobjectsForType(def.type);
      totalMetaobjects += result.metaobjects;
      totalTranslations += result.translations;
    }

    logger.info('[MetaobjectSync] Full sync completed', {
      context: 'MetaobjectSync',
      definitions: definitions.length,
      metaobjects: totalMetaobjects,
      translations: totalTranslations
    });

    return {
      definitions: definitions.length,
      metaobjects: totalMetaobjects,
      translations: totalTranslations
    };
  }

  /**
   * Sync all metaobject definitions
   */
  async syncDefinitions(): Promise<MetaobjectDefinition[]> {
    const query = `#graphql
      query getMetaobjectDefinitions($first: Int!) {
        metaobjectDefinitions(first: $first) {
          edges {
            node {
              id
              type
              name
              description
              fieldDefinitions {
                key
                name
                type {
                  name
                }
              }
            }
          }
        }
      }
    `;

    const response = await this.admin.graphql(query, { variables: { first: 100 } });
    const data = await response.json();

    if (data.errors) {
      logger.error('[MetaobjectSync] GraphQL errors fetching definitions', {
        context: 'MetaobjectSync',
        errors: data.errors
      });
      throw new Error('Failed to fetch metaobject definitions');
    }

    const definitions: MetaobjectDefinition[] =
      data.data?.metaobjectDefinitions?.edges?.map((edge: { node: MetaobjectDefinition }) => edge.node) || [];

    // Upsert definitions to DB
    for (const def of definitions) {
      await db.metaobjectDefinition.upsert({
        where: {
          shop_id: {
            shop: this.shop,
            id: def.id
          }
        },
        create: {
          id: def.id,
          shop: this.shop,
          type: def.type,
          name: def.name,
          description: def.description,
          fieldDefinitions: def.fieldDefinitions,
          lastSyncedAt: new Date()
        },
        update: {
          name: def.name,
          description: def.description,
          fieldDefinitions: def.fieldDefinitions,
          lastSyncedAt: new Date()
        }
      });
    }

    return definitions;
  }

  /**
   * Sync metaobjects for a specific type
   */
  async syncMetaobjectsForType(type: string): Promise<{ metaobjects: number; translations: number }> {
    logger.info(`[MetaobjectSync] Syncing metaobjects for type: ${type}`, {
      context: 'MetaobjectSync',
      type
    });

    // 1. Fetch metaobjects
    const metaobjects = await this.fetchMetaobjects(type);

    // 2. Upsert metaobjects to DB
    for (const metaobj of metaobjects) {
      await db.metaobject.upsert({
        where: {
          shop_id: {
            shop: this.shop,
            id: metaobj.id
          }
        },
        create: {
          id: metaobj.id,
          shop: this.shop,
          type: metaobj.type,
          handle: metaobj.handle,
          displayName: metaobj.displayName,
          fields: metaobj.fields,
          shopifyUpdatedAt: new Date(metaobj.updatedAt),
          lastSyncedAt: new Date()
        },
        update: {
          handle: metaobj.handle,
          displayName: metaobj.displayName,
          fields: metaobj.fields,
          shopifyUpdatedAt: new Date(metaobj.updatedAt),
          lastSyncedAt: new Date()
        }
      });
    }

    // 3. Sync translations for all metaobjects
    let totalTranslations = 0;
    for (const metaobj of metaobjects) {
      const transCount = await this.syncTranslationsForMetaobject(metaobj.id, type);
      totalTranslations += transCount;
    }

    return {
      metaobjects: metaobjects.length,
      translations: totalTranslations
    };
  }

  /**
   * Fetch all metaobjects for a specific type
   */
  private async fetchMetaobjects(type: string): Promise<Metaobject[]> {
    const query = `#graphql
      query getMetaobjects($type: String!, $first: Int!) {
        metaobjects(type: $type, first: $first) {
          edges {
            node {
              id
              handle
              displayName
              type
              updatedAt
              fields {
                key
                value
                type
              }
            }
          }
        }
      }
    `;

    const response = await this.admin.graphql(query, { variables: { type, first: 250 } });
    const data = await response.json();

    if (data.errors) {
      logger.error('[MetaobjectSync] GraphQL errors fetching metaobjects', {
        context: 'MetaobjectSync',
        type,
        errors: data.errors
      });
      return [];
    }

    return data.data?.metaobjects?.edges?.map((edge: { node: Metaobject }) => edge.node) || [];
  }

  /**
   * Sync translations for a single metaobject across all locales
   */
  private async syncTranslationsForMetaobject(metaobjectId: string, type: string): Promise<number> {
    // Get shop locales
    const locales = await fetchShopLocales(this.admin.graphql.bind(this.admin));
    const foreignLocales = locales.filter(l => !l.primary).map(l => l.locale);

    if (foreignLocales.length === 0) {
      return 0;
    }

    let translationCount = 0;

    for (const locale of foreignLocales) {
      const translations = await this.fetchTranslations(metaobjectId, locale);

      for (const trans of translations) {
        // Only sync display_name, name, or label translations
        if (trans.key === 'display_name' || trans.key === 'name' || trans.key === 'label') {
          await db.metaobjectTranslation.upsert({
            where: {
              shop_metaobjectId_key_locale: {
                shop: this.shop,
                metaobjectId,
                key: trans.key,
                locale: trans.locale
              }
            },
            create: {
              shop: this.shop,
              metaobjectId,
              type,
              key: trans.key,
              value: trans.value,
              locale: trans.locale,
              outdated: false
            },
            update: {
              value: trans.value,
              outdated: false,
              updatedAt: new Date()
            }
          });

          translationCount++;
        }
      }
    }

    return translationCount;
  }

  /**
   * Fetch translations for a metaobject in a specific locale
   */
  private async fetchTranslations(metaobjectId: string, locale: string): Promise<MetaobjectTranslation[]> {
    const query = `#graphql
      query getMetaobjectTranslations($resourceId: ID!, $locale: String!) {
        translatableResource(resourceId: $resourceId) {
          resourceId
          translations(locale: $locale) {
            key
            value
            locale
          }
        }
      }
    `;

    const response = await this.admin.graphql(query, {
      variables: { resourceId: metaobjectId, locale }
    });

    const data = await response.json();

    if (data.errors) {
      logger.debug('[MetaobjectSync] GraphQL errors fetching translations', {
        context: 'MetaobjectSync',
        metaobjectId,
        locale,
        errors: data.errors
      });
      return [];
    }

    return data.data?.translatableResource?.translations || [];
  }

  /**
   * Sync a single metaobject type (for manual reload)
   */
  async syncSingleType(type: string): Promise<{ success: boolean; metaobjects: number; translations: number }> {
    try {
      const result = await this.syncMetaobjectsForType(type);

      return {
        success: true,
        ...result
      };
    } catch (error) {
      logger.error('[MetaobjectSync] Error syncing single type', {
        context: 'MetaobjectSync',
        type,
        error: error instanceof Error ? error.message : String(error)
      });

      return {
        success: false,
        metaobjects: 0,
        translations: 0
      };
    }
  }
}
