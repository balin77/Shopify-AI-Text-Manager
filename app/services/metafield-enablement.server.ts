/**
 * Helpers around EnabledMetafieldDefinition — the per-shop set of product
 * metafield definitions enabled for the ContentPilot translation pipeline.
 *
 * Used by the settings tab (read/write) and by the product/settings loaders
 * (gating which metafields show in the editor + one-time lazy backfill).
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "@prisma/client";
import { ContentService } from "./content.service";
import { categorizeMetafieldOwner, type MetafieldOwnerCategory } from "../config/known-third-party-apps";
import { logger } from "~/utils/logger.server";

/** Metafield types we treat as translatable text in the editor. */
export const TRANSLATABLE_METAFIELD_TYPES = [
  "single_line_text_field",
  "multi_line_text_field",
  "rich_text_field",
  "list.single_line_text_field",
];

/** Cap on per-key translatability probes per scan (distinct keys are usually few). */
const MAX_PROBES = 80;

/**
 * A product metafield surfaced by the data-driven scanner. Unlike a raw
 * definition, this is keyed on the actual metafields present on products, so it
 * also surfaces third-party / definition-less metafields (Google, Judge.me).
 */
export interface ScannedMetafield {
  /** Definition GID when one exists, else a synthetic `namespace.key` id. */
  id: string;
  namespace: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  /** Already translatable (public definition OR confirmed via probe). */
  translatable: boolean;
  ownerCategory: MetafieldOwnerCategory;
  appName?: string;
  /** Whether a metafield definition exists (false ⇒ enabling must create one). */
  hasDefinition: boolean;
}

/** Build the `namespace.key` key used to match metafields against enabled defs. */
export function metafieldEnableKey(namespace: string, key: string): string {
  return `${namespace}.${key}`;
}

/**
 * THE editor-visibility predicate for product metafields: translatable text
 * type AND enabled by the merchant in the settings tab. Shared by the product
 * editor loader (app.products.tsx) and the bulk editor's column source
 * (bulk-editor/columns.server.ts) — the two surfaces MUST show the same
 * fields, so neither may invent its own filter (Plan §4.1).
 */
export function isEditableProductMetafield(
  mf: { namespace: string; key: string; type: string },
  enabledKeys: Set<string>,
): boolean {
  return (
    TRANSLATABLE_METAFIELD_TYPES.includes(mf.type) &&
    enabledKeys.has(metafieldEnableKey(mf.namespace, mf.key))
  );
}

/**
 * Data-driven scan of a shop's product metafields.
 *
 * Sources the candidate list from the ACTUAL metafields present on products
 * (synced into ProductMetafield) UNIONed with merchant-visible definitions —
 * not from `metafieldDefinitions` alone, which omits app-owned and
 * definition-less metafields (so Google/Judge.me never showed). For each
 * candidate not already known translatable via a public definition, probes
 * `translatableResource` on a sample metafield to get the definitive
 * translatability signal (works even for app-owned definitions we can't read).
 */
export async function scanProductMetafields(
  admin: AdminApiContext,
  db: Pick<PrismaClient, "productMetafield">,
  shop: string,
): Promise<ScannedMetafield[]> {
  const service = new ContentService(admin);

  type Cand = {
    namespace: string;
    key: string;
    type: string;
    name: string;
    description: string | null;
    defId?: string;
    defPublic: boolean;
    hasDefinition: boolean;
    sampleGid?: string;
  };
  const cands = new Map<string, Cand>();

  // 1. Merchant-visible definitions (gives storefront access + nice names).
  const defs = await service.getProductMetafieldDefinitions();
  for (const d of defs) {
    if (!TRANSLATABLE_METAFIELD_TYPES.includes(d.type)) continue;
    cands.set(metafieldEnableKey(d.namespace, d.key), {
      namespace: d.namespace,
      key: d.key,
      type: d.type,
      name: d.name,
      description: d.description,
      defId: d.id,
      defPublic: d.translatable,
      hasDefinition: true,
    });
  }

  // 2. Actual metafields present on products (distinct namespace.key + sample).
  const rows = await db.productMetafield.findMany({
    where: { product: { shop } },
    distinct: ["namespace", "key"],
    select: { id: true, namespace: true, key: true, type: true },
  });
  for (const r of rows) {
    if (!TRANSLATABLE_METAFIELD_TYPES.includes(r.type)) continue;
    const k = metafieldEnableKey(r.namespace, r.key);
    const existing = cands.get(k);
    if (existing) {
      existing.sampleGid = r.id; // attach a real metafield GID for probing
    } else {
      cands.set(k, {
        namespace: r.namespace,
        key: r.key,
        type: r.type,
        name: r.key,
        description: null,
        defPublic: false,
        hasDefinition: false,
        sampleGid: r.id,
      });
    }
  }

  // 3. Probe translatability for candidates not already public-by-definition.
  const toProbe = [...cands.values()].filter((c) => !c.defPublic && c.sampleGid).slice(0, MAX_PROBES);
  const probed = new Map<string, boolean>();
  const batchSize = 10;
  for (let i = 0; i < toProbe.length; i += batchSize) {
    const batch = toProbe.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((c) => service.isMetafieldTranslatable(c.sampleGid!)));
    results.forEach((res, idx) => {
      if (res.status === "fulfilled") {
        probed.set(metafieldEnableKey(batch[idx].namespace, batch[idx].key), res.value);
      }
    });
  }

  // 4. Classify.
  return [...cands.values()]
    .map((c): ScannedMetafield => {
      const owner = categorizeMetafieldOwner(c.namespace);
      const k = metafieldEnableKey(c.namespace, c.key);
      const translatable = c.defPublic || probed.get(k) === true;
      return {
        id: c.defId ?? k,
        namespace: c.namespace,
        key: c.key,
        name: c.name,
        description: c.description,
        type: c.type,
        translatable,
        ownerCategory: owner.category,
        appName: owner.appName,
        hasDefinition: c.hasDefinition,
      };
    })
    .sort((a, b) =>
      metafieldEnableKey(a.namespace, a.key).localeCompare(metafieldEnableKey(b.namespace, b.key)),
    );
}

