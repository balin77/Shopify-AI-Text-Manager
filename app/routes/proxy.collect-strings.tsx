/**
 * App Proxy endpoint (POST): the storefront reports untranslated strings it
 * rendered so the merchant can review + translate them in the admin.
 *
 * Storefront URL: POST /apps/contentpilot/collect-strings
 * Body: { locale: string, items: Array<{ text: string, scope?: string }> }
 *
 * Opt-in only: ignored unless the shop enabled collection. Heuristically
 * filtered + capped server-side (recordCandidates). Never creates translations.
 */
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  getDynamicTranslationSettings,
  recordCandidates,
  MAX_CANDIDATES_PER_REQUEST,
} from "../services/dynamic-translation.server";
import { isValidLocale } from "../utils/validation";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, { status: 200 });

  // Opt-in gate: do nothing unless the merchant enabled collection.
  const settings = await getDynamicTranslationSettings(db, session.shop);
  if (!settings.collect) return json({ ok: true, recorded: 0 });

  let body: { locale?: string; items?: Array<{ text?: string; scope?: string }> };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const locale = (body.locale || "").trim();
  if (!locale || !isValidLocale(locale)) return json({ ok: false, error: "Invalid locale" }, { status: 400 });

  const items = Array.isArray(body.items) ? body.items : [];
  const clean = items
    .slice(0, MAX_CANDIDATES_PER_REQUEST)
    .map((i) => ({ text: String(i?.text ?? ""), scope: i?.scope ? String(i.scope) : "global" }))
    .filter((i) => i.text);

  const recorded = clean.length > 0 ? await recordCandidates(db, session.shop, locale, clean) : 0;
  return json({ ok: true, recorded }, { headers: { "Cache-Control": "no-store" } });
}
