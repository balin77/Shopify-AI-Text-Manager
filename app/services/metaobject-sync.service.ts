/**
 * Metaobject Sync Service
 *
 * Synchronizes Metaobject Definitions and Metaobjects from Shopify to local PostgreSQL database.
 * This service is used by the sync scheduler and installation process.
 *
 * Performance: Uses translatableResourcesByIds for bulk translation fetching
 * instead of per-metaobject queries. Locales are fetched once and reused.
 */

import { db } from '../db.server';
import { logger } from '~/utils/logger.server';
import type { ShopifyGraphQLClient, ShopLocale } from './sync-types';
import { fetchShopLocales } from './sync-utils';
import { isMetaobjectLabelField } from '~/constants/shopifyFields';

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

const TRANSLATION_BATCH_SIZE = 250;

export class MetaobjectSyncService {
  private cachedLocales: ShopLocale[] | null = null;

  constructor(
    private admin: ShopifyGraphQLClient,
    private shop: string
  ) {}

  /**
   * Full sync: Sync all metaobject definitions and metaobjects
   */
  async syncAll(onProgress?: (current: number, total: number, message: string) => void): Promise<{ definitions: number; metaobjects: number; translations: number }> {
    logger.info('[MetaobjectSync] Starting full sync', { context: 'MetaobjectSync', shop: this.shop });

    // Pre-fetch locales once for the entire sync
    await this.getLocales();

    // 1. Sync definitions
    onProgress?.(0, 1, 'Fetching metaobject definitions...');
    const definitions = await this.syncDefinitions();
    logger.info(`[MetaobjectSync] Synced ${definitions.length} definitions`, {
      context: 'MetaobjectSync',
      count: definitions.length
    });

    // 1b. Definition-level stale-delete: a whole type removed in Shopify means
    // syncMetaobjectsForType never runs for it again, so its metaobjects +
    // translations would never be cleaned up. Delete removed definitions and
    // cascade their metaobjects/translations. (syncDefinitions throws on
    // data.errors, so an outage is already handled there; the 0-guard covers
    // an empty-but-error-free response.)
    if (definitions.length >= 100) {
      logger.warn(`[MetaobjectSync] Skipping definition stale-delete: result possibly truncated (>=100)`);
    } else {
      const liveDefIds = definitions.map((d) => d.id);
      const liveTypes = definitions.map((d) => d.type);
      if (definitions.length === 0) {
        const localDefs = await db.metaobjectDefinition.count({ where: { shop: this.shop } });
        if (localDefs > 0) {
          logger.warn(`[MetaobjectSync] Skipping definition stale-delete: Shopify returned 0 definitions but ${localDefs} exist locally (possible outage)`);
        }
      } else {
        const removed = await db.$transaction(async (tx) => {
          const delDefs = await tx.metaobjectDefinition.deleteMany({
            where: { shop: this.shop, id: { notIn: liveDefIds } },
          });
          // Metaobjects/translations of removed types (the per-type loop will
          // not visit these types anymore).
          await tx.metaobjectTranslation.deleteMany({
            where: { shop: this.shop, type: { notIn: liveTypes } },
          });
          await tx.metaobject.deleteMany({
            where: { shop: this.shop, type: { notIn: liveTypes } },
          });
          return delDefs.count;
        });
        if (removed > 0) {
          logger.debug(`[MetaobjectSync] 🗑️ Deleted ${removed} stale metaobject definitions (+ their metaobjects/translations)`);
        }
      }
    }

    // 2. Sync metaobjects for each definition
    let totalMetaobjects = 0;
    let totalTranslations = 0;

    for (let i = 0; i < definitions.length; i++) {
      const def = definitions[i];
      onProgress?.(i + 1, definitions.length, `Syncing ${def.name || def.type} (${i + 1}/${definitions.length})`);
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

    // 1b. Stale-delete: metaobjects deleted in Shopify have no webhook, so
    // without this they linger forever. Mirrors the article stale-delete.
    if (metaobjects.length >= 250) {
      // Un-paginated (first:250) — can't tell which are truly gone.
      logger.warn(`[MetaobjectSync] Skipping stale-delete for type ${type}: result possibly truncated (>=250)`);
    } else if (metaobjects.length === 0) {
      // fetchMetaobjects swallows GraphQL errors and returns [] — 0 is
      // ambiguous (genuinely empty vs API error). Never mass-delete on empty.
      const localCount = await db.metaobject.count({ where: { shop: this.shop, type } });
      if (localCount > 0) {
        logger.warn(`[MetaobjectSync] Skipping stale-delete for type ${type}: Shopify returned 0 but ${localCount} exist locally (possible outage)`);
      }
    } else {
      const shopifyIds = metaobjects.map((m) => m.id);
      const deleted = await db.$transaction(async (tx) => {
        const stale = await tx.metaobject.findMany({
          where: { shop: this.shop, type, id: { notIn: shopifyIds } },
          select: { id: true },
        });
        const staleIds = stale.map((s) => s.id);
        const del = await tx.metaobject.deleteMany({
          where: { shop: this.shop, type, id: { notIn: shopifyIds } },
        });
        if (staleIds.length > 0) {
          await tx.metaobjectTranslation.deleteMany({
            where: { shop: this.shop, metaobjectId: { in: staleIds } },
          });
        }
        return del.count;
      });
      if (deleted > 0) {
        logger.debug(`[MetaobjectSync] 🗑️ Deleted ${deleted} stale metaobjects of type ${type}`);
      }
    }

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

    // 3. Bulk-fetch translations for all metaobjects of this type
    const totalTranslations = await this.syncTranslationsBulk(metaobjects, type);

    return {
      metaobjects: metaobjects.length,
      translations: totalTranslations
    };
  }

  /**
   * Get locales (cached for the lifetime of this service instance)
   */
  private async getLocales(): Promise<ShopLocale[]> {
    if (!this.cachedLocales) {
      this.cachedLocales = await fetchShopLocales(this.admin.graphql.bind(this.admin));
    }
    return this.cachedLocales;
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
   * Bulk-fetch translations for a batch of metaobjects using translatableResourcesByIds.
   *
   * Before: N metaobjects × M locales = N×M API calls (e.g. 50×3 = 150 calls)
   * After:  ceil(N/250) × M API calls (e.g. 1×3 = 3 calls)
   */
  private async syncTranslationsBulk(metaobjects: Metaobject[], type: string): Promise<number> {
    if (metaobjects.length === 0) return 0;

    const locales = await this.getLocales();
    const foreignLocales = locales.filter(l => !l.primary && l.published);

    if (foreignLocales.length === 0) return 0;

    const metaobjectIds = metaobjects.map(m => m.id);
    let translationCount = 0;

    // Split IDs into batches for the bulk query
    const batches: string[][] = [];
    for (let i = 0; i < metaobjectIds.length; i += TRANSLATION_BATCH_SIZE) {
      batches.push(metaobjectIds.slice(i, i + TRANSLATION_BATCH_SIZE));
    }

    for (const locale of foreignLocales) {
      for (const batch of batches) {
        try {
          const response = await this.admin.graphql(
            `#graphql
              query getMetaobjectTranslationsBulk($resourceIds: [ID!]!, $locale: String!) {
                translatableResourcesByIds(first: ${batch.length}, resourceIds: $resourceIds) {
                  edges {
                    node {
                      resourceId
                      translations(locale: $locale) {
                        key
                        value
                        locale
                      }
                    }
                  }
                }
              }`,
            { variables: { resourceIds: batch, locale: locale.locale } }
          );

          const data = await response.json();

          if (data.errors) {
            logger.warn(`[MetaobjectSync] GraphQL error fetching bulk translations for locale ${locale.locale}:`, {
              context: 'MetaobjectSync',
              errors: data.errors[0]?.message
            });
            continue;
          }

          const resources = data.data?.translatableResourcesByIds?.edges || [];

          // Collect all upsert operations for this batch
          const upsertOps = [];

          for (const edge of resources) {
            if (!edge.node?.resourceId) continue;
            const metaobjectId = edge.node.resourceId;
            const translations = edge.node.translations || [];

            for (const trans of translations) {
              if (!trans.value) continue;
              // Only sync translatable field keys
              if (isMetaobjectLabelField(trans.key)) {
                upsertOps.push(
                  db.metaobjectTranslation.upsert({
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
                  })
                );
              }
            }
          }

          // Execute all upserts in a single transaction
          if (upsertOps.length > 0) {
            await db.$transaction(upsertOps);
            translationCount += upsertOps.length;
          }
        } catch (error) {
          logger.warn(`[MetaobjectSync] Error fetching bulk translations for locale ${locale.locale}:`, {
            context: 'MetaobjectSync',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    return translationCount;
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
