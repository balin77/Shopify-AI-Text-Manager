/**
 * Manual bulk-meta editor (SEO_TAB_IMPLEMENTATION_PLAN.md Anhang C3) — a
 * spreadsheet-like editor for Title / SEO-Title / Meta-Description / Handle
 * across the catalog, distinct from the AI bulk-fix
 * (api-ai-handlers/seo-bulk-fix.handler.ts).
 *
 * Persistence reuses the SAME Shopify mutation paths the single-item editor
 * uses (a minimal partial `productUpdate` for Product, ShopifyContentService
 * for Collection/Article/Page — see seo-bulk-fix.handler.ts's persistField for
 * precedent), but groups every dirty field on one row into a SINGLE mutation
 * call instead of one call per field.
 *
 * `computeDiff` is the one pure, unit-tested piece: it turns the route's
 * client-side `${id}:${field}` edit map into a diff-only list of changed
 * cells, so "Save" only ever writes what actually changed (plan requirement).
 */

import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { ShopifyApiGateway } from "../shopify-api-gateway.service";
import { ShopifyContentService } from "../../../src/services/shopify-content.service";

export type BulkMetaType = "product" | "collection" | "article" | "page";
export type BulkMetaField = "title" | "seoTitle" | "seoDescription" | "handle";

export const BULK_META_TYPES: BulkMetaType[] = ["product", "collection", "article", "page"];
export const BULK_META_FIELDS: BulkMetaField[] = ["title", "seoTitle", "seoDescription", "handle"];

/** Rows shown per page in the grid (A2-style take cap, offset-paged via ?page=). */
export const BULK_META_PAGE_SIZE = 100;

/** More dirty rows than this go through the detached "seoBulkMeta" Task
 * (seo-bulk-meta.handler.ts) instead of a synchronous save. */
export const MAX_SYNC_SAVE = 25;

/** Hard cap on one detached run. There's no per-item AI call here (unlike
 * MAX_BULK_FIX_ITEMS in seo-bulk-fix.handler.ts), so the ceiling can be much
 * higher — this just bounds one runner's worst-case wall-clock time. */
export const MAX_BULK_META_TASK_ITEMS = 500;

export interface BulkMetaRow {
  id: string;
  type: BulkMetaType;
  title: string;
  seoTitle: string;
  seoDescription: string;
  handle: string;
}

export interface BulkMetaDiffEntry {
  id: string;
  type: BulkMetaType;
  field: BulkMetaField;
  value: string;
}

export interface BulkMetaFailure {
  id: string;
  type: BulkMetaType;
  message: string;
}

export interface BulkMetaApplyResult {
  saved: number;
  failures: BulkMetaFailure[];
}

// ─── Pure diff computation (unit-tested) ──────────────────────────────────

/**
 * Diff-only save-all: only cells whose trimmed value differs from the
 * (trimmed) original row value are returned. `edits` is keyed by
 * `${id}:${field}` — exactly the shape of the route's client-side edit map.
 *
 * Trimming means whitespace-only "changes" never count as dirty, but
 * deliberately clearing a field (typing nothing) still produces a
 * `value: ""` entry whenever the original had content — an explicit clear is
 * a real, save-worthy diff, not a no-op.
 *
 * Split on the LAST ":" rather than the first: Shopify GIDs
 * ("gid://shopify/Product/123") contain their own colon, but none of the
 * field names do, so the separator is always the final one.
 */
export function computeDiff(rows: BulkMetaRow[], edits: Record<string, string>): BulkMetaDiffEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const diff: BulkMetaDiffEntry[] = [];

  for (const key of Object.keys(edits)) {
    const sep = key.lastIndexOf(":");
    if (sep < 0) continue;
    const id = key.slice(0, sep);
    const field = key.slice(sep + 1) as BulkMetaField;
    if (!BULK_META_FIELDS.includes(field)) continue;

    const row = byId.get(id);
    if (!row) continue;

    const original = (row[field] ?? "").trim();
    const next = (edits[key] ?? "").trim();
    if (next !== original) {
      diff.push({ id: row.id, type: row.type, field, value: next });
    }
  }

  return diff;
}

