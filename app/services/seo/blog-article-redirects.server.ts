/**
 * PLAN_CONTENT_CREATION §Phase 3.3 — when a BLOG is renamed, its articles move
 * with it.
 *
 * ── Why this is a task and not part of the save ────────────────────────────
 * A blog's articles live one segment below it: `/blogs/<blog>/<article>`.
 * Renaming the blog therefore breaks the blog's own URL AND every article's,
 * and Shopify's URL redirects have **no wildcards** — there is no
 * `/blogs/old/*` to write. Each article needs its own row.
 *
 * That is bounded but not small: a blog with 200 articles is 200 redirects,
 * and each one is a lookup plus a create. Doing it inside the save would hold
 * the merchant's request open for minutes and put the whole thing at the mercy
 * of a request timeout. So the save creates the blog's own redirect
 * synchronously — that one is instant and is the URL most likely to be linked
 * — and hands the articles to a Task, which is the machinery this app already
 * uses for anything long (`bulkTranslation`, `seoBulkMeta`, …).
 *
 * ── What is redirected ─────────────────────────────────────────────────────
 * Only articles whose OLD URL was reachable. A draft article's address was
 * never live, so a redirect from it is clutter in the merchant's list — the
 * same rule `wasEverLive` applies to the object being renamed. `isPublished`
 * is trusted only once `attributesSyncedAt` is set; before that it is the
 * migration's default and says nothing, and unknown proceeds (a redirect too
 * many is removable, a redirect too few is traffic nobody notices losing).
 *
 * ── Failure is per article ─────────────────────────────────────────────────
 * One article that will not redirect must not abort the other 199. Failures
 * are counted and reported on the Task; the blog rename itself already
 * succeeded long before this runs.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { PrismaClient } from "@prisma/client";
import { logger } from "~/utils/logger.server";
import { applyRedirectPair } from "./handle-redirect.server";

/** Task type — also listed in `LONG_RUNNING_TASK_TYPES` (task-recovery.service.js),
 *  because a large blog takes minutes and would otherwise be reaped as stuck. */
export const BLOG_ARTICLE_REDIRECT_TASK_TYPE = "blogArticleRedirects";

/**
 * Hard ceiling on articles redirected in one run. Not a performance guess: it
 * is the point past which a merchant's redirect list stops being something a
 * human can review, and it keeps one rename from spending an hour of the
 * shop's API budget. What is skipped is REPORTED on the task rather than
 * silently dropped — "no silent caps", the same rule the crawler follows.
 */
export const MAX_ARTICLE_REDIRECTS = 500;

export interface BlogArticleRedirectResult {
  created: number;
  failed: number;
  /** Articles skipped because their old URL was never reachable. */
  skippedDrafts: number;
  /** Articles beyond MAX_ARTICLE_REDIRECTS — named, never silently dropped. */
  skippedOverCap: number;
}

function slug(handle: string): string {
  return handle.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Creates one redirect per article of a renamed blog. Runs in the background;
 * see the header for why. Never throws — it is called fire-and-forget and the
 * rename it follows has already succeeded.
 */
export async function redirectBlogArticles(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
  params: { blogId: string; previousBlogHandle: string; nextBlogHandle: string },
): Promise<BlogArticleRedirectResult> {
  const result: BlogArticleRedirectResult = { created: 0, failed: 0, skippedDrafts: 0, skippedOverCap: 0 };
  const from = slug(params.previousBlogHandle);
  const to = slug(params.nextBlogHandle);
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return result;

  const { getTaskExpirationDate } = await import("../../config/constants");

  const articles = await db.article.findMany({
    where: { shop, blogId: params.blogId },
    select: { handle: true, isPublished: true, attributesSyncedAt: true },
    orderBy: { handle: "asc" },
  });

  const eligible = articles.filter((a) => {
    if (!a.handle?.trim()) return false;
    // Unknown proceeds; only a KNOWN draft is skipped.
    const wasLive = a.attributesSyncedAt ? a.isPublished : null;
    if (wasLive === false) {
      result.skippedDrafts += 1;
      return false;
    }
    return true;
  });

  const toRedirect = eligible.slice(0, MAX_ARTICLE_REDIRECTS);
  result.skippedOverCap = eligible.length - toRedirect.length;
  if (toRedirect.length === 0) return result;

  const task = await db.task.create({
    data: {
      shop,
      type: BLOG_ARTICLE_REDIRECT_TASK_TYPE,
      status: "running",
      resourceType: "blog",
      resourceId: params.blogId,
      resourceTitle: `/blogs/${from} → /blogs/${to}`,
      total: toRedirect.length,
      progress: 1,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    for (const [index, article] of toRedirect.entries()) {
      const handle = slug(article.handle);
      try {
        const outcome = await applyRedirectPair(
          admin,
          shop,
          `/blogs/${from}/${handle}`,
          `/blogs/${to}/${handle}`,
        );
        if (outcome.ok) result.created += 1;
        else result.failed += 1;
      } catch {
        // Per ARTICLE, never per run: one stubborn redirect must not cost the
        // other 199 theirs.
        result.failed += 1;
      }

      // Heartbeat. The task-recovery sweep reaps a non-terminal task whose
      // `updatedAt` has gone quiet, and a long blog is exactly the case that
      // would otherwise look stuck while it is working.
      await db.task
        .update({
          where: { id: task.id },
          data: {
            processed: index + 1,
            progress: Math.min(99, Math.round(((index + 1) / toRedirect.length) * 100)),
          },
        })
        .catch(() => undefined);
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        processed: toRedirect.length,
        completedAt: new Date(),
        result: JSON.stringify(result),
      },
    });
    logger.info("[HandleRedirect] Redirected a renamed blog's articles", {
      context: "HandleRedirect", shop, blogId: params.blogId, ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: message.substring(0, 1000) },
      })
      .catch(() => undefined);
    logger.warn("[HandleRedirect] The blog-article redirect run failed", {
      context: "HandleRedirect", shop, blogId: params.blogId, error: message,
    });
  }

  return result;
}
