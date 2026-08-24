/**
 * Auto-translation for the bulk editor's own saves.
 *
 * The single editor already answers "the primary text moved, now what?" the
 * same way everywhere: with `autoTranslateExternalChanges` on, the save hands
 * the change to `reconcileAfterPrimarySave` instead of deleting the stale
 * translations. The bulk editor only did that for PRODUCT and COLLECTION rows,
 * and not even itself — their `products/update` / `collections/update` webhook
 * does it. Every other row type, every sub-resource cell, every alt text and
 * every metaobject field was DELETED, so one merchant with one switch got two
 * opposite behaviours out of one grid depending on which column they typed in.
 *
 * This module is the collection side of closing that. The persist paths call
 * `collectBulkRepair` where they would otherwise purge; `flushBulkRepairs`
 * turns what was collected into repair calls once, at the end of the save.
 *
 * Three rules shape it, and each is a cost the single editor never has to pay:
 *
 * 1. ONE GROUP PER (row, surface) — the same grouping the single editor uses,
 *    never one per cell. A product whose title, three metafields and two alt
 *    texts changed is three groups (content, sub-resources, alt texts), which
 *    is three Task rows and three AI requests per locale: exactly what the same
 *    edit made one product at a time would cost.
 *
 * 2. A CAP on the number of groups (`MAX_REPAIR_GROUPS`). A save may carry 500
 *    cells over hundreds of rows, and every group is an unattended, detached AI
 *    run on the merchant's own API key. Past the cap nothing is collected: the
 *    surface falls back to the merchant's stored deletion answer, exactly as it
 *    behaved before this module existed, and the overflow is REPORTED rather
 *    than silently dropped.
 *
 * 3. PRODUCT and COLLECTION content rows are the webhook's, not ours —
 *    starting a run here would queue a duplicate behind a repair that has
 *    already happened (`retranslationsInFlight` queues, it never drops). The
 *    ONE exception is a row this save also CLAIMED: a foreign content write
 *    marks the row (`markTranslationSaved`), and `reconcileStaleTranslations`
 *    bails wholesale on that mark for 30 seconds — so the webhook arriving from
 *    this very save does nothing, and with the purge off the row's other
 *    locales would stay stale for good. Where we blocked the webhook, we owe
 *    the repair.
 */

import type { PrismaClient } from "@prisma/client";
import type { ShopifyApiGateway } from "../shopify-api-gateway.service";
import type { BulkRowType } from "./columns.shared";
import { CONTENT_RESOURCE_TYPE_BY_ROW_TYPE } from "./translations.server";
import type { TranslationChangePolicy } from "../translations/translation-change-policy.server";
import {
  altTextLockId,
  featuredAltLockId,
  subResourceLockId,
} from "../translations/translation-locks.shared";
import { logger } from "../../utils/logger.server";

/**
 * How many repair groups ONE save may start.
 *
 * Deliberately the same number as `MAX_SYNC_SAVE`, the cell count this app
 * already treats as "a save small enough to run inside the request": a merchant
 * who can picture 25 cells can picture 25 background translations. Past it the
 * work is not refused — it follows the stored deletion answer, which is what
 * the same save did before auto-translate reached the bulk editor at all.
 */
export const MAX_REPAIR_GROUPS = 25;

/** Which repair a group belongs to — the mirror and the lock follow from it. */
export type BulkRepairSurface =
  | "content"
  | "metaobject"
  | "subResource"
  | "productImageAlt"
  | "libraryImageAlt"
  | "featuredAlt";

export interface BulkRepairEntry {
  /** The Shopify translatable resource the register/removal addresses. */
  resourceId: string;
  resourceType: string;
  key: string;
  /** `false` = remove rather than re-translate (see StaleTranslation). */
  retranslatable?: boolean;
}

