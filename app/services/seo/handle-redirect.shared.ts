/**
 * PLAN_CONTENT_CREATION §Phase 3.3 / §A1 — a handle change breaks the old URL.
 *
 * This app changes handles in three places today — the single editor, the bulk
 * editor's `field.handle` column, and bulk-translate — and creates a redirect
 * in NONE of them. Every one of those edits silently 404s whatever linked to
 * the old address: search results, the merchant's own newsletter, other shops.
 * Shopify's admin offers a checkbox for exactly this; going through the API
 * removed the checkbox and, with it, the redirect.
 *
 * The decision is pure and lives here so all three write paths can share it and
 * so the cases that must NOT redirect are testable. Those cases are the whole
 * reason this is not a one-liner:
 *
 *   - a BRAND-NEW object has no old URL. A redirect from a handle that never
 *     existed is at best noise in the merchant's redirect list and at worst a
 *     loop once they reuse that handle elsewhere.
 *   - an unchanged handle is not a change, and neither is one that differs
 *     only in case or surrounding whitespace — Shopify normalises both.
 *   - a redirect whose source and target are equal is a LOOP. Shopify would
 *     accept it; the crawler in this very app would then report it.
 *   - the merchant may not want one. It is offered, not imposed.
 */

/** The types whose storefront URL is derived from a handle. */
export type RedirectableResource = "product" | "collection" | "page" | "article" | "blog";

/**
 * The app's own resource names → the ones above. Blog CONTAINERS and articles
 * share a tab and are told apart by their GID, which is why this takes the id.
 * Types with no handle-derived storefront URL (policies, metaobjects, theme
 * content) map to null.
 */
export function redirectResourceFor(
  resourceType: string,
  itemId: string,
): RedirectableResource | null {
  // The blogs tab serves BOTH, and their URLs differ in shape.
  if (itemId.includes("/Blog/")) return resourceType === "Article" || resourceType === "Blog" ? "blog" : null;
  switch (resourceType) {
    case "Product":    return "product";
    case "Collection": return "collection";
    case "Page":       return "page";
    case "Article":    return "article";
    default:           return null;
  }
}

/**
 * Does this save want a redirect?
 *
 * Three inputs, in precedence order, because there are three legitimate
 * answers and collapsing them loses one: an explicit per-save choice (a future
 * per-edit checkbox — the wire format exists now so adding it needs no server
 * change), then the shop's stored preference, and only then the default.
 *
 * The default is ON: a stray redirect is untidy, a broken URL costs traffic.
 * `null`/`undefined` from the settings row means "shop row predates the
 * column", which must behave as on rather than as an opt-out nobody chose.
 */
export function resolveRedirectPreference(
  submitted: string | null | undefined,
  shopPreference: boolean | null | undefined,
): boolean {
  if (submitted === "true") return true;
  if (submitted === "false") return false;
  return shopPreference !== false;
}

export interface HandleRedirectRequest {
  resource: RedirectableResource;
  previousHandle: string | null | undefined;
  nextHandle: string | null | undefined;
  /** The merchant's checkbox. Off ⇒ nothing happens, by their choice. */
  wanted: boolean;
  /** True while creating — there is no old URL to preserve. */
  isNew?: boolean;
  /** Articles live under their blog: `/blogs/<blog>/<article>`. */
  blogHandle?: string | null;
}

export type HandleRedirectDecision =
  | { redirect: true; fromPath: string; toPath: string }
  | {
      redirect: false;
      reason: "notWanted" | "isNew" | "unchanged" | "missingHandle" | "missingBlogHandle" | "wouldLoop";
    };

/** Trim, strip surrounding slashes, lowercase — what Shopify does to a handle. */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** Storefront PATH (not URL) for a handle — redirects are path-based. */
export function storefrontPathFor(
  resource: RedirectableResource,
  handle: string,
  blogHandle?: string | null,
): string | null {
  const clean = handle.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  switch (resource) {
    case "product":    return `/products/${clean}`;
    case "collection": return `/collections/${clean}`;
    case "page":       return `/pages/${clean}`;
    // A blog's own index page. Its ARTICLES live one level below and each has
    // its own path, so this redirect does NOT cover them — Shopify's redirects
    // have no wildcards. `blogArticlesUncovered` says so rather than letting
    // the merchant assume otherwise; see the note code in the server half.
    case "blog":       return `/blogs/${clean}`;
    case "article": {
      const blog = (blogHandle ?? "").trim().replace(/^\/+|\/+$/g, "");
      // Without the blog handle the article's URL is not derivable, and a
      // guessed path is worse than none: it would redirect a URL that never
      // existed, and leave the real old one still broken.
      return blog ? `/blogs/${blog}/${clean}` : null;
    }
  }
}

export function decideHandleRedirect(request: HandleRedirectRequest): HandleRedirectDecision {
  if (!request.wanted) return { redirect: false, reason: "notWanted" };
  // A brand-new object has no old URL to preserve.
  if (request.isNew) return { redirect: false, reason: "isNew" };

  const previous = (request.previousHandle ?? "").trim();
  const next = (request.nextHandle ?? "").trim();
  if (!previous || !next) return { redirect: false, reason: "missingHandle" };

  // Compared the way the PATH is built — trimmed, unslashed, lowercased —
  // because that is what decides whether the URL actually differs. Comparing
  // the raw strings would call "/same/" → "same" a change and then refuse it
  // one step later as a loop: the same outcome, reported as the wrong reason.
  // Shopify normalises handles this way too.
  if (normalizeHandle(previous) === normalizeHandle(next)) return { redirect: false, reason: "unchanged" };

  const fromPath = storefrontPathFor(request.resource, previous, request.blogHandle);
  const toPath = storefrontPathFor(request.resource, next, request.blogHandle);
  if (!fromPath || !toPath) {
    return {
      redirect: false,
      reason: request.resource === "article" ? "missingBlogHandle" : "missingHandle",
    };
  }
  if (fromPath.toLowerCase() === toPath.toLowerCase()) return { redirect: false, reason: "wouldLoop" };

  return { redirect: true, fromPath, toPath };
}
