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

/** `ok` is false when anything inconclusive or failed happened: the catch-up keeps its flag then. */
interface ReconcileTypeResult {
  repaired: number;
  ok: boolean;
}

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

async function reconcileProducts(admin: ShopifyGraphQLClient, shop: string, maxItems: number): Promise<ReconcileTypeResult> {
  const { refs, complete } = await listRefs(admin, "products", maxItems);
  const local = await db.product.findMany({
    where: { shop },
    select: { id: true, shopifyUpdatedAt: true },
  });
  const localMap = new Map(local.map((p) => [p.id, p.shopifyUpdatedAt]));
  const svc = new ProductSyncService(admin, shop);

  let repaired = 0;
  let ok = true;
  for (const [id, updatedAt] of refs) {
    const localUpdated = localMap.get(id);
    if (!localUpdated || new Date(updatedAt) > localUpdated) {
      try {
        // Stale-translation reconciliation ONLY for a resource we already had
        // and that Shopify says has changed since — that is the missed change
        // event. A resource with no cached row at all is a FIRST sync (fresh
        // install, plan cap lifted, newly created product): reconciling there
        // would delete every translation Shopify happens to flag outdated
        // before the merchant has ever seen this app.
        await svc.syncProduct(id, false, { reconcileTranslations: localMap.has(id) });
        repaired++;
      } catch (e) {
        ok = false;
        logger.warn(`[Reconcile] product sync failed ${id}`, { shop, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (complete) {
    if (refs.size === 0 && local.length > 0) {
      ok = false; // inconclusive, not proof of a clean shop
      logger.warn(`[Reconcile] Skipping product stale-delete: Shopify returned 0 but ${local.length} exist locally (possible outage)`);
    } else {
      for (const p of local) {
        if (!refs.has(p.id)) {
          try {
            await svc.deleteProduct(p.id);
            repaired++;
          } catch (e) {
            ok = false;
            logger.warn(`[Reconcile] product delete failed ${p.id}`, { shop, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
  }
  return { repaired, ok };
}

async function reconcileCollections(admin: ShopifyGraphQLClient, shop: string, maxItems: number): Promise<ReconcileTypeResult> {
  const { refs, complete } = await listRefs(admin, "collections", maxItems);
  const local = await db.collection.findMany({
    where: { shop },
    select: { id: true, shopifyUpdatedAt: true },
  });
  const localMap = new Map(local.map((c) => [c.id, c.shopifyUpdatedAt]));
  const svc = new ContentSyncService(admin, shop);

  let repaired = 0;
  let ok = true;
  for (const [id, updatedAt] of refs) {
    const localUpdated = localMap.get(id);
    if (!localUpdated || new Date(updatedAt) > localUpdated) {
      try {
        // See reconcileProducts: a never-cached collection is a FIRST sync,
        // not a missed change event.
        await svc.syncCollection(id, false, { reconcileTranslations: localMap.has(id) });
        repaired++;
      } catch (e) {
        ok = false;
        logger.warn(`[Reconcile] collection sync failed ${id}`, { shop, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (complete) {
    if (refs.size === 0 && local.length > 0) {
      ok = false; // inconclusive, not proof of a clean shop
      logger.warn(`[Reconcile] Skipping collection stale-delete: Shopify returned 0 but ${local.length} exist locally (possible outage)`);
    } else {
      for (const c of local) {
        if (!refs.has(c.id)) {
          try {
            await svc.deleteCollection(c.id);
            repaired++;
          } catch (e) {
            ok = false;
            logger.warn(`[Reconcile] collection delete failed ${c.id}`, { shop, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
    }
  }
  return { repaired, ok };
}

/**
 * Reconcile the webhook-backed types (products, collections) for a shop.
 * Plan-aware (skips types the plan does not entitle). Per-type isolated so one
 * failing type never breaks the other or the scheduler. Returns repair counts
 * and, per type, whether the pass was CLEAN (`ok`): a listing that threw, an
 * item that failed to sync or delete, or an inconclusive empty answer is not ok.
 * A type the plan does not cover counts as ok (nothing is owed there). The
 * catch-up after a connection block (webhook-catchup.server.ts) clears its flag
 * only when every type is ok.
 */
export async function reconcileWebhookBackedTypes(
  admin: ShopifyGraphQLClient,
  shop: string,
): Promise<{ products: number; collections: number; ok: { products: boolean; collections: boolean } }> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const scope = getSyncScope(plan);

  let products = 0;
  let collections = 0;
  const ok = { products: true, collections: true };

  if (scope.products.enabled) {
    try {
      const r = await reconcileProducts(admin, shop, scope.products.max ?? 10000);
      products = r.repaired;
      ok.products = r.ok;
    } catch (e) {
      ok.products = false;
      logger.warn(`[Reconcile] products reconcile aborted`, { shop, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (scope.collections.enabled) {
    try {
      const r = await reconcileCollections(admin, shop, scope.collections.max ?? 10000);
      collections = r.repaired;
      ok.collections = r.ok;
    } catch (e) {
      ok.collections = false;
      logger.warn(`[Reconcile] collections reconcile aborted`, { shop, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (products > 0 || collections > 0) {
    logger.info(`[Reconcile] Repaired drift for ${shop}`, { products, collections });
  }
  return { products, collections, ok };
}
