/**
 * Resolving a menu item's `resourceId` back into something a merchant reads.
 *
 * The tree Shopify hands over says `gid://shopify/Collection/123`, and a row
 * that shows that is a row nobody can check. This turns the GIDs of a whole
 * menu into titles in one query per TYPE — not per item — off the same caches
 * the picker searches, so the label under a row and the option in the dropdown
 * can never disagree.
 *
 * The one rule: an id that resolves to nothing is LEFT OUT of the map, never
 * mapped to a placeholder. The caller renders "type + raw id" for an unresolved
 * target, because "this points at something we cannot name" and "this points at
 * nothing" are different states and only the second one is a defect. A resource
 * created in the Shopify admin since the last sync produces the first.
 */

import type { PrismaClient } from "@prisma/client";

/** `gid://shopify/<Kind>/<n>` → `<Kind>`; anything else → "". */
export function gidKind(id: string): string {
  const match = /^gid:\/\/shopify\/([A-Za-z0-9_]+)\//.exec(id);
  return match ? match[1] : "";
}

type Resolver = (ids: string[]) => Promise<Array<{ id: string; title: string }>>;

export async function resolveMenuTargetTitles(
  db: PrismaClient,
  shop: string,
  resourceIds: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(resourceIds.filter((id) => typeof id === "string" && id))];
  if (unique.length === 0) return {};

  const byKind = new Map<string, string[]>();
  for (const id of unique) {
    const kind = gidKind(id);
    if (!kind) continue;
    const list = byKind.get(kind) ?? [];
    list.push(id);
    byKind.set(kind, list);
  }

  const resolvers: Record<string, Resolver> = {
    Product: async (ids) =>
      db.product.findMany({ where: { shop, id: { in: ids } }, select: { id: true, title: true } }),
    Collection: async (ids) =>
      db.collection.findMany({ where: { shop, id: { in: ids } }, select: { id: true, title: true } }),
    Page: async (ids) =>
      db.page.findMany({ where: { shop, id: { in: ids } }, select: { id: true, title: true } }),
    Article: async (ids) =>
      db.article.findMany({ where: { shop, id: { in: ids } }, select: { id: true, title: true } }),
    ShopPolicy: async (ids) =>
      db.shopPolicy.findMany({ where: { shop, id: { in: ids } }, select: { id: true, title: true } }),
    Metaobject: async (ids) => {
      const rows = await db.metaobject.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, displayName: true },
      });
      return rows.map((r) => ({ id: r.id, title: r.displayName }));
    },
    // No Blog model in this cache — the title rides on the articles that point
    // at it (see the picker's blog group for the same gap and the same reason).
    Blog: async (ids) => {
      const rows = await db.article.findMany({
        where: { shop, blogId: { in: ids } },
        distinct: ["blogId"],
        select: { blogId: true, blogTitle: true },
      });
      return rows.map((r) => ({ id: r.blogId, title: r.blogTitle }));
    },
  };

  const out: Record<string, string> = {};
  await Promise.all(
    [...byKind].map(async ([kind, ids]) => {
      const resolver = resolvers[kind];
      if (!resolver) return;
      try {
        for (const row of await resolver(ids)) {
          if (row.title) out[row.id] = row.title;
        }
      } catch {
        // A failed lookup leaves those ids unresolved, which the row renders as
        // "type + id". Throwing here would take the whole menus page down over
        // a label.
      }
    }),
  );
  return out;
}

/** Every `resourceId` in a raw menu tree, at any depth. */
export function collectMenuResourceIds(items: unknown, out: string[] = []): string[] {
  if (!Array.isArray(items)) return out;
  for (const raw of items) {
    const node = raw as Record<string, unknown>;
    if (typeof node?.resourceId === "string" && node.resourceId) out.push(node.resourceId);
    collectMenuResourceIds(node?.items, out);
  }
  return out;
}
