/**
 * App Proxy endpoint: serves the direct-translation dictionary to the storefront
 * for the active locale.
 *
 * Storefront URL: /apps/contentpilot/dynamic-translations?locale=<iso>
 * (configured via [app_proxy] in shopify.app.*.toml → forwarded here). The URL
 * keeps the historical `dynamic-translations` path; the feature is now
 * "Direktübersetzungen". There is no `enabled` gate — the theme app embed being
 * active is the on/off switch.
 *
 * `authenticate.public.appProxy` validates the Shopify proxy HMAC signature and
 * resolves the shop's offline session, so the shop is trusted (not client
 * input). Same-origin from the storefront → no CORS needed.
 */
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { getDictionary, isDirectTranslationsAvailable } from "../services/direct-translation.server";
import { isValidLocale } from "../utils/validation";

// `available` tells the storefront whether the Max-plan feature is active (it
// gates the theme-editor capture tool). Translations/collector are also gated.
const EMPTY = { available: false, collect: false, version: 0, entries: {} as Record<string, string> };

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);

  // No offline session (app not installed / token gone) → harmless empty dict.
  if (!session) {
    return json(EMPTY, { headers: { "Cache-Control": "no-store" } });
  }

  // Max-plan only: non-Max shops get an empty, unavailable dictionary.
  if (!(await isDirectTranslationsAvailable(db, session.shop))) {
    return json(EMPTY, { headers: { "Cache-Control": "no-store" } });
  }

  const locale = new URL(request.url).searchParams.get("locale")?.trim() ?? "";
  if (!locale || !isValidLocale(locale)) {
    return json({ ...EMPTY, available: true }, { headers: { "Cache-Control": "no-store" } });
  }

  const dict = await getDictionary(db, session.shop, locale);

  // Short edge/browser cache; the storefront JS additionally caches in
  // localStorage and revalidates against `version` (stale-while-revalidate).
  return json({ ...dict, available: true }, {
    headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=600" },
  });
}
