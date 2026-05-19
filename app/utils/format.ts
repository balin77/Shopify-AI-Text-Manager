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
 */
export function formatNumber(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}
