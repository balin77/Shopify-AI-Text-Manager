/**
 * Which of a resource's foreign translations no longer describe their primary
 * text — pure, client-safe, and the ONE place the rule is written down.
 *
 * THE GATE — "this sync SAW the primary text move". Nothing is stale unless
 * the key's source digest DIFFERS from the digest the previous sync stored on
 * that resource's translation rows. This is the load-bearing rule, and it is
 * checked first:
 *
 *   Shopify's `outdated` flag says a translation is older than its source —
 *   it does NOT say WHEN that happened. A shop that has been translating for
 *   years (Langify, hand-written entries in the Shopify admin) carries plenty
 *   of translations Shopify flags outdated and keeps serving anyway. Acting on
 *   the flag alone would mean that editing ONE product's price — `products/
 *   update` fires for that too — deletes every outdated translation that
 *   product has ever accumulated. Unrecoverable, and nothing the merchant did
 *   asked for it. Requiring a digest CHANGE since our own last sync makes the
 *   trigger exactly what the feature promises: the primary text changed, now,
 *   outside this app.
 *
 *   The baseline is per (LOCALE, KEY), never one digest per key: a digest
 *   describes the source a PARTICULAR translation was written against, and two
 *   locales legitimately hold different ones (translate DE, the merchant edits
 *   the source, translate FR — DE is now stale and FR is not). Collapsing them
 *   made which row got repaired depend on the order Postgres returned them in.
 *
 *   No previous digest ⇒ no evidence ⇒ nothing stale. That covers a first
 *   sync (fresh install, newly cached resource) and rows written before
 *   digests were stored; the sync itself writes the digests, so a shop
 *   self-heals into the feature after one pass instead of paying for it.
 *
 * Once a key is through that gate, ONE of two signals has to confirm the
 * translation is actually stale:
 *
 *  1. **Shopify's own `outdated` flag.** Authoritative for ANY key, including
 *     ones this app does not manage. If someone re-registered the translation
 *     against the new source in between, Shopify reports `false` and we leave
 *     it alone — which is why this is checked in addition to the digest.
 *
 *  2. **The primary value is gone.** `translatableContent` only lists keys
 *     that HAVE a primary value (CLAUDE.md: the trap that produced the wrong
 *     "collection images are not translatable" invariant). So a key that has a
 *     translation but no entry in `translatableContent` is a field the
 *     merchant CLEARED — and Shopify does not always flag that as outdated,
 *     which is exactly the case that used to leave orphan translations behind
 *     ("wird ein Eintrag in der Hauptsprache gelöscht, bleibt die Übersetzung
 *     stehen"). This rule is deliberately limited to the keys this app
 *     manages, so an exotic key of some other app is never touched on a
 *     signal this weak.
 *
 * All of it applies to the GLOBAL layer only (`marketId ""`). A market-specific
 * override is a deliberate, separate value and survives a primary change —
 * the same rule the single and the bulk editor already follow.
 *
 * An EMPTY `primaryContent` map is not evidence of anything (a failed or
 * partial fetch looks identical to "every field cleared"), so rule 2 is
 * skipped entirely in that case rather than reporting the whole resource
 * stale.
 */

/** One `translatableContent` entry: the primary value plus its digest. */
export interface PrimaryContentEntry {
  value: string;
  digest?: string | null;
}

/** A translation row as the sync fetched it from Shopify. */
export interface SyncedTranslation {
  key: string;
  value: string;
  locale: string;
  /** "" (or absent) = global layer; a market GID = market override. */
  marketId?: string;
  /** Shopify's own staleness verdict. `undefined` = the caller did not ask. */
  outdated?: boolean;
}

export type StaleReason = "outdated" | "primary-empty";

/**
 * Key for the per-(locale, key) digest baseline. The separator is an ESCAPE,
 * never a literal control byte — a NUL in the source makes git treat the file
 * as binary and the module invisible in every diff.
 */
export function digestBaselineKey(locale: string, key: string): string {
  return `${locale}\u0000${key}`;
}

