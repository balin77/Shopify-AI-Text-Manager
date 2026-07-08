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
import { groupDiffByRow } from "./bulk-meta.shared";
import type {
  BulkMetaType,
  BulkMetaField,
  BulkMetaRow,
  BulkMetaDiffEntry,
  BulkMetaApplyResult,
  BulkMetaFailure,
} from "./bulk-meta.shared";

// Types, constants and the pure diff computation live in bulk-meta.shared.ts
// (client-safe — the route component uses them); re-export so server-side
// consumers keep this single import path.
export * from "./bulk-meta.shared";

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
