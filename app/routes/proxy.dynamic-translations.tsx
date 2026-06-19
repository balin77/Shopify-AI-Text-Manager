/**
 * App Proxy endpoint: serves the dynamic-translation dictionary to the
 * storefront for the active locale.
 *
 * Storefront URL: /apps/contentpilot/dynamic-translations?locale=<iso>
 * (configured via [app_proxy] in shopify.app.*.toml → forwarded here).
 *
 * `authenticate.public.appProxy` validates the Shopify proxy HMAC signature and
 * resolves the shop's offline session, so the shop is trusted (not client
 * input). Same-origin from the storefront → no CORS needed.
 */
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { getDictionary } from "../services/dynamic-translation.server";
import { isValidLocale } from "../utils/validation";

const EMPTY = { enabled: false, version: 0, entries: {} as Record<string, Record<string, string>> };

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);

  // No offline session (app not installed / token gone) → harmless empty dict.
  if (!session) {
    return json(EMPTY, { headers: { "Cache-Control": "no-store" } });
  }

  const locale = new URL(request.url).searchParams.get("locale")?.trim() ?? "";
  if (!locale || !isValidLocale(locale)) {
    return json(EMPTY, { headers: { "Cache-Control": "no-store" } });
  }

  const dict = await getDictionary(db, session.shop, locale);

  // Short edge/browser cache; the storefront JS additionally caches in
  // localStorage and revalidates against `version` (stale-while-revalidate).
  return json(dict, {
    headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=600" },
  });
}
