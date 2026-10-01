/**
 * Where does a Task row's item open — INSIDE this app.
 *
 * The Tasks page used to link its rows at `https://<shop>/admin/<path>/<id>`,
 * i.e. out of the app and into the Shopify admin, which is the one editor that
 * cannot show what the task actually did: a translation, an alt text, a
 * metaobject field. This app has its own editor for every one of those, and it
 * is reachable by the `?select=<GID>` deep link the SEO dashboard, the crawl
 * report, the hreflang audit and the structured-data section already use.
 *
 * Two rules, and both are why this is a module rather than a map in the route:
 *
 *  - **The GID decides**, through `taskResourceKind` — the same single rule
 *    that decides which cache table can NAME the item. The old admin-path map
 *    keyed off the `resourceType` STRING and had drifted: the blogs editor
 *    stores `"Article"` for a post (`content-fields.config.tsx`), which the map
 *    did not list, so every blog task lost its link; and it mapped `"Blog"` —
 *    a blog CONTAINER — onto `/admin/articles/<id>`, an address that names a
 *    different object. A GID cannot be read two ways.
 *  - **No entry is no link.** A site-wide SEO run, a theme content group
 *    (`group_<id>`), an `OnlineStoreTheme`, an e-mail template: these name no
 *    single item, so the row renders its subject as plain text. That is the
 *    right answer and always was — never a guessed route.
 */

import { taskResourceKind, type TaskResourceKind } from "./task-resource-kind.shared";

/**
 * Kind -> the route that can select it.
 *
 * `article` and `blog` share `/app/blog` on purpose: that page's item list
 * holds both the Blog containers and their posts, each under its own GID, so
 * one `?select=` reaches either. `metaobject` names an ENTRY and the route
 * resolves it to its TYPE server-side (app.metaobjects.tsx), which is the only
 * place that mapping can be made.
 */
const KIND_TO_ROUTE: Record<TaskResourceKind, string> = {
  product: "/app/products",
  collection: "/app/collections",
  page: "/app/pages",
  article: "/app/blog",
  blog: "/app/blog",
  shopPolicy: "/app/policies",
  metaobject: "/app/metaobjects",
  menu: "/app/menus",
};

export interface TaskEditorDeepLink {
  /** The in-app route — always absolute, always under `/app`. */
  path: string;
  /** The value for `?select=`: the resource's full Shopify GID. */
  select: string;
}

/**
 * The in-app editor link for a Task row, or `null` when the row names no
 * single item this app can open.
 *
 * `resourceType` is passed through to `taskResourceKind` unchanged — it is a
 * hint that function deliberately does not consult today, kept in the
 * signature so the two can never be called with different information.
 */
export function taskEditorDeepLink(
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
): TaskEditorDeepLink | null {
  const kind = taskResourceKind(resourceType, resourceId);
  if (!kind) return null;
  return { path: KIND_TO_ROUTE[kind], select: (resourceId as string).trim() };
}
