/**
 * A content page's own action, answered as JSON.
 *
 * The editor's plain-`fetch` saves (a field or an alt text copied to all
 * languages, the product editor's option / metafield translations) fire one
 * `fetch` per locale or per resource. Posted to the page route they were
 * answered with the rendered HTML document -- a full page render each, and an
 * answer nobody could read, so a failed save was reported as copied. See
 * content-action-endpoint.shared.ts.
 *
 * This route runs the page's OWN exported `action` -- not a copy of it, so
 * every page keeps its exact checks -- on a request rebuilt for the page's URL,
 * and hands back whatever it returns. Those checks live in the action
 * factories every listed page is built with: the plan gate by content type
 * (`makeContentRouteAction` / `makeThemeContentRouteAction` in app/utils, and
 * the cookie banner's own `updateContent` branch), plus managed AI, theme
 * scope and resource id inside the shared handlers. This route adds no gate of
 * its own and needs none: it can only reach an action that already has one.
 * A resource route (no default export) serialises that as JSON.
 *
 * It is not a second door to the editors: only the pages in the shared list,
 * and per page only `updateContent`, the editor's "translate all" runs on
 * every listed page (`CONTENT_EDITOR_EVERY_PAGE_ACTIONS`: `translateAll`,
 * `translateAllForLocale` -- their own request so a save never queues behind
 * an AI run on the editor's one fetcher), plus the actions that page's
 * plain-fetch callers send (`CONTENT_EDITOR_EXTRA_ACTIONS`).
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import {
  contentEditorActionAllowed,
  contentEditorActionPage,
  type ContentEditorActionPage,
} from "~/services/editor/content-action-endpoint.shared";
import { apiAuthBounceRejection } from "~/utils/api-auth-bounce.server";

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
  // Per page: `updateContent` everywhere, plus the page's own fetch-sent
  // actions (the product editor's sub-resource translations).
  if (!contentEditorActionAllowed(page, String(formData.get("action") ?? ""))) {
    return json({ success: false, error: "Unsupported action" }, { status: 400 });
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
  try {
    return await pageAction({ ...args, request: pageRequest });
  } catch (error) {
    // The page action authenticates against the PAGE's URL (`/app/...`), so
    // the `/api/*` bounce conversion in enhancedAuthenticate.admin does not
    // recognise it: a fetch that arrived without a session token got the App
    // Bridge bounce page (200 HTML) back through this door. Judged here
    // against the ORIGINAL `/api` request, which is what the browser sent --
    // same 401 + retry header and the same warn line as every other `/api`
    // route. Anything else (a redirect, a real error) is re-thrown unchanged.
    throw apiAuthBounceRejection(error, request) ?? error;
  }
};
