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
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  getSettings,
  recordCandidates,
  isDirectTranslationsAvailable,
  MAX_CANDIDATES_PER_REQUEST,
} from "../services/direct-translation.server";
import { isValidLocale } from "../utils/validation";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, { status: 200 });

  // Max-plan only.
  if (!(await isDirectTranslationsAvailable(db, session.shop))) return json({ ok: true, recorded: 0 });

  // Opt-in gate: do nothing unless the merchant enabled collection.
  const settings = await getSettings(db, session.shop);
  if (!settings.collect) return json({ ok: true, recorded: 0 });

  let body: { items?: Array<{ text?: string }>; locale?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  const clean = items
    .slice(0, MAX_CANDIDATES_PER_REQUEST)
    .map((i) => ({ text: String(i?.text ?? "") }))
    .filter((i) => i.text);

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
