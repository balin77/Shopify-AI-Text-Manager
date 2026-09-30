/**
 * Translation-change policy — what happens to a FOREIGN translation when its
 * PRIMARY source text changes.
 *
 * Until this module existed the answer was hard-coded in every write path:
 * "delete it". That is right by default (a translation of a text that no
 * longer exists is worse than no translation), but it is a merchant decision,
 * not ours — a shop whose translations are hand-written by an agency wants the
 * old value kept and re-checked, not thrown away. Settings → Übersetzungen
 * owns both switches; every purge site asks THIS module, never the column.
 *
 * Two rules make this module boring on purpose:
 *
 *  - **It fails OPEN.** A lookup error resolves to the historic behaviour
 *    (purge on, auto-translate off). A DB hiccup must never silently start
 *    keeping stale translations alive on the storefront — that is invisible to
 *    the merchant, while a purge is not.
 *  - **The two switches are mutually exclusive, and that is decided here** —
 *    but only where the re-translation actually runs. Auto-translate supersedes
 *    the purge on the surfaces the sync reconciles; on the ones it cannot reach
 *    (metaobjects, theme content, sub-resources, alt-texts) the merchant's
 *    stored choice stands, because "don't delete" without "will refresh" is
 *    just a stale translation nobody ever corrects.
 *  - **The plan gate lives here.** `autoTranslateExternalChanges` is a Max
 *    feature; the column can legitimately hold `true` on a shop that has since
 *    downgraded, so the flag is ANDed with the plan on every read instead of
 *    being reset on downgrade (the same rule the SEO limits follow).
 *  - **A sub-decision is ANDed with the decision it sits under.**
 *    `autoTranslateHandles` only means anything while the re-translation runs,
 *    so it is resolved against the parent switch here rather than at each
 *    reader. Neither column is cleared when the other is switched off: a
 *    merchant trying a switch must not lose the answer underneath it, which is
 *    what makes the ANDing the only honest place for this.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger.server";
import { meetsPlan, type Plan } from "../../utils/planUtils";
import { AUTO_TRANSLATE_MIN_PLAN } from "./translation-change-policy.shared";

export { AUTO_TRANSLATE_MIN_PLAN };

export interface TranslationChangePolicy {
  /**
   * Delete a foreign translation when its primary value changed or was
   * cleared, ON A SURFACE THE SYNC-SIDE RE-TRANSLATION REACHES BY ITSELF — the
   * resource's own translatable fields on **Product and Collection**, the two
   * types Shopify sends an update webhook for.
   *
   * Pages, articles, blogs and policies are reconciled by the same code, but
   * only when the merchant presses reload on that item (CLAUDE.md: they have no
   * webhook). Suppressing their deletion would trade a certain repair for one
   * that depends on a button nobody knows to press, so they count as
   * UNRECONCILED here.
   *
   * FALSE while `autoTranslateExternalChanges` is in force: there the deletion
   * would only throw away the row the re-translation is about to refresh. A
   * caller that wants "remove what could not be re-translated" must not read
   * this flag for it; that correction belongs to the auto-translation itself
   * (stale-translation-sync.server.ts).
   */
  purgeOnPrimaryChange: boolean;
  /**
   * The same question for a surface NOTHING repairs — and after the auto-
   * translate rollout that is no longer a LIST of surfaces but a set of
   * CIRCUMSTANCES: the bulk editor, and every case where a save's own repair
   * cannot run (no primary locale, an unresolvable image, a lookup that failed,
   * a value the AI prompt would corrupt). Auto-translate does NOT suppress the deletion
   * there, because nothing would refresh those translations and a translation
   * of text that no longer exists would stay on the storefront for good. This
   * is the merchant's stored choice, unmodified.
   *
   * Metaobject fields, the product sub-resources, alt-texts, theme content and
   * menu-item renames USED to be on this side and no longer are: their own save
   * performs the repair
   * (`reconcileAfterPrimarySave`), so they ask `purgeOnPrimaryChange` whenever
   * that repair can actually run. A new purge site must ask which of the two it
   * is rather than copying a neighbour.
   */
  purgeUnreconciledSurfaces: boolean;
  /**
   * Max plan: when a sync notices the primary text changed OUTSIDE this app,
   * re-translate the NEW value into that locale instead of leaving the field
   * untranslated. Already ANDed with the plan gate.
   */
  autoTranslateExternalChanges: boolean;
  /**
   * The sub-decision under the switch above: may the automatic re-translation
   * also rewrite a URL HANDLE? Already ANDed with BOTH the plan and
   * `autoTranslateExternalChanges`, so a caller never has to remember either —
   * without the parent switch there is no re-translation for this to be a part
   * of, and reading the raw column would make the sub-decision outrank the
   * decision it sits under.
   *
   * The stored column is deliberately NOT cleared when the parent is switched
   * off (a merchant who tries the parent switch must not lose this answer), so
   * the ANDing is the only thing that keeps the pair honest.
   *
   * It says "may a handle move at all", never "may THIS URL move": the repair
   * still refuses a handle it cannot put a redirect on
   * (handle-retranslation.server.ts).
   */
  autoTranslateHandles: boolean;
  /**
   * The merchant's OPTIONAL daily limit on FIRST automatic translations — the
   * resources whose auto-translation rests on the primary digest baseline
   * alone (stale-translation-sync.server.ts). `null` = no limit, which is the
   * default: the setting is the merchant's to set, not ours to impose. Only
   * meaningful while `autoTranslateExternalChanges` is in force, and `null`
   * whenever it is not.
   */
  autoTranslateDailyLimit: number | null;
  /** The shop's plan, for callers that log or surface it. */
  plan: Plan;
}

