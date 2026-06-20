/**
 * App Proxy endpoint (POST): add a direct-translation item straight from the
 * storefront — used by the visual theme-editor capture mode, where the merchant
 * clicks rendered text to capture it 1:1.
 *
 * Storefront URL: POST /apps/contentpilot/direct-add
 * Body: { sourceText: string, translateAll?: boolean, locale?: string, targetText?: string }
 *
 * `authenticate.public.appProxy` validates the Shopify proxy HMAC signature and
 * resolves the shop's offline session (+ an Admin API client). The captured
 * source string is exactly the rendered DOM text, so it is guaranteed to match.
 * When `translateAll` is set, a Task-tracked AI translation into all published
 * target locales is kicked off in the background.
 */
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { createItem, setTranslation, normalizeSource, isDirectTranslationsAvailable } from "../services/direct-translation.server";
import { translateItemsIntoAllLocales } from "../services/direct-translation-ai.server";
import { isValidLocale } from "../utils/validation";

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, { status: 200 });

  // Max-plan only.
  if (!(await isDirectTranslationsAvailable(db, session.shop))) {
    return json({ ok: false, error: "Not available on this plan" }, { status: 200 });
  }

  let body: { sourceText?: string; translateAll?: boolean; locale?: string; targetText?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const sourceText = normalizeSource(String(body.sourceText ?? ""));
  if (!sourceText) return json({ ok: false, error: "Empty source" }, { status: 400 });

  const item = await createItem(db, session.shop, sourceText);

  // Optional: a single explicit translation (kept for completeness).
  const locale = String(body.locale ?? "").trim();
  const targetText = String(body.targetText ?? "");
  if (locale && targetText.trim()) {
    if (!isValidLocale(locale)) return json({ ok: false, error: "Invalid locale" }, { status: 400 });
    await setTranslation(db, session.shop, item.id, locale, targetText, "user");
  }

  // Optional: AI-translate into all published target locales (background, Task-tracked).
  let translating = false;
  if (body.translateAll && admin) {
    translating = true;
    void translateItemsIntoAllLocales(
      admin,
      session.shop,
      [{ id: item.id, sourceText: item.sourceText }],
      item.sourceText.slice(0, 80),
    ).catch(() => {});
  }

  return json(
    { ok: true, itemId: item.id, sourceText: item.sourceText, translating },
    { headers: { "Cache-Control": "no-store" } },
  );
}
