/**
 * Storefront crawler / site audit — "Jetzt scannen" action
 * (PLAN_SEO_SUITE_COMPLETION.md §3.5, Phase 1).
 *
 * Thin: everything around the crawl (single-flight, Task row, snapshot
 * retention, detached runner) lives in services/seo/crawl-run.server.ts, which
 * the weekly Max sweep calls as well — one start path, so the unattended run
 * cannot drift from the one a merchant watches.
 *
 * Non-AI task: the crawl is a live storefront fetch, never a provider call
 * — exempt from the route's "shop must have an AI key" gate (NON_AI_ACTIONS
 * in api.ai.tsx), matching seoAudit/seoJsonLdAudit.
 */

import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { startCrawlRun } from "~/services/seo/crawl-run.server";
import type { DataResponse } from "~/types/data-response";

export async function handleSeoCrawl(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db } = ctx;

  const result = await startCrawlRun({ db, admin, shop: session.shop });

  if (!result.started) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "A site crawl is already running for this store. Check the Tasks tab for progress.",
        taskId: result.taskId,
      },
      { status: 409 },
    );
  }

  return json({ success: true, taskId: result.taskId, snapshotId: result.snapshotId });
}
