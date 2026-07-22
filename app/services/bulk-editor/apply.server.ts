/**
 * Bulk editor — diff persistence (docs/plans/PLAN_BULK_EDITOR.md §3).
 *
 * Applies a diff-only payload to Shopify + the DB content cache, one row (not
 * one cell) at a time. Persistence reuses the SAME Shopify mutation paths the
 * single-item editor uses (a minimal partial `productUpdate` for Product,
 * ShopifyContentService for Collection/Article/Page), grouping every dirty
 * cell on one row into a SINGLE mutation call.
 *
 * Server-only: ShopifyApiGateway drags logger.server into the bundle. The
 * pure pieces (computeDiff, groupDiffByRow, descriptors) live in
 * columns.shared.ts, which is client-safe.
 */

import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { ShopifyApiGateway } from "../shopify-api-gateway.service";
import { ShopifyContentService } from "../../../src/services/shopify-content.service";
import {
  groupDiffByRow,
  isColumnEditableForType,
  getColumnForType,
  fieldNameOfColumn,
  type BulkRowType,
  type BulkDiffEntry,
  type BulkDiffRowGroup,
  type BulkApplyResult,
  type BulkFailure,
} from "./columns.shared";

interface ApplyContext {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
}

const PRODUCT_STATUSES = new Set(["ACTIVE", "DRAFT", "ARCHIVED"]);

/** Resolves a row group's cells (columnId → value) into flat field names
 * (title, seoTitle, …), rejecting non-editable/unknown columns. */
function fieldsOfGroup(group: BulkDiffRowGroup): Partial<Record<string, string>> {
  const fields: Partial<Record<string, string>> = {};
  for (const columnId of Object.keys(group.cells)) {
    const column = getColumnForType(group.rowType, columnId);
    // Per-type column guard — the route validator checks this too, but this
    // path is also reached from the /api/ai task runner, so reject here as
    // well before either Shopify or the DB can complain inconsistently.
    if (!column || !isColumnEditableForType(group.rowType, columnId) || column.kind !== "field") {
      throw new Error(`Column "${columnId}" is not editable on ${group.rowType}.`);
    }
    fields[fieldNameOfColumn(column)] = group.cells[columnId];
  }
  return fields;
}

