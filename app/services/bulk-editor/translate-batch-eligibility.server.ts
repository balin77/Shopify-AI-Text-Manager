/**
 * Can THIS shop's "add missing translations" run be sent as a provider batch?
 * (PLAN_BULK_TRANSLATE_BATCHING 5.1.)
 *
 * One question, asked in two places: when the confirmation dialog's estimate is
 * built (to decide whether the "cheaper, result within 24 hours" choice is
 * OFFERED) and when a batch start arrives (the route is directly POST-reachable,
 * so the answer is re-decided on the server, never taken from the page).
 *
 * The answer is "yes" only when ALL of these hold:
 *  - the credentials resolver lets the shop spend at all (managed with consent,
 *    or the merchant's own key) -- a refusal here is the ordinary refusal;
 *  - the provider has a Batch API this app drives (Anthropic; Gemini, Grok,
 *    DeepSeek and HuggingFace have none here);
 *  - a managed shop is not on the one-time TASTER: a hold against a taster's
 *    mini-budget is meaningless, and the taster stays immediate-only.
 *
 * Read-only: it builds a service only to read what it is (no request is sent)
 * and reads the managed budget without writing it.
 */

import type { AISettings } from "@prisma/client";
import { AIService } from "../../../src/services/ai.service";
import { aiServiceFor } from "../ai/ai-credentials.server";
import type { Plan } from "~/config/plans";

export type BatchIneligibleReason = "refused" | "provider" | "taster" | "unavailable";

export type BatchEligibility =
  | { available: true; provider: string; model: string; source: "managed" | "byo" }
  | { available: false; reason: BatchIneligibleReason };

export async function batchEligibility(
  settings: AISettings | null,
  shop: string,
  plan: Plan,
): Promise<BatchEligibility> {
  try {
    const { service, decision } = aiServiceFor(settings, shop);
    if (!decision.ok) return { available: false, reason: "refused" };
    const limits = service.packageLimits();
    if (!AIService.batchSupportedFor(limits.provider)) return { available: false, reason: "provider" };
    const source = decision.source === "managed" ? "managed" : "byo";
    if (source === "managed") {
      const { managedBudgetStatus } = await import("../ai/managed-budget.server");
      const status = await managedBudgetStatus(shop, settings, plan as never);
      // A budget that cannot be read is no claim either way -- but a batch needs a hold, so: not offered.
      if (status.readFailed || status.unavailable) return { available: false, reason: "unavailable" };
      if (status.kind === "taster") return { available: false, reason: "taster" };
    }
    return { available: true, provider: limits.provider, model: limits.model, source };
  } catch {
    return { available: false, reason: "unavailable" };
  }
}
