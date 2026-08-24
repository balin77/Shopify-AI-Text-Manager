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
 * Six rules shape it, and each is a cost the single editor never has to pay:
 *
 * 1. ONE GROUP PER (row, surface) — the same grouping the single editor uses,
 *    never one per cell. A product whose title, three metafields and two alt
 *    texts changed is three groups (content, sub-resources, alt texts), which is
 *    one Task row and one AI request per locale each: exactly what the same edit
 *    made one product at a time would cost.
 *
 * 2. A CAP on the number of groups (`MAX_REPAIR_GROUPS`). A save may carry 500
 *    cells over hundreds of rows, and every group is an unattended, detached AI
 *    run on the merchant's own API key. Past the cap nothing is collected and
 *    the surface falls back to the merchant's stored deletion answer, exactly as
 *    it behaved before this module existed — REPORTED rather than silently
 *    dropped.
 *
 * 3. PRODUCT and COLLECTION content rows are collected like every other surface.
 *    They were the webhook's for one release, on the argument that a run started
 *    here would queue a duplicate behind a repair that has already happened. It
 *    does not happen: the sync-side gate proves a change by comparing digests
 *    stored ON TRANSLATION ROWS, so a row nobody ever translated has no baseline
 *    and its webhook can prove nothing — which is exactly the row a merchant
 *    switches the feature on for. The duplicate is prevented by the CLAIM
 *    instead: the repair marks the row before it starts and
 *    `reconcileStaleTranslations` bails wholesale on that mark, so the webhook
 *    arriving from this very save stands down.
 *
 * 4. WHAT THE SAVE WROTE goes in as `alreadyWritten` and lands in neither list:
 *    a row whose foreign value the merchant may have typed in the SAME save is
 *    ours to repair, and re-translating over it is the one thing we must not do.
 *    GLOBAL layer only — a market override is not a value the repair could
 *    overwrite, and recording one silences it for a global translation nobody
 *    touched.
 *
 * 5. A GROUP IS NOT PRE-CHECKED against its mirror any more. It used to be —
 *    one DB query, and an empty answer skipped the group before a single
 *    Shopify call, which kept this path's reach where the deletion it replaces
 *    had it. That is precisely what made "translate automatically" mean
 *    "refresh what is already there": a row whose translations were still empty
 *    stayed empty after every primary edit, on every surface this module
 *    covers. The repair FILLS now, so the first translation is the one thing
 *    the pre-check must not stand in front of — and it no longer buys anything
 *    either, since the repair asks Shopify per locale only when a removal is on
 *    the table.
 *
 * 6. NOTHING HERE MAY FAIL THE SAVE: every row is already written by the time
 *    this runs, so a repair that cannot start logs and leaves the stale rows.
 */

import type { PrismaClient } from "@prisma/client";
import type { ShopifyApiGateway } from "../shopify-api-gateway.service";
import type { BulkRowType } from "./columns.shared";
import { CONTENT_RESOURCE_TYPE_BY_ROW_TYPE } from "./translations.server";
import type { TranslationChangePolicy } from "../translations/translation-change-policy.server";
// TYPE only: the module itself is imported dynamically inside the flush, so
// nothing here pulls the repair (and its AI stack) into a caller that only
// collects.
import type { TranslationMirror } from "../translations/stale-translation-sync.server";
import {
  altTextLockId,
  featuredAltLockId,
  subResourceLockId,
} from "../translations/translation-locks.shared";
import { marketOverrideKey } from "../translations/market-layer-purge.server";
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
  /** Group KEYS the cap refused — reported, never silently dropped. Keys, not
   *  calls: ten metafields of one product past the cap are ONE refused group. */
  overflow: Set<string>;
  /** The ROWS behind those groups. A product that overflows on its content,
   *  its sub-resources and its alt texts is three groups and ONE row, and the
   *  merchant is told about rows. */
  overflowRows: Set<string>;
  /**
   * Every FOREIGN translation this save wrote itself, as (resource, locale,
   * key). Handed to the repair as `alreadyWritten`, which leaves them in
   * neither list — re-translating a value the merchant typed in this very save
   * is the one thing rule 3's exception must not do.
   */
  claimedWrites: Array<{ resourceId: string; locale: string; key: string }>;
  /**
   * Every MARKET-layer translation this save wrote, as `marketOverrideKey`.
   *
   * The market purge and the market write are two halves of one save and the
   * client decides which row group persists first. Without this, a merchant who
   * edits a row's primary text AND one market's translation of it in the same
   * save loses the second whenever the market group happened to go first — and
   * on that layer nothing ever recreates it.
   */
  marketWrites: Set<string>;
}

