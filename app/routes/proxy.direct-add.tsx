/**
 * App Proxy endpoint (POST): add a direct-translation item straight from the
 * storefront — used by the visual theme-editor capture mode, where the merchant
 * clicks rendered text to capture it 1:1.
 *
 * Storefront URL: POST /apps/contentpilot/direct-add
 * Body: { sourceText: string, captureToken: string, translateAll?: boolean,
 *         locale?: string, targetText?: string }
 *
 * `authenticate.public.appProxy` validates the Shopify proxy HMAC signature and
 * resolves the shop's offline session (+ an Admin API client). That signature
 * only proves the request came THROUGH the storefront — any anonymous visitor's
 * request does — so it is not proof that the MERCHANT sent it, and the
 * storefront script's "theme editor only" gate is a UI rule. The caller must
 * therefore present a capture token (direct-capture-token.server.ts) that only
 * the authenticated admin page mints, bound to this shop and short-lived; a
 * request without a valid one is refused with 403 before anything is written.
 * On top of that: a per-shop rate limit (applied AFTER the token check, so
 * anonymous traffic cannot drain it), length caps and an item cap. The captured
 * source string is exactly the rendered DOM text, so it is guaranteed to match.
 * When `translateAll` is set, a Task-tracked AI translation into all published
 * target locales is kicked off in the background.
 */
import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import {
  createItem,
  setTranslation,
  normalizeSource,
  isDirectTranslationsAvailable,
  captureItemCapAllows,
  directAddRateLimiter,
  MAX_CAPTURE_SOURCE_LENGTH,
  MAX_CAPTURE_TARGET_LENGTH,
} from "../services/direct-translation.server";
import { MAX_DIRECT_ADD_BODY_BYTES } from "../services/direct-translation-limits.shared";
import { translateItemsIntoAllLocales } from "../services/direct-translation-ai.server";
import { verifyCaptureToken } from "../services/direct-capture-token.server";
import { isValidLocale } from "../utils/validation";
import { declaresBodyLargerThan, readBodyCapped } from "../utils/read-body-capped.server";

const NO_STORE = { "Cache-Control": "no-store" };

// Body cap: see MAX_DIRECT_ADD_BODY_BYTES in direct-translation-limits.shared.ts
// (kept out of this file: a route may export only its route values).

export async function action({ request }: ActionFunctionArgs) {
  // A declared oversize body is refused before anything else runs.
  if (declaresBodyLargerThan(request, MAX_DIRECT_ADD_BODY_BYTES)) {
    return json({ ok: false, error: "Body too large" }, { status: 413, headers: NO_STORE });
  }

  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, { status: 200 });

  let body: {
    sourceText?: unknown;
    captureToken?: unknown;
    translateAll?: unknown;
    locale?: unknown;
    targetText?: unknown;
  };
  const raw = await readBodyCapped(request, MAX_DIRECT_ADD_BODY_BYTES);
  if (!raw.ok) {
    return raw.tooLarge
      ? json(
          { ok: false, error: "Body too large" },
          { status: 413, headers: { ...NO_STORE, Connection: "close" } },
        )
      : json({ ok: false, error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }
  try {
    body = JSON.parse(raw.text);
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }

  // The merchant proof. Checked before the plan lookup so an anonymous caller
  // learns nothing about the shop and costs no DB query.
  if (!verifyCaptureToken(body.captureToken, session.shop)) {
    return json({ ok: false, error: "captureTokenInvalid" }, { status: 403, headers: NO_STORE });
  }

  // Per-shop rate limit — only for requests that carry the merchant's token.
  // It used to run BEFORE the token check, so anonymous token-less POSTs
  // (any storefront visitor can send them) drained the shop's bucket and
  // locked the merchant out of capture mode. A refused request costs a JSON
  // parse and one HMAC, no DB work, so it needs no bucket of its own.
  if (!directAddRateLimiter.allow(session.shop)) {
    return json({ ok: false, error: "rateLimited" }, { status: 429, headers: NO_STORE });
  }

  // Max-plan only.
  if (!(await isDirectTranslationsAvailable(db, session.shop))) {
    return json({ ok: false, error: "Not available on this plan" }, { status: 200, headers: NO_STORE });
  }

  if (body.translateAll !== undefined && typeof body.translateAll !== "boolean") {
    return json({ ok: false, error: "Invalid translateAll" }, { status: 400, headers: NO_STORE });
  }
  const translateAll = body.translateAll === true;

  if (typeof body.sourceText !== "string") {
    return json({ ok: false, error: "Empty source" }, { status: 400, headers: NO_STORE });
  }
  const sourceText = normalizeSource(body.sourceText);
  if (!sourceText) return json({ ok: false, error: "Empty source" }, { status: 400, headers: NO_STORE });
  if (sourceText.length > MAX_CAPTURE_SOURCE_LENGTH) {
    return json({ ok: false, error: "Source too long" }, { status: 400, headers: NO_STORE });
  }

  // Validate the optional translation pair UP FRONT — previously an invalid
  // locale rejected the request AFTER createItem ran, leaving an orphan item
  // in the DB with no way to undo it server-side.
  const locale = typeof body.locale === "string" ? body.locale.trim() : "";
  const targetText = typeof body.targetText === "string" ? body.targetText : "";
  if (targetText.length > MAX_CAPTURE_TARGET_LENGTH) {
    return json({ ok: false, error: "Translation too long" }, { status: 400, headers: NO_STORE });
  }
  const hasExplicitTranslation = locale.length > 0 && targetText.trim().length > 0;
  if (hasExplicitTranslation && (locale.length > 16 || !isValidLocale(locale))) {
    return json({ ok: false, error: "Invalid locale" }, { status: 400, headers: NO_STORE });
  }

  if (!(await captureItemCapAllows(db, session.shop, sourceText))) {
    return json({ ok: false, error: "itemLimitReached" }, { status: 409, headers: NO_STORE });
  }

  const item = await createItem(db, session.shop, sourceText);
  if (hasExplicitTranslation) {
    await setTranslation(db, session.shop, item.id, locale, targetText, "user");
  }

  // Optional: AI-translate into all published target locales (background, Task-tracked).
  let translating = false;
  if (translateAll && admin) {
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
    { headers: NO_STORE },
  );
}
