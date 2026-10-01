/**
 * The client-safe half of the translation-change policy: the plan gate.
 *
 * Lives apart from `translation-change-policy.server.ts` because the Settings
 * UI needs the required tier to grey out the switch, and a `.server` module
 * must never reach the client bundle. One constant, one meaning, both sides.
 */

import type { Plan } from "../../utils/planUtils";

/**
 * Minimum plan for "translate automatically when the text changed outside this
 * app". It is unattended AI spend on the merchant's key, plus recurring
 * background work on ours — the same axis every other Max entitlement sits on.
 */
export const AUTO_TRANSLATE_MIN_PLAN: Plan = "max";
