/**
 * Crawl-to-crawl comparison (PLAN_SEO_CRAWL_EXPANSION §7.2).
 *
 * Pure and client-safe (no `.server`, no Prisma, no fetch): the route loader
 * reads two snapshots' page rows, this folds them into a diff.
 *
 * "12 pages went to noindex since the last crawl" is the message one has an SEO
 * tool for — a state report says everything is fine right up until it isn't,
 * while a diff names the day it changed.
 */

import type { IndexabilityVerdict } from "./onpage.service";

/** The columns a diff needs — a deliberate subset of SeoCrawlPage. */
export interface DiffRow {
  url: string;
  statusCode: number;
  title: string | null;
  metaRobots: string;
  xRobotsTag: string;
  indexabilityKnown: boolean;
}

export interface CrawlDiff {
  newUrls: string[];
  goneUrls: string[];
  statusChanged: Array<{ url: string; from: number; to: number }>;
  /** Empty unless BOTH snapshots know their indexability — see below. */
  indexabilityChanged: Array<{ url: string; from: IndexabilityVerdict; to: IndexabilityVerdict }>;
  titleChanged: Array<{ url: string; from: string | null; to: string | null }>;
  counts: {
    pages: [number, number];
    broken: [number, number];
    nonIndexable: [number, number];
  };
  /**
   * False when one of the snapshots predates the indexability columns. The UI
   * must then HIDE the indexability half rather than render it: the first crawl
   * after the deploy would otherwise report the entire shop as "changed",
   * because `unknown → indexable` is a transition in the data and not in the
   * shop (§1.1).
   */
  indexabilityComparable: boolean;
}

/** Local copy of the verdict rule, kept dependency-free on purpose: importing
 *  `deriveIndexability` would pull `onpage.service` → `crawl.service` →
 *  `url-resolver.server` into whatever imports this. The rule is three lines
 *  and covered by its own tests on both sides. */
function verdict(row: DiffRow): IndexabilityVerdict {
  if (!row.indexabilityKnown) return "unknown";
  if (row.statusCode < 200 || row.statusCode >= 300) return "unknown";
  const tokens = `${row.metaRobots},${row.xRobotsTag}`
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const colon = trimmed.lastIndexOf(":");
      return (colon >= 0 ? trimmed.slice(colon + 1) : trimmed).trim().toLowerCase();
    })
    .filter(Boolean);
  if (tokens.some((t) => t === "noindex" || t === "none")) return "noindex";
  if (tokens.some((t) => t === "nofollow")) return "nofollow_only";
  return "indexable";
}

function isBroken(statusCode: number): boolean {
  // Mirrors `classifyLinkStatus`'s "broken" bucket (4xx + redirect loop) —
  // 403/429 are a bot firewall and 5xx is the page failing, neither is "gone".
  return statusCode === -1 || (statusCode >= 400 && statusCode < 500 && statusCode !== 403 && statusCode !== 429);
}

/** Cap per list so one pathological crawl can't produce a page of 2000 rows. */
export const MAX_DIFF_ROWS = 200;

export function diffCrawls(previous: DiffRow[], current: DiffRow[]): CrawlDiff {
  const prevByUrl = new Map(previous.map((r) => [r.url, r]));
  const currByUrl = new Map(current.map((r) => [r.url, r]));

  const newUrls: string[] = [];
  const goneUrls: string[] = [];
  const statusChanged: CrawlDiff["statusChanged"] = [];
  const indexabilityChanged: CrawlDiff["indexabilityChanged"] = [];
  const titleChanged: CrawlDiff["titleChanged"] = [];

  // A snapshot "knows" its indexability if ANY of its rows does. Per-row would
  // be wrong: a 404 legitimately has no answer, so requiring every row would
  // mark a perfectly current snapshot as incomparable.
  const knows = (rows: DiffRow[]) => rows.some((r) => r.indexabilityKnown);
  const indexabilityComparable = knows(previous) && knows(current);

  for (const row of current) {
    const before = prevByUrl.get(row.url);
    if (!before) {
      newUrls.push(row.url);
      continue;
    }
    if (before.statusCode !== row.statusCode) {
      statusChanged.push({ url: row.url, from: before.statusCode, to: row.statusCode });
    }
    if ((before.title ?? "") !== (row.title ?? "")) {
      titleChanged.push({ url: row.url, from: before.title, to: row.title });
    }
    if (indexabilityComparable) {
      const from = verdict(before);
      const to = verdict(row);
      // `unknown` on either side is a gap in the DATA, not a change in the
      // shop — reporting it would be the loudest possible false positive.
      if (from !== to && from !== "unknown" && to !== "unknown") {
        indexabilityChanged.push({ url: row.url, from, to });
      }
    }
  }

  for (const row of previous) {
    if (!currByUrl.has(row.url)) goneUrls.push(row.url);
  }

  const countNonIndexable = (rows: DiffRow[]) => rows.filter((r) => verdict(r) === "noindex").length;

  return {
    newUrls: newUrls.slice(0, MAX_DIFF_ROWS),
    goneUrls: goneUrls.slice(0, MAX_DIFF_ROWS),
    statusChanged: statusChanged.slice(0, MAX_DIFF_ROWS),
    indexabilityChanged: indexabilityChanged.slice(0, MAX_DIFF_ROWS),
    titleChanged: titleChanged.slice(0, MAX_DIFF_ROWS),
    counts: {
      pages: [previous.length, current.length],
      broken: [previous.filter((r) => isBroken(r.statusCode)).length, current.filter((r) => isBroken(r.statusCode)).length],
      nonIndexable: [countNonIndexable(previous), countNonIndexable(current)],
    },
    indexabilityComparable,
  };
}

/** True when the diff has anything worth rendering at all. */
export function hasDiffContent(diff: CrawlDiff): boolean {
  return (
    diff.newUrls.length > 0 ||
    diff.goneUrls.length > 0 ||
    diff.statusChanged.length > 0 ||
    diff.indexabilityChanged.length > 0 ||
    diff.titleChanged.length > 0
  );
}