/** Groups flat diff entries into one patch per (type,id) row, so a row with
 * several dirty cells produces a single Shopify mutation instead of one per
 * field. Exported (alongside computeDiff) since it's pure and easy to test
 * independently of any I/O. */
export function groupDiffByRow(
  diff: BulkMetaDiffEntry[],
): { type: BulkMetaType; id: string; fields: Partial<Record<BulkMetaField, string>> }[] {
  const map = new Map<string, { type: BulkMetaType; id: string; fields: Partial<Record<BulkMetaField, string>> }>();
  for (const entry of diff) {
    const key = `${entry.type}:${entry.id}`;
    let group = map.get(key);
    if (!group) {
      group = { type: entry.type, id: entry.id, fields: {} };
      map.set(key, group);
    }
    group.fields[entry.field] = entry.value;
  }
  return [...map.values()];
}

// ─── Loading a page of rows (select-minimized, take-capped) ───────────────

interface CacheRow {
  id: string;
  title: string;
  seoTitle: string | null;
  seoDescription: string | null;
  handle: string;
}

function normalizeRow(type: BulkMetaType, row: CacheRow): BulkMetaRow {
  return {
    id: row.id,
    type,
    title: row.title,
    seoTitle: row.seoTitle ?? "",
    seoDescription: row.seoDescription ?? "",
    handle: row.handle,
  };
}

/** One page of the content cache for `type`, select-minimized to exactly the
 * four editable fields (+ id), offset-paged via skip/take. */
export async function loadBulkMetaPage(
  db: PrismaClient,
  shop: string,
  type: BulkMetaType,
  opts: { skip: number; take: number },
): Promise<{ rows: BulkMetaRow[]; total: number }> {
  const { skip, take } = opts;
  const select = { id: true, title: true, seoTitle: true, seoDescription: true, handle: true } as const;
  const orderBy = { title: "asc" as const };

  switch (type) {
    case "product": {
      const [items, total] = await Promise.all([
        db.product.findMany({ where: { shop }, select, orderBy, skip, take }),
        db.product.count({ where: { shop } }),
      ]);
      return { rows: items.map((i) => normalizeRow("product", i)), total };
    }
    case "collection": {
      const [items, total] = await Promise.all([
        db.collection.findMany({ where: { shop }, select, orderBy, skip, take }),
        db.collection.count({ where: { shop } }),
      ]);
      return { rows: items.map((i) => normalizeRow("collection", i)), total };
    }
    case "article": {
      const [items, total] = await Promise.all([
        db.article.findMany({ where: { shop }, select, orderBy, skip, take }),
        db.article.count({ where: { shop } }),
      ]);
      return { rows: items.map((i) => normalizeRow("article", i)), total };
    }
    case "page": {
      const [items, total] = await Promise.all([
        db.page.findMany({ where: { shop }, select, orderBy, skip, take }),
        db.page.count({ where: { shop } }),
      ]);
      return { rows: items.map((i) => normalizeRow("page", i)), total };
    }
  }
}

// ─── Applying a diff to Shopify + the DB cache ─────────────────────────────

interface ApplyContext {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
}

