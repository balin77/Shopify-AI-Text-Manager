/**
 * The retry ladder of ONE package (PLAN_BULK_TRANSLATE_BATCHING 3.1):
 *
 *   package -> the rejected entries as HALF-size packages (at most two levels)
 *           -> one entry alone, on the pre-existing single-entry path
 *           -> a failed cell for that entry and language.
 *
 * Nothing here knows a provider, a queue or a database: the two calls are
 * injected, so the ladder is testable end to end with a scripted model. The
 * rules it keeps:
 * - an entry is accepted per LANGUAGE, only after every check of
 *   translate-package-verify.shared.ts passed;
 * - a truncated, unparseable or errored answer rejects the whole package (the
 *   halves are what makes progress possible), never a part of it;
 * - the source text is never offered as a translation;
 * - a fatal error (a rejected key, a managed refusal, a queue shutdown) is
 *   thrown by the injected call and propagates untouched -- the caller decides
 *   what stands down; everything not yet resolved stays UNRESOLVED (absent from
 *   the outcome map), which is not a failure.
 */

import {
  groupKeyOf,
  halvePackage,
  type PackageItem,
  type TranslatePackage,
} from "./translate-packages.shared";
import { judgePackageAnswer, verifyTranslation, type VerifyFailure } from "./translate-package-verify.shared";

/** What one package call answered. `invalid` = the answer cannot be used at all. */
export interface PackageCallResult {
  answer: { parsed: unknown; idOf: Map<string, string> } | null;
  invalid?: "truncated" | "unparseable" | "starved" | "error";
}

export interface LadderDeps {
  /** One package request. Throws only for a FATAL error (propagated). */
  callPackage(pkg: TranslatePackage): Promise<PackageCallResult>;
  /** The pre-existing single-entry path. Returns locale -> text (possibly partial);
   *  null/throw-free failure = nothing. Throws only for a FATAL error. */
  callSingle(item: PackageItem): Promise<Record<string, string> | null>;
  /** True once the run should stop spending (cancelled, stood down). */
  shouldStop(): boolean | Promise<boolean>;
}

export interface ItemOutcome {
  item: PackageItem;
  /** locale -> verified text */
  accepted: Record<string, string>;
  /** locale -> why it could not be delivered */
  failed: Record<string, VerifyFailure | "unavailable">;
}

export interface LadderStats {
  /** Provider requests made (packages + singles). */
  requests: number;
  /** Of those, the ones that were retries of something that failed. */
  retries: number;
}

export const MAX_LADDER_DEPTH = 2;

/** `item` restricted to `locales` (same key and owners, so outcomes merge). */
function restrict(item: PackageItem, locales: string[]): PackageItem {
  return { ...item, locales: [...locales].sort() };
}

export async function runPackageLadder(
  pkg: TranslatePackage,
  deps: LadderDeps,
): Promise<{ outcomes: Map<string, ItemOutcome>; stats: LadderStats }> {
  const outcomes = new Map<string, ItemOutcome>();
  const stats: LadderStats = { requests: 0, retries: 0 };
  const originals = new Map(pkg.items.map((item) => [item.key, item] as const));
  const outcomeOf = (key: string): ItemOutcome => {
    let outcome = outcomes.get(key);
    if (!outcome) {
      outcome = { item: originals.get(key)!, accepted: {}, failed: {} };
      outcomes.set(key, outcome);
    }
    return outcome;
  };

  const runOne = async (current: TranslatePackage, depth: number, isRetry: boolean): Promise<void> => {
    if (await deps.shouldStop()) return;
    stats.requests++;
    if (isRetry) stats.retries++;
    const result = await deps.callPackage(current);
    // Whatever this answer holds was paid for: the verified part is kept even
    // when the run is being stopped.
    const rejectedByItem = new Map<string, string[]>();
    const verdicts = result.answer
      ? judgePackageAnswer(current.items, result.answer.idOf, result.answer.parsed)
      : null;
    for (const item of current.items) {
      const verdict = verdicts?.get(item.key);
      if (verdict) {
        const out = outcomeOf(item.key);
        for (const [locale, text] of Object.entries(verdict.accepted)) out.accepted[locale] = text;
      }
      const rejected = verdict ? Object.keys(verdict.rejected) : [...item.locales];
      if (rejected.length > 0) rejectedByItem.set(item.key, rejected);
    }
    if (rejectedByItem.size === 0) return;

    // Group the rejected entries (their locale sets may now differ) and send
    // each group down one rung.
    const retryItems = [...rejectedByItem].map(([key, locales]) => restrict(originals.get(key)!, locales));
    const groups = new Map<string, PackageItem[]>();
    for (const item of retryItems) {
      const key = groupKeyOf(item);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const [groupKey, items] of groups) {
      if (await deps.shouldStop()) return;
      if (items.length > 1 && depth < MAX_LADDER_DEPTH) {
        const smaller: TranslatePackage = {
          ...current,
          id: `${current.id}r`,
          groupKey,
          locales: items[0].locales,
          items,
        };
        for (const half of halvePackage(smaller)) await runOne(half, depth + 1, true);
        continue;
      }
      for (const item of items) await runSingle(item);
    }
  };

  const runSingle = async (item: PackageItem): Promise<void> => {
    if (await deps.shouldStop()) return;
    stats.requests++;
    stats.retries++;
    const answered = await deps.callSingle(item);
    const out = outcomeOf(item.key);
    for (const locale of item.locales) {
      const failure = verifyTranslation({
        kind: item.kind,
        source: item.source,
        translation: answered?.[locale],
        strictNumbers: false,
      });
      if (failure) out.failed[locale] = failure === "missing" || failure === "empty" ? "unavailable" : failure;
      else out.accepted[locale] = answered![locale].trim();
    }
  };

  await runOne(pkg, 0, false);
  return { outcomes, stats };
}
