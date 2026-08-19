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
 * Split the stale set into "re-translate this" and "just delete this".
 *
 * A stale entry can only be re-translated when there IS a new primary value to
 * translate (a cleared field has nothing to say), the key is one we translate
 * automatically, and a digest is available — `translationsRegister` requires
 * one, and a translation we cannot register would leave the storefront showing
 * the stale text we set out to remove.
 */
export function partitionStaleTranslations(
  stale: readonly StaleTranslation[],
  autoTranslate: boolean,
): { retranslate: StaleTranslation[]; purge: StaleTranslation[] } {
  const retranslate: StaleTranslation[] = [];
  const purge: StaleTranslation[] = [];
  for (const entry of stale) {
    const canRetranslate =
      autoTranslate &&
      !!entry.primaryValue.trim() &&
      !!entry.digest &&
      AUTO_RETRANSLATABLE_KEYS.has(entry.key);
    (canRetranslate ? retranslate : purge).push(entry);
  }
  return { retranslate, purge };
}
