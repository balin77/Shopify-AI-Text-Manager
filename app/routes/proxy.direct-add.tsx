/**
 * App Proxy endpoint (POST): add a direct-translation item (and optionally one
 * translation) straight from the storefront — used by the visual theme-editor
 * mode, where the merchant clicks rendered text to capture it 1:1.
 *
 * Storefront URL: POST /apps/contentpilot/direct-add
 * Body: { sourceText: string, locale?: string, targetText?: string }
 *
 * `authenticate.public.appProxy` validates the Shopify proxy HMAC signature and
 * resolves the shop's offline session, so the shop is trusted. The captured
 * source string is exactly the rendered DOM text, so it is guaranteed to match.
 */
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { createItem, setTranslation, normalizeSource } from "../services/direct-translation.server";
import { isValidLocale } from "../utils/validation";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, { status: 200 });

  let body: { sourceText?: string; locale?: string; targetText?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const sourceText = normalizeSource(String(body.sourceText ?? ""));
  if (!sourceText) return json({ ok: false, error: "Empty source" }, { status: 400 });

  const item = await createItem(db, session.shop, sourceText);

  const locale = String(body.locale ?? "").trim();
  const targetText = String(body.targetText ?? "");
  if (locale && targetText.trim()) {
    if (!isValidLocale(locale)) return json({ ok: false, error: "Invalid locale" }, { status: 400 });
    await setTranslation(db, session.shop, item.id, locale, targetText, "user");
  }

  return json(
    { ok: true, itemId: item.id, sourceText: item.sourceText },
    { headers: { "Cache-Control": "no-store" } },
  );
}