/**
 * Return the set of `namespace.key` strings the shop has enabled for product
 * metafield translation. The product loader intersects this with the
 * translatable text-type metafields to decide editor visibility.
 */
export async function getEnabledMetafieldKeySet(
  db: Pick<PrismaClient, "enabledMetafieldDefinition">,
  shop: string,
): Promise<Set<string>> {
  const rows = await db.enabledMetafieldDefinition.findMany({
    where: { shop, ownerType: "PRODUCT" },
    select: { namespace: true, key: true },
  });
  return new Set(rows.map((r) => metafieldEnableKey(r.namespace, r.key)));
}

/**
 * One-time lazy backfill for existing merchants.
 *
 * Editor visibility now requires an EnabledMetafieldDefinition row (decided
 * design point 1). Without a backfill, every existing shop's product editor
 * would lose its already-translatable metafields the day this ships. So the
 * FIRST time a shop hits a loader after deploy (guarded by
 * AISettings.metafieldsLastScanAt being null), we run the data-driven scan and
 * enable every metafield that is already translatable — including app-owned
 * ones like Judge.me (patchedTranslatable:false — we did not change Shopify
 * state).
 *
 * Idempotent: the metafieldsLastScanAt timestamp is set even when zero
 * definitions are translatable, so a shop with no translatable metafields does
 * not re-scan on every load. Safe to call from multiple loaders.
 *
 * Resilience: this runs in the products loader, which fires on EVERY navigation
 * and prefetch. A per-process in-memory guard ensures we attempt the backfill
 * at most once per shop per process — so a persistently failing scan (e.g. a
 * Shopify API/schema error) cannot spam the logs or add a failing round-trip to
 * every page load. The guard is set BEFORE the await, which also collapses
 * concurrent loaders for the same shop into a single scan. A process restart
 * (deploy) clears it, and the manual "Scan now" button is a separate path.
 */
const backfillAttempted = new Set<string>();

export async function backfillEnabledMetafieldDefinitionsIfNeeded(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
): Promise<void> {
  if (backfillAttempted.has(shop)) return;
  try {
    const settings = await db.aISettings.findUnique({
      where: { shop },
      select: { metafieldsLastScanAt: true },
    });

    // Already scanned/backfilled once → nothing to do.
    if (settings?.metafieldsLastScanAt) {
      backfillAttempted.add(shop);
      return;
    }

    // Mark attempted up front so concurrent loaders and subsequent requests in
    // this process don't re-run (even if the scan below throws).
    backfillAttempted.add(shop);

    const scanned = await scanProductMetafields(admin, db, shop);
    const translatable = scanned.filter((d) => d.translatable);

    await db.$transaction(async (tx) => {
      for (const def of translatable) {
        await tx.enabledMetafieldDefinition.upsert({
          where: { shop_definitionId: { shop, definitionId: def.id } },
          create: {
            shop,
            definitionId: def.id,
            namespace: def.namespace,
            key: def.key,
            ownerType: "PRODUCT",
            patchedTranslatable: false,
          },
          update: {},
        });
      }
      // Mark scanned regardless of count so the guard never re-runs.
      await tx.aISettings.upsert({
        where: { shop },
        create: { shop, metafieldsLastScanAt: new Date() },
        update: { metafieldsLastScanAt: new Date() },
      });
    });

    logger.info(
      `[Metafields] Backfilled ${translatable.length} translatable product metafields`,
      { context: "MetafieldEnablement", shop },
    );
  } catch (error) {
    // Backfill is best-effort — never block a page load on it.
    logger.error("[Metafields] Backfill failed", {
      context: "MetafieldEnablement",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
