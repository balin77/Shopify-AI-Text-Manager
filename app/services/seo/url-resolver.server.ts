/**
 * Shared URL → Shopify resource resolver (PLAN_SEO_SUITE_COMPLETION.md §3.1 /
 * §1 "Shared infrastructure"). Extracted verbatim (no behavior change) from:
 *
 *  - `resolveGscPagePath` — previously module-internal to
 *    google-search-console.server.ts (was exported from there for the Quick
 *    wins "Optimize" deep-link + unit tests).
 *  - the batched handle→id lookup previously named `resolveQuickWinResources`
 *    in app.seo.search-console.tsx.
 *
 * Both original call sites now import from here instead of keeping their own
 * copy — this is a move, not a rebuild, so the JSON-LD /  crawler / GSC
 * consumers can never drift against each other on what a storefront path
 * resolves to. The Phase-1 crawler (crawl.service.ts) is the new third
 * consumer: it resolves every crawled URL's path the same way, including the
 * locale-prefix detection (`resolveGscPagePath`'s `locale` field) that feeds
 * `SeoCrawlPage.locale`.
 */

import type { PrismaClient } from "@prisma/client";

/** A URL path resolved to the store resource it points at. */
export interface ResolvedGscPage {
  /**
   * "Policy" is deliberately part of this union even though it is NOT an
   * `AuditType`: `/policies/refund-policy` is a real, editable storefront page
   * (Settings → Policies, body only), and leaving it unresolved meant the crawl
   * report offered no "open in editor" on any policy page of any shop. Callers
   * that only handle the four content types must filter it out explicitly —
   * the GSC ones do.
   */
  resourceType: "Product" | "Collection" | "Page" | "Article" | "Policy";
  handle: string;
  /**
   * The locale prefix the path carried (e.g. "de" from "/de/products/foo"),
   * lowercased, or null for an unprefixed path. GSC queries carry no locale —
   * for a multilingual shop a French query ranks on the FR page, so the adopt
   * flow (PLAN_KEYWORDS_EXPANSION.md §4.2) uses this as the LOCALE SUGGESTION
   * for the tracked keyword (validated against the shop's published locales
   * by the caller — a random two-letter first segment must not silently
   * create keywords under a nonexistent locale). The crawler (Phase 1) uses
   * the same field to set `SeoCrawlPage.locale`.
   */
  locale: string | null;
}

// Matches an optional leading locale segment in a storefront path, e.g.
// "/de/products/foo" or "/en-us/collections/bar" — Shopify prefixes every
// path with the active locale under an internationalized domain/subfolder
// setup, and that segment must be stripped before matching /products/ etc.
const LOCALE_SEGMENT_RE = /^[a-z]{2}(-[a-z]{2,4})?$/i;

/**
 * Map a storefront path/URL (as returned by GSC's page-dimensioned rows, OR
 * a URL the crawler visited) back to the store resource it points at. Pure
 * and exported for unit testing. Returns null for anything that isn't a
 * recognized content path (home page, /search, cart, unknown routes, or an
 * unparsable URL) — callers must not render a resource-linked action then.
 */
export function resolveGscPagePath(pageUrl: string): ResolvedGscPage | null {
  let path: string;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    return null;
  }

  const segments = path.split("/").filter(Boolean);
  let locale: string | null = null;
  if (segments.length > 0 && LOCALE_SEGMENT_RE.test(segments[0])) {
    locale = segments[0].toLowerCase();
    segments.shift();
  }
  if (segments.length === 0) return null;

  const [first, second, third] = segments;
  if (first === "products" && second) return { resourceType: "Product", handle: second, locale };
  if (first === "collections" && second) return { resourceType: "Collection", handle: second, locale };
  if (first === "pages" && second) return { resourceType: "Page", handle: second, locale };
  // /blogs/<blogHandle>/<articleHandle> — the article's own handle (third
  // segment) is what SeoKeyword/Article rows are keyed by, not the blog handle.
  if (first === "blogs" && second && third) return { resourceType: "Article", handle: third, locale };
  // /policies/<policyHandle> — the handle IS the policy type in kebab case
  // ("refund-policy" ⇄ REFUND_POLICY); ShopPolicy has no handle column.
  if (first === "policies" && second) return { resourceType: "Policy", handle: second, locale };
  return null;
}

const RESOURCE_MODELS = ["Product", "Collection", "Page", "Article", "Policy"] as const;

/** `/policies/refund-policy` → `REFUND_POLICY`, the `ShopPolicy.type` value. */
export function policyHandleToType(handle: string): string {
  return handle.toUpperCase().replace(/-/g, "_");
}

/** A resolved path, now including the DB id when the handle matched a cached row. */
export interface ResolvedResourceRef {
  resourceType: ResolvedGscPage["resourceType"];
  handle: string;
  locale: string | null;
  /** Shopify GID, or null when no cached row has this handle for this shop. */
  id: string | null;
}

/**
 * Best-effort resolve a batch of storefront paths/URLs to the store resources
 * they point at (Product/Collection/Page/Article), scoped to `shop`. Uses one
 * batched `findMany` per resource type instead of one query per URL — the
 * technique `resolveQuickWinResources` (app.seo.search-console.tsx) used
 * before this extraction, generalized so the crawler can resolve up to
 * thousands of URLs per run just as cheaply.
 *
 * A DB failure here must not break the caller — returns an all-null-id map
 * (every URL present, `id: null`) rather than throwing.
 *
 * Returns a Map keyed by the ORIGINAL url/path string passed in (not the
 * normalized handle), value `null` for URLs that don't match any recognized
 * content path at all (resolveGscPagePath returned null for them).
 */
