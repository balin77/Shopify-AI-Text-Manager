/**
 * R4-UX6: locale-aware number formatting.
 *
 * `(n).toLocaleString()` with no argument uses the Node/browser default
 * locale (effectively "en-US" on the server and often there too), so a
 * German/Spanish merchant saw "1,000" where they expect "1.000". Bind the
 * grouping/decimal separators to the app locale instead.
 *
 * The app's Locale codes ("en" | "de" | "es") are already valid BCP-47
 * language tags, so they can be passed straight to Intl. Falls back to a
 * plain string if Intl ever throws on an unexpected tag.
 *
 * Binding the locale is ALSO what makes this SSR-safe: the app locale comes
 * from the route loader, so it is the same value on the server and in the
 * browser and both sides render the same string. A bare `toLocaleString()`
 * does not have that property — see the timestamp helpers below.
 */
export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  try {
    return new Intl.NumberFormat(locale, options).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Timestamps are the one thing an explicit locale can NOT make SSR-safe: the
 * server renders in UTC and the merchant's browser in its own time zone, so
 * the same instant is a different string on each side no matter which locale
 * is bound. React 18 reports that as a hydration mismatch — in production the
 * minified error #418, which throws the whole root away and re-renders it on
 * the client (this is what Sentry recorded on `master`).
 *
 * So every timestamp is rendered in two steps: a deterministic UTC stamp that
 * both sides agree on, and the merchant's local rendering once the client has
 * mounted. Callers pass the flag from
 * [useHydrated()](../hooks/useHydrated.ts).
 *
 * The localized half deliberately keeps `toLocaleString()` WITHOUT a bound
 * locale, i.e. the browser's own formatting — exactly what these call sites
 * showed before. Binding them to the app locale the way `formatNumber` does
 * would be a visible behaviour change and belongs in its own change, not in a
 * hydration fix.
 */
type TimestampInput = string | number | Date | null | undefined;

function toDate(value: TimestampInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026-08-28` — no locale, no time zone, identical on both sides. */
function utcDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** `18:00 UTC` — the zone is spelled out so the pre-hydration value can't be
 * misread as the merchant's local time. */
function utcTime(date: Date): string {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/**
 * Date + time. `fallback` is returned for a missing/unparseable value, so a
 * broken timestamp renders as nothing rather than as "Invalid Date".
 */
export function formatDateTime(value: TimestampInput, hydrated: boolean, fallback = ""): string {
  const date = toDate(value);
  if (!date) return fallback;
  return hydrated ? date.toLocaleString() : `${utcDate(date)} ${utcTime(date)}`;
}

/** Date only. */
export function formatDate(value: TimestampInput, hydrated: boolean, fallback = ""): string {
  const date = toDate(value);
  if (!date) return fallback;
  return hydrated ? date.toLocaleDateString() : utcDate(date);
}

/** Time only. */
export function formatTime(value: TimestampInput, hydrated: boolean, fallback = ""): string {
  const date = toDate(value);
  if (!date) return fallback;
  return hydrated ? date.toLocaleTimeString() : utcTime(date);
}
