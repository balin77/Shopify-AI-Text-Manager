import { isThemeContentType } from "./content-type-groups";

/**
 * Which `resourceType` the single-item reload posts to
 * `/api/sync-single-resource`.
 *
 * Lives here rather than inside UnifiedContentEditor because the mapping is a
 * routing decision with two non-obvious cases, and both were shipped wrong at
 * some point — a rule of that kind belongs somewhere it can be tested.
 */
export type ReloadResourceType =
  | "product"
  | "collection"
  | "page"
  | "article"
  | "blog"
  | "policy"
  | "templates";

/**
 * @param contentType the editor's rubric ("products", "blogs", "sellingPlans", …)
 * @param itemId      the selected item's Shopify GID — required to tell a blog
 *                    container apart from an article, see below
 */
export function getReloadResourceType(contentType: string, itemId?: string): ReloadResourceType {
  // The whole theme-content family (templates + system / delivery / sellingPlans
  // / onlineStoreExtras) reloads through the single-group theme-content path
  // (api.sync-single-resource → syncSingleThemeGroup, which is now domain-aware).
  // Without this, non-templates rubrics posted their raw contentType and the
  // route rejected it ("Unknown resource type: sellingPlans").
  if (isThemeContentType(contentType)) return "templates";

  // The blogs tab serves BOTH articles and blog containers, and the contentType
  // alone cannot tell them apart — the item GID can. Without this a blog
  // container reloaded as `gid://shopify/Article/<blogId>`, which resolves to
  // nothing while the route still answered "reloaded successfully": the one
  // failure mode worse than an error, a green message over an untouched cache.
  // Same discriminator the write paths use (content-update.action.ts,
  // translation.action.ts).
  if (contentType === "blogs" && itemId?.includes("/Blog/")) return "blog";

  const resourceTypeMap: Record<string, ReloadResourceType> = {
    blogs: "article",
    pages: "page",
    policies: "policy",
    collections: "collection",
    products: "product",
    templates: "templates",
  };
  return resourceTypeMap[contentType] || (contentType as ReloadResourceType);
}