export async function resolvePathsToResources(
  db: PrismaClient,
  shop: string,
  urls: string[],
): Promise<Map<string, ResolvedResourceRef | null>> {
  const parsed = urls.map((url) => ({ url, resolved: resolveGscPagePath(url) }));

  const handlesByType: Record<(typeof RESOURCE_MODELS)[number], Set<string>> = {
    Product: new Set(),
    Collection: new Set(),
    Page: new Set(),
    Article: new Set(),
    Policy: new Set(),
  };
  for (const { resolved } of parsed) {
    if (resolved) handlesByType[resolved.resourceType].add(resolved.handle);
  }

  const idByTypeAndHandle = new Map<string, string>(); // key: `${resourceType}::${handle}`
  try {
    // ShopPolicy is keyed by TYPE, not by handle — the storefront handle is the
    // type in kebab case, so the `in` list is built from the mapped values and
    // mapped back below.
    const policyTypes = Array.from(handlesByType.Policy).map(policyHandleToType);
    const [products, collections, pages, articles, policies] = await Promise.all([
      handlesByType.Product.size
        ? db.product.findMany({
            where: { shop, handle: { in: Array.from(handlesByType.Product) } },
            select: { id: true, handle: true },
          })
        : Promise.resolve([]),
      handlesByType.Collection.size
        ? db.collection.findMany({
            where: { shop, handle: { in: Array.from(handlesByType.Collection) } },
            select: { id: true, handle: true },
          })
        : Promise.resolve([]),
      handlesByType.Page.size
        ? db.page.findMany({
            where: { shop, handle: { in: Array.from(handlesByType.Page) } },
            select: { id: true, handle: true },
          })
        : Promise.resolve([]),
      handlesByType.Article.size
        ? db.article.findMany({
            where: { shop, handle: { in: Array.from(handlesByType.Article) } },
            select: { id: true, handle: true },
          })
        : Promise.resolve([]),
      policyTypes.length
        ? db.shopPolicy.findMany({
            where: { shop, type: { in: policyTypes } },
            select: { id: true, type: true },
          })
        : Promise.resolve([]),
    ]);
    for (const p of products as { id: string; handle: string }[]) idByTypeAndHandle.set(`Product::${p.handle}`, p.id);
    for (const c of collections as { id: string; handle: string }[]) idByTypeAndHandle.set(`Collection::${c.handle}`, c.id);
    for (const pg of pages as { id: string; handle: string }[]) idByTypeAndHandle.set(`Page::${pg.handle}`, pg.id);
    for (const a of articles as { id: string; handle: string }[]) idByTypeAndHandle.set(`Article::${a.handle}`, a.id);
    // Back from `REFUND_POLICY` to the `refund-policy` the URL carried, so the
    // key composes exactly like the handle-keyed types above.
    for (const pol of policies as { id: string; type: string }[]) {
      idByTypeAndHandle.set(`Policy::${pol.type.toLowerCase().replace(/_/g, "-")}`, pol.id);
    }

    // TRANSLATED handles. Shopify serves a translated resource under its own
    // translated handle — `/es/products/caja-kumiko-…` is the SAME product as
    // `/products/kumikobox-…` — and the cache tables only carry the PRIMARY
    // handle. Without this pass every foreign-locale URL of a shop that
    // translates its handles resolves to `id: null`, which on the crawl report
    // means no "open in editor" button on what is often most of the catalogue.
    //
    // Runs only for the handles the primary lookup did NOT find, so a
    // single-language shop pays one extra query with an empty `in` list — i.e.
    // nothing. `ContentTranslation.resourceType` uses the same capitalized
    // convention as `ResolvedGscPage.resourceType`, so the key composes directly.
    const unresolved = new Map<string, Set<string>>();
    for (const { resolved } of parsed) {
      if (!resolved) continue;
      if (idByTypeAndHandle.has(`${resolved.resourceType}::${resolved.handle}`)) continue;
      const set = unresolved.get(resolved.resourceType) ?? new Set<string>();
      set.add(resolved.handle);
      unresolved.set(resolved.resourceType, set);
    }
    const allUnresolved = Array.from(unresolved.values()).flatMap((set) => Array.from(set));
    if (allUnresolved.length > 0) {
      const rows: { resourceId: string; resourceType: string; value: string }[] =
        await db.contentTranslation.findMany({
          where: { shop, key: "handle", value: { in: allUnresolved } },
          select: { resourceId: true, resourceType: true, value: true },
        });
      for (const row of rows) {
        const key = `${row.resourceType}::${row.value}`;
        // First writer wins. A handle translated identically in two locales
        // points at the same resource anyway; two DIFFERENT resources sharing
        // one translated handle cannot happen on Shopify (handles are unique
        // per type), so there is nothing to disambiguate.
        if (!idByTypeAndHandle.has(key)) idByTypeAndHandle.set(key, row.resourceId);
      }
    }
  } catch {
    // Best-effort: leave idByTypeAndHandle empty — every URL falls back to
    // id:null below rather than failing the whole caller.
  }

  const out = new Map<string, ResolvedResourceRef | null>();
  for (const { url, resolved } of parsed) {
    if (!resolved) {
      out.set(url, null);
      continue;
    }
    const id = idByTypeAndHandle.get(`${resolved.resourceType}::${resolved.handle}`) ?? null;
    out.set(url, { resourceType: resolved.resourceType, handle: resolved.handle, locale: resolved.locale, id });
  }
  return out;
}
