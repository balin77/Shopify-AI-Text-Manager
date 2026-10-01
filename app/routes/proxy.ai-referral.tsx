/**
 * App Proxy endpoint (POST): record a visit that arrived from an AI assistant.
 *
 * Storefront URL: POST /apps/contentpilot/ai-referral
 * Body: { path: string, referrer?: string, utmSource?: string }
 *
 * Fired by the theme app-embed beacon only when the referrer (or the landing
 * URL's `utm_source`) looks like an AI assistant, so the ordinary pageview
 * sends nothing at all. `authenticate.public.appProxy` validates the Shopify
 * proxy HMAC and resolves the shop's offline session. Always answers 200 with
 * no-store so a beacon failure never disturbs the storefront.
 *
 * The referrer is classified HERE and only the resulting source key is stored —
 * a referrer can carry a conversation id or a search term, and the collector is
 * the last place that can decide it never reaches the database. Client-side
 * classification alone would not be enough: this endpoint is POST-reachable
 * directly, so it has to re-derive the source rather than trust one.
 */
import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  allowReferralHit,
  classifyAiReferral,
  recordAiReferral,
} from "../services/seo/ai-referral.service";

const NO_STORE = { "Cache-Control": "no-store" };

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, { status: 200 });

  // Rate-limit BEFORE any DB work. Over-limit requests still get the ordinary
  // 200/no-store response — the storefront beacon must never learn it was
  // throttled.
  if (!allowReferralHit(session.shop)) {
    return json({ ok: true }, { status: 200, headers: NO_STORE });
  }

  let body: { path?: string; referrer?: string; utmSource?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, { status: 200, headers: NO_STORE });
  }

  const path = String(body.path ?? "");
  if (!path) return json({ ok: false }, { status: 200, headers: NO_STORE });

  const source = classifyAiReferral(body.referrer ?? null, body.utmSource ?? null);
  // Not an AI referral: nothing to record. The beacon should not have fired,
  // but a direct POST can claim anything.
  if (!source) return json({ ok: false }, { status: 200, headers: NO_STORE });

  try {
    await recordAiReferral(db, session.shop, { source, path });
  } catch {
    // Never surface a collector error to the storefront.
    return json({ ok: false }, { status: 200, headers: NO_STORE });
  }

  return json({ ok: true }, { status: 200, headers: NO_STORE });
}
