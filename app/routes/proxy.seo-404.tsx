/**
 * App Proxy endpoint (POST): record a storefront 404 (SEO tab Phase 3).
 *
 * Storefront URL: POST /apps/contentpilot/seo-404
 * Body: { path: string, referrer?: string }
 *
 * Fired by the theme app-embed beacon only on 404 pages
 * (`request.page_type == '404'`). `authenticate.public.appProxy` validates the
 * Shopify proxy HMAC and resolves the shop's offline session. Always answers
 * 200 with no-store so a beacon failure never disturbs the storefront.
 */
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { record404Hit } from "../services/seo/redirects.service";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, { status: 200 });

  let body: { path?: string; referrer?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  const path = String(body.path ?? "");
  if (!path) {
    return json({ ok: false }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  try {
    await record404Hit(db, session.shop, { path, referrer: body.referrer ?? null });
  } catch {
    // Never surface a collector error to the storefront.
    return json({ ok: false }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  return json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
