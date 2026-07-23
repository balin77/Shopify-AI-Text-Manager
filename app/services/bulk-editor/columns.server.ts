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
  isEditableMetaobjectFieldType,
  METAFIELD_TYPE_RICH_TEXT,
  BULK_ROW_TYPES,
  BULK_ROW_TYPE_TO_CONTENT_TYPE,
  type BulkRowType,
  type ColumnDescriptor,
  type MetafieldColumnSpec,
  type MetaobjectColumnSpec,
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

/**
 * The shop's metaobject columns (Phase 5, Plan §7): one spec per field of
 * every synced MetaobjectDefinition, restricted to text-like types (plus
 * rich_text, which becomes a read-only column). Sorted by (type, definition
 * order) so the grid shows a definition's fields in their authored order.
 */
export async function loadMetaobjectColumnSpecs(
  db: Pick<PrismaClient, "metaobjectDefinition">,
  shop: string,
): Promise<MetaobjectColumnSpec[]> {
  const definitions = await db.metaobjectDefinition.findMany({
    where: { shop },
    select: { type: true, fieldDefinitions: true },
    orderBy: { type: "asc" },
  });

  const specs: MetaobjectColumnSpec[] = [];
  for (const def of definitions) {
    // fieldDefinitions JSON shape from metaobject-sync.service.ts:
    // Array<{ key, name, type: { name } }>. Defensive parse — a malformed
    // row yields no columns for that definition, never a crash.
    const fields = Array.isArray(def.fieldDefinitions) ? def.fieldDefinitions : [];
    for (const raw of fields) {
      if (!raw || typeof raw !== "object") continue;
      const field = raw as { key?: unknown; name?: unknown; type?: { name?: unknown } | null };
      const key = typeof field.key === "string" ? field.key : "";
      const fieldType = typeof field.type?.name === "string" ? field.type.name : "";
      if (!key || !fieldType) continue;
      if (!isEditableMetaobjectFieldType(fieldType) && fieldType !== METAFIELD_TYPE_RICH_TEXT) continue;
      specs.push({
        type: def.type,
        fieldKey: key,
        fieldType,
        name: typeof field.name === "string" ? field.name : key,
      });
    }
  }
  return specs;
}

/** The full, trustworthy column universe per row type for this shop + plan —
 * the validation allowlist for both save entrances and the descriptor source
 * for applyBulkDiff. Metaobject columns are the UNION over all definitions
 * (Plan §7) — the toolbar's type filter narrows rendering, not validity. */
export async function buildServerColumnsByType(
  db: Pick<PrismaClient, "enabledMetafieldDefinition" | "productMetafield" | "metaobjectDefinition">,
  shop: string,
  plan: Plan,
): Promise<Record<BulkRowType, ColumnDescriptor[]>> {
  const caps = productColumnCapsForPlan(plan);
  const metafieldSpecs = caps.metafields ? await loadProductMetafieldColumnSpecs(db, shop) : [];
  // Only load definitions when the plan can see metaobject rows at all
  // (§10.7) — allowedRowTypesForPlan is the same gate the entrances apply.
  const metaobjectSpecs = allowedRowTypesForPlan(plan).includes("metaobject")
    ? await loadMetaobjectColumnSpecs(db, shop)
    : [];
  const byType = {} as Record<BulkRowType, ColumnDescriptor[]>;
  for (const type of BULK_ROW_TYPES) {
    byType[type] = buildColumnsForType(type, metafieldSpecs, caps, metaobjectSpecs);
  }
  return byType;
}
