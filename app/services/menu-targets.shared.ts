/**
 * What a menu item can POINT AT — the pure half (no Shopify, no Prisma).
 *
 * A menu item's target is one of three shapes, and the whole picker exists
 * because a merchant should not have to know which:
 *
 *   HTTP            a free URL they type or paste
 *   target-less     FRONTPAGE, SEARCH, CATALOG, COLLECTIONS,
 *                   CUSTOMER_ACCOUNT_PAGE — the type IS the target
 *   resource-bound  PRODUCT, COLLECTION, PAGE, BLOG, ARTICLE, SHOP_POLICY,
 *                   METAOBJECT — a GID has to be chosen
 *
 * The three classes are `menu-tree.shared.ts`'s (it validates against them);
 * this module adds what a PICKER needs on top: which cache each resource type
 * is searched in, how a chosen target is described back to the merchant, and
 * whether a typed string is a usable URL.
 *
 * It is deliberately separate from `menu-tree.shared.ts`: that module is the
 * write path's vocabulary and is imported by the server, while this one is
 * imported by a route AND a component, and adding search concerns to the
 * former would put the picker's catalogue inside the save.
 */

import {
  MENU_ITEM_TYPES_NEEDING_RESOURCE,
  MENU_ITEM_TYPES_WITHOUT_TARGET,
} from "./menu-tree.shared";

/**
 * A resource-bound menu item type and where its candidates come from.
 *
 * `search` names the cache this app already keeps — no live Shopify call per
 * keystroke, and the same rows the rest of the app renders. BLOG is the one
 * exception and says so: this app has no Blog model, only `Article.blogId` /
 * `Article.blogTitle`, so its candidates are DISTINCT values off the article
 * cache. That has a stated blind spot — a blog with no articles cannot be
 * offered — which is reported in the picker rather than hidden, because an
 * absent option and an empty shop look identical from the dropdown.
 */
export interface MenuTargetGroup {
  /** The MenuItemType this group fills in. */
  type: string;
  /** Which cache the endpoint reads. */
  source: "product" | "collection" | "page" | "article" | "blogFromArticles" | "shopPolicy" | "metaobject";
  /** Key into `t.content.menuTargetGroups` — the section header. */
  labelKey: string;
}

/**
 * The order the groups appear in, which is the order a merchant looks in:
 * collections and products first (what a navigation is mostly made of), the
 * rest after, metaobjects last (the rarest by a wide margin).
 */
export const MENU_TARGET_GROUPS: MenuTargetGroup[] = [
  { type: "COLLECTION", source: "collection", labelKey: "collections" },
  { type: "PRODUCT", source: "product", labelKey: "products" },
  { type: "PAGE", source: "page", labelKey: "pages" },
  { type: "BLOG", source: "blogFromArticles", labelKey: "blogs" },
  { type: "ARTICLE", source: "article", labelKey: "articles" },
  { type: "SHOP_POLICY", source: "shopPolicy", labelKey: "policies" },
  { type: "METAOBJECT", source: "metaobject", labelKey: "metaobjects" },
];

/** Every resource-bound type has exactly one group — asserted, not assumed. */
export function menuTargetGroupFor(type: string): MenuTargetGroup | undefined {
  return MENU_TARGET_GROUPS.find((g) => g.type === type);
}

/**
 * The target-less types, in the order they are offered.
 *
 * Same list as `MENU_ITEM_TYPES_WITHOUT_TARGET` — re-stated as an order rather
 * than re-declared: `menuTargetlessTypes()` reads the write path's constant, so
 * a type added there cannot go missing from the picker, and one removed there
 * cannot linger here.
 */
const TARGETLESS_ORDER = ["FRONTPAGE", "CATALOG", "COLLECTIONS", "SEARCH", "CUSTOMER_ACCOUNT_PAGE"];

export function menuTargetlessTypes(): string[] {
  const known = new Set<string>(MENU_ITEM_TYPES_WITHOUT_TARGET);
  const ordered = TARGETLESS_ORDER.filter((t) => known.has(t));
  // Anything the write path knows and this order does not is appended rather
  // than dropped: an un-offered type is one a merchant cannot choose, and the
  // list above is a preference, not the authority.
  for (const type of MENU_ITEM_TYPES_WITHOUT_TARGET) {
    if (!ordered.includes(type)) ordered.push(type);
  }
  return ordered;
}