export interface BulkRepairGroup {
  surface: BulkRepairSurface;
  /** The row the Task names: a product, a collection, a metaobject entry. */
  ownerId: string;
  rowType: BulkRowType;
  entries: BulkRepairEntry[];
  /** productImageAlt only: MediaImage GID to ProductImage cache row id. */
  imageIdByMedia?: Map<string, string>;
}

export interface BulkRepairPlan {
  groups: Map<string, BulkRepairGroup>;
  /** Groups the cap refused — reported, never silently dropped. */
  overflow: number;
  /**
   * Rows a foreign CONTENT write claimed in this save. Only these make a
   * product/collection content group ours to repair (rule 3 above).
   */
  claimedRows: Set<string>;
}

export function newBulkRepairPlan(): BulkRepairPlan {
  return { groups: new Map(), overflow: 0, claimedRows: new Set() };
}

const KEY_SEP = "|";

function groupKey(surface: BulkRepairSurface, ownerId: string): string {
  return `${surface}${KEY_SEP}${ownerId}`;
}

/**
 * Record a surface whose primary text this save changed, for repair instead of
 * deletion. Returns FALSE when the caller must fall back to its own purge —
 * the cap is reached, or there was nothing to record.
 */
export function collectBulkRepair(
  plan: BulkRepairPlan,
  args: {
    surface: BulkRepairSurface;
    ownerId: string;
    rowType: BulkRowType;
    entries: BulkRepairEntry[];
    imageIdByMedia?: ReadonlyMap<string, string>;
  },
): boolean {
  if (args.entries.length === 0) return false;
  const key = groupKey(args.surface, args.ownerId);
  let group = plan.groups.get(key);
  if (!group) {
    // The cap counts GROUPS and is checked before a new one is opened: adding
    // entries to a group that already exists costs no extra run.
    if (plan.groups.size >= MAX_REPAIR_GROUPS) {
      plan.overflow++;
      return false;
    }
    group = {
      surface: args.surface,
      ownerId: args.ownerId,
      rowType: args.rowType,
      entries: [],
      ...(args.imageIdByMedia ? { imageIdByMedia: new Map(args.imageIdByMedia) } : {}),
    };
    plan.groups.set(key, group);
  }
  const seen = new Set(group.entries.map((entry) => `${entry.resourceId}${KEY_SEP}${entry.key}`));
  for (const entry of args.entries) {
    const id = `${entry.resourceId}${KEY_SEP}${entry.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    group.entries.push(entry);
  }
  if (args.imageIdByMedia && group.imageIdByMedia) {
    for (const [media, imageId] of args.imageIdByMedia) group.imageIdByMedia.set(media, imageId);
  }
  return true;
}

/**
 * Drop the content groups of the two webhook-backed row types that this save
 * did NOT claim — the webhook repairs those, and a second run would queue a
 * duplicate behind it (rule 3). Called once, before the flush, because a row is
 * claimed by its FOREIGN group while the candidate comes from its PRIMARY one
 * and the two are persisted in whatever order the client sent them.
 */
export function dropWebhookOwnedGroups(plan: BulkRepairPlan): number {
  let dropped = 0;
  for (const [key, group] of plan.groups) {
    if (group.surface !== "content") continue;
    if (group.rowType !== "product" && group.rowType !== "collection") continue;
    if (plan.claimedRows.has(group.ownerId)) continue;
    plan.groups.delete(key);
    dropped++;
  }
  return dropped;
}

/** The merchant-facing kind the AI prompt and the Tasks tab speak. */
function contentKindFor(rowType: BulkRowType): "product" | "collection" | "blog" | "page" {
  if (rowType === "product") return "product";
  if (rowType === "collection") return "collection";
  if (rowType === "article" || rowType === "blog") return "blog";
  return "page";
}

/** Row titles for the Task rows, one query per row type present. */
async function loadOwnerTitles(
  db: PrismaClient,
  shop: string,
  byType: Map<BulkRowType, string[]>,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (const [rowType, ids] of byType) {
    if (ids.length === 0) continue;
    try {
      const where = { shop, id: { in: ids } };
      const select = { id: true, title: true } as const;
      switch (rowType) {
        case "product":
          for (const row of await db.product.findMany({ where, select })) titles.set(row.id, row.title);
          break;
        case "collection":
          for (const row of await db.collection.findMany({ where, select })) titles.set(row.id, row.title);
          break;
        case "article":
          for (const row of await db.article.findMany({ where, select })) titles.set(row.id, row.title);
          break;
        case "page":
          for (const row of await db.page.findMany({ where, select })) titles.set(row.id, row.title);
          break;
        // No `blog` case: this app keeps no Blog model (CLAUDE.md — the bulk
        // editor's blog rows come from a DISTINCT over the article cache), so a
        // blog group's Task row is named by its GID.
        case "metaobject":
          for (const row of await db.metaobject.findMany({
            where,
            select: { id: true, displayName: true, type: true },
          })) {
            titles.set(row.id, row.displayName || row.type);
          }
          break;
        default:
          break;
      }
    } catch (error: unknown) {
      // A Task row named by its GID is ugly; a save that fails over a label is
      // worse. Every primary write has already happened by the time this runs.
      logger.warn("[BULK] Could not load repair task titles", {
        context: "Bulk",
        rowType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return titles;
}

/**
 * Hand every collected group to the shared repair. Never throws: the primary
 * writes have already succeeded, and a repair that could not start must not
 * turn a saved row into a failed one.
 */
export async function flushBulkRepairs(params: {
  db: PrismaClient;
  shop: string;
  gateway: ShopifyApiGateway;
  foreignLocales: readonly string[];
  /**
   * The shop's primary locale — the source language of every value prompt.
   * Without it a `translateAs` group has nothing to translate FROM, so it falls
   * back to the deletion rather than leaving the stale text live. The same rule
   * the metaobject editor's repair follows.
   */
  primaryLocale?: string;
  policy: TranslationChangePolicy;
  plan: BulkRepairPlan;
}): Promise<{ started: number; skipped: number }> {
  const { db, shop, gateway, foreignLocales, primaryLocale, policy, plan } = params;
  if (plan.groups.size === 0) return { started: 0, skipped: 0 };

  const {
    reconcileAfterPrimarySave,
    contentTranslationMirror,
    metaobjectTranslationMirror,
    productImageAltMirror,
    featuredImageAltMirror,
  } = await import("../translations/stale-translation-sync.server");

  const byType = new Map<BulkRowType, string[]>();
  for (const group of plan.groups.values()) {
    const list = byType.get(group.rowType) ?? [];
    list.push(group.ownerId);
    byType.set(group.rowType, list);
  }
  const titles = await loadOwnerTitles(db, shop, byType);

  let started = 0;
  let skipped = 0;
  for (const group of plan.groups.values()) {
    const resourceTitle = titles.get(group.ownerId) || group.ownerId;
    const contentKind = contentKindFor(group.rowType);
    const valuePrompt = (context: string) =>
      primaryLocale ? { kind: "values" as const, context, sourceLocale: primaryLocale } : null;

    try {
      switch (group.surface) {
        case "content": {
          await reconcileAfterPrimarySave({
            client: gateway,
            shop,
            resourceId: group.ownerId,
            resourceType: CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[group.rowType],
            contentKind,
            resourceTitle,
            changed: group.entries,
            foreignLocales,
            policy,
            mirror: contentTranslationMirror(shop),
          });
          started++;
          break;
        }
        case "metaobject": {
          const prompt = valuePrompt("metaobject field values");
          if (!prompt) {
            skipped++;
            break;
          }
          const typeById = new Map<string, string>();
          for (const entry of group.entries) typeById.set(entry.resourceId, "");
          for (const row of await db.metaobject.findMany({
            where: { shop, id: { in: [...typeById.keys()] } },
            select: { id: true, type: true },
          })) {
            typeById.set(row.id, row.type);
          }
          await reconcileAfterPrimarySave({
            client: gateway,
            shop,
            resourceId: group.ownerId,
            resourceType: "Metaobject",
            // The AI prompt comes from `translateAs`, so this only decides the
            // Task label — and `taskResourceType` keeps a metaobject OUT of the
            // admin-path map, which would otherwise offer /admin/pages/<id>.
            contentKind: "page",
            taskResourceType: "metaobject",
            resourceTitle,
            changed: group.entries,
            foreignLocales,
            policy,
            mirror: metaobjectTranslationMirror(shop, typeById),
            translateAs: prompt,
          });
          started++;
          break;
        }
        case "subResource": {
          const prompt = valuePrompt("product option and metafield values");
          if (!prompt) {
            skipped++;
            break;
          }
          await reconcileAfterPrimarySave({
            client: gateway,
            shop,
            resourceId: group.ownerId,
            resourceType: "Product",
            // A product carries several independent repairs; claiming the
            // product itself would make its own webhook reconciliation bail.
            lockId: subResourceLockId(group.ownerId),
            contentKind: "product",
            resourceTitle,
            changed: group.entries,
            foreignLocales,
            policy,
            mirror: contentTranslationMirror(shop),
            translateAs: prompt,
          });
          started++;
          break;
        }
        case "productImageAlt": {
          const prompt = valuePrompt("product image alt texts");
          if (!prompt || !group.imageIdByMedia || group.imageIdByMedia.size === 0) {
            skipped++;
            break;
          }
          await reconcileAfterPrimarySave({
            client: gateway,
            shop,
            resourceId: group.ownerId,
            resourceType: "Product",
            lockId: altTextLockId(group.ownerId),
            contentKind: "product",
            resourceTitle,
            changed: group.entries,
            foreignLocales,
            policy,
            mirror: productImageAltMirror(group.imageIdByMedia),
            translateAs: prompt,
          });
          started++;
          break;
        }
        case "libraryImageAlt": {
          // An image that is not product media has no ProductImage row: its
          // mirror is the generic ContentTranslation table under resourceType
          // "MediaImage", the same split the write path makes. It has no owning
          // product either, so the media GID is its own lock.
          const prompt = valuePrompt("image alt texts");
          if (!prompt) {
            skipped++;
            break;
          }
          await reconcileAfterPrimarySave({
            client: gateway,
            shop,
            resourceId: group.ownerId,
            resourceType: "MediaImage",
            contentKind: "product",
            resourceTitle,
            changed: group.entries,
            foreignLocales,
            policy,
            mirror: contentTranslationMirror(shop),
            translateAs: prompt,
          });
          started++;
          break;
        }
        case "featuredAlt": {
          const prompt = valuePrompt("image alt texts");
          if (!prompt) {
            skipped++;
            break;
          }
          await reconcileAfterPrimarySave({
            client: gateway,
            shop,
            resourceId: group.ownerId,
            resourceType: CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[group.rowType],
            // The featured alt is its own surface: the parent's lock belongs to
            // that resource's CONTENT repair, which an article save runs on the
            // same id.
            lockId: featuredAltLockId(group.ownerId),
            contentKind,
            resourceTitle,
            changed: group.entries,
            foreignLocales,
            policy,
            mirror: featuredImageAltMirror(
              shop,
              group.ownerId,
              CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[group.rowType],
            ),
            translateAs: prompt,
          });
          started++;
          break;
        }
      }
    } catch (error: unknown) {
      skipped++;
      logger.warn("[BULK] Auto-translation repair could not start — stale rows kept", {
        context: "Bulk",
        surface: group.surface,
        ownerId: group.ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (started > 0 || skipped > 0 || plan.overflow > 0) {
    logger.info("[BULK] Auto-translation repairs", {
      context: "Bulk",
      shop,
      started,
      skipped,
      overflow: plan.overflow,
    });
  }
  return { started, skipped };
}