async function persistRow(
  group: BulkDiffRowGroup,
  deps: { db: PrismaClient; shop: string; gateway: ShopifyApiGateway; contentService: ShopifyContentService },
): Promise<void> {
  const { rowType: type, rowId: id } = group;
  const { db, shop, gateway, contentService } = deps;

  // Phase-1 guard: the translation write path (translationsRegister with
  // digest + echo verification, Plan §6) lands in Phase 4. The diff format
  // already carries locale/marketId, but only primary/global groups may be
  // persisted here — anything else must fail loudly instead of silently
  // writing a foreign value into the primary content.
  if (group.locale !== "" || group.marketId !== "") {
    throw new Error("Translated cells cannot be saved yet — the bulk editor currently edits the primary language only.");
  }

  const fields = fieldsOfGroup(group);

  // Shopify rejects an empty title outright for every one of these resource
  // types — reject it here too so it counts as a per-row failure instead of
  // an opaque userError, mirroring updatePrimaryProduct's own guard
  // (app/actions/product/update.actions.ts).
  if (fields.title !== undefined && fields.title.trim() === "") {
    throw new Error("Title cannot be empty.");
  }

  // Product status is an enum on Shopify; reject anything else before we send
  // it. The Select in the UI only offers valid values, but the diff-only save
  // still runs the value through here.
  if (fields.status !== undefined) {
    const s = fields.status.trim().toUpperCase();
    if (!PRODUCT_STATUSES.has(s)) {
      throw new Error(`Invalid status "${fields.status}" — expected ACTIVE, DRAFT or ARCHIVED.`);
    }
    fields.status = s;
  }

  // Build the DB patch mirror. Every editable field maps 1:1 to its Prisma
  // column with the same name — no renames — so a single loop is enough.
  const dbData: Record<string, unknown> = { lastSyncedAt: new Date() };
  for (const key of Object.keys(fields)) {
    dbData[key] = fields[key];
  }

  switch (type) {
    case "product": {
      // Minimal partial productUpdate — only the fields that changed are
      // sent, so everything else is left untouched by Shopify (omitted
      // GraphQL input fields = "no change").
      const input: Record<string, unknown> = { id };
      if (fields.title !== undefined) input.title = fields.title;
      if (fields.handle !== undefined) input.handle = fields.handle;
      if (fields.descriptionHtml !== undefined) input.descriptionHtml = fields.descriptionHtml;
      if (fields.productType !== undefined) input.productType = fields.productType;
      if (fields.status !== undefined) input.status = fields.status;
      if (fields.seoTitle !== undefined || fields.seoDescription !== undefined) {
        // Partial SEO clobber guard: productUpdate treats `seo` as a unit —
        // sending only `title` wipes the existing description (and vice versa).
        // When only one half is dirty, load the untouched half from the DB
        // cache and send it too. See "Partial SEO clobber" bug pattern in the
        // repo memory / CLAUDE.md.
        const partialSeo =
          (fields.seoTitle !== undefined) !== (fields.seoDescription !== undefined);
        let untouched: { seoTitle: string | null; seoDescription: string | null } | null = null;
        if (partialSeo) {
          untouched = await db.product.findUnique({
            where: { shop_id: { shop, id } },
            select: { seoTitle: true, seoDescription: true },
          });
        }
        input.seo = {
          title: fields.seoTitle !== undefined ? fields.seoTitle : untouched?.seoTitle ?? "",
          description:
            fields.seoDescription !== undefined
              ? fields.seoDescription
              : untouched?.seoDescription ?? "",
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
      // Same partial-SEO clobber guard as product above — collectionUpdate
      // also treats `seo` as a unit.
      let seo: { title: string; description: string } | undefined;
      if (fields.seoTitle !== undefined || fields.seoDescription !== undefined) {
        const partialSeo =
          (fields.seoTitle !== undefined) !== (fields.seoDescription !== undefined);
        let untouched: { seoTitle: string | null; seoDescription: string | null } | null = null;
        if (partialSeo) {
          untouched = await db.collection.findUnique({
            where: { shop_id: { shop, id } },
            select: { seoTitle: true, seoDescription: true },
          });
        }
        seo = {
          title: fields.seoTitle !== undefined ? fields.seoTitle : untouched?.seoTitle ?? "",
          description:
            fields.seoDescription !== undefined
              ? fields.seoDescription
              : untouched?.seoDescription ?? "",
        };
      }
      await contentService.updateCollection(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.descriptionHtml !== undefined ? { descriptionHtml: fields.descriptionHtml } : {}),
        ...(seo ? { seo } : {}),
      });
      await db.collection.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    case "page": {
      await contentService.updatePage(id, {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.handle !== undefined ? { handle: fields.handle } : {}),
        ...(fields.body !== undefined ? { body: fields.body } : {}),
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
        ...(fields.body !== undefined ? { body: fields.body } : {}),
        ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
        ...(fields.seoTitle !== undefined ? { seoTitle: fields.seoTitle } : {}),
        ...(fields.seoDescription !== undefined ? { seoDescription: fields.seoDescription } : {}),
      });
      await db.article.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    default: {
      // Exhaustiveness backstop — a new BulkRowType without a persist branch
      // must fail the row loudly, never silently skip the Shopify push while
      // the caller reports success (the false-success pattern from CLAUDE.md).
      const _never: never = type;
      throw new Error(`Unsupported row type "${_never as BulkRowType}".`);
    }
  }
}

/**
 * Applies a diff-only payload to Shopify + the DB content cache, one row (not
 * one cell) at a time. A single row's userErrors (e.g. a handle collision)
 * are caught and reported as a per-row failure — they never abort the rest of
 * the batch. `onProgress` lets callers (the detached Task runner) heartbeat
 * progress after every row.
 */
export async function applyBulkDiff(
  ctx: ApplyContext,
  diff: BulkDiffEntry[],
  onProgress?: (processed: number, total: number) => void | Promise<void>,
): Promise<BulkApplyResult> {
  const { db, shop, admin } = ctx;
  const gateway = new ShopifyApiGateway(admin, shop);
  const contentService = new ShopifyContentService(gateway as any); // eslint-disable-line @typescript-eslint/no-explicit-any

  const groups = groupDiffByRow(diff);
  const failures: BulkFailure[] = [];
  let saved = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    try {
      await persistRow(group, { db, shop, gateway, contentService });
      saved++;
    } catch (err: unknown) {
      failures.push({
        rowId: group.rowId,
        rowType: group.rowType,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (onProgress) await onProgress(i + 1, groups.length);
  }

  return { saved, failures };
}
