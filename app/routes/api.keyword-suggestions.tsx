/**
 * Keyword-research endpoint for the keywords tab's research panel
 * (PLAN_KEYWORDS_EXPANSION.md §6). Thin wrapper around
 * keyword-suggestions.service.ts: per-shop rate limit (3 seeds/min), explicit
 * merchant action only (no prefetch anywhere), friendly coded errors on
 * throttling. Import into a group happens via the keywords tab's own
 * `importCsv` action — this endpoint only researches.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  gatherSuggestions,
  checkSuggestionsRateLimit,
  markSuggestionsAvailability,
  SuggestionsRateLimitedError,
  type SuggestionGroups,
} from "../services/seo/keyword-suggestions.service";
import { getFormString } from "../utils/form-data.utils";
import { MAX_KEYWORD_LENGTH } from "../services/seo/keywords.service";

type ActionResult =
  | { ok: true; groups: SuggestionGroups }
  | { ok: false; error: "invalid" | "rateLimited" | "blocked" };

// Locale codes we pass through as `hl` — a plain allow-shape check, NOT a
// list: any bcp47-ish "xx" / "xx-yy" is fine for Google.
const HL_RE = /^[a-z]{2}(-[a-z]{2,4})?$/i;

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { session } = await authenticate.admin(request);

  const form = await request.formData();
  const seed = getFormString(form, "seed").trim();
  const rawHl = getFormString(form, "hl").trim();
  const hl = HL_RE.test(rawHl) ? rawHl.toLowerCase() : "en";
  const expandAlphabet = getFormString(form, "expandAlphabet") === "true";

  if (!seed || seed.length > MAX_KEYWORD_LENGTH) {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }

  if (!checkSuggestionsRateLimit(session.shop)) {
    return json<ActionResult>({ ok: false, error: "rateLimited" }, { status: 429 });
  }

  try {
    const groups = await gatherSuggestions(seed, hl, { expandAlphabet });
    // Real outcome feeds the availability cache (integrated §6.1 spike).
    markSuggestionsAvailability("ok");
    return json<ActionResult>({ ok: true, groups });
  } catch (err) {
    if (err instanceof SuggestionsRateLimitedError) {
      markSuggestionsAvailability("blocked");
      return json<ActionResult>({ ok: false, error: "blocked" }, { status: 429 });
    }
    throw err;
  }
};
