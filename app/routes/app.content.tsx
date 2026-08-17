import { redirect, type LoaderFunctionArgs } from "react-router";

/**
 * Legacy redirect route.
 *
 * `/app/content?type=…` was the original combined content editor. It has been
 * superseded by dedicated per-type routes (each with its own editor and the
 * native Shopify save bar). This route now only redirects old links/bookmarks
 * to the matching route, preserving the Shopify session params (shop, host,
 * embedded, …). Nothing in the app links here anymore.
 */
const TYPE_ROUTES: Record<string, string> = {
  collections: "/app/collections",
  blogs: "/app/blog",
  pages: "/app/pages",
  policies: "/app/policies",
  menus: "/app/menus",
  templates: "/app/templates",
  metaobjects: "/app/metaobjects",
  shopMetadata: "/app/metadata",
};

export const loader = ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "";
  const target = TYPE_ROUTES[type] || "/app/menus";

  // Preserve all other params (shop, host, embedded, …); drop the consumed `type`.
  url.searchParams.delete("type");
  const search = url.searchParams.toString();

  return redirect(search ? `${target}?${search}` : target);
};
