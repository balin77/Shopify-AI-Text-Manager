/**
 * Open Graph / Twitter Card delivery report — PLAN_MARKUP_ACTIVATION §2.4.
 *
 * The social twin of `summarizeLiveJsonLd` (json-ld-audit.service.ts), reading
 * the same crawl snapshot and answering the same two questions: what do the
 * shop's pages actually serve, and where is the same tag served twice.
 *
 * Why it exists at all: `social-meta.liquid` sets exactly the trap the JSON-LD
 * block does. Most themes already emit `og:title` and `og:image`, and two
 * `og:image` tags on one page are for Facebook and LinkedIn what two `Product`
 * nodes are for Google — the scraper picks one, and which one is not the
 * merchant's decision. Until Phase 2 there was no column for og:* at all, so
 * the section could only offer an activation button and hope.
 *
 * Three rules carry over verbatim from the JSON-LD side, and each one exists
 * because getting it wrong produces a confident, wrong report:
 *
 *  - `notMeasured` separates "this shop serves no social tags" from "this
 *    snapshot predates the columns". `socialKnown` is the discriminator and is
 *    set only when the crawl actually parsed a body.
 *  - `appIsOneCopy` is the only thing that makes "switch our embed off" the
 *    right advice. Where both copies are the theme's, our switch changes
 *    nothing and saying otherwise sends the merchant to the wrong screen.
 *  - `appEmbedDetected: boolean | null` — the absence of our marker proves
 *    nothing on its own, because a shop running an older version of the block
 *    looks identical to one with the embed switched off.
 *
 * Deliberately NOT here: a catalog-side social audit. What a page can put in
 * `og:title` / `og:image` is the SEO title, the meta description and the
 * product image — all three already scanned by `analyzeStore` and the JSON-LD
 * batch audit, and two scores for one product in two tabs help nobody (the
 * same rule catalog-readiness.service.ts follows). This module reports
 * delivery only, off the page that was actually served.
 */

import type { PrismaClient } from "@prisma/client";
// APP_SOCIAL_TAGS lives in the shared module because the activation section
// renders it in component scope — see the comment on it there.
import { APP_SOCIAL_TAGS, type MarkupTypeStat } from "./markup-activation.shared";
export { APP_SOCIAL_TAGS };
import { loadCrawlMarkupPages } from "./crawl-markup-rows.server";


// The coverage table reports `og:title` and `og:image` and nothing else on
// purpose: `og:description` and the twitter:* family degrade gracefully
// (scrapers fall back to the page's own title/description), while a missing
// image is a link that unfurls as a bare grey box.

export interface LiveSocialCoverageRow {
  resourceType: "product" | "collection" | "article" | "page";
  /** Crawled, successfully served pages of this type. */
  total: number;
  /** …of which carry og:title. */
  withTitle: number;
  /** …of which carry og:image. */
  withImage: number;
  /** Up to 5 example URLs missing at least one of the two. */
  missingExamples: string[];
}

export interface LiveSocialDuplicateRow {
  tag: string;
  /** Pages serving this tag more than once. */
  pages: number;
  examples: string[];
  /** …of which one of the copies is this app's. */
  appIsOneCopy: number;
}

export interface LiveSocialSummary {
  crawledAt: string;
  crawlStatus: string;
  /** Successfully served pages the numbers are based on. */
  pagesChecked: number;
  /**
   * True when NO served page in the snapshot was measured for social tags
   * (every `socialKnown` false). Without it an old snapshot would render as
   * "this shop serves no Open Graph at all", which is a false alarm.
   */
  notMeasured: boolean;
  coverage: LiveSocialCoverageRow[];
  /** Every og:/twitter: property served anywhere, with pages serving it. */
  tagCounts: { tag: string; pages: number }[];
  duplicates: LiveSocialDuplicateRow[];
  /** Per tag, everything the activation gate needs — see MarkupTypeStat. */
  typeStats: MarkupTypeStat[];
  /**
   * Whether this app's social block was seen emitting anything at all.
   * `null` = unknown (no page carried the marker, and none could have on a
   * snapshot from before the marked block shipped) — never "off".
   */
  appEmbedDetected: boolean | null;
}

const MAX_LIVE_EXAMPLES = 5;

const COVERAGE_RESOURCE_TYPES: LiveSocialCoverageRow["resourceType"][] = [
  "product",
  "collection",
  "article",
  "page",
];

const splitTags = (raw: string | null | undefined): string[] =>
  raw ? raw.split(",").filter(Boolean) : [];

/**
 * Summarize the social markup actually served, from the newest crawl snapshot.
 * Returns null when the shop has never completed a crawl — the UI then points
 * at the crawl section instead of showing empty numbers.
 */
