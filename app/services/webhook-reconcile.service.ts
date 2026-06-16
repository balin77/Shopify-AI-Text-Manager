/**
 * Webhook-backed Drift Reconcile
 *
 * products + collections are kept fresh by Shopify webhooks (they are NOT in
 * the recurring BackgroundSyncService.syncAll). If a webhook is missed (app
 * downtime at event time, delivery failure), they silently drift until the
 * next initial/force resync. This is a lightweight, low-frequency safety net:
 * it lists only id + updatedAt, diffs against the local cache, and repairs
 * ONLY drifted items via the exact same single-item entry points the webhooks
 * use (no divergent sync path). The scheduler calls it every N incremental
 * cycles for active shops only.
 *
 * Cheap by design: id+updatedAt query (capped to the plan limit), per-item
 * sync only for genuine drift (≈0 under healthy webhooks). Stale-delete only
 * when the remote listing is provably complete, with the same empty-response
 * outage guard used elsewhere.
 */

import { db } from "../db.server";
import { logger } from "~/utils/logger.server";
import { getSyncScope, type Plan } from "../utils/planUtils";
import { ProductSyncService } from "./product-sync.service";
import { ContentSyncService } from "./content-sync.service";
import type { ShopifyGraphQLClient } from "./sync-types";

const PAGE_SIZE = 250;

interface RemoteRef {
  id: string;
  updatedAt: string;
}

/** Lists id+updatedAt for a connection, capped at maxItems. `complete` is true
 *  only when the entire set was listed (no truncation), so stale-deletes are
 *  safe. */
async function listRefs(
  admin: ShopifyGraphQLClient,
  root: "products" | "collections",
  maxItems: number,
): Promise<{ refs: Map<string, string>; complete: boolean }> {
  const refs = new Map<string, string>();
  let cursor: string | null = null;
  let complete = true;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = `#graphql
      query reconcile($first: Int!, $after: String) {
        ${root}(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { id updatedAt } }
        }
      }`;
    const res = await admin.graphql(query, { variables: { first: PAGE_SIZE, after: cursor } });
    const data = await res.json();
    if (data.errors?.length) {
      // Treat as outage: incomplete listing → caller must not stale-delete.
      throw new Error(`GraphQL error in reconcile ${root}: ${data.errors[0].message}`);
    }
    const conn = data.data?.[root];
    const edges: Array<{ node: RemoteRef }> = conn?.edges || [];
    for (const e of edges) refs.set(e.node.id, e.node.updatedAt);

    if (refs.size >= maxItems) {
      // Capped before exhausting the connection → cannot prove completeness.
      if (conn?.pageInfo?.hasNextPage) complete = false;
      break;
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { refs, complete };
}

async function reconcileProducts(admin: ShopifyGraphQLClient, shop: string, maxItems: number): Promise<number> {
  const { refs, complete } = await listRefs(admin, "products", maxItems);
  const local = await db.product.findMany({
    where: { shop },
    select: { id: true, shopifyUpdatedAt: true },
  });
  const localMap = new Map(local.map((p) => [p.id, p.shopifyUpdatedAt]));
  const svc = new ProductSyncService(admin, shop);

  let repaired = 0;
  for (const [id, updatedAt] of refs) {
    const localUpdated = localMap.get(id);
    if (!localUpdated || new Date(updatedAt) > localUpdated) {
      try {
        await svc.syncProduct(id);
        repaired++;
      } catch (e) {
        logger.warn(`[Reconcile] product sync failed ${id}`, { shop, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (complete) {
    if (refs.size === 0 && local.length > 0) {
      logger.warn(`[Reconcile] Skipping product stale-delete: Shopify returned 0 but ${local.length} exist locally (possible outage)`);
    } else {
      for (const p of local) {
        if (!refs.has(p.id)) {
          try {
            await svc.deleteProduct(p.id);
            repaired++;
          } catch (e) {
            logger.warn(`[Reconcile] product delete failed ${p.id}`, { shop, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
  }
  return repaired;
}

async function reconcileCollections(admin: ShopifyGraphQLClient, shop: string, maxItems: number): Promise<number> {
  const { refs, complete } = await listRefs(admin, "collections", maxItems);
  const local = await db.collection.findMany({
    where: { shop },
    select: { id: true, shopifyUpdatedAt: true },
  });
  const localMap = new Map(local.map((c) => [c.id, c.shopifyUpdatedAt]));
  const svc = new ContentSyncService(admin, shop);

  let repaired = 0;
  for (const [id, updatedAt] of refs) {
    const localUpdated = localMap.get(id);
    if (!localUpdated || new Date(updatedAt) > localUpdated) {
      try {
        await svc.syncCollection(id);
        repaired++;
      } catch (e) {
        logger.warn(`[Reconcile] collection sync failed ${id}`, { shop, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (complete) {
    if (refs.size === 0 && local.length > 0) {
      logger.warn(`[Reconcile] Skipping collection stale-delete: Shopify returned 0 but ${local.length} exist locally (possible outage)`);
    } else {
      for (const c of local) {
        if (!refs.has(c.id)) {
          try {
            await svc.deleteCollection(c.id);
            repaired++;
          } catch (e) {
            logger.warn(`[Reconcile] collection delete failed ${c.id}`, { shop, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
  }
  return repaired;
}

/**
 * Reconcile the webhook-backed types (products, collections) for a shop.
 * Plan-aware (skips types the plan does not entitle). Per-type isolated so one
 * failing type never breaks the other or the scheduler. Returns repair counts.
 */
export async function reconcileWebhookBackedTypes(
  admin: ShopifyGraphQLClient,
  shop: string,
): Promise<{ products: number; collections: number }> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const scope = getSyncScope(plan);

  let products = 0;
  let collections = 0;

  if (scope.products.enabled) {
    try {
      products = await reconcileProducts(admin, shop, scope.products.max ?? 10000);
    } catch (e) {
      logger.warn(`[Reconcile] products reconcile aborted`, { shop, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (scope.collections.enabled) {
    try {
      collections = await reconcileCollections(admin, shop, scope.collections.max ?? 10000);
    } catch (e) {
      logger.warn(`[Reconcile] collections reconcile aborted`, { shop, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (products > 0 || collections > 0) {
    logger.info(`[Reconcile] Repaired drift for ${shop}`, { products, collections });
  }
  return { products, collections };
}