async function persistRow(
  group: { type: BulkMetaType; id: string; fields: Partial<Record<BulkMetaField, string>> },
  deps: { db: PrismaClient; shop: string; gateway: ShopifyApiGateway; contentService: ShopifyContentService },
): Promise<void> {
  const { type, id, fields } = group;
  const { db, shop, gateway, contentService } = deps;

  // Shopify rejects an empty title outright for every one of these resource
  // types — reject it here too so it counts as a per-row failure instead of
  // an opaque userError, mirroring updatePrimaryProduct's own guard
  // (app/actions/product/update.actions.ts).
  if (fields.title !== undefined && fields.title.trim() === "") {
    throw new Error("Title cannot be empty.");
  }

  const dbData: Record<string, unknown> = { lastSyncedAt: new Date() };
  if (fields.title !== undefined) dbData.title = fields.title;
  if (fields.seoTitle !== undefined) dbData.seoTitle = fields.seoTitle;
  if (fields.seoDescription !== undefined) dbData.seoDescription = fields.seoDescription;
  if (fields.handle !== undefined) dbData.handle = fields.handle;

  switch (type) {
    case "product": {
      // Minimal partial productUpdate — only the fields that changed are
      // sent, so everything else is left untouched by Shopify (omitted
      // GraphQL input fields = "no change"). Same shape as
      // seo-bulk-fix.handler.ts's persistField, extended to title/handle.
      const input: Record<string, unknown> = { id };
      if (fields.title !== undefined) input.title = fields.title;
      if (fields.handle !== undefined) input.handle = fields.handle;
      if (fields.seoTitle !== undefined || fields.seoDescription !== undefined) {
        input.seo = {
          ...(fields.seoTitle !== undefined ? { title: fields.seoTitle } : {}),
          ...(fields.seoDescription !== undefined ? { description: fields.seoDescription } : {}),
        };
      }
      const response = await gateway.graphql(
        `#graphql
          mutation seoBulkMetaProductUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              userErrors { field message }
            }
          }`,
        { variables: { input } },
      );
      const data = (await response.json()) as {
        data?: { productUpdate?: { userErrors?: { field?: string; message: string }[] } };
      };
      const userErrors = data.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) throw new Error(userErrors[0].message);

      await db.product.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    case "collection": {
      const seo =
        fields.seoTitle !== undefined || fields.seoDescription !== undefined
          ? {
              ...(fields.seoTitle !== undefined ? { title: fields.seoTitle } : {}),
              ...(fields.seoDescription !== undefined ? { description: fields.seoDescription } : {}),
            }
          : undefined;
      await contentService.updateCollection(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(seo ? { seo } : {}),
      });
      await db.collection.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    case "page": {
      await contentService.updatePage(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.seoTitle !== undefined ? { seoTitle: fields.seoTitle } : {}),
        ...(fields.seoDescription !== undefined ? { seoDescription: fields.seoDescription } : {}),
      });
      await db.page.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    case "article": {
      // Article SEO title/description are stored as global.title_tag /
      // description_tag metafields, written inline by updateArticle() (see
      // ShopifyContentService.updateArticle) — same as Page/Blog.
      await contentService.updateArticle(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.seoTitle !== undefined ? { seoTitle: fields.seoTitle } : {}),
        ...(fields.seoDescription !== undefined ? { seoDescription: fields.seoDescription } : {}),
      });
      await db.article.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
  }
}

/**
 * Applies a diff-only payload to Shopify + the DB content cache, one row (not
 * one field) at a time. A single row's userErrors (e.g. a handle collision)
 * are caught and reported as a per-row failure — they never abort the rest of
 * the batch. `onProgress` lets callers (the detached Task runner) heartbeat
 * progress after every row.
 */
export async function applyBulkMetaDiff(
  ctx: ApplyContext,
  diff: BulkMetaDiffEntry[],
  onProgress?: (processed: number, total: number) => void | Promise<void>,
): Promise<BulkMetaApplyResult> {
  const { db, shop, admin } = ctx;
  const gateway = new ShopifyApiGateway(admin, shop);
  const contentService = new ShopifyContentService(gateway as any); // eslint-disable-line @typescript-eslint/no-explicit-any

  const groups = groupDiffByRow(diff);
  const failures: BulkMetaFailure[] = [];
  let saved = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    try {
      await persistRow(group, { db, shop, gateway, contentService });
      saved++;
    } catch (err: unknown) {
      failures.push({
        id: group.id,
        type: group.type,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (onProgress) await onProgress(i + 1, groups.length);
  }

  return { saved, failures };
}
