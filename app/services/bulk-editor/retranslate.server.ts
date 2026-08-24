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
 *    texts changed is at most three groups (content, sub-resources, alt texts)
 *    — the content one only if rule 3's exception applies, so normally two —
 *    which is one Task row and one AI request per locale each: exactly what the
 *    same edit made one product at a time would cost.
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
  /**
   * The two webhook-backed row types' CONTENT groups, kept OUT of `groups` and
   * out of the cap until `promoteClaimedGroups` decides which of them are ours.
   *
   * They are collected at all only because the claim that makes them ours
   * (a foreign write on the same row) can land after the candidate does. Left
   * in the capped pool they filled it with groups that were then thrown away:
   * thirteen product rows that each changed a base field and a metafield spent
   * every slot on content groups nobody ran, and from row thirteen on the
   * SUB-RESOURCE candidates were refused and their translations deleted. A
   * budget spent on work that never happened must not cost a merchant their
   * translations.
   */
  webhookOwned: Map<string, BulkRepairGroup>;
  /** Group KEYS the cap refused — reported, never silently dropped. Keys, not
   *  calls: ten metafields of one product past the cap are ONE refused row. */
  overflow: Set<string>;
  /**
   * Rows a foreign CONTENT write claimed in this save. Only these make a
   * product/collection content group ours to repair (rule 3 above).
   */
  claimedRows: Set<string>;
  /**
   * Every FOREIGN translation this save wrote itself, as (resource, locale,
   * key). Handed to the repair as `alreadyWritten`, which leaves them in
   * neither list — re-translating a value the merchant typed in this very save
   * is the one thing rule 3's exception must not do.
   */
  claimedWrites: Array<{ resourceId: string; locale: string; key: string }>;
}

export function newBulkRepairPlan(): BulkRepairPlan {
  return {
    groups: new Map(),
    webhookOwned: new Map(),
    overflow: new Set(),
    claimedRows: new Set(),
    claimedWrites: [],
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
  // A product's or collection's OWN fields belong to its update webhook unless
  // this save blocks it — decided at the flush, so until then they wait in
  // their own uncapped pool (see `BulkRepairPlan.webhookOwned`).
  const webhookOwned =
    args.surface === "content" && (args.rowType === "product" || args.rowType === "collection");
  const pool = webhookOwned ? plan.webhookOwned : plan.groups;
  let group = pool.get(key);
  if (!group) {
    // The cap counts GROUPS and is checked before a new one is opened: adding
    // entries to a group that already exists costs no extra run.
    if (!webhookOwned && pool.size >= MAX_REPAIR_GROUPS) {
      plan.overflow.add(key);
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

/**
 * Move the webhook-backed content groups this save CLAIMED into the pool that
 * runs, and forget the rest — their webhook repairs them, and a second run
 * would queue a duplicate behind it (rule 3). Called once, before the flush,
 * because a row is claimed by its FOREIGN group while the candidate comes from
 * its PRIMARY one and the two are persisted in whatever order the client sent
 * them.
 *
 * The promoted ones get their OWN budget rather than competing for the other
 * pool's: a claimed row is owed a repair (its webhook has been made to bail and
 * nothing else will notice), while the surfaces in `groups` have already stood
 * their deletion down and would otherwise be evicted into "neither refreshed
 * nor removed". So a save starts at most MAX_REPAIR_GROUPS of each.
 *
 * A claimed row past that budget is counted into `overflow` and keeps its stale
 * translations: nothing deleted them (auto-translate turns that purge off) and
 * its webhook was made to bail, so it is genuinely untouched until the next
 * change event. That is why `overflow` is reported as "not re-translated"
 * rather than as "deleted" — the two outcomes it covers are different.
 */
export function promoteClaimedGroups(plan: BulkRepairPlan): number {
  let promoted = 0;
  for (const [key, group] of plan.webhookOwned) {
    if (!plan.claimedRows.has(group.ownerId)) continue;
    if (promoted >= MAX_REPAIR_GROUPS) {
      plan.overflow.add(key);
      continue;
    }
    plan.groups.set(key, group);
    promoted++;
  }
  plan.webhookOwned.clear();
  return promoted;
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
  const alreadyWritten = plan.claimedWrites;

  let started = 0;
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
          resourceId?: string;
          resourceType: string;
          lockId?: string;
          contentKind?: "product" | "collection" | "blog" | "page";
          taskResourceType?: string;
          mirror: unknown;
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

      // Does this surface hold ANY foreign translation to repair? One DB query
      // against the same mirror the repair would use, and a `no` skips the
      // group before a single Shopify call — the repair's own detection asks
      // Shopify once PER LOCALE, which on a shop that never translated this
      // surface is a round trip per locale per row for a certain nothing.
      //
      // It also keeps this path's REACH exactly where the deletion it replaces
      // had it: that one short-circuited on an empty mirror too. A translation
      // written in the Shopify admin with no row here is therefore not repaired
      // by a bulk save — as it was not deleted by one before.
      const refs = [
        ...new Map(
          group.entries.map((entry) => [
            entry.resourceId,
            { resourceId: entry.resourceId, resourceType: entry.resourceType },
          ]),
        ).values(),
      ];
      const keys = [...new Set(group.entries.map((entry) => entry.key))];
      const existing = await (
        mirror as { existing: (r: typeof refs, l: readonly string[], k: string[]) => Promise<unknown[]> }
      ).existing(refs, foreignLocales, keys);
      if (existing.length === 0) continue;

      await reconcileAfterPrimarySave({
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
        mirror: mirror as never,
        ...(shape.lockId ? { lockId: shape.lockId } : {}),
        ...(shape.taskResourceType ? { taskResourceType: shape.taskResourceType } : {}),
        ...(shape.translateAs ? { translateAs: shape.translateAs } : {}),
      });
      started++;
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
      skipped,
      overflow: plan.overflow.size,
    });
  }
  return { started, skipped };
}
