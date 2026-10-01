/**
 * A content page's own action, answered as JSON.
 *
 * The editor's "copy to all languages" saves (a field, an alt text) fire one
 * plain `fetch` per locale. Posted to the page route they were answered with
 * the rendered HTML document -- a full page render per locale, and an answer
 * nobody could read, so a failed save was reported as copied. See
 * content-action-endpoint.shared.ts.
 *
 * This route runs the page's OWN exported `action` -- not a copy of it, so
 * every page keeps its exact checks -- on a request rebuilt for the page's URL,
 * and hands back whatever it returns. Those checks live in the action
 * factories every listed page is built with: the plan gate by content type
 * (`makeContentRouteAction` / `makeThemeContentRouteAction` in app/utils, and
 * the cookie banner's own `updateContent` branch), plus managed AI, theme
 * scope and resource id inside the shared handlers. This route adds no gate of
 * its own and needs none: it can only reach an action that already has one. A resource route (no default export) serialises that as JSON.
 *
 * It is not a second door to the editors: only the pages in the shared list,
 * and only `updateContent`, which is what both callers send.
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import {
  CONTENT_EDITOR_FETCH_ACTION,
  contentEditorActionPage,
  type ContentEditorActionPage,
} from "~/services/editor/content-action-endpoint.shared";

type PageModule = { action: (args: ActionFunctionArgs) => unknown };

const PAGE_ACTIONS: Record<ContentEditorActionPage, () => Promise<PageModule>> = {
  "/app/products": () => import("./app.products"),
  "/app/collections": () => import("./app.collections"),
  "/app/pages": () => import("./app.pages"),
  "/app/blog": () => import("./app.blog"),
  "/app/policies": () => import("./app.policies"),
  "/app/metaobjects": () => import("./app.metaobjects"),
  "/app/cookie-banner": () => import("./app.cookie-banner"),
  "/app/templates": () => import("./app.templates"),
  "/app/delivery": () => import("./app.delivery"),
  "/app/selling-plans": () => import("./app.selling-plans"),
  "/app/system": () => import("./app.system"),
  "/app/online-store-extras": () => import("./app.online-store-extras"),
  "/app/shop-metadata": () => import("./app.shop-metadata"),
  "/app/theme-app-embeds": () => import("./app.theme-app-embeds"),
  "/app/theme-section-groups": () => import("./app.theme-section-groups"),
  "/app/theme-settings": () => import("./app.theme-settings"),
  "/app/theme-standard": () => import("./app.theme-standard"),
  "/app/theme-static-sections": () => import("./app.theme-static-sections"),
};

export const action = async (args: ActionFunctionArgs) => {
  const { request } = args;
  const formData = await request.formData();

  if (formData.get("action") !== CONTENT_EDITOR_FETCH_ACTION) {
    return json({ success: false, error: "Unsupported action" }, { status: 400 });
  }

  // `_page` is the page's path plus its query. Only the path is matched
  // against the list; the query rides along so the action sees its own URL.
  const rawPage = String(formData.get("_page") ?? "");
  formData.delete("_page");
  const pageUrl = new URL(rawPage || "/", request.url);
  // Same origin only: `new URL` takes an absolute URL as-is, and a page
  // spelled as one would otherwise name a foreign host.
  const page = pageUrl.origin === new URL(request.url).origin
    ? contentEditorActionPage(pageUrl.pathname)
    : null;
  if (!page) {
    return json({ success: false, error: "Unknown page" }, { status: 400 });
  }

  const { action: pageAction } = await PAGE_ACTIONS[page]();
  // The page's action authenticates itself from these headers (the session
  // token), exactly as it would on its own route.
  // Minus the body's own framing: the FormData is re-encoded with a new
  // multipart boundary, and the old Content-Type would name the old one.
  const headers = new Headers(request.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  const pageRequest = new Request(pageUrl, {
    method: "POST",
    headers,
    body: formData,
    signal: request.signal,
  });
  return pageAction({ ...args, request: pageRequest });
};
