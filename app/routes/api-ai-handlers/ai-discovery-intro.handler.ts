/**
 * "Improve with AI" for the merchant-authored intro of agents.md / llms.txt —
 * the `aiDiscoveryIntro` action behind the AEO tab's step 2.
 *
 * Read-only towards the shop: it returns a suggested text and writes nothing.
 * The merchant sees it in the box and still has to press save, which is what
 * keeps a model answer from reaching a published file on its own.
 *
 * One click = ONE LLM call. Synchronous by design; the Task row exists for
 * prompt logging and the Tasks-tab audit trail, like seoRobotsAdvice.
 */

import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { meetsPlan } from "~/utils/planUtils";
import type { Plan } from "~/config/plans";
import {
  AI_DISCOVERY_INTRO_MAX_CHARS,
  buildDiscoveryIntroPrompt,
  getShopIdentity,
  normalizeDiscoveryIntro,
  parseDiscoveryIntroResponse,
  type AiDiscoveryFile,
} from "~/services/seo/aeo.service";
import type { DataResponse } from "~/types/data-response";

/** Longest instruction accepted — a sentence or two, not a pasted document. */
const MAX_INSTRUCTION_CHARS = 600;

export async function handleAiDiscoveryIntro(ctx: AIActionContext): Promise<DataResponse> {
  const { admin, session, db, settings, formData } = ctx;

  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "basic")) {
    return json({ success: false, error: "This feature requires the Basic plan or higher." }, { status: 403 });
  }

  // The file name decides which document the prompt describes, so it is
  // validated rather than forwarded — this route is directly POST-reachable.
  const rawFile = String(formData.get("file") || "");
  if (rawFile !== "agents" && rawFile !== "llms") {
    return json({ success: false, error: "invalid_file" }, { status: 400 });
  }
  const file = rawFile as AiDiscoveryFile;

  const instruction = String(formData.get("instruction") || "").trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!instruction) {
    return json({ success: false, error: "missing_instruction" }, { status: 400 });
  }
  const current = normalizeDiscoveryIntro(String(formData.get("current") || ""));

  const { name, description } = await getShopIdentity(admin, session.shop);

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "aiDiscoveryIntro",
      status: "running",
      resourceType: "seo",
      fieldType: file,
      total: 1,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const language = settings?.appLanguage || "de";
    const aiService = createAIService(settings, session.shop, task.id);
    const raw = await aiService["askAI"](
      buildDiscoveryIntroPrompt({ file, shopName: name, description, current, instruction, language }),
    );
    const text = parseDiscoveryIntroResponse(raw);

    await db.task.update({
      where: { id: task.id },
      data: {
        status: text ? "completed" : "failed",
        progress: 100,
        processed: 1,
        completedAt: new Date(),
        result: JSON.stringify({ file, chars: text.length }),
      },
    });

    // An empty answer is a failure, not a suggestion to clear the box — the
    // merchant would otherwise press save on nothing and publish a file whose
    // intro silently disappeared.
    if (!text) return json({ success: false, error: "empty_answer" }, { status: 502 });

    return json({ success: true, text, maxChars: AI_DISCOVERY_INTRO_MAX_CHARS });
  } catch (error: unknown) {
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: errorMessage(error).substring(0, 1000) },
      })
      .catch(() => {});
    logger.error("[API-AI] AI-discovery intro rewrite failed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(error),
    });
    throw error; // auth errors get the central INVALID_AI_KEY translation
  }
}
