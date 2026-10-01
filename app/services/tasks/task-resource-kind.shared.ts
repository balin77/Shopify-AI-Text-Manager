/**
 * Which cached ITEM does a Task row name — decided from its GID alone.
 *
 * This lived inside `resource-title.server.ts`, which is a SERVER module: the
 * Tasks page needs the same answer in the browser (to link a row into this
 * app's own editor), and a second copy of the map is how the `resourceType`
 * spellings drifted in the first place. So the rule moved here, client-safe
 * and import-free, and the server module re-exports it.
 *
 * The rule itself is unchanged and is the load-bearing part: **the GID decides
 * the kind, never the `resourceType` string.** That string reaches the Task
 * table in at least eight spellings (`product`, `products`, `Product`,
 * `blog`, `blogs`, `Article`, `Blog`, `seo`, `templates`, `templateTitles`)
 * and is ambiguous in several of them, while `gid://shopify/<Type>/<n>` is
 * exact — and it is what every cache table and every `?select=` deep link in
 * this app is keyed by. A GID type outside the allowlist is not an item this
 * app can name or open, and answers `null` rather than a guess.
 */

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
