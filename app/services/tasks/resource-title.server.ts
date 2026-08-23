/**
 * Which ITEM was this task fired from?
 *
 * `Task.resourceTitle` is the one column the Tasks page, the navigation
 * badge's hover card and the completion toast all render as a task's subject.
 * It was filled in by hand at ~30 creation sites, and three of them had
 * drifted into telling the merchant nothing:
 *
 *  - the busiest paths (the editor's generate / translate / format buttons,
 *    which all POST to `/api/ai`) wrote the FIELD LABEL into it, i.e. the same
 *    value as `fieldType`, so the card printed the field name twice and the
 *    item never;
 *  - the single-field translate and the single alt-text translate wrote
 *    nothing at all, though they stored a `resourceId`;
 *  - the alt-text handlers fell back to the raw GID, which a merchant cannot
 *    read.
 *
 * This module is the ONE answer to that question. The client does not send a
 * title on those paths and must not have to: a title is content this app
 * already caches, and asking the browser for it would make the Task label
 * something the client could get wrong.
 *
 * Three rules, and the first outranks everything:
 *
 *  - **It must never fail a task creation.** Every lookup is wrapped; an error
 *    or a miss answers `null` and the task is created anyway. A merchant
 *    losing a translation because a display-title lookup threw would be far
 *    worse than the defect this fixes.
 *  - **The GID decides the table, not the `resourceType` string.** That string
 *    reaches the callers in at least six spellings (`product`, `products`,
 *    `Product`, `blogs`, `templates`, `seo`) and is ambiguous in one of them,
 *    while `gid://shopify/<Type>/<n>` is exact — and it is what every cache
 *    table is keyed by, so a kind derived from anything else could only ever
 *    produce a query that misses. A GID type outside the allowlist below is
 *    not a cached item and answers `null` rather than a guess.
 *  - **Shop-scoped, always.** Every row in this app is scoped by `shop`; a
 *    lookup by GID alone would let one merchant's Task row be labelled with
 *    another's product title.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger.server";

/**
 * The cached item kinds a task can name. A `Blog` is here even though there is
 * no `Blog` TABLE: its title is mirrored onto every one of its articles as
 * `Article.blogTitle`, which is the only cached copy of it in this app.
 */
export type TaskResourceKind =
  | "product"
  | "collection"
  | "page"
  | "article"
  | "blog"
  | "shopPolicy"
  | "metaobject"
  | "menu";

/** `gid://shopify/<Type>/<numeric id>` — the Type segment. */
const GID_TYPE_TO_KIND: Record<string, TaskResourceKind> = {
  Product: "product",
  Collection: "collection",
  Page: "page",
  Article: "article",
  Blog: "blog",
  ShopPolicy: "shopPolicy",
  Metaobject: "metaobject",
  Menu: "menu",
};

/** The `<Type>` segment of a Shopify GID, or `null` for anything else. */
function gidType(resourceId: string): string | null {
  const match = /^gid:\/\/shopify\/([A-Za-z0-9_]+)\/[^/]+$/.exec(resourceId.trim());
  return match ? match[1] : null;
}

/**
 * Which cached table (if any) can name this resource.
 *
 * The GID is the ONLY thing consulted, and `resourceType` is a hint this
 * function deliberately does not fall back to. Two reasons, both concrete:
 *
 *  - Every cache table in this app is keyed by the full GID, so an id that is
 *    not one is an id no query could find. A kind derived from the type string
 *    could only buy a lookup that is guaranteed to miss.
 *  - The string is genuinely ambiguous where the GID is not: the blogs editor
 *    addresses `Blog` containers and `Article` posts under ONE
 *    `contentType: "blogs"`, and `app.seo.performance.tsx` writes `"Product"`
 *    while `api.translate-alt-text-template.tsx` writes `"products"`.
 *
 * A GID whose type is not in the allowlist above answers `null` — a theme, a
 * template group, an `OnlineStoreTheme`, a bare id: not a cached item, so not
 * a guess either. The parameter stays in the signature because it is what
 * every caller has in hand next to the id, and because a future kind that is
 * NOT GID-keyed would be resolved by it.
 */
export function taskResourceKind(
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
): TaskResourceKind | null {
  void resourceType;
  if (typeof resourceId !== "string" || !resourceId.trim()) return null;
  const type = gidType(resourceId);
  return type ? GID_TYPE_TO_KIND[type] ?? null : null;
}

/** A title that is only whitespace is no title. */
function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve the display titles of several resources at once.
 *
 * ONE query per KIND, never one per id: `api.convert-webp.tsx` creates a
 * parent row plus one row per image in a loop, and a per-row lookup there
 * would be an N+1 against the product cache for a title that is the same on
 * every one of them.
 *
 * Returns a map keyed by the resource id. Ids that resolve to nothing are
 * simply absent — a caller decides its own fallback.
 */
