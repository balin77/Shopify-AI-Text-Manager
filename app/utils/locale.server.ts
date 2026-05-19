import { DEFAULT_LOCALE, type Locale } from "~/i18n";

const SUPPORTED: readonly Locale[] = ["de", "en", "es"];

function toSupported(raw: string | null | undefined): Locale | null {
  if (!raw) return null;
  // "de-DE", "es_419", "EN" → base language token
  const base = raw.trim().toLowerCase().split(/[-_;,\s]/)[0];
  return (SUPPORTED as readonly string[]).includes(base) ? (base as Locale) : null;
}

/**
 * R4-UX1: resolve the merchant's preferred app locale from the Shopify
 * embedded-app request when they have NOT made an explicit choice.
 *
 * Shopify App Bridge appends the merchant's admin UI language as a
 * `?locale=` query param on every embedded request (e.g. `de`, `es-ES`);
 * `Accept-Language` is the browser fallback. Previously the app ignored
 * both and defaulted to English, so a German/Spanish merchant saw the app
 * in English until they manually found Settings → App Language (and the
 * bundled de/es translations were effectively never shown by default).
 *
 * `shopPrimaryLocale` (the storefront's primary language) is a weak last
 * resort — it is about the shop's customers, not the person using the
 * admin — but it is better than a hardcoded default.
 *
 * Returns a guaranteed-supported Locale (never throws).
 */
export function resolveMerchantLocale(
  request: Request,
  shopPrimaryLocale?: string | null,
): Locale {
  let url: URL | null = null;
  try {
    url = new URL(request.url);
  } catch {
    /* non-standard request URL — fall through to header/default */
  }

  return (
    toSupported(url?.searchParams.get("locale")) ??
    toSupported(request.headers.get("accept-language")) ??
    toSupported(shopPrimaryLocale) ??
    DEFAULT_LOCALE
  );
}
