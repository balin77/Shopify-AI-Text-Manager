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
 * The DETECTION here is GLOBAL-layer only (`marketId ""`): a market override is
 * a deliberately different wording and nothing in this app ever re-translates
 * one, so it is never a reason to start a repair. It no longer SURVIVES a
 * primary change, though — `purgeMarketOverrides`
 * (market-layer-purge.server.ts) removes it wherever something happens to the
 * global row beside it, because otherwise it would describe text that no longer
 * exists with nobody left to notice.
 *
 * An EMPTY `primaryContent` map is not evidence of anything (a failed or
 * partial fetch looks identical to "every field cleared"), so rule 2 is
 * skipped entirely in that case rather than reporting the whole resource
 * stale.
 *
 * THE FILL — "auto-translate" means translate, not only refresh. Everything
 * above answers "which existing translations moved out from under their source",
 * because a translation row is where the digest baseline lives. A locale that
 * was never translated has no row, so it can never be the one that notices, and
 * for a shop with the auto-translation on that read as the feature being off:
 * the primary text changed, the languages that had a translation got the new
 * one, and the languages that had none stayed empty forever. `fillLocales`
 * closes it — once a key has PROVEN itself through the gate above, every
 * published locale that holds no translation of it gets one too. Only entries
 * that will really be translated are filled; see the option's own note.
 *
 * THE SECOND ENTRANCE — a baseline that does not live on a translation row.
 * The fill above still needs ONE translated locale to prove the key moved, so a
 * resource nobody had translated yet could never be proven changed: an edit in
 * the Shopify admin reached nothing, while the same edit made in this app (whose
 * save needs no proof — it performed the write) translated everything. The
 * PRIMARY digest baseline (`PrimaryDigestBaseline`, one row per resource, the
 * digests `translatableContent` reported the last time we looked) closes that:
 * a managed key whose primary digest moved against IT feeds the same fill, for
 * the locales that hold no value. Rule one is unchanged and outranks everything
 * — NO STORED DIGEST, NO EVIDENCE, NOTHING HAPPENS — so the first sync after the
 * deploy only writes baselines and translates nothing.
 *
 * What that entrance does NOT have, by construction, is the SECOND SIGNAL. A
 * locale with no translation carries no `outdated` flag, and a key whose primary
 * value is empty has nothing to translate, so neither confirmation above can
 * ever exist for it: the entrance stands on the digest change ALONE. That is a
 * deliberate decision, not a loosening, and it is bounded on both sides — it
 * only ever CREATES a translation where none exists (a locale that already holds
 * a value is left to the first entrance, so a row Shopify reports `outdated:
 * false` is never touched), and the second signal exists to protect an EXISTING
 * translation from a stale flag, of which there is none here. It is also exactly
 * what the in-app save path (`reconcileAfterPrimarySave`) has always done.
 */

/**
 * The locales the FILL translates into: published, and not the primary one — a
 * primary locale never holds a translation row, and an unpublished locale is on
 * no storefront. Written once because every sync derives it from the same
 * `shopLocales` shape and a call site that filtered only on `primary` would
 * translate into a language the shop does not serve.
 */
