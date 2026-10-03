/**
 * The primary theme save answers its failures as STRUCTURED issues
 * (`errors: [{ errorKey, fields?, count?, detail? }]`) beside the English
 * `error` string, which stays as the fallback for a client that does not know a
 * code. This turns the issues into one sentence in the merchant's language.
 *
 * Fields are named by their LABELS (`labelFor`), never by raw keys; `detail` is
 * raw text from Shopify or a file name and is passed through in its own words,
 * inside a localised lead-in. Import-free (client and server).
 */
export interface ThemeSaveIssue {
  errorKey: string;
  /** Raw field keys (the first few). */
  fields?: string[];
  /** Total number of affected fields when `fields` is cut short. */
  count?: number;
  /** Shopify's own words or a file name. */
  detail?: string;
}

/** Every code the server may send; the i18n bundle carries one text for each. */
export const THEME_SAVE_ERROR_KEYS = [
  "themeSaveNotEditable",
  "themeSaveNotLocated",
  "themeSaveRichtext",
  "themeSaveShopifyRejected",
  "themeSaveSomeFailed",
  "themeSaveFileUnreadable",
  "themeSaveScopeRejected",
  "themeSaveNoTheme",
  "themeSaveNotAvailable",
  "themeSaveScopeDisabled",
] as const;

export const MAX_ISSUE_FIELDS = 5;

export function themeSaveIssuesOf(data: unknown): ThemeSaveIssue[] {
  const raw = (data as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (i): i is ThemeSaveIssue => !!i && typeof i === "object" && typeof (i as ThemeSaveIssue).errorKey === "string",
  );
}

/**
 * One sentence per issue, joined. Null when there are no issues or when any
 * issue's code has no text (the caller then shows the English fallback rather
 * than a half-translated message).
 */
export function themeSaveIssuesMessage(
  data: unknown,
  labelFor: (key: string) => string,
  texts: Record<string, string | undefined>,
): string | null {
  const issues = themeSaveIssuesOf(data);
  if (issues.length === 0) return null;
  const parts: string[] = [];
  for (const issue of issues) {
    const template = texts[issue.errorKey];
    if (!template) return null;
    const labels = (issue.fields ?? []).map(labelFor);
    const more = issue.count && issue.count > labels.length ? ` (+${issue.count - labels.length})` : "";
    parts.push(
      template
        // Replacer functions: a `$&` in Shopify's words or a label must stay literal.
        .replace("{fields}", () => labels.join(", ") + more)
        .replace("{detail}", () => issue.detail ?? ""),
    );
  }
  return parts.join(" ");
}