export async function resolveTaskResourceTitles(
  db: PrismaClient,
  shop: string,
  resources: Array<{ resourceType?: string | null; resourceId?: string | null }>,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!shop) return found;

  const byKind = new Map<TaskResourceKind, Set<string>>();
  for (const entry of resources) {
    const kind = taskResourceKind(entry?.resourceType, entry?.resourceId);
    if (!kind) continue;
    const id = (entry.resourceId as string).trim();
    const bucket = byKind.get(kind);
    if (bucket) bucket.add(id);
    else byKind.set(kind, new Set([id]));
  }
  if (byKind.size === 0) return found;

  await Promise.all(
    [...byKind.entries()].map(async ([kind, ids]) => {
      const idList = [...ids];
      try {
        switch (kind) {
          case "product": {
            const rows = await db.product.findMany({
              where: { shop, id: { in: idList } },
              select: { id: true, title: true },
            });
            for (const row of rows) {
              const title = clean(row.title);
              if (title) found.set(row.id, title);
            }
            return;
          }
          case "collection": {
            const rows = await db.collection.findMany({
              where: { shop, id: { in: idList } },
              select: { id: true, title: true },
            });
            for (const row of rows) {
              const title = clean(row.title);
              if (title) found.set(row.id, title);
            }
            return;
          }
          case "page": {
            const rows = await db.page.findMany({
              where: { shop, id: { in: idList } },
              select: { id: true, title: true },
            });
            for (const row of rows) {
              const title = clean(row.title);
              if (title) found.set(row.id, title);
            }
            return;
          }
          case "article": {
            const rows = await db.article.findMany({
              where: { shop, id: { in: idList } },
              select: { id: true, title: true },
            });
            for (const row of rows) {
              const title = clean(row.title);
              if (title) found.set(row.id, title);
            }
            return;
          }
          case "blog": {
            // There is no `Blog` table. A blog's title is mirrored onto every
            // one of its articles (`Article.blogTitle`), so the container is
            // named through any ONE of them.
            //
            // `groupBy`, NOT `findMany({ distinct })`: Prisma's `distinct` is
            // applied in the CLIENT, so that query pulls every article row of
            // the blog across the wire and then throws all but one away — a
            // blog with 500 posts costs 500 rows to learn one title. A
            // GROUP BY narrows in the database and comes back with a row per
            // (blogId, blogTitle) pair, which is one row per blog. The
            // `@@index([shop, blogId])` on Article is what makes it cheap.
            const rows = await db.article.groupBy({
              by: ["blogId", "blogTitle"],
              where: { shop, blogId: { in: idList } },
            });
            for (const row of rows) {
              // A blog whose posts disagree about `blogTitle` (a rename that
              // only half-synced) yields two rows; the first non-empty one
              // wins and the second is ignored, because a Task label is not
              // the place to adjudicate a stale cache.
              if (found.has(row.blogId)) continue;
              const title = clean(row.blogTitle);
              if (title) found.set(row.blogId, title);
            }
            return;
          }
          case "shopPolicy": {
            const rows = await db.shopPolicy.findMany({
              where: { shop, id: { in: idList } },
              select: { id: true, title: true },
            });
            for (const row of rows) {
              const title = clean(row.title);
              if (title) found.set(row.id, title);
            }
            return;
          }
          case "metaobject": {
            // `displayName` is the primary-locale label a merchant sees in the
            // entry list; `handle` is what the card falls back to when a
            // definition names no label field (CLAUDE.md: the label keys are a
            // naming convention, and an entry without one is not empty).
            const rows = await db.metaobject.findMany({
              where: { shop, id: { in: idList } },
              select: { id: true, displayName: true, handle: true },
            });
            for (const row of rows) {
              const title = clean(row.displayName) ?? clean(row.handle);
              if (title) found.set(row.id, title);
            }
            return;
          }
          case "menu": {
            const rows = await db.menu.findMany({
              where: { shop, id: { in: idList } },
              select: { id: true, title: true },
            });
            for (const row of rows) {
              const title = clean(row.title);
              if (title) found.set(row.id, title);
            }
            return;
          }
        }
      } catch (error) {
        // Never fatal: the caller is about to create a Task row, and a task
        // that runs under a poorer label beats a task that was never created.
        logger.warn("[taskResourceTitle] Lookup failed", {
          context: "Tasks",
          kind,
          count: idList.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return found;
}

/**
 * The display title of ONE resource, or `null` when this app has no cached
 * name for it (an uncached item, a type that is not an item at all, or a
 * lookup that failed). Never throws.
 */
export async function resolveTaskResourceTitle(
  db: PrismaClient,
  shop: string,
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
): Promise<string | null> {
  if (!taskResourceKind(resourceType, resourceId)) return null;
  const titles = await resolveTaskResourceTitles(db, shop, [{ resourceType, resourceId }]);
  return titles.get((resourceId as string).trim()) ?? null;
}

/**
 * The shape almost every creation site wants: whatever title the caller
 * already holds, else the cached one, else a readable last resort.
 *
 * `fallback` is deliberately the LAST word and defaults to nothing: a raw GID
 * is only better than an empty subject because the card's Shopify deep link
 * hangs off the same row — pass `resourceId` where that is the intent, and
 * omit it where a missing title should simply leave the line out.
 */
export async function taskTitleOrFallback(
  db: PrismaClient,
  shop: string,
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
  known?: string | null,
  fallback?: string | null,
): Promise<string | undefined> {
  const provided = clean(known);
  if (provided) return provided;
  const resolved = await resolveTaskResourceTitle(db, shop, resourceType, resourceId);
  return resolved ?? clean(fallback) ?? undefined;
}
