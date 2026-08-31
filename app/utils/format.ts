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
 *
 * Two input shapes to keep out (no current caller passes either, both would
 * reintroduce the divergence these helpers exist to remove):
 * - A NON-ISO date string ("28.08.2026"): `new Date()` then falls into
 *   implementation-defined parsing, which the server's V8 and a non-V8
 *   browser may not agree on. Pass an ISO string or a Date.
 * - A DATE-ONLY string ("2026-08-28"): parsed as UTC midnight, so in a
 *   negative-offset zone the hydrated rendering lands on the PREVIOUS day
 *   while the pre-hydration one does not — the value visibly changes day on
 *   hydration. Pass a full timestamp.
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

/**
 * `a.localeCompare(b)` with no locale argument uses the HOST default locale —
 * Node's ICU default on the server, the merchant's browser locale in the
 * client. Where the result decides the ORDER of server-rendered list children
 * that is a STRUCTURAL hydration mismatch, which is worse than a differing text
 * node: React does not patch it, it throws the whole root away and re-renders
 * (production error #418). A Swedish browser sorts "Ä" after "Z" where an
 * en-US server sorts it next to "A", so one umlaut in a collection title is
 * enough.
 *
 * Collation is therefore bound to the app locale, which comes from the route
 * loader and is the same value on both sides — the same rule as formatNumber.
 * The collators are cached because building one is the expensive part and a
 * sort comparator calls this O(n log n) times.
 *
 * What this does NOT remove: server and browser can ship different ICU/CLDR
 * versions, so identical locales can still collate differently in principle.
 * That residual is small and stable for Latin-script content in en/de/es,
 * whereas the locale mismatch this replaces was systematic — a Swedish or
 * Turkish browser against an en-US server, every request. Two call sites carry
 * a LARGER residual than the collation itself because they sort by
 * `Intl.DisplayNames` output (getLocalizedLanguageName): display-name data
 * moves between CLDR releases far more than collation data does. Pinning that
 * would mean owning the language names in the app's own i18n — a separate
 * change, not a hydration fix.
 */
const collators = new Map<string, Intl.Collator>();
/** Callers pass the app locale, so 3 in practice. The cap only stops an
 *  unforeseen caller from growing this without bound in a long-lived server
 *  process — a collator is pure, so dropping the cache costs nothing but time. */
const MAX_CACHED_COLLATORS = 16;

export function collatorFor(locale: string): Intl.Collator {
  const cached = collators.get(locale);
  if (cached) return cached;
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(locale);
  } catch {
    // An unexpected tag (or "") would throw a RangeError. Falling back to a
    // FIXED locale keeps both sides in agreement, which is the whole point;
    // the host default would not — and on this stack the host default happens
    // to BE en-US, so a test comparing the two is worthless (see format.test).
    collator = new Intl.Collator("en");
  }
  if (collators.size >= MAX_CACHED_COLLATORS) collators.clear();
  collators.set(locale, collator);
  return collator;
}

/** Drop-in for `a.localeCompare(b)` in anything that renders. */
export function compareStrings(a: string, b: string, locale: string): number {
  return collatorFor(locale).compare(a, b);
}