export async function summarizeLiveSocial(
  db: PrismaClient,
  shop: string,
): Promise<LiveSocialSummary | null> {
  const loaded = await loadCrawlMarkupPages(db, shop);
  if (!loaded) return null;
  const { snapshot, judged } = loaded;

  // A row this crawl never PARSED contributes nothing, in either direction —
  // `loadCrawlMarkupPages` already dropped those. `socialKnown` narrows once
  // more, to rows written after the og:* columns existed: a snapshot can know
  // the JSON-LD half and not this one, since these columns are younger.
  const measured = judged.filter((r) => r.socialKnown);

  const duplicateExamples = new Map<string, string[]>();
  const duplicateCounts = new Map<string, number>();
  const duplicateAppCounts = new Map<string, number>();
  const tagPages = new Map<string, number>();
  const tagAppPages = new Map<string, number>();

  for (const row of measured) {
    const tags = [...splitTags(row.ogTags), ...splitTags(row.twitterTags)];
    const appTags = new Set(splitTags(row.ogAppTags));

    const perPage = new Map<string, number>();
    for (const t of tags) perPage.set(t, (perPage.get(t) ?? 0) + 1);

    for (const [tag, n] of perPage) {
      tagPages.set(tag, (tagPages.get(tag) ?? 0) + 1);
      if (appTags.has(tag)) tagAppPages.set(tag, (tagAppPages.get(tag) ?? 0) + 1);
      if (n <= 1) continue;
      duplicateCounts.set(tag, (duplicateCounts.get(tag) ?? 0) + 1);
      if (appTags.has(tag)) duplicateAppCounts.set(tag, (duplicateAppCounts.get(tag) ?? 0) + 1);
      const list = duplicateExamples.get(tag) ?? [];
      if (list.length < MAX_LIVE_EXAMPLES) list.push(row.url);
      duplicateExamples.set(tag, list);
    }
  }

  // Every tag the app CAN emit gets a stat row even at zero pages: the gate
  // reads these by name, and a missing entry would only accidentally coincide
  // with "nothing serves it".
  const statTags = new Set<string>([...APP_SOCIAL_TAGS, ...tagPages.keys()]);
  const typeStats: MarkupTypeStat[] = [...statTags]
    .map((tag) => ({
      type: tag,
      // The social block carries no page-type guard — it emits on every page,
      // so there is nothing to scope and the gate sums one shop-wide bucket.
      resourceType: "",
      pages: tagPages.get(tag) ?? 0,
      appPages: tagAppPages.get(tag) ?? 0,
      duplicatePages: duplicateCounts.get(tag) ?? 0,
      appIsOneCopy: duplicateAppCounts.get(tag) ?? 0,
      // Unlike VideoObject, no social property legitimately repeats: `og:image`
      // twice is two candidate images for one card, and the scraper picks one.
      // (Multi-image OG exists in the spec but no Shopify theme emits it, and
      // an unmeasured maybe is worse than a finding the merchant can check.)
      repeatable: false,
    }))
    .sort((a, b) => b.pages - a.pages || a.type.localeCompare(b.type));

  const coverage: LiveSocialCoverageRow[] = [];
  for (const resourceType of COVERAGE_RESOURCE_TYPES) {
    const ofType = measured.filter((r) => r.resourceType === resourceType);
    if (ofType.length === 0) continue;
    let withTitle = 0;
    let withImage = 0;
    const missingExamples: string[] = [];
    for (const row of ofType) {
      const tags = new Set(splitTags(row.ogTags));
      const hasTitle = tags.has("og:title");
      const hasImage = tags.has("og:image");
      if (hasTitle) withTitle += 1;
      if (hasImage) withImage += 1;
      if ((!hasTitle || !hasImage) && missingExamples.length < MAX_LIVE_EXAMPLES) {
        missingExamples.push(row.url);
      }
    }
    coverage.push({ resourceType, total: ofType.length, withTitle, withImage, missingExamples });
  }

  const anyMarked = measured.some((r) => !!r.ogAppTags);

  return {
    crawledAt: (snapshot.finishedAt ?? snapshot.startedAt).toISOString(),
    crawlStatus: snapshot.status,
    pagesChecked: measured.length,
    // No measured row at all — the snapshot predates the columns, or the crawl
    // never parsed a body (password-protected storefront, bot shield). Note
    // this is a KNOWN-ness check, not an emptiness check: a shop that genuinely
    // serves no og:* has measured rows with empty columns and gets a real
    // "nothing found" report.
    notMeasured: measured.length === 0,
    coverage,
    tagCounts: [...tagPages.entries()]
      .map(([tag, pages]) => ({ tag, pages }))
      .sort((a, b) => b.pages - a.pages || a.tag.localeCompare(b.tag)),
    duplicates: [...duplicateCounts.entries()]
      .map(([tag, pages]) => ({
        tag,
        pages,
        examples: duplicateExamples.get(tag) ?? [],
        appIsOneCopy: duplicateAppCounts.get(tag) ?? 0,
      }))
      .sort((a, b) => b.pages - a.pages || a.tag.localeCompare(b.tag)),
    typeStats,
    appEmbedDetected: anyMarked ? true : null,
  };
}
