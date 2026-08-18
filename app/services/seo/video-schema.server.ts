/**
 * Writing the product-video upload dates to Shopify.
 *
 * The map built in video-schema.shared.ts has to reach the STOREFRONT, and a
 * product metafield is the only channel Liquid can read. This module owns that
 * write, and it is diff-driven: `Product.videoSchemaJson` mirrors what was last
 * pushed, so a shop whose videos did not change costs zero Shopify calls no
 * matter how often it syncs.
 *
 * Three rules from the codebase apply verbatim:
 *  - `metafieldsSet` with `""` is rejected; a product that lost its last video
 *    is cleared with `metafieldsDelete` (CLAUDE.md).
 *  - `type` is always sent — required when creating without a definition.
 *  - The echo decides: an empty `userErrors` is not proof anything was stored,
 *    so the mirror is only written for the identifiers Shopify echoed back.
 *    Without that, a silent no-op would mark the product as done forever.
 *
 * Never throws: every caller is a sync path whose real job is the catalog.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { METAFIELDS_SET, METAFIELDS_DELETE } from "../../graphql/content.mutations";
import { logger } from "../../utils/logger.server";
import {
  VIDEO_SCHEMA_KEY,
  VIDEO_SCHEMA_NAMESPACE,
  VIDEO_SCHEMA_TYPE,
  serializeVideoUploadDates,
  videoSchemaChanged,
  type VideoUploadDates,
} from "./video-schema.shared";

/** Shopify's cap for one metafieldsSet call. */
export const VIDEO_SCHEMA_CHUNK = 25;

export interface VideoSchemaUpdate {
  /** Product GID — the metafield owner. */
  productId: string;
  /** Freshly built map; `{}` means "this product has no videos any more". */
  uploadDates: VideoUploadDates;
}

export interface VideoSchemaResult {
  written: number;
  cleared: number;
  failed: number;
  /** Products whose value already matched the mirror — no Shopify call made. */
  unchanged: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Persist the video upload dates for a batch of products.
 *
 * `db` is the Prisma client (or a transaction) used for the mirror; it is read
 * for the previous value and written only after Shopify confirms.
 */
export async function persistVideoSchema(
  admin: AdminApiContext,
  db: any,
  updates: VideoSchemaUpdate[],
): Promise<VideoSchemaResult> {
  const result: VideoSchemaResult = { written: 0, cleared: 0, failed: 0, unchanged: 0 };
  if (updates.length === 0) return result;

  try {
    const rows: Array<{ id: string; videoSchemaJson: string | null }> = await db.product.findMany({
      where: { id: { in: updates.map((u) => u.productId) } },
      select: { id: true, videoSchemaJson: true },
    });
    const stored = new Map(rows.map((r) => [r.id, r.videoSchemaJson]));

    const toSet: Array<{ productId: string; json: string }> = [];
    const toClear: string[] = [];

    for (const update of updates) {
      // A product the cache does not know yet cannot be mirrored — its row is
      // written by the same sync pass, so skipping here just defers the
      // metafield to the next run rather than writing one we cannot track.
      if (!stored.has(update.productId)) continue;
      const next = serializeVideoUploadDates(update.uploadDates);
      if (!videoSchemaChanged(stored.get(update.productId), next)) {
        result.unchanged++;
        continue;
      }
      if (next === null) toClear.push(update.productId);
      else toSet.push({ productId: update.productId, json: next });
    }

    for (const batch of chunk(toSet, VIDEO_SCHEMA_CHUNK)) {
      const confirmed = await setBatch(admin, batch);
      for (const entry of batch) {
        if (!confirmed.has(entry.productId)) {
          result.failed++;
          continue;
        }
        await db.product
          .update({ where: { id: entry.productId }, data: { videoSchemaJson: entry.json } })
          .catch(() => {});
        result.written++;
      }
    }

    for (const batch of chunk(toClear, VIDEO_SCHEMA_CHUNK)) {
      const confirmed = await clearBatch(admin, batch);
      for (const productId of batch) {
        if (!confirmed.has(productId)) {
          result.failed++;
          continue;
        }
        await db.product
          .update({ where: { id: productId }, data: { videoSchemaJson: null } })
          .catch(() => {});
        result.cleared++;
      }
    }
  } catch (err) {
    logger.warn("[VideoSchema] Failed to persist video upload dates", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/** Owner ids Shopify echoed back as written. */
async function setBatch(
  admin: AdminApiContext,
  batch: Array<{ productId: string; json: string }>,
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  try {
    const res = await admin.graphql(METAFIELDS_SET, {
      variables: {
        metafields: batch.map((entry) => ({
          ownerId: entry.productId,
          namespace: VIDEO_SCHEMA_NAMESPACE,
          key: VIDEO_SCHEMA_KEY,
          type: VIDEO_SCHEMA_TYPE,
          value: entry.json,
        })),
      },
    });
    const body: any = await res.json();
    const errors = body?.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length > 0) {
      logger.warn("[VideoSchema] metafieldsSet userErrors", {
        error: errors.map((e: any) => e?.message).join("; "),
      });
    }
    // The echo carries the metafield, not its owner, so a written entry is
    // recognised by its value — unique per product within this batch.
    const written: any[] = body?.data?.metafieldsSet?.metafields ?? [];
    const byValue = new Map(written.map((m: any) => [String(m?.value ?? ""), true]));
    for (const entry of batch) if (byValue.has(entry.json)) confirmed.add(entry.productId);
  } catch (err) {
    logger.warn("[VideoSchema] metafieldsSet failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return confirmed;
}

/** Owner ids Shopify echoed back as deleted. Deleting a missing metafield is a no-op. */
async function clearBatch(admin: AdminApiContext, productIds: string[]): Promise<Set<string>> {
  const confirmed = new Set<string>();
  try {
    const res = await admin.graphql(METAFIELDS_DELETE, {
      variables: {
        metafields: productIds.map((ownerId) => ({
          ownerId,
          namespace: VIDEO_SCHEMA_NAMESPACE,
          key: VIDEO_SCHEMA_KEY,
        })),
      },
    });
    const body: any = await res.json();
    const errors = body?.data?.metafieldsDelete?.userErrors ?? [];
    if (errors.length > 0) {
      logger.warn("[VideoSchema] metafieldsDelete userErrors", {
        error: errors.map((e: any) => e?.message).join("; "),
      });
    }
    const deleted: any[] = body?.data?.metafieldsDelete?.deletedMetafields ?? [];
    const deletedOwners = new Set(deleted.map((d: any) => String(d?.ownerId ?? "")));
    for (const ownerId of productIds) {
      // Shopify reports nothing for an owner that had no metafield — which is
      // exactly the state we want, so an absent echo counts as cleared only
      // when there were no userErrors at all.
      if (deletedOwners.has(ownerId) || errors.length === 0) confirmed.add(ownerId);
    }
  } catch (err) {
    logger.warn("[VideoSchema] metafieldsDelete failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return confirmed;
}
