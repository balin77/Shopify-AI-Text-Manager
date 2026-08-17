/**
 * PLAN_CONTENT_CREATION §Phase 3.4 / §A2 — telling IndexNow about a page,
 * article or blog that just became visible.
 *
 * ── Why this file exists at all ────────────────────────────────────────────
 * Products and collections are covered: Shopify emits `products/update` and
 * `collections/update`, and [webhooks.products.tsx](../../routes/webhooks.products.tsx)
 * already enqueues from them. Shopify emits **no webhook for pages, articles
 * or blogs**. So a page this app publishes reaches IndexNow only when a
 * merchant remembers to send the entire catalogue by hand — which is to say,
 * usually never. The editor's own save is the only moment anything knows.
 *
 * ── What is enqueued, and when ─────────────────────────────────────────────
 * The TRANSITION, not the save. `shouldEnqueuePublishChange` is the rule: a
 * draft is never pinged (its URL is a 404 no engine ever knew about), and an
 * item that just went from visible to hidden IS pinged, because reporting a
 * removal is half of what IndexNow is for.
 *
 * A handle change is the second case: the OLD URL is now a 404 (or a redirect
 * — §Phase 3.3), and it is only worth reporting if it was ever live. The
 * product webhook applies the same rule to `before.handle`.
 *
 * ── Never fails the save ───────────────────────────────────────────────────
 * Same contract as the handle redirect: the content update has already
 * happened. Every failure is swallowed and logged. A merchant told their edit
 * failed when it did not is worse than a URL that gets crawled a day later.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";
import {
  articleUrl,
  enqueueIndexNowUrl,
  getEnabledConfig,
  shouldEnqueuePublishChange,
  storefrontUrl,
} from "./index-now.service";

/** The three types with no webhook of their own. */
export type PublishableResource = "page" | "article" | "blog";

export interface PublishChange {
  resource: PublishableResource;
  /** Visibility BEFORE the save, from the cache. `undefined` = not known. */
  previousPublished: boolean | null | undefined;
  /** Visibility AFTER the save, from Shopify's echo where there is one. */
  nextPublished: boolean | null | undefined;
  previousHandle: string | null | undefined;
  nextHandle: string | null | undefined;
  /** Articles live under their blog; without it their URL is not derivable. */
  blogHandle?: string | null;
  /**
   * Lazy alternative to `blogHandle`, for callers whose lookup is expensive.
   * Resolving an article's blog costs a DB read plus a GraphQL call, and this
   * module returns early for every shop with IndexNow switched off — so an
   * eagerly-passed value would put that round-trip in the critical path of
   * every article save on every shop, including the ones that cannot use it.
   */
  loadBlogHandle?: () => Promise<string | null>;
}

/**
 * Builds the URLs this change makes worth re-crawling. Pure, so the rules —
 * which are the whole point — are testable without a shop.
 *
 * Returns storefront paths' full URLs on `host`, de-duplicated.
 */
export function indexNowUrlsForPublishChange(host: string, change: PublishChange): string[] {
  const urls: string[] = [];
  const urlFor = (handle: string | null | undefined): string | null => {
    const clean = (handle ?? "").trim();
    if (!clean) return null;
    if (change.resource === "article") {
      const blog = (change.blogHandle ?? "").trim();
      // Without the blog handle the article's URL cannot be built, and a
      // guessed one would ask an engine to crawl an address that never
      // existed. Same rule as the handle redirect.
      return blog ? articleUrl(host, blog, clean) : null;
    }
    // A blog's INDEX is `/blogs/<handle>` — not a "flat" type at all.
    // `storefrontUrl` knows only product/collection/page, so the blog case is
    // built here rather than borrowed from the page shape, which would have
    // submitted `/pages/<blog-handle>`: a URL that does not exist, for a
    // resource that does.
    if (change.resource === "blog") {
      return `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/blogs/${clean}`;
    }
    return storefrontUrl(host, change.resource, clean);
  };

  if (shouldEnqueuePublishChange(change.previousPublished, change.nextPublished)) {
    const current = urlFor(change.nextHandle ?? change.previousHandle);
    if (current) urls.push(current);
  }

  // A renamed handle leaves the old URL behind — worth reporting only if that
  // URL was ever live, exactly as the product webhook decides it.
  const renamed =
    !!change.previousHandle &&
    !!change.nextHandle &&
    change.previousHandle.trim().toLowerCase() !== change.nextHandle.trim().toLowerCase();
  if (renamed && change.previousPublished === true) {
    const old = urlFor(change.previousHandle);
    if (old) urls.push(old);
  }

  return [...new Set(urls)];
}

/** Blogs have no `isPublished`; their index page exists as soon as they do. */
function normalizeChange(change: PublishChange): PublishChange {
  if (change.resource !== "blog") return change;
  return { ...change, previousPublished: true, nextPublished: true };
}

/**
 * Enqueues whatever this save made worth re-crawling. No-op unless IndexNow is
 * configured and enabled for the shop, so shops without it pay one cached
 * config lookup and nothing else.
 */
export async function enqueuePublishChange(
  db: PrismaClient,
  shop: string,
  change: PublishChange,
): Promise<void> {
  try {
    const config = await getEnabledConfig(db, shop);
    if (!config) return;

    // The config's `host` is the shop's PRIMARY domain, persisted there
    // precisely so this path needs no lookup. A myshopify URL published
    // outwards is a non-canonical redirect and fails IndexNow's ownership
    // check — see the note at the top of index-now.service.ts.
    // Only NOW, past the config check, is the blog handle worth resolving.
    const resolved = change.loadBlogHandle
      ? { ...change, blogHandle: await change.loadBlogHandle() }
      : change;

    const urls = indexNowUrlsForPublishChange(config.host, normalizeChange(resolved));
    if (urls.length === 0) return;

    for (const url of urls) await enqueueIndexNowUrl(db, shop, url);
    logger.info("[IndexNow] Enqueued a content change with no webhook of its own", {
      context: "IndexNow",
      shop,
      resource: change.resource,
      urls: urls.length,
    });
  } catch (error) {
    // Best effort by design — see the header. The save already happened.
    logger.warn("[IndexNow] Could not enqueue a content change", {
      context: "IndexNow",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
