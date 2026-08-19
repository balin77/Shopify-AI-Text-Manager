/**
 * The ONE read behind both markup delivery reports — PLAN_MARKUP_ACTIVATION.
 *
 * `summarizeLiveJsonLd` and `summarizeLiveSocial` are two halves of step 1 of
 * `/app/seo/structured-data` and are rendered side by side from one loader.
 * They therefore must not each resolve "the latest crawl" for themselves: two
 * independent `findFirst` calls can land on different snapshots the moment a
 * crawl finishes between them, and the page would show two reports about two
 * runs with no way for anyone to notice. It is also two full scans of the
 * snapshot's rows where one does. Same rule `crawl-snapshot.server.ts` states
 * for the crawl tab: never add a second single-flight query.
 *
 * The second thing this module owns is the discriminator, and it is the more
 * important half.
 *
 * **A crawled row is not automatically a MEASURED row.** `runCrawl` persists a
 * row for every URL it touched, but only fills the markup columns where it
 * actually parsed a body — which excludes 4xx/5xx, a page whose HTML cheerio
 * refused, a 3xx row (still inside the 200–399 "served" window), and anything
 * past `CRAWL_BFS_MAX_DEPTH`. Judging those as "no markup found" turns "we
 * never looked" into a green light, which for the activation gate means
 * telling a merchant it is safe to switch on a type their theme is demonstrably
 * already serving. That is the exact damage the plan exists to prevent, and the
 * fourth instance of the "an empty crawl column is never evidence" trap.
 *
 * `indexabilityKnown` is the flag: `runCrawl` sets it on the same line group
 * that fills `jsonLdTypes` and `socialKnown`, so it is true exactly when a body
 * was parsed. It is also the OLDEST of the three, so it judges the most
 * existing snapshots. A snapshot from before it existed has it false
 * everywhere; there `judged` falls back to every served row, the same shape
 * `judgeable` in onpage.service.ts uses — and the per-family `notMeasured`
 * flags still catch that case, because such a snapshot carries no markup
 * columns either.
 */

import type { PrismaClient } from "@prisma/client";

export interface CrawlMarkupSnapshot {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
}

export interface CrawlMarkupRow {
  url: string;
  statusCode: number;
  resourceType: string | null;
  jsonLdTypes: string;
  jsonLdAppTypes: string;
  ogTags: string;
  twitterTags: string;
  ogAppTags: string;
  socialKnown: boolean;
  indexabilityKnown: boolean;
}

export interface CrawlMarkupPages {
  snapshot: CrawlMarkupSnapshot;
  /**
   * Rows whose body this crawl actually parsed. Everything downstream counts
   * over THESE, never over the raw rows — see the module comment.
   */
  judged: CrawlMarkupRow[];
}

/**
 * Latest completed (or capped) snapshot plus the rows worth judging. Null when
 * the shop has never completed a crawl — the UI then points at the crawl
 * section rather than showing empty numbers.
 */
export async function loadCrawlMarkupPages(
  db: PrismaClient,
  shop: string,
): Promise<CrawlMarkupPages | null> {
  const snapshot = await db.seoCrawlSnapshot.findFirst({
    where: { shop, status: { in: ["completed", "capped"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true, finishedAt: true, status: true },
  });
  if (!snapshot) return null;

  const rows = await db.seoCrawlPage.findMany({
    where: { shop, snapshotId: snapshot.id },
    select: {
      url: true,
      statusCode: true,
      resourceType: true,
      jsonLdTypes: true,
      jsonLdAppTypes: true,
      ogTags: true,
      twitterTags: true,
      ogAppTags: true,
      socialKnown: true,
      indexabilityKnown: true,
    },
  });

  // Only pages that actually served content can be judged on their markup — a
  // 404 carrying no Product schema is not a structured-data problem.
  const served = rows.filter((r) => r.statusCode >= 200 && r.statusCode < 400);
  const anyKnown = served.some((r) => r.indexabilityKnown);
  return { snapshot, judged: anyKnown ? served.filter((r) => r.indexabilityKnown) : served };
}
