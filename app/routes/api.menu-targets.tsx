/**
 * The menu target picker's search — one endpoint for every resource-bound
 * MenuItemType.
 *
 * GET /api/menu-targets?q=vase
 *   q  substring over the title (optional; empty = the first page of each
 *      group, so the dropdown is BROWSABLE and not only searchable)
 *
 * Every group, always. A `type` parameter for drilling into one group was
 * written and removed again: nothing calls it, and an untravelled branch in a
 * search endpoint is a second answer waiting to drift from the first.
 *
 * It reads the DB CACHE, never Shopify: a live query per keystroke would
 * throttle a real catalogue, and every row here is one the rest of the app
 * already renders. The one consequence is stated rather than hidden — a
 * resource created in the Shopify admin since the last sync is not offered, and
 * the picker says so with a link to the reload.
 *
 * Directly GET-reachable, so the plan gate lives here as well as in the page —
 * the same class as the `/api/ai` handlers.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { logger } from "../utils/logger.server";
import { canAccessContentType } from "../utils/planUtils";
import {
  MENU_TARGET_GROUPS,
  type MenuTargetCandidate,
  type MenuTargetGroupResult,
  type MenuTargetSearchResult,
} from "../services/menu-targets.shared";

/**
 * How many rows one group returns — the dropdown is a menu, not a catalogue.
 *
 * One extra row is asked for: getting it back is what `truncated` means, and
 * "there are more" is the only honest thing to say to a query that matched a
 * thousand products.
 */
const PER_GROUP = 6;

interface RowQueryArgs {
  shop: string;
  q: string;
  take: number;
}

/**
 * One group's rows. Each branch returns AT MOST `take` rows; the caller asks
 * for one more than it shows.
 *
 * BLOG is the odd one and the comment belongs on it: this app keeps no Blog
 * model, so its candidates are distinct `(blogId, blogTitle)` pairs off the
 * ARTICLE cache. A blog with no articles therefore cannot be offered — a real
 * gap, reported in the UI, never papered over with a live query that would
 * make this endpoint the only one here that talks to Shopify.
 */
async function loadGroup(source: string, { shop, q, take }: RowQueryArgs): Promise<MenuTargetCandidate[]> {
  const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;

  switch (source) {
    case "product": {
      const rows = await db.product.findMany({
        where: { shop, ...(contains ? { title: contains } : {}) },
        orderBy: { title: "asc" },
        take,
        select: { id: true, title: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.title }));
    }
    case "collection": {
      const rows = await db.collection.findMany({
        where: { shop, ...(contains ? { title: contains } : {}) },
        orderBy: { title: "asc" },
        take,
        select: { id: true, title: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.title }));
    }
    case "page": {
      const rows = await db.page.findMany({
        where: { shop, ...(contains ? { title: contains } : {}) },
        orderBy: { title: "asc" },
        take,
        select: { id: true, title: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.title }));
    }
    case "article": {
      const rows = await db.article.findMany({
        where: { shop, ...(contains ? { title: contains } : {}) },
        orderBy: { title: "asc" },
        take,
        select: { id: true, title: true, blogTitle: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.title, subtitle: r.blogTitle || undefined }));
    }
    case "blogFromArticles": {
      // `distinct` over the pair, ordered by the title the merchant reads.
      const rows = await db.article.findMany({
        where: { shop, ...(contains ? { blogTitle: contains } : {}) },
        orderBy: { blogTitle: "asc" },
        distinct: ["blogId"],
        take,
        select: { blogId: true, blogTitle: true },
      });
      return rows.map((r) => ({ id: r.blogId, title: r.blogTitle }));
    }
    case "shopPolicy": {
      const rows = await db.shopPolicy.findMany({
        where: { shop, ...(contains ? { title: contains } : {}) },
        orderBy: { title: "asc" },
        take,
        select: { id: true, title: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.title }));
    }
    case "metaobject": {
      const rows = await db.metaobject.findMany({
        where: { shop, ...(contains ? { displayName: contains } : {}) },
        orderBy: { displayName: "asc" },
        take,
        select: { id: true, displayName: true, type: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.displayName, subtitle: r.type }));
    }
    default:
      return [];
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  if (!canAccessContentType((settings?.subscriptionPlan || "free") as never, "menus")) {
    return json({ groups: [], failed: [] } satisfies MenuTargetSearchResult, { status: 403 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const take = PER_GROUP + 1;

  // Per GROUP, never all-or-nothing: one failing query must not blank a
  // dropdown whose other six groups answered — and the group that failed is
  // NAMED, because an empty list would read as "this shop has none".
  const settled = await Promise.all(
    MENU_TARGET_GROUPS.map(async (group): Promise<{ group: MenuTargetGroupResult } | { failedType: string }> => {
      try {
        const rows = await loadGroup(group.source, { shop, q, take });
        const truncated = rows.length > take - 1;
        return {
          group: {
            type: group.type,
            labelKey: group.labelKey,
            items: truncated ? rows.slice(0, take - 1) : rows,
            truncated,
          },
        };
      } catch (error) {
        logger.error("Menu target search failed", {
          context: "MENUS",
          group: group.type,
          error: error instanceof Error ? error.message : String(error),
        });
        return { failedType: group.type };
      }
    }),
  );

  const result: MenuTargetSearchResult = { groups: [], failed: [] };
  for (const entry of settled) {
    if ("group" in entry) {
      // An empty group is dropped from the response rather than rendered as an
      // empty section: seven headers with nothing under them is a dropdown a
      // merchant has to scroll past to reach the one match.
      if (entry.group.items.length > 0) result.groups.push(entry.group);
    } else {
      result.failed.push(entry.failedType);
    }
  }
  return json(result);
};
