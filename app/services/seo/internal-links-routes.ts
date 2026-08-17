/**
 * Where a suggestion's SOURCE item is edited: the real editor route that owns
 * it, plus the contentConfig field key an accepted link is written into.
 *
 * Client-safe on purpose (plain data, no server imports) — the suggestions page
 * needs the paths for "open in editor", while the apply endpoint needs the
 * field keys. Keeping ONE map means the two cannot drift apart.
 */
export const RESOURCE_ROUTE: Record<string, { path: string; fieldKey: "description" | "body" }> = {
  Product: { path: "/app/products", fieldKey: "description" },
  Collection: { path: "/app/collections", fieldKey: "description" },
  Article: { path: "/app/blog", fieldKey: "body" },
  Page: { path: "/app/pages", fieldKey: "body" },
};

/** Endpoint the suggestions page posts every action to (a resource route). */
export const INTERNAL_LINKS_API = "/api/seo-internal-links";

/**
 * "Alle annehmen" applies at most this many suggestions per click. Each one is
 * a full editor save (Shopify mutation + stale-translation purge), so the whole
 * pending list — up to MAX_PENDING_PER_SHOP = 200 — would run far past any
 * sensible request duration. The response reports what is left so the merchant
 * can simply click again; "Alle ablehnen" has no such cap because it is a
 * single UPDATE.
 *
 * Lives here rather than in the endpoint because the confirmation dialog names
 * the number — and a page must never import a route module (that would drag
 * server-only imports into the client bundle).
 */
export const BULK_ACCEPT_LIMIT = 25;