export function isResourceBoundMenuType(type: string): boolean {
  return (MENU_ITEM_TYPES_NEEDING_RESOURCE as readonly string[]).includes(type);
}

// ── What the endpoint returns ───────────────────────────────────────────────

export interface MenuTargetCandidate {
  /** The resource GID — exactly what `resourceId` on the item takes. */
  id: string;
  title: string;
  /** A second line: the blog a post sits in, a metaobject's type. */
  subtitle?: string;
}

export interface MenuTargetGroupResult {
  type: string;
  labelKey: string;
  items: MenuTargetCandidate[];
  /** More matches exist than were returned — the picker says so. */
  truncated: boolean;
}

export interface MenuTargetSearchResult {
  groups: MenuTargetGroupResult[];
  /**
   * A group whose lookup FAILED, by type. Never folded into an empty list:
   * "this shop has no pages" and "the page query threw" are the same zero, and
   * only one of them means the merchant should stop looking.
   */
  failed: string[];
}

// ── Reading a typed string ──────────────────────────────────────────────────

/**
 * Is this something a merchant meant as a URL?
 *
 * Deliberately generous in one direction and strict in the other. A path
 * (`/pages/about`) and an absolute `https://` URL both count, because both are
 * what Shopify's own field accepts and what a merchant pastes. A bare word does
 * NOT, or every search query would offer itself as a link and the top row of
 * the dropdown would be a mistake waiting to be clicked.
 *
 * `http://` is accepted although the storefront is https: a merchant linking to
 * a third-party site that has no certificate is making a decision this picker
 * has no standing to refuse — and refusing it silently would send them to the
 * Shopify admin, which is the one outcome this whole page exists to avoid.
 */
export function looksLikeMenuUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return true;
  if (/^https?:\/\/\S+$/i.test(trimmed)) return true;
  // "mailto:" and "tel:" are real navigation targets in a footer menu.
  if (/^(mailto:|tel:)\S+$/i.test(trimmed)) return true;
  return false;
}

/**
 * How the CURRENT target reads in the field, given what the picker knows.
 *
 * Returns a shape rather than a string because the caller owns the words: the
 * app ships in three languages, and a type name assembled here could not be
 * translated. `resourceTitle` is what the picker resolved the GID to, and its
 * ABSENCE is meaningful — an item bound to a resource that is not in the cache
 * (deleted, or never synced) shows its type plus the raw id, never a blank
 * field that reads as "no target".
 */
export interface MenuTargetSummary {
  kind: "url" | "targetless" | "resource" | "unknown";
  type: string;
  /** For `url`. */
  url?: string;
  /** For `resource`: the resolved title, or null when the GID is unresolved. */
  resourceTitle?: string | null;
  resourceId?: string | null;
}

export function summarizeMenuTarget(
  node: { type: string; url?: string | null; resourceId?: string | null },
  resolve?: (id: string) => string | undefined,
): MenuTargetSummary {
  const type = node.type || "";
  if (type === "HTTP") return { kind: "url", type, url: node.url ?? "" };
  if (isResourceBoundMenuType(type)) {
    const id = node.resourceId ?? null;
    return { kind: "resource", type, resourceId: id, resourceTitle: id ? (resolve?.(id) ?? null) : null };
  }
  if ((MENU_ITEM_TYPES_WITHOUT_TARGET as readonly string[]).includes(type)) {
    return { kind: "targetless", type };
  }
  return { kind: "unknown", type };
}

/**
 * The patch a pick produces.
 *
 * One function for all three shapes so no call site has to remember that
 * choosing a target-less type must CLEAR the resourceId — an item that was a
 * PRODUCT and becomes FRONTPAGE while keeping its old `resourceId` is a payload
 * Shopify may accept and nobody meant.
 */
export function menuTargetPatch(
  choice:
    | { kind: "url"; url: string }
    | { kind: "targetless"; type: string }
    | { kind: "resource"; type: string; id: string },
): { type: string; url: string | null; resourceId: string | null } {
  if (choice.kind === "url") return { type: "HTTP", url: choice.url.trim(), resourceId: null };
  if (choice.kind === "targetless") return { type: choice.type, url: null, resourceId: null };
  return { type: choice.type, url: null, resourceId: choice.id };
}