export function publishedForeignLocales(
  locales: ReadonlyArray<{ locale: string; primary?: boolean; published?: boolean }>,
): string[] {
  return locales.filter((l) => l.published && !l.primary).map((l) => l.locale);
}

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
  /**
   * This (locale, key) holds NO translation today — the entry exists to CREATE
   * one (`findStaleTranslations`' fill). It is never a removal, in either
   * direction: `partitionStaleTranslations` drops it outright when the
   * auto-translation is off (where every other entry becomes a purge), and the
   * fallback purge that follows a failed AI run skips it. Sending a removal for
   * a translation that does not exist echoes nothing back, costs a re-read per
   * locale, and reports removals the merchant never had.
   */
  filled?: boolean;
  /**
   * This fill was proven by the PRIMARY digest baseline alone — no translation
   * row of the key moved (see THE SECOND ENTRANCE in the header). Always
   * `filled` as well. Carried so the caller can apply its daily brake to exactly
   * the work that did not exist before this entrance did, and hold that key's
   * baseline back when it refuses.
   */
  baselineFill?: boolean;
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
 * Keys a stale translation may be RE-translated for automatically (Max plan)
 * WITHOUT the merchant asking for that key by name.
 *
 * `handle` is deliberately absent, and stays absent: a slug is a URL, so
 * rewriting one unattended moves a storefront page nobody asked to move. It is
 * the one key behind an explicit second switch — `translateHandles` in
 * `classifyStaleTranslation`, fed by `AISettings.autoTranslateHandles`. With
 * that switch off the behaviour is unchanged (the stale handle translation is
 * purged); with it on the handle is REFRESHED and FILLED under the rules
 * written at that option — on every entrance, in-app and sync-side alike —
 * never added to this list — because "may this key be translated at
 * all" and "may it be translated by default" are different questions and the
 * fill below asks the second one.
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
  /**
   * THE FILL. `fillLocales` turns "refresh what is there" into what the switch
   * is called: a key this function PROVED moved also yields an entry for every
   * published locale that holds NO translation of it yet, so a shop with the
   * auto-translation on gets the new text in every language rather than only in
   * the ones that happened to be translated before.
   *
   * Only the caller that has the shop's published foreign locales may pass it,
   * and only when the auto-translation is really in force — a fill entry is by
   * construction one that will be TRANSLATED (`classifyStaleTranslation` decides,
   * so the rule cannot drift from the partition), never one that will be
   * removed: there is nothing to remove where nothing exists, and sending the
   * removal anyway would be an unechoed no-op logged as an unconfirmed removal
   * for every locale the merchant never translated.
   */
  opts: {
    fillLocales?: readonly string[];
    anyKey?: boolean;
    translateHandles?: boolean;
    /**
     * THE SECOND ENTRANCE: key → the PRIMARY digest stored the last time this
     * resource was looked at (`PrimaryDigestBaseline`). Only consulted together
     * with `fillLocales`, because all it can ever produce is a fill. Absent, or
     * a key absent from it, is no evidence (rule one).
     */
    previousPrimaryDigests?: Readonly<Record<string, string | null | undefined>>;
  } = {},
): StaleTranslation[] {
  const primaryKnown = Object.keys(primaryContent).length > 0;
  const seen = new Set<string>();
  const stale: StaleTranslation[] = [];
  /**
   * (locale, key) pairs that already CARRY A VALUE on the global layer — the
   * fill below adds the locales this set does not hold.
   *
   * The value check is the whole point and not a defence: `translations(locale:)`
   * answers with a row per translatable KEY and `value: null` where that locale
   * has nothing, and every sync in this repo hands those rows straight through
   * (only the drift sweep filters them). Counting them as translated made the
   * fill a no-op on exactly the shops it is for — a shop publishing de and it
   * with only de translated reported it as "already has one" and stayed empty,
   * which is the merchant report this exists to fix.
   */
  const translated = new Set<string>();
  for (const row of translations) {
    if ((row.marketId ?? "") !== "") continue;
    if (!row.value || !row.value.trim()) continue;
    translated.add(`${row.locale}\u0000${row.key}`);
  }

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

  // THE FILL. A key is only filled once it has PROVEN itself above — same gate,
  // same two signals, same evidence — so this can never translate a key on a
  // resource whose source text nobody touched. What it adds is the locales that
  // had nothing to prove it with: a translation row is where the digest
  // baseline lives, so a locale that was never translated can never be the one
  // that notices, and requiring it to be is what made "translate automatically"
  // mean "refresh what is already there".
  if (opts.fillLocales?.length) {
    const provenKeys = [...new Set(stale.map((entry) => entry.key))];
    for (const key of provenKeys) {
      const entry = primaryContent[key];
      for (const locale of opts.fillLocales) {
        const id = `${locale}\u0000${key}`;
        if (translated.has(id) || seen.has(id)) continue;
        const candidate: StaleTranslation = {
          key,
          locale,
          reason: "outdated",
          primaryValue: entry?.value ?? "",
          digest: entry?.digest ?? null,
          // KNOWN to hold no translation — see the flag's own note: it keeps
          // this entry out of every removal, including the fallback purge a
          // failed AI run triggers.
          filled: true,
        };
        // Only a candidate that will really be TRANSLATED is emitted: a purge
        // entry here would address a translation that does not exist.
        if (
          classifyStaleTranslation(candidate, true, {
            anyKey: opts.anyKey,
            translateHandles: opts.translateHandles,
          }) !== "retranslate"
        ) {
          continue;
        }
        seen.add(id);
        stale.push(candidate);
      }
    }
  }

  // THE SECOND ENTRANCE. A key the first entrance could not prove — typically
  // because no locale has ever translated it — but whose PRIMARY digest moved
  // against the per-resource baseline. Same fill, same classifier, same
  // "never where a value already exists"; only the evidence in front differs,
  // and it stands on the digest alone (see the header for why that is a
  // decision and not a loosening).
  if (opts.fillLocales?.length && opts.previousPrimaryDigests && primaryKnown) {
    const provenKeys = new Set(stale.map((entry) => entry.key));
    for (const key of primaryBaselineMovedKeys(primaryContent, opts.previousPrimaryDigests)) {
      if (provenKeys.has(key)) continue;
      const entry = primaryContent[key];
      for (const locale of opts.fillLocales) {
        const id = `${locale}\u0000${key}`;
        if (translated.has(id) || seen.has(id)) continue;
        const candidate: StaleTranslation = {
          key,
          locale,
          reason: "outdated",
          primaryValue: entry?.value ?? "",
          digest: entry?.digest ?? null,
          filled: true,
          baselineFill: true,
        };
        if (
          classifyStaleTranslation(candidate, true, {
            anyKey: opts.anyKey,
            translateHandles: opts.translateHandles,
          }) !== "retranslate"
        ) {
          continue;
        }
        seen.add(id);
        stale.push(candidate);
      }
    }
  }

  return stale;
}