export interface StaleTranslation {
  key: string;
  locale: string;
  /**
   * The Shopify resource this translation actually lives on, when it is NOT the
   * one being repaired. A product save moves its OPTIONS, OPTION VALUES and
   * METAFIELDS too, and each of those is its own `translatableResource` with
   * its own GID — but they are one merchant action, so they are repaired as one
   * group: one Task row, one batched detection, one AI request per locale.
   * Absent = the group's own resource, which is every content-type entry.
   */
  resourceId?: string;
  /** `ContentTranslation.resourceType` (or the mirror's equivalent) for the
   *  row above. Absent = the group's own. */
  resourceType?: string;
  /**
   * `false` forces this entry to the REMOVAL even under auto-translate. The
   * caller uses it for a value the generic prompt cannot carry — a multi-line
   * text (newlines are stripped) or a list field (raw JSON) — where a
   * re-translation would be echo-confirmed and mirrored, i.e. recorded as a
   * success while the value is corrupt. Removing it is what happened before
   * auto-translate reached these surfaces, so it is the known-safe answer.
   */
  retranslatable?: boolean;
  reason: StaleReason;
  /** The CURRENT primary value ("" when the field was cleared). */
  primaryValue: string;
  /** Digest of the current primary value — required to re-register. */
  digest?: string | null;
}

/**
 * Translation keys this app manages on a resource's own `translatableResource`
 * (the values of FIELD_TO_TRANSLATION_KEY plus ShopPolicy's "body").
 */
export const MANAGED_TRANSLATION_KEYS: ReadonlySet<string> = new Set([
  "title",
  "body_html",
  "body",
  "handle",
  "meta_title",
  "meta_description",
  "product_type",
  "summary_html",
]);

/**
 * Keys a stale translation may be RE-translated for automatically (Max plan).
 *
 * `handle` is deliberately absent: a slug is a URL. Rewriting it unattended
 * would move a storefront page nobody asked to move (and leave the old URL to
 * Shopify's redirect handling), so a stale handle translation is purged like
 * before and re-translated by the merchant on purpose.
 */
export const AUTO_RETRANSLATABLE_KEYS: ReadonlySet<string> = new Set([
  "title",
  "body_html",
  "body",
  "meta_title",
  "meta_description",
  "product_type",
  "summary_html",
]);

/**
 * @param translations  Every translation row the sync fetched (all layers).
 * @param primaryContent  key → { value, digest } from `translatableContent`.
 *   Keys with an empty primary value are ABSENT — that is Shopify's shape, not
 *   a caller convention.
 * @param previousDigests  `digestBaselineKey(locale, key)` → the source digest
 *   stored on THAT translation row before this sync overwrote it. A row whose
 *   digest is unchanged (or unknown) did not move and can never be stale — see
 *   THE GATE above. An empty/absent map therefore yields nothing, which is what
 *   makes a first sync harmless.
 */
export function findStaleTranslations(
  translations: readonly SyncedTranslation[],
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>,
  previousDigests: Readonly<Record<string, string | null | undefined>> = {},
): StaleTranslation[] {
  const primaryKnown = Object.keys(primaryContent).length > 0;
  const seen = new Set<string>();
  const stale: StaleTranslation[] = [];

  for (const row of translations) {
    if ((row.marketId ?? "") !== "") continue; // global layer only

    const entry = primaryContent[row.key];
    const primaryValue = entry?.value ?? "";
    const primaryEmpty = !primaryValue.trim();

    // THE GATE: did the source text move since OUR last sync? A missing
    // previous digest is "we cannot tell", never "it changed".
    const previousDigest = previousDigests[digestBaselineKey(row.locale, row.key)];
    if (!previousDigest) continue;
    if ((entry?.digest ?? null) === previousDigest) continue;

    // An empty map is a failed/partial fetch, not "every field was cleared" —
    // and with no primary content there is no digest to have moved either, so
    // nothing here can be judged. Stated as its own rule rather than left to
    // follow from the gate, because the header promises it.
    if (!primaryKnown) continue;

    let reason: StaleReason | null = null;
    if (row.outdated === true) {
      reason = "outdated";
    } else if (primaryEmpty && MANAGED_TRANSLATION_KEYS.has(row.key)) {
      reason = "primary-empty";
    }
    if (!reason) continue;

    // A resource can report the same (key, locale) once per market layer; the
    // global row is the only one that reaches here, but a defensive dedupe
    // keeps the removal call free of duplicates. The separator is written as
    // an ESCAPE, never as a literal NUL: a control byte in the source makes
    // git treat this file as binary, and the module that decides which
    // translations get deleted would then be invisible in every diff.
    const id = `${row.locale}\u0000${row.key}`;
    if (seen.has(id)) continue;
    seen.add(id);

    stale.push({
      key: row.key,
      locale: row.locale,
      reason,
      primaryValue,
      digest: entry?.digest ?? null,
    });
  }

  return stale;
}

