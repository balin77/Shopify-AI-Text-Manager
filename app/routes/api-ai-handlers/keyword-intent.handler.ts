/**
 * Search-intent batch classifier (PLAN_KEYWORDS_EXPANSION.md §7.2) — the
 * `classifyKeywordIntents` action behind the keywords tab's "classify" button.
 *
 * One click = ONE LLM call classifying up to INTENT_BATCH_SIZE distinct
 * unclassified keyword texts (applied to every locale row sharing the text);
 * the response reports how many remain so the button can offer the next
 * batch. Synchronous by design — a single call finishes in seconds, no
 * detached runner needed; the Task row exists for prompt logging + the
 * Tasks-tab audit trail.
 */

import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { meetsPlan } from "~/utils/planUtils";
import type { Plan } from "~/config/plans";
import {
  buildIntentPrompt,
  parseIntentResponse,
  INTENT_BATCH_SIZE,
} from "~/services/seo/keyword-intent.service";

export async function handleClassifyKeywordIntents(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings } = ctx;

  // Pro-gate (plan §8: Intent-Batch is Pro).
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "pro")) {
    return json({ success: false, error: "This feature requires the Pro plan or higher." }, { status: 403 });
  }

  // Distinct unclassified keyword TEXTS (the same text in two locales gets
  // one classification applied to both rows).
  const unclassifiedRows = await db.seoKeyword.findMany({
    where: { shop: session.shop, intent: null },
    orderBy: { createdAt: "asc" },
    select: { keyword: true },
    // Over-fetch so the distinct cut below still fills a batch.
    take: INTENT_BATCH_SIZE * 2,
  });
  const distinct = Array.from(new Set(unclassifiedRows.map((r) => r.keyword))).slice(0, INTENT_BATCH_SIZE);
  if (distinct.length === 0) {
    return json({ success: true, classified: 0, remaining: 0 });
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "keywordIntent",
      status: "running",
      resourceType: "seo",
      fieldType: "intent",
      total: distinct.length,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const aiService = createAIService(settings, session.shop, task.id);
    const raw = await aiService["askAI"](buildIntentPrompt(distinct));
    const intents = parseIntentResponse(raw, new Set(distinct));

    let classified = 0;
    for (const [keyword, intent] of intents) {
      const updated = await db.seoKeyword.updateMany({
        where: { shop: session.shop, keyword, intent: null },
        data: { intent },
      });
      classified += updated.count;
    }

    const remaining = await db.seoKeyword.count({ where: { shop: session.shop, intent: null } });

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        processed: distinct.length,
        completedAt: new Date(),
        result: JSON.stringify({ classified, remaining }),
      },
    });

    return json({ success: true, classified, remaining });
  } catch (error: unknown) {
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: errorMessage(error).substring(0, 1000) },
      })
      .catch(() => {});
    logger.error("[API-AI] Keyword intent classification failed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(error),
    });
    throw error; // auth errors get the central INVALID_AI_KEY translation
  }
}
