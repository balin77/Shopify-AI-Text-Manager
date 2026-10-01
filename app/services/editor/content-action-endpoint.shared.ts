/**
 * Where an editor's plain-`fetch` save goes, and how its answer is read.
 *
 * Two editor paths save with a plain `fetch` instead of a fetcher, because
 * they fire one request per locale at once ("copy to all languages" for a
 * field and for an alt text). They used to post to `window.location.pathname`
 * -- the PAGE route. React Router answers a plain POST to a page route by
 * running the action AND rendering the whole document, so every locale cost a
 * full page render, and the answer was HTML: nobody could tell a failed save
 * from a successful one, and the merchant was told "copied" either way.
 *
 * `/api/content-editor-action` (api.content-editor-action.tsx) runs the SAME
 * page action and answers with its JSON. Import-free, because the hooks pull
 * it into the client bundle and the route into the server graph -- one list
 * for both, so a page the route knows is exactly a page the client sends.
 */

import { PLAN_REFUSED, isPlanRefusal, saveAnswerFailed } from "./per-locale-saves.shared";

export const CONTENT_EDITOR_ACTION_ENDPOINT = "/api/content-editor-action";

/** The only action this door takes: both callers save through `updateContent`. */
export const CONTENT_EDITOR_FETCH_ACTION = "updateContent";

/** Every page whose editor saves with a plain fetch. */
export const CONTENT_EDITOR_ACTION_PAGES = [
  "/app/products",
  "/app/collections",
  "/app/pages",
  "/app/blog",
  "/app/policies",
  "/app/metaobjects",
  "/app/cookie-banner",
  "/app/templates",
  "/app/delivery",
  "/app/selling-plans",
  "/app/system",
  "/app/online-store-extras",
  "/app/shop-metadata",
  "/app/theme-app-embeds",
  "/app/theme-section-groups",
  "/app/theme-settings",
  "/app/theme-standard",
  "/app/theme-static-sections",
] as const;

export type ContentEditorActionPage = (typeof CONTENT_EDITOR_ACTION_PAGES)[number];

/** The page path without a trailing slash, or null for a page not listed. */
export function contentEditorActionPage(pathname: string): ContentEditorActionPage | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (CONTENT_EDITOR_ACTION_PAGES as readonly string[]).includes(normalized)
    ? (normalized as ContentEditorActionPage)
    : null;
}

/**
 * Posts one editor save and says whether it landed.
 *
 * `true` / `false` when the answer could be read (`PLAN_REFUSED` for the
 * plan gate's 403); `null` when it cannot be
 * known -- a page this list does not name goes to its own route as before,
 * whose HTML answer says nothing, and a caller must not report THAT as a
 * failure. The page's own path and query travel along so the action runs on
 * the URL it would have seen.
 */
export async function postContentEditorSave(
  formData: FormData,
  location: { pathname: string; search: string } = window.location,
): Promise<boolean | null | typeof PLAN_REFUSED> {
  const page = contentEditorActionPage(location.pathname);
  if (!page) {
    try {
      await fetch(location.pathname, { method: "POST", body: formData });
    } catch {
      // Unknowable either way; see the doc comment.
    }
    return null;
  }
  formData.set("_page", `${page}${location.search}`);
  try {
    const response = await fetch(CONTENT_EDITOR_ACTION_ENDPOINT, { method: "POST", body: formData });
    if (!response.ok) return (await isPlanRefusal(response)) ? PLAN_REFUSED : false;
    // A save can answer `success: true` and still name what it refused
    // (`failedAltTextIndices`): that is a failure for the caller too.
    const body = await response.json().catch(() => null);
    return !saveAnswerFailed(body);
  } catch {
    return false;
  }
}
