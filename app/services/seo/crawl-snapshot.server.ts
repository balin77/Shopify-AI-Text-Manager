/**
 * The ONE way a route reads "the latest crawl" (PLAN_SEO_CRAWL_EXPANSION §0.3).
 *
 * `/app/seo/crawl` and `/app/seo/onpage` are two views of the SAME crawl: one
 * `seoCrawl` task, one `SeoCrawlSnapshot`. They therefore must not each carry
 * their own copy of the "is a run in flight" single-flight query and the error
 * parsing — the moment those drift, the two tabs disagree about a crawl the
 * merchant just started, which is exactly the confusion the split risks.
 */

import type { PrismaClient } from "@prisma/client";
import { parseCrawlError, type BlockSource } from "./crawl.service";
import type { SnapshotHeaderView } from "./crawl.shared";

export type { SnapshotHeaderView };

export interface LatestSnapshot {
  row: {
    id: string;
    startedAt: Date;
    finishedAt: Date | null;
    status: string;
    error: string | null;
    pagesCrawled: number;
    totalDiscovered: number;
    pagesOk: number;
    pagesBroken: number;
    orphanCount: number;
    headDriftCount: number;
  } | null;
  /** A `seoCrawl` Task is running for this shop right now. */
  running: boolean;
  /** `error` split into its code and the bot-block attribution (§ parseCrawlError). */
  errorCode: string | null;
  blockedBy: BlockSource | null;
}

export async function loadLatestSnapshot(db: PrismaClient, shop: string): Promise<LatestSnapshot> {
  const [row, runningTask] = await Promise.all([
    db.seoCrawlSnapshot.findFirst({
      where: { shop },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        startedAt: true,
        finishedAt: true,
        status: true,
        error: true,
        pagesCrawled: true,
        totalDiscovered: true,
        pagesOk: true,
        pagesBroken: true,
        orphanCount: true,
        headDriftCount: true,
      },
    }),
    db.task.findFirst({ where: { shop, type: "seoCrawl", status: "running" }, select: { id: true } }),
  ]);

  const parsed = parseCrawlError(row?.error ?? null);
  return { row: row ?? null, running: !!runningTask, errorCode: parsed.code, blockedBy: parsed.blockedBy };
}

/** The serializable header view both routes hand to `CrawlSnapshotHeader`
 *  (the type itself lives in crawl.shared.ts — client-safe). */
export function toHeaderView(snapshot: LatestSnapshot): SnapshotHeaderView | null {
  if (!snapshot.row) return null;
  return {
    startedAt: snapshot.row.startedAt.toISOString(),
    finishedAt: snapshot.row.finishedAt ? snapshot.row.finishedAt.toISOString() : null,
    status: snapshot.row.status,
    errorCode: snapshot.errorCode,
    blockedBy: snapshot.blockedBy,
    pagesCrawled: snapshot.row.pagesCrawled,
    totalDiscovered: snapshot.row.totalDiscovered,
  };
}