/**
 * Split the stale set into three: "re-translate this", "just delete this", and
 * "we declined to translate this".
 *
 * The third one exists because the two are not the same promise. `purge` is
 * what the automation CANNOT deliver — a cleared source with nothing to
 * translate, a missing digest, a `handle` — and a shop that asked for "always
 * give it the new text" wants those removed rather than left describing text
 * that no longer exists. `declined` is what WE refuse to hand to the AI for our
 * own safety (a multi-line value, markup, a type the prompt would corrupt), and
 * that is not the merchant's automation failing: it is us choosing not to try,
 * so their stored "don't delete" answer stands. Folding the two would delete
 * every richtext theme translation on a shop that switched the deletion off.
 *
 * A stale entry can only be re-translated when there IS a new primary value to
 * translate (a cleared field has nothing to say), the key is one we translate
 * automatically, and a digest is available — `translationsRegister` requires
 * one, and a translation we cannot register would leave the storefront showing
 * the stale text we set out to remove.
 */
/**
 * Can this value go through the generic single-line prompt at all?
 *
 * A TYPE check is not always available — a theme setting carries no type
 * metadata, only a key — so the VALUE is asked instead, which is the question
 * anyway: `translateBatchValues` sanitises with `allowNewlines: false`, so
 * anything multi-line comes back flattened, and it has no rule that preserves
 * markup, so a value carrying tags comes back with them rewritten or dropped.
 * Both would be echo-confirmed and mirrored, i.e. corruption recorded as a
 * success. A value this refuses keeps the behaviour that predates
 * auto-translate on these surfaces: its stale translation is REMOVED.
 *
 * Deliberately conservative in the same direction as `isBatchTranslatableValueType`,
 * which stays as the TYPE-level guard where a type is known — this is the
 * value-level backstop for the surfaces where it is not.
 */
export function survivesValuePrompt(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  // Opening AND closing tags, and HTML entities: a value carrying any of them
  // is markup the prompt has no rule to preserve, and matching only `<a…>`
  // let `…</a>` and `&amp;` straight through into the flattening batch — the
  // corruption this exists to prevent. A plain `&` is not markup and passes.
  if (/<\/?[a-zA-Z][^>]*>/.test(value)) return false;
  return !/&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/.test(value);
}

export function partitionStaleTranslations(
  stale: readonly StaleTranslation[],
  autoTranslate: boolean,
  /**
   * `anyKey` lifts the `AUTO_RETRANSLATABLE_KEYS` allowlist, and only a caller
   * that translates BARE VALUES may pass it. That list is a vocabulary of
   * CONTENT-FIELD keys whose one job is to keep `handle` out — a slug is a URL,
   * and rewriting one unattended moves a storefront page nobody asked to move.
   * A metafield's `value`, an option's `name` and a metaobject field key are
   * simply not in it, so applying it there would silently re-translate NOTHING
   * on those surfaces while reporting that it had. There is no `handle` among
   * them to protect: they name their own keys, and the caller has already
   * filtered to the ones it changed.
   */
  opts: { anyKey?: boolean } = {},
): { retranslate: StaleTranslation[]; purge: StaleTranslation[]; declined: StaleTranslation[] } {
  const retranslate: StaleTranslation[] = [];
  const purge: StaleTranslation[] = [];
  const declined: StaleTranslation[] = [];
  for (const entry of stale) {
    if (!autoTranslate || !entry.primaryValue.trim() || !entry.digest) {
      // Nothing to translate, or nothing to register it against. The
      // automation cannot deliver these no matter what we do.
      purge.push(entry);
      continue;
    }
    // The caller's own refusal, on EVERY surface: it is a deliberate decline,
    // not a failure, so it keeps the merchant's stored answer.
    if (entry.retranslatable === false) {
      declined.push(entry);
      continue;
    }
    if (opts.anyKey) {
      // A value surface: we DECLINE anything the single-line prompt would
      // mangle — see `declined` on the return type for why that is not the
      // same as a failure.
      (survivesValuePrompt(entry.primaryValue) ? retranslate : declined).push(entry);
      continue;
    }
    // A content surface: the allowlist keeps `handle` out, and that exclusion
    // is deliberately a PURGE — a slug the merchant cannot have re-translated
    // must not keep describing a URL that moved (CLAUDE.md).
    (AUTO_RETRANSLATABLE_KEYS.has(entry.key) ? retranslate : purge).push(entry);
  }
  return { retranslate, purge, declined };
}
