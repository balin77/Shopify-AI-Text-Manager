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

import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { meetsPlan } from "~/utils/planUtils";
import type { Plan } from "~/config/plans";
import {
  analyzeAeo,
  adviseableRules,
  buildRobotsAdvicePrompt,
  parseRobotsAdviceResponse,
  getShopIdentity,
  ROBOTS_ADVICE_BATCH,
} from "~/services/seo/aeo.service";

export async function handleSeoRobotsAdvice(ctx: AIActionContext): Promise<Response> {
  const { admin, session, db, settings } = ctx;

  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "basic")) {
    return json({ success: false, error: "This feature requires the Basic plan or higher." }, { status: 403 });
  }

  // Re-audit server-side rather than trusting a client-supplied rule list: the
  // paths coming back drive a theme write later on.
  const { name, domain } = await getShopIdentity(admin, session.shop);
  const analysis = await analyzeAeo(admin, session.shop, {
    db,
    shopName: name,
    domain,
    // Irrelevant here (we only read the robots half), but passed through
    // faithfully rather than guessed.
    autoUpdate: (settings as { llmsTxtAutoUpdate?: boolean } | null)?.llmsTxtAutoUpdate ?? true,
  });
  if (!analysis.robotsAuditAvailable) {
    return json({ success: false, error: "robots_unavailable" }, { status: 400 });
  }

  const rules = adviseableRules(analysis.crawlerGroups).slice(0, ROBOTS_ADVICE_BATCH);
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
