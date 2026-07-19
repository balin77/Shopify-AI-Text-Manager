/**
 * Content-Template Variable Substitution
 *
 * Pure, dependency-free helpers that replace `{{variable}}` placeholders in a
 * reusable prompt template with values taken from the current content data.
 *
 * Kept pure (no DB / no server imports) so it is fully unit-testable. The
 * sanitization of the *substituted values* (which originate from merchant
 * content and must not be able to inject prompt instructions) happens in the
 * service layer BEFORE the values reach this function — see
 * app/services/content-template.service.ts.
 *
 * Placeholder syntax: `{{ name }}` where `name` is `[A-Za-z0-9_]+`. Surrounding
 * whitespace inside the braces is ignored, so `{{name}}` and `{{ name }}` are
 * equivalent. Names are matched case-sensitively.
 *
 * Unknown placeholders (no matching key, or a null/undefined value) are left
 * intact in the output so the merchant can see in the preview that a variable
 * did not resolve, and are additionally reported via `missingVars`.
 */

/** Matches `{{ variable_name }}` with optional inner whitespace. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export interface SubstitutionResult {
  /** Template with all resolvable placeholders replaced. */
  result: string;
  /** Distinct variable names that were successfully substituted. */
  usedVars: string[];
  /** Distinct placeholder names present in the template but not resolvable. */
  missingVars: string[];
}

/**
 * Returns the distinct variable names referenced by a template, in first-seen
 * order. Useful for the editor UI ("this template uses: …").
 */
export function extractTemplateVariables(template: string): string[] {
  if (!template) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Substitutes `{{variable}}` placeholders with the provided values.
 *
 * A variable is considered resolvable only when `vars` contains the key AND
 * its value is neither `null` nor `undefined`. An empty string IS a valid
 * value (the merchant may legitimately have an empty field) and counts as
 * used, not missing.
 */
export function substituteTemplateVariables(
  template: string,
  vars: Record<string, string | null | undefined>,
): SubstitutionResult {
  if (!template) {
    return { result: "", usedVars: [], missingVars: [] };
  }

  const used = new Set<string>();
  const missing = new Set<string>();

  const result = template.replace(PLACEHOLDER_RE, (full, rawName: string) => {
    const name = rawName as string;
    const value = Object.prototype.hasOwnProperty.call(vars, name)
      ? vars[name]
      : undefined;

    if (value === null || value === undefined) {
      missing.add(name);
      return full; // leave placeholder intact so it is visible
    }

    used.add(name);
    return value;
  });

  return {
    result,
    usedVars: [...used],
    missingVars: [...missing],
  };
}
