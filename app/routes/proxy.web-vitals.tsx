/**
 * App Proxy endpoint (POST): record a storefront real-user web-vitals (RUM)
 * beacon (SEO tab Performance section, Phase 2).
 *
 * Storefront URL: POST /apps/contentpilot/web-vitals
 * Body: WebVitalBeaconPayload (see app/services/seo/web-vitals.types.ts)
 *
 * Fired by the theme app-embed's web-vitals beacon on ordinary page loads.
 * `authenticate.public.appProxy` validates the Shopify proxy HMAC and
 * resolves the shop's offline session. Always answers 200 with no-store so a
 * beacon failure never disturbs the storefront.
 */
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { allowWebVitalSample, recordWebVitalSample } from "../services/seo/web-vitals.service";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, { status: 200 });

  // Rate-limit BEFORE any DB work (a flood of beacons otherwise costs a write
  // each). Over-limit requests still get the ordinary 200/no-store response —
  // the storefront beacon must never learn it was throttled, and it never
  // throws (see allowWebVitalSample's doc comment for the single-process
  // rationale).
  if (!allowWebVitalSample(session.shop)) {
    return json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  try {
    await recordWebVitalSample({ db, shop: session.shop, payload: body });
  } catch {
    // Never surface a collector error to the storefront.
    return json({ ok: false }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  return json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