/** A stored limit that is not a positive integer is no limit — never zero,
 *  which would silently stop every first translation. */
function normalizeDailyLimit(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The historic, hard-coded behaviour — also the fail-open fallback. */
const DEFAULT_POLICY: TranslationChangePolicy = {
  purgeOnPrimaryChange: true,
  purgeUnreconciledSurfaces: true,
  autoTranslateExternalChanges: false,
  // Fails OPEN in the same direction as the rest: with no re-translation there
  // is no handle to refresh, and a slug that moves on the strength of a failed
  // lookup is the one outcome this option must never produce.
  autoTranslateHandles: false,
  autoTranslateDailyLimit: null,
  plan: "free",
};

/**
 * @param dbClient  Pass the PrismaClient the caller already holds (every write
 *   path has one); omitted, the shared instance is imported.
 */
export async function loadTranslationChangePolicy(
  shop: string,
  dbClient?: PrismaClient,
): Promise<TranslationChangePolicy> {
  try {
    const db = dbClient ?? (await import("../../db.server")).db;
    const row = await db.aISettings.findUnique({
      where: { shop },
      select: {
        translationPurgeOnPrimaryChange: true,
        autoTranslateExternalChanges: true,
        autoTranslateHandles: true,
        autoTranslateDailyLimit: true,
        subscriptionPlan: true,
      },
    });
    const plan = (row?.subscriptionPlan || "free") as Plan;
    const autoTranslate =
      (row?.autoTranslateExternalChanges ?? false) && meetsPlan(plan, AUTO_TRANSLATE_MIN_PLAN);
    const storedPurge = row?.translationPurgeOnPrimaryChange ?? true;
    return {
      // The two switches are MUTUALLY EXCLUSIVE and auto-translate wins:
      // "delete the translation when the text changes" and "translate the new
      // text" are two answers to one question, and a shop that picked the
      // second one does not want the first one deleting the very rows the
      // re-translation is about to refresh. Enforced HERE, not only in the UI,
      // because both columns are independently writable (a stale client, a
      // direct POST) and the stored pair must never decide behaviour the
      // merchant was not shown. `?? true` covers "no settings row yet".
      purgeOnPrimaryChange: !autoTranslate && storedPurge,
      purgeUnreconciledSurfaces: storedPurge,
      autoTranslateExternalChanges: autoTranslate,
      // ANDed with the parent, not merely with the plan: the column survives
      // the merchant switching the automation off, and reading it on its own
      // would let a sub-decision act where the decision it belongs to does not.
      autoTranslateHandles: autoTranslate && (row?.autoTranslateHandles ?? false),
      autoTranslateDailyLimit: autoTranslate ? normalizeDailyLimit(row?.autoTranslateDailyLimit) : null,
      plan,
    };
  } catch (error: unknown) {
    logger.warn("[TranslationPolicy] Could not load policy — falling back to purge-on-change", {
      context: "TranslationPolicy",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_POLICY;
  }
}

/**
 * The one question every in-app purge site asks before deleting a foreign
 * translation for a changed/cleared primary value.
 *
 * @param opts.reconciled  Will anything re-translate THIS surface — an
 *   automatic event, or the very save that is asking? `true` for the resource's
 *   own translatable fields on **Product and Collection** (the types with an
 *   update webhook), and for the surfaces whose SAVE performs the repair while
 *   auto-translate is on: the webhook-less content types, the product
 *   sub-resources, metaobject fields, alt-texts, theme content and menu-item
 *   renames. What is left — the bulk editor, and any save whose repair could
 *   not run — leaves it unset,
 *   and then auto-translate does NOT switch the deletion off: nothing would
 *   refresh those translations afterwards, so the stale text would simply stay
 *   live. Defaults to the safe answer, so a new purge site that forgets the
 *   flag keeps deleting rather than silently keeping stale content.
 */
export async function isPurgeOnPrimaryChangeEnabled(
  shop: string,
  dbClient?: PrismaClient,
  opts: { reconciled?: boolean } = {},
): Promise<boolean> {
  const policy = await loadTranslationChangePolicy(shop, dbClient);
  return opts.reconciled ? policy.purgeOnPrimaryChange : policy.purgeUnreconciledSurfaces;
}