export function newBulkRepairPlan(): BulkRepairPlan {
  return {
    groups: new Map(),
    overflow: new Set(),
    overflowRows: new Set(),
    claimedWrites: [],
    marketWrites: new Set(),
  };
}

/** Record a foreign translation this save wrote — see `claimedWrites`. */
export function recordBulkForeignWrite(
  plan: BulkRepairPlan,
  resourceId: string,
  locale: string,
  key: string,
): void {
  if (!locale || !key) return;
  plan.claimedWrites.push({ resourceId, locale, key });
}

/** The MARKET-layer counterpart — see `marketWrites`. Deliberately separate:
 *  `claimedWrites` silences the REPAIR (which writes global rows) and this one
 *  silences the market PURGE, and the two must not be confused. */
export function recordBulkMarketWrite(
  plan: BulkRepairPlan,
  resourceId: string,
  marketId: string,
  locale: string,
  key: string,
): void {
  if (!marketId || !locale || !key) return;
  plan.marketWrites.add(marketOverrideKey(resourceId, marketId, locale, key));
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
  // EVERY surface is collected the same way, a product's and a collection's own
  // fields included. They used to wait in a pool of their own until the flush
  // decided whether this save had blocked their update webhook — the exclusion
  // that assumed the webhook repairs them. It does not when there is nothing to
  // detect: the sync-side gate reads digests stored ON TRANSLATION ROWS, so a
  // row nobody has ever translated carries no baseline and its webhook can
  // prove nothing, forever. The repair CLAIMS the row when it starts, which is
  // what makes the webhook stand down instead (IN_APP_RETRANSLATED_RESOURCE_TYPES).
  const pool = plan.groups;
  let group = pool.get(key);
  if (!group) {
    // The cap counts GROUPS and is checked before a new one is opened: adding
    // entries to a group that already exists costs no extra run.
    if (pool.size >= MAX_REPAIR_GROUPS) {
      plan.overflow.add(key);
      plan.overflowRows.add(args.ownerId);
      return false;
    }
    group = {
      surface: args.surface,
      ownerId: args.ownerId,
      rowType: args.rowType,
      entries: [],
      ...(args.imageIdByMedia ? { imageIdByMedia: new Map(args.imageIdByMedia) } : {}),
    };
    pool.set(key, group);
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
}): Promise<{ started: number; translations: number; skipped: number }> {
  const { db, shop, gateway, foreignLocales, primaryLocale, policy, plan } = params;
  if (plan.groups.size === 0) return { started: 0, translations: 0, skipped: 0 };

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
  const alreadyWritten = plan.claimedWrites;

  let started = 0;
  let translations = 0;
  let skipped = 0;
  for (const group of plan.groups.values()) {
    const resourceTitle = titles.get(group.ownerId) || group.ownerId;
    const contentKind = contentKindFor(group.rowType);
    const rowResourceType = CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[group.rowType];
    const valuePrompt = (context: string) =>
      primaryLocale ? { kind: "values" as const, context, sourceLocale: primaryLocale } : null;

    /** Everything but the shared fields — null = this group cannot run. */
    const shape = (():
      | {
          resourceType: string;
          lockId?: string;
          contentKind?: "product" | "collection" | "blog" | "page";
          taskResourceType?: string;
          mirror: TranslationMirror | null;
          translateAs?: { kind: "values"; context: string; sourceLocale: string };
        }
      | null => {
      switch (group.surface) {
        case "content":
          return { resourceType: rowResourceType, mirror: contentTranslationMirror(shop) };
        case "metaobject": {
          const prompt = valuePrompt("metaobject field values");
          if (!prompt) return null;
          return {
            resourceType: "Metaobject",
            // The AI prompt comes from `translateAs`, so this only decides the
            // Task label — and `taskResourceType` keeps a metaobject OUT of the
            // admin-path map, which would otherwise offer /admin/pages/<id>.
            contentKind: "page",
            taskResourceType: "metaobject",
            mirror: null, // resolved below: it needs the entries' types
            translateAs: prompt,
          };
        }
        case "subResource": {
          const prompt = valuePrompt("product option and metafield values");
          if (!prompt) return null;
          return {
            resourceType: "Product",
            // A product carries several independent repairs; claiming the
            // product itself would make its own webhook reconciliation bail.
            lockId: subResourceLockId(group.ownerId),
            contentKind: "product",
            mirror: contentTranslationMirror(shop),
            translateAs: prompt,
          };
        }
        case "productImageAlt": {
          const prompt = valuePrompt("product image alt texts");
          if (!prompt || !group.imageIdByMedia || group.imageIdByMedia.size === 0) return null;
          return {
            resourceType: "Product",
            lockId: altTextLockId(group.ownerId),
            contentKind: "product",
            mirror: productImageAltMirror(group.imageIdByMedia),
            translateAs: prompt,
          };
        }
        case "libraryImageAlt": {
          // An image that is not product media has no ProductImage row: its
          // mirror is the generic ContentTranslation table under resourceType
          // "MediaImage", the same split the write path makes. It has no owning
          // product either, so the media GID is its own lock.
          const prompt = valuePrompt("image alt texts");
          if (!prompt) return null;
          return {
            resourceType: "MediaImage",
            contentKind: "product",
            mirror: contentTranslationMirror(shop),
            translateAs: prompt,
          };
        }
        case "featuredAlt": {
          const prompt = valuePrompt("image alt texts");
          if (!prompt) return null;
          return {
            resourceType: rowResourceType,
            // The featured alt is its own surface: the parent's lock belongs to
            // that resource's CONTENT repair, which an article save runs on the
            // same id.
            lockId: featuredAltLockId(group.ownerId),
            mirror: featuredImageAltMirror(shop, group.ownerId, rowResourceType),
            translateAs: prompt,
          };
        }
      }
    })();

    if (!shape) {
      skipped++;
      continue;
    }

    try {
      let mirror = shape.mirror;
      if (group.surface === "metaobject") {
        const typeById = new Map<string, string>();
        for (const entry of group.entries) typeById.set(entry.resourceId, "");
        for (const row of await db.metaobject.findMany({
          where: { shop, id: { in: [...typeById.keys()] } },
          select: { id: true, type: true },
        })) {
          typeById.set(row.id, row.type);
        }
        mirror = metaobjectTranslationMirror(shop, typeById);
      }

      // A group with no mirror is one whose store this module cannot name — it
      // is REPORTED as skipped, never silently dropped.
      //
      // What is deliberately NOT asked here any more: "does this surface hold
      // any translation at all". That pre-check existed to keep this path's
      // reach where the deletion it replaces had it — that one short-circuited
      // on an empty mirror — and it is exactly what made the merchant's report
      // true: a row whose translations were still empty stayed empty after
      // every edit, because the repair was skipped before it could write the
      // first one. "Translate automatically" has to include the first
      // translation. The cost that bought it is gone too: with the fill the
      // repair only queries Shopify per locale when a REMOVAL is on the table,
      // so a group whose keys all carry a value now costs one read-back.
      if (!mirror) {
        skipped++;
        continue;
      }

      const outcome = await reconcileAfterPrimarySave({
        client: gateway,
        shop,
        resourceId: group.ownerId,
        resourceType: shape.resourceType,
        contentKind: shape.contentKind ?? contentKind,
        resourceTitle,
        changed: group.entries,
        foreignLocales,
        alreadyWritten,
        policy,
        mirror,
        ...(shape.lockId ? { lockId: shape.lockId } : {}),
        ...(shape.taskResourceType ? { taskResourceType: shape.taskResourceType } : {}),
        ...(shape.translateAs ? { translateAs: shape.translateAs } : {}),
      });
      // Counted from what the repair actually took on, never from the fact that
      // it was CALLED: it starts no Task and no run when nothing is left to
      // translate — every entry refused as un-promptable, every triple already
      // written by this save, an unreadable read-back. Reporting those as
      // started sent the merchant to a Tasks tab with nothing in it.
      if (outcome.retranslating > 0) {
        started++;
        translations += outcome.retranslating;
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

  if (started > 0 || skipped > 0 || plan.overflow.size > 0) {
    logger.info("[BULK] Auto-translation repairs", {
      context: "Bulk",
      shop,
      started,
      translations,
      skipped,
      overflow: plan.overflow.size,
    });
  }
  return { started, translations, skipped };
}