/**
 * The MANAGED keys whose primary digest moved against the per-resource
 * baseline — the evidence of THE SECOND ENTRANCE.
 *
 * A key qualifies only when ALL of these hold, and every one is rule one in a
 * different costume: the baseline HAS a digest for it (none ⇒ no evidence — a
 * first sync, a field filled for the first time since we started recording), the
 * key HAS a current value with a digest (an absent entry is a cleared field, and
 * a cleared field has nothing to translate), and the two differ. Deliberately
 * limited to `MANAGED_TRANSLATION_KEYS`: the baseline only ever records those.
 */
export function primaryBaselineMovedKeys(
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>,
  previousPrimaryDigests: Readonly<Record<string, string | null | undefined>>,
): string[] {
  const moved: string[] = [];
  for (const [key, entry] of Object.entries(primaryContent)) {
    if (!MANAGED_TRANSLATION_KEYS.has(key)) continue;
    const previous = previousPrimaryDigests[key];
    if (!previous) continue;
    if (!entry.digest || !entry.value.trim()) continue;
    if (entry.digest !== previous) moved.push(key);
  }
  return moved;
}

/**
 * The baseline map to STORE after this look, or `null` when nothing needs
 * writing — the second is the common case and the point: a sync where no text
 * moved must not cost a database write (a full sync over 5000 products would
 * otherwise be 5000 upserts per run).
 *
 * Built as an OVERLAY on the previous map, not a replacement: a key whose field
 * is currently empty keeps the digest of the text it last had, so clearing a
 * field and writing a NEW text later is still a proven move (text A → nothing →
 * text B), while restoring the old text is not. `held` keys keep their previous
 * digest verbatim — the caller refused to act on their evidence (the daily
 * brake), and advancing the baseline past it would swallow the work instead of
 * deferring it. An empty `primaryContent` is a failed or partial fetch, never
 * "every field cleared", so it writes nothing.
 */
export function nextPrimaryDigestBaseline(
  previous: Readonly<Record<string, string>>,
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>,
  held: ReadonlySet<string> = new Set(),
): Record<string, string> | null {
  const next = primaryDigestBaselineTarget(previous, primaryContent, held);
  if (!next) return null;
  const keys = Object.keys(next);
  const unchanged =
    keys.length === Object.keys(previous).length && keys.every((key) => next[key] === previous[key]);
  return unchanged ? null : next;
}

/**
 * The map `nextPrimaryDigestBaseline` would store, WITHOUT the "did it change"
 * question — for a caller whose row no longer holds `previous` (a claim
 * already advanced it) and that compares against what it holds now. `null`
 * only for an empty content map (a failed fetch).
 */
export function primaryDigestBaselineTarget(
  previous: Readonly<Record<string, string>>,
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>,
  held: ReadonlySet<string> = new Set(),
): Record<string, string> | null {
  if (Object.keys(primaryContent).length === 0) return null;
  const next: Record<string, string> = { ...previous };
  for (const [key, entry] of Object.entries(primaryContent)) {
    if (!MANAGED_TRANSLATION_KEYS.has(key) || held.has(key)) continue;
    if (!entry.digest || !entry.value.trim()) continue;
    next[key] = entry.digest;
  }
  return next;
}

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
export type StaleVerdict = "retranslate" | "purge" | "declined";

