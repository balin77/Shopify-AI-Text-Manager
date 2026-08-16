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

/** Attribution of a bot block. Mirrors `BlockSource` in crawl.service.ts —
 *  duplicated as a client-safe type for the same bundling reason as above. */
export type CrawlBlockSource =
  | "cloudflare_challenge"
  | "cloudflare_waf"
  | "cloudflare_unattributed"
  | "shopify_rate_limit"
  | "shopify_security"
  | "rate_limit"
  | "unknown";

/**
 * The snapshot view `CrawlSnapshotHeader` renders (PLAN_SEO_CRAWL_EXPANSION
 * §0.3). Lives here, not in `crawl-snapshot.server.ts`, because the header is a
 * CLIENT component: importing the type from a `.server` module would be erased
 * by TypeScript but still trips the Remix/Vite server-module guard.
 */
export interface SnapshotHeaderView {
  startedAt: string;
  finishedAt: string | null;
  status: string;
  errorCode: string | null;
  blockedBy: CrawlBlockSource | null;
  pagesCrawled: number;
  totalDiscovered: number;
}
