/**
 * Client-safe crawl constants.
 *
 * `crawl.service.ts` statically imports `url-resolver.server` (and cheerio), so
 * ANY component-scope reference to it pulls a server-only module into the
 * client bundle and fails `remix vite:build` outright. Loader-only imports are
 * tree-shaken and stay fine; values the rendered component needs must live
 * here instead. Same split as `bulk-editor/columns.shared.ts`.
 */

/**
 * Response time at which a page is worth warning the merchant about.
 *
 * Shopify aborts a storefront render at roughly three seconds and returns a
 * 500, so a page in this band is one busy moment away from failing for a
 * visitor or for Googlebot — measured on a real store, where the same URL
 * alternated between 2.2s (200) and 3.3s (500) depending on load.
 */
export const SLOW_PAGE_WARN_MS = 2000;
