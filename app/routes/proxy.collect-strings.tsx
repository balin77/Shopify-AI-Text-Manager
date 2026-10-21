/**
 * App Proxy endpoint (POST): the storefront reports untranslated strings it
 * rendered so the merchant can review them in the admin ("Gefundene Texte").
 *
 * Storefront URL: POST /apps/contentpilot/collect-strings
 * Body: { items: Array<{ text: string }> }
 *
 * Opt-in only: ignored unless the shop enabled collection. Heuristically
 * filtered + capped server-side (recordCandidates). Direct translations are
 * global, so there is no per-locale / per-scope partitioning. Never creates
 * items or translations.
 */
import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  getSettings,
  recordCandidates,
  isDirectTranslationsAvailable,
  collectStringsRateLimiter,
  MAX_CANDIDATES_PER_REQUEST,
} from "../services/direct-translation.server";
import { isValidLocale } from "../utils/validation";
import { declaresBodyLargerThan, readBodyCapped } from "../utils/read-body-capped.server";

const NO_STORE = { "Cache-Control": "no-store" };

/** Longest candidate the storefront collector reports (`isCollectible` in direct-translation.js). */
const MAX_RAW_CANDIDATE_CHARS = 1500;

/**
 * Hard cap on the request body, enforced BEFORE it is parsed — the route is
 * reachable by any storefront visitor. Derived from what a legitimate beacon
 * can carry: MAX_CANDIDATES_PER_REQUEST candidates of up to 1500 characters
 * (the collector's own `isCollectible` limit) at up to 4 UTF-8 bytes each,
 * plus per-item JSON framing and the locale. The storefront script sends at
 * most 50 items, so this leaves a 2x margin over a real payload.
 */
export const MAX_COLLECT_STRINGS_BODY_BYTES =
  MAX_CANDIDATES_PER_REQUEST * (MAX_RAW_CANDIDATE_CHARS * 4 + 64) + 4096;

export async function action({ request }: ActionFunctionArgs) {
  // A declared oversize body is refused before anything else runs.
  if (declaresBodyLargerThan(request, MAX_COLLECT_STRINGS_BODY_BYTES)) {
    return json({ ok: false, error: "Body too large" }, { status: 413, headers: NO_STORE });
  }

  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, { status: 200 });

  // Rate-limit BEFORE any DB work. Over the limit the beacon still gets an
  // ordinary 200 — the collector only samples, and the storefront must never
  // be disturbed by a throttled report.
  if (!collectStringsRateLimiter.allow(session.shop)) {
    return json({ ok: true, recorded: 0 }, { headers: { "Cache-Control": "no-store" } });
  }

  // Max-plan only.
  if (!(await isDirectTranslationsAvailable(db, session.shop))) return json({ ok: true, recorded: 0 });

  // Opt-in gate: do nothing unless the merchant enabled collection.
  const settings = await getSettings(db, session.shop);
  if (!settings.collect) return json({ ok: true, recorded: 0 });

  let body: { items?: Array<{ text?: string }>; locale?: string };
  const raw = await readBodyCapped(request, MAX_COLLECT_STRINGS_BODY_BYTES);
  if (!raw.ok) {
    return raw.tooLarge
      ? json(
          { ok: false, error: "Body too large" },
          { status: 413, headers: { ...NO_STORE, Connection: "close" } },
        )
      : json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  try {
    body = JSON.parse(raw.text);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  const clean = items
    .slice(0, MAX_CANDIDATES_PER_REQUEST)
    .map((i) => ({ text: typeof i?.text === "string" ? i.text : "" }))
    // Drop oversized strings before any normalisation work: recordCandidates
    // refuses anything past 1500 characters after collapsing whitespace, so a
    // raw value four times that long can never become a candidate.
    .filter((i) => i.text && i.text.length <= 6000);

  // Only forward the visitor locale when it's a syntactically valid Shopify
  // locale string (e.g. "de" / "pt-BR"). Without this an attacker could send
  // a megabyte-long string straight into franc and the BCP-47 mapper.
  const visitorLocale =
    typeof body.locale === "string" && body.locale.length < 16 && isValidLocale(body.locale)
      ? body.locale
      : undefined;
  const recorded = clean.length > 0
    ? await recordCandidates(db, session.shop, clean, {
        visitorLocale,
        filterByLanguage: settings.filterByLanguage,
      })
    : 0;
  return json({ ok: true, recorded }, { headers: { "Cache-Control": "no-store" } });
}
