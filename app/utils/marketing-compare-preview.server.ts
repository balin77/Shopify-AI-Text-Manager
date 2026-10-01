/**
 * Whether this request may see UNPUBLISHED comparison topics: only with
 * `?preview` in the URL and never on the production deployment, so facts
 * that are still being researched can be looked at on development without
 * being published. A preview page is marked noindex as well.
 */
export function comparePreviewAllowed(url: URL): boolean {
  return url.searchParams.has("preview") && process.env.APP_ENV !== "production";
}
