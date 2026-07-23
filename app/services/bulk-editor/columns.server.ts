/**
 * Bulk editor — server-side column source (Plan §4.1/§10.7).
 *
 * Builds the shop-specific column universe: the metafield columns come from
 * the merchant's enabled definitions (EnabledMetafieldDefinition) intersected
 * with the translatable text types — EXACTLY the filter the product editor
 * loader uses (isEditableProductMetafield, metafield-enablement.server.ts).
 * The dynamic product columns are additionally gated on the plan's cache
 * flags (cacheEnabled.productMetafields/productOptions/productImages,
 * Plan §10.7).
 *
 * Both save entrances (route action AND the /api/ai seoBulkMeta handler) call
 * buildServerColumnsByType and validate every diff entry against it — that is
 * what makes the mf.-column allowlist a SERVER-side check against the enabled
 * definitions instead of trusting client-sent column ids.
 *
 * Server-only: imports Prisma types and metafield-enablement.server. The pure
 * builders live in columns.shared.ts (client-safe).
 */

import type { PrismaClient } from "@prisma/client";
import {
  getEnabledMetafieldKeySet,
  isEditableProductMetafield,
  metafieldEnableKey,
} from "../metafield-enablement.server";
import { PLAN_CONFIG, type Plan } from "../../config/plans";
import {
  buildColumnsForType,
  BULK_ROW_TYPES,
  BULK_ROW_TYPE_TO_CONTENT_TYPE,
  type BulkRowType,
  type ColumnDescriptor,
  type MetafieldColumnSpec,
  type ProductColumnCaps,
} from "./columns.shared";

/** Row types the shop's plan may edit (Plan §3.4): supported types ∩
 * PLAN_CONFIG[plan].contentTypes — the same intersection the bulk route and
 * the seoBulkMeta handler apply; the CSV export/import routes use this. */
export function allowedRowTypesForPlan(plan: Plan): BulkRowType[] {
  const contentTypes = PLAN_CONFIG[plan].contentTypes as string[];
  return BULK_ROW_TYPES.filter((t) => contentTypes.includes(BULK_ROW_TYPE_TO_CONTENT_TYPE[t]));
}

/** Which dynamic product columns the plan may offer (Plan §10.7): the cache
 * that feeds them is only maintained from Basic on. */
export function productColumnCapsForPlan(plan: Plan): ProductColumnCaps {
  const cache = PLAN_CONFIG[plan].cacheEnabled;
  return {
    metafields: cache.productMetafields,
    options: cache.productOptions,
    imageAlt: cache.productImages,
  };
}

/**
 * The shop's metafield columns: enabled definitions ∩ translatable text
 * types, resolved to a concrete Shopify type via the ACTUAL metafield rows in
 * the cache (a definition whose type we cannot determine gets no column — the
 * grid could not create values of an unknown type, and the product editor
 * would not show it either since it only lists metafields present on the
 * product).
 */
export async function loadProductMetafieldColumnSpecs(
  db: Pick<PrismaClient, "enabledMetafieldDefinition" | "productMetafield">,
  shop: string,
): Promise<MetafieldColumnSpec[]> {
  const enabledKeys = await getEnabledMetafieldKeySet(db as Pick<PrismaClient, "enabledMetafieldDefinition">, shop);
  if (enabledKeys.size === 0) return [];

  const rows = await db.productMetafield.findMany({
    where: { product: { shop } },
    distinct: ["namespace", "key", "type"],
    select: { namespace: true, key: true, type: true },
  });

  const specs = new Map<string, MetafieldColumnSpec>();
  for (const row of rows) {
    if (!isEditableProductMetafield(row, enabledKeys)) continue;
    const key = metafieldEnableKey(row.namespace, row.key);
    // First type wins if (pathologically) the same namespace.key exists with
    // two translatable types — a per-product type mismatch surfaces as a
    // metafieldsSet userError → cell failure, never a silent wrong write.
    if (!specs.has(key)) specs.set(key, { namespace: row.namespace, key: row.key, type: row.type });
  }

  return [...specs.values()].sort((a, b) =>
    metafieldEnableKey(a.namespace, a.key).localeCompare(metafieldEnableKey(b.namespace, b.key)),
  );
}

/** The full, trustworthy column universe per row type for this shop + plan —
 * the validation allowlist for both save entrances and the descriptor source
 * for applyBulkDiff. */
export async function buildServerColumnsByType(
  db: Pick<PrismaClient, "enabledMetafieldDefinition" | "productMetafield">,
  shop: string,
  plan: Plan,
): Promise<Record<BulkRowType, ColumnDescriptor[]>> {
  const caps = productColumnCapsForPlan(plan);
  const metafieldSpecs = caps.metafields ? await loadProductMetafieldColumnSpecs(db, shop) : [];
  const byType = {} as Record<BulkRowType, ColumnDescriptor[]>;
  for (const type of BULK_ROW_TYPES) {
    byType[type] = buildColumnsForType(type, metafieldSpecs, caps);
  }
  return byType;
}
