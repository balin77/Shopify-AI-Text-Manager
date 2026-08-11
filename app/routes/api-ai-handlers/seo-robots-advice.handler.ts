/**
 * robots.txt rule advice — the `seoRobotsAdvice` action behind the AEO tab's
 * "check with AI" button.
 *
 * Read-only: it classifies which Disallow rules are worth unblocking for AI
 * search and returns a recommendation per rule. It never writes anything — the
 * merchant picks from the result and the removal goes through the AEO route's
 * own action (which is separately gated on AEO_THEME_WRITES).
 *
 * One click = ONE LLM call over at most ROBOTS_ADVICE_BATCH rules. Synchronous
 * by design, like the keyword-intent classifier; the Task row exists for prompt
 * logging and the Tasks-tab audit trail.
 */

import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { meetsPlan } from "~/utils/planUtils";
import type { Plan } from "~/config/plans";
import {
  auditLiveRobots,
  adviseableRules,
  buildRobotsAdvicePrompt,
  parseRobotsAdviceResponse,
  ROBOTS_ADVICE_BATCH,
} from "~/services/seo/aeo.service";
import type { DataResponse } from "~/types/data-response";

export async function handleSeoRobotsAdvice(ctx: AIActionContext): Promise<DataResponse> {
  const { admin, session, db, settings } = ctx;

  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "basic")) {
    return json({ success: false, error: "This feature requires the Basic plan or higher." }, { status: 403 });
  }

  // Re-audit server-side rather than trusting a client-supplied rule list.
  // Only the robots half — `analyzeAeo` would also rebuild llms.txt and read
  // the theme file, three Admin API calls for data discarded here.
  const audit = await auditLiveRobots(session.shop);
  if (!audit.available) {
    return json({ success: false, error: "robots_unavailable" }, { status: 400 });
  }

  const rules = adviseableRules(audit.crawlerGroups).slice(0, ROBOTS_ADVICE_BATCH);
  if (rules.length === 0) {
    return json({ success: true, advice: [], total: 0 });
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoRobotsAdvice",
      status: "running",
      resourceType: "seo",
      fieldType: "robots",
      total: rules.length,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const language = settings?.appLanguage || "de";
    const aiService = createAIService(settings, session.shop, task.id);
    const raw = await aiService["askAI"](buildRobotsAdvicePrompt(rules, language));
    const advice = parseRobotsAdviceResponse(raw, new Set(rules.map((r) => r.path)));

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        processed: rules.length,
        completedAt: new Date(),
        result: JSON.stringify({ advised: advice.length, total: rules.length }),
      },
    });

    return json({ success: true, advice, total: rules.length });
  } catch (error: unknown) {
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: errorMessage(error).substring(0, 1000) },
      })
      .catch(() => {});
    logger.error("[API-AI] robots.txt advice failed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(error),
    });
    throw error; // auth errors get the central INVALID_AI_KEY translation
  }
}
