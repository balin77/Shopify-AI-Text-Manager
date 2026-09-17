/**
 * Which glossary rule applies to ONE locale — the shared answer.
 *
 * Client-safe (`.shared`) on purpose, and that is the whole reason this is not
 * in `glossary.service.ts`: that module imports `db.server`, so a single
 * import of it from a component pulls Prisma into the client bundle and
 * `npm run build` refuses it — which typecheck and vitest both miss.
 *
 * Both ends must agree on the answer. The prompt builders resolve a rule
 * through this so a `de` entry reaches a `de-CH` translation; the glossary
 * EDITOR resolves it through the same function so the field can say that the
 * inherited rule is in force. A second copy would drift, and the failure mode
 * is the one this exists to fix: an empty field that means "no rule" on one
 * side and "the base rule applies" on the other.
 */

/** A rule's fixed renderings, `locale -> value`. */
export type GlossaryTranslations = Record<string, string>;

export interface ResolvedGlossaryValue {
  /** The locale the value is actually STORED under (`de` for a `de-CH` ask). */
  locale: string;
  value: string;
}

/**
 * The rendering that applies to `locale`, and the locale it is stored under.
 *
 * Subtags are dropped ONE at a time from the right, so `zh-Hant-TW` asks
 * `zh-Hant` before `zh`: the most specific entry wins, which is how a merchant
 * says "in Switzerland we call it something else". It only ever widens
 * DOWNWARDS (`de` reaches `de-CH`), never up — a Swiss wording must not leak
 * into generic German.
 *
 * An empty or whitespace-only value is "no rule" (that is what normalize
 * stores), so an exact entry holding one does NOT shadow the base entry. The
 * flip side, stated rather than hidden: there is therefore no way to say
 * "translate FREELY in de-CH" once a `de` rule exists - clearing the de-CH
 * field re-inherits it. That is now at least VISIBLE (the editor renders the
 * inherited rendering as the field's placeholder via `inheritedGlossaryValue`)
 * rather than an empty field quietly meaning the opposite of what it says.
 * Expressing the opt-out needs a sentinel value and an affordance to go with
 * it; recording one the editor renders as blank would be worse than none.
 *
 * Own-property lookups only, because the key comes off the wire and
 * `translations["constructor"]` is not a translation.
 */
export function resolveGlossaryValue(
  translations: GlossaryTranslations,
  locale: string,
): ResolvedGlossaryValue | undefined {
  const at = (key: string): string | undefined => {
    if (!key || !Object.prototype.hasOwnProperty.call(translations, key)) return undefined;
    const v = translations[key];
    return typeof v === "string" && v.trim() ? v : undefined;
  };

  let key = locale;
  for (;;) {
    const hit = at(key);
    if (hit !== undefined) return { locale: key, value: hit };
    const cut = key.lastIndexOf("-");
    if (cut <= 0) return undefined;
    key = key.slice(0, cut);
  }
}

/** The applying rendering alone, for callers that do not care where it is stored. */
export function glossaryValueForLocale(
  translations: GlossaryTranslations,
  locale: string,
): string | undefined {
  return resolveGlossaryValue(translations, locale)?.value;
}

/**
 * The rendering `locale` INHERITS, i.e. one that applies but is stored under a
 * different locale. `undefined` when the locale has its own entry or none
 * applies — the two cases where the editor's empty field is already truthful.
 */
export function inheritedGlossaryValue(
  translations: GlossaryTranslations,
  locale: string,
): ResolvedGlossaryValue | undefined {
  const resolved = resolveGlossaryValue(translations, locale);
  if (!resolved || resolved.locale === locale) return undefined;
  return resolved;
}