/**
 * Which of the three a single entry belongs to. Split out of the partition
 * below because two callers need the SAME answer for one entry rather than for
 * a set: `findStaleTranslations`' fill only emits a candidate it knows will be
 * translated, and a second copy of these rules would decide differently within
 * one release.
 *
 * `anyKey` lifts the `AUTO_RETRANSLATABLE_KEYS` allowlist, and only a caller
 * that translates BARE VALUES may pass it. That list is a vocabulary of
 * CONTENT-FIELD keys whose one job is to keep `handle` out — a slug is a URL,
 * and rewriting one unattended moves a storefront page nobody asked to move.
 * A metafield's `value`, an option's `name` and a metaobject field key are
 * simply not in it, so applying it there would silently re-translate NOTHING
 * on those surfaces while reporting that it had. There is no `handle` among
 * them to protect: they name their own keys, and the caller has already
 * filtered to the ones it changed — which is why the handle rule below is
 * asked on the CONTENT path only.
 *
 * `translateHandles` is the merchant's opt-in (`AISettings.autoTranslateHandles`,
 * ANDed with the parent switch and the plan in
 * translation-change-policy.server.ts). Off — the default, and the behaviour
 * that predates the option — a stale `handle` is a PURGE, exactly as before.
 * On, it becomes a re-translation, and a FILLED entry is one too: the
 * merchant decided (2026-09) that the opt-in means "give every language a
 * translated handle", not only "refresh the ones that have one". A locale
 * without a handle of its own was served under the primary slug behind its
 * prefix; that address is covered by the primary handle's own redirect and
 * Shopify canonicalises it to the translated URL, so filling breaks nothing.
 *
 *  - the WRITE side has a second rail this function cannot see: the repair
 *    refuses a handle it cannot put a redirect on
 *    (handle-retranslation.server.ts). A pure classifier cannot ask Shopify
 *    what else answers that path, so "may this key move at all" is decided
 *    here and "may THIS URL move" is decided there.
 */
export function classifyStaleTranslation(
  entry: StaleTranslation,
  autoTranslate: boolean,
  opts: { anyKey?: boolean; translateHandles?: boolean } = {},
): StaleVerdict {
  if (!autoTranslate || !entry.primaryValue.trim() || !entry.digest) {
    // Nothing to translate, or nothing to register it against. The automation
    // cannot deliver these no matter what we do.
    return "purge";
  }
  // The caller's own refusal, on EVERY surface: it is a deliberate decline,
  // not a failure, so it keeps the merchant's stored answer.
  if (entry.retranslatable === false) return "declined";
  if (opts.anyKey) {
    // A value surface: we DECLINE anything the single-line prompt would
    // mangle — see `declined` on the partition's return type for why that is
    // not the same as a failure.
    return survivesValuePrompt(entry.primaryValue) ? "retranslate" : "declined";
  }
  // A content surface. `handle` is not in the allowlist and never will be; the
  // merchant's own opt-in is what moves it, and only out of the two buckets
  // above — see this function's note.
  if (entry.key === "handle") {
    if (!opts.translateHandles) return "purge";
    // Refreshed AND filled: the merchant's opt-in asks for translated handles,
    // and a locale that had none gets one (their decision, 2026-09). Filling
    // breaks nothing: that locale's address was the primary slug behind its
    // prefix, which the primary handle's own redirect covers and Shopify
    // canonicalises to the translated URL. Whether THIS URL may move is still
    // the resolver's question (handle-retranslation.server.ts).
    return "retranslate";
  }
  // Everything else the allowlist does not name is a PURGE — a stale
  // translation the automation cannot re-translate must not keep describing
  // text that moved (CLAUDE.md).
  return AUTO_RETRANSLATABLE_KEYS.has(entry.key) ? "retranslate" : "purge";
}

export function partitionStaleTranslations(
  stale: readonly StaleTranslation[],
  autoTranslate: boolean,
  opts: { anyKey?: boolean; translateHandles?: boolean } = {},
): { retranslate: StaleTranslation[]; purge: StaleTranslation[]; declined: StaleTranslation[] } {
  const retranslate: StaleTranslation[] = [];
  const purge: StaleTranslation[] = [];
  const declined: StaleTranslation[] = [];
  for (const entry of stale) {
    const verdict = classifyStaleTranslation(entry, autoTranslate, opts);
    // A fill has nothing to fall back to: it is a candidate to be TRANSLATED or
    // it is not a candidate at all. Structural rather than a rule in a comment,
    // because `fillLocales` is the caller's option and only this can stop a
    // caller that passed it under the wrong switch — or for a key the rules
    // refuse to fill, which is what `handle` now is — from turning a filled
    // entry into a removal of a translation that does not exist.
    if (entry.filled && verdict !== "retranslate") continue;
    if (verdict === "retranslate") retranslate.push(entry);
    else if (verdict === "declined") declined.push(entry);
    else purge.push(entry);
  }
  return { retranslate, purge, declined };
}
