/**
 * Item-picker search endpoint (PLAN_KEYWORDS_UI_REWORK.md §4.2, Phase 3).
 *
 * Server-side title search over the per-type DB cache (Product / Collection /
 * Article / Page). Replaces the loader's old `pickers` block (four `findMany`
 * à PICKER_CAP=250 on every page load) with an on-demand, cursor-paged search
 * so item #300 is actually findable.
 *
 * GET /api/seo/item-picker?type=Product&q=vase&productType=&cursor=&locale=de
 *   type        Product | Collection | Article | Page   (default Product)
 *   q           title `contains` search (optional)
 *   productType Product-only facet (optional)
 *   cursor      an item id — page starts AFTER it (optional)
 *   locale      "" = primary; non-empty overlays translated titles (§4.2)
 *
 * Response: { items: { id, title, imageUrl: string | null }[], nextCursor, total }
 * Not Pro-gated. The client (ItemPicker.tsx) appends the CDN `?width=` param.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { logger } from "../utils/logger.server";

const PICKER_TYPES = ["Product", "Collection", "Article", "Page"] as const;
type PickerType = (typeof PICKER_TYPES)[number];

// One extra row over the page size: if we get PAGE_SIZE+1 back, the last row's
// id is the next cursor and we return the first PAGE_SIZE.
const PAGE_SIZE = 60;

interface PickerItem {
  id: string;
  title: string;
  imageUrl: string | null;
}

/** Pure builder for the shared `where` filter (used by both the query and the count). */
export function buildWhere(shop: string, type: PickerType, q: string, productType: string) {
  return {
    shop,
    ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
    ...(type === "Product" && productType ? { productType } : {}),
  };
}

/**
 * Pure builder for the optional cursor page args (skip the cursor row itself).
 * The explicit return type keeps the result assignable when spread into
 * `findMany` args — same shape as the previous inline `cursorArgs` const.
 */
export function buildCursorArgs(
  shop: string,
  cursor: string,
): { cursor?: { shop_id: { shop: string; id: string } }; skip?: number } {
  return cursor ? { cursor: { shop_id: { shop, id: cursor } }, skip: 1 } : {};
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const typeParam = url.searchParams.get("type") || "Product";
  const type: PickerType = PICKER_TYPES.includes(typeParam as PickerType)
    ? (typeParam as PickerType)
    : "Product";
  const q = (url.searchParams.get("q") || "").trim();
  const productType = url.searchParams.get("productType") || "";
  const cursor = url.searchParams.get("cursor") || "";
  const locale = url.searchParams.get("locale") || "";

  try {
    const where = buildWhere(shop, type, q, productType);
    const orderBy = [{ title: "asc" as const }, { id: "asc" as const }];
    // Optional cursor page (skip the cursor row itself).
    const cursorArgs = buildCursorArgs(shop, cursor);

    // Per-type query — each cache model has a different image column
    // (Product.featuredImageUrl, Collection/Article.imageUrl, Page: none).
    let rows: PickerItem[];
    let total: number;
    switch (type) {
      case "Product": {
        const [found, count] = await Promise.all([
          db.product.findMany({
            where,
            orderBy,
            take: PAGE_SIZE + 1,
            select: { id: true, title: true, featuredImageUrl: true },
            ...cursorArgs,
          }),
          db.product.count({ where }),
        ]);
        rows = found.map((r) => ({ id: r.id, title: r.title, imageUrl: r.featuredImageUrl ?? null }));
        total = count;
        break;
      }
      case "Collection": {
        const [found, count] = await Promise.all([
          db.collection.findMany({
            where,
            orderBy,
            take: PAGE_SIZE + 1,
            select: { id: true, title: true, imageUrl: true },
            ...cursorArgs,
          }),
          db.collection.count({ where }),
        ]);
        rows = found.map((r) => ({ id: r.id, title: r.title, imageUrl: r.imageUrl ?? null }));
        total = count;
        break;
      }
      case "Article": {
        const [found, count] = await Promise.all([
          db.article.findMany({
            where,
            orderBy,
            take: PAGE_SIZE + 1,
            select: { id: true, title: true, imageUrl: true },
            ...cursorArgs,
          }),
          db.article.count({ where }),
        ]);
        rows = found.map((r) => ({ id: r.id, title: r.title, imageUrl: r.imageUrl ?? null }));
        total = count;
        break;
      }
      case "Page": {
        const [found, count] = await Promise.all([
          db.page.findMany({
            where,
            orderBy,
            take: PAGE_SIZE + 1,
            select: { id: true, title: true },
            ...cursorArgs,
          }),
          db.page.count({ where }),
        ]);
        // Pages have no image field in the cache — imageUrl is always null.
        rows = found.map((r) => ({ id: r.id, title: r.title, imageUrl: null }));
        total = count;
        break;
      }
    }

    // Paging: we asked for PAGE_SIZE+1. If we got the extra row, its id is the
    // next cursor and we drop it from the returned page.
    let nextCursor: string | null = null;
    if (rows.length > PAGE_SIZE) {
      nextCursor = rows[PAGE_SIZE].id;
      rows = rows.slice(0, PAGE_SIZE);
    }

    // Locale title overlay (§4.2): overlay a non-empty translated title over the
    // base title; fall back to the base when missing or empty.
    if (locale && rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const translations = await db.contentTranslation.findMany({
        where: { shop, locale, resourceType: type, resourceId: { in: ids }, key: "title" },
        select: { resourceId: true, value: true },
      });
      const titleBy: Record<string, string> = {};
      for (const t of translations) {
        if (t.value && t.value.trim()) titleBy[t.resourceId] = t.value;
      }
      rows = rows.map((r) => ({ ...r, title: titleBy[r.id] ?? r.title }));
    }

    return json({ items: rows, nextCursor, total });
  } catch (error) {
    logger.error("Item-picker search failed", {
      context: "SEO",
      type,
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ items: [] as PickerItem[], nextCursor: null, total: 0 }, { status: 500 });
  }
};
