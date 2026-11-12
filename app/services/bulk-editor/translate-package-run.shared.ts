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
 * - a TRANSIENT failure (5xx / 529 / connection reset) repeats the SAME package
 *   once after a jittered pause before anything is halved: halving cannot cure
 *   an overloaded provider and doubles the requests into it;
 * - a fatal error (a rejected key, a managed refusal, a queue shutdown) is
 *   thrown by the injected call; the ladder CATCHES it, keeps every outcome
 *   already verified (those were paid for) and returns it as `stopped`, so the
 *   caller can settle what is decided before it stands down or aborts.
 *   Everything not yet resolved stays UNRESOLVED (absent from the outcome map),
 *   which is not a failure.
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
  invalid?: "truncated" | "unparseable" | "starved" | "error" | "transient";
}

const TRANSIENT_STATUS = new Set([500, 502, 503, 504, 529, 408]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET"]);

/**
 * A provider error that says "try the same request again": an overloaded or
 * unavailable provider (5xx, Anthropic's 529, 408) or a dropped connection.
 * NOT a timeout (the call was too big or too slow: the halves are the cure),
 * not a 429 (the queue owns that), not a 4xx.
 */
export function isTransientProviderError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { status?: unknown; code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (/timeout|timed out/i.test(name) || /timed out|timeout/i.test(message)) return false;
  if (typeof e.status === "number") return TRANSIENT_STATUS.has(e.status);
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  const causeCode = (e.cause as { code?: unknown } | undefined)?.code;
  if (typeof causeCode === "string" && TRANSIENT_CODES.has(causeCode)) return true;
  // The SDKs' status-less connection failures ("Connection error.", "fetch failed").
  return name === "APIConnectionError" || /^(connection error|fetch failed)/i.test(message);
}

export interface LadderDeps {
  /** One package request. Throws only for a FATAL error (propagated). */
  callPackage(pkg: TranslatePackage): Promise<PackageCallResult>;
  /** The pre-existing single-entry path. Returns locale -> text (possibly partial);
   *  null/throw-free failure = nothing. Throws only for a FATAL error. */
  callSingle(item: PackageItem): Promise<Record<string, string> | null>;
  /** True once the run should stop spending (cancelled, stood down). */
  shouldStop(): boolean | Promise<boolean>;
  /** Pause before the transient retry (tests inject an instant one). */
  sleep?(ms: number): Promise<void>;
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

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Jittered pause before a transient retry. */
const transientPauseMs = () => 300 + Math.floor(Math.random() * 700);

/** `item` restricted to `locales` (same key and owners, so outcomes merge). */
function restrict(item: PackageItem, locales: string[]): PackageItem {
  return { ...item, locales: [...locales].sort() };
}

export async function runPackageLadder(
  pkg: TranslatePackage,
  deps: LadderDeps,
): Promise<{ outcomes: Map<string, ItemOutcome>; stats: LadderStats; stopped?: { error: unknown } }> {
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
    let result = await deps.callPackage(current);
    if (result.invalid === "transient") {
      // Same package once more, after a pause; only then does it split.
      await (deps.sleep ?? defaultSleep)(transientPauseMs());
      if (await deps.shouldStop()) return;
      stats.requests++;
      stats.retries++;
      result = await deps.callPackage(current);
    }
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
        checkProtectedTokens: false,
      });
      if (failure) out.failed[locale] = failure === "missing" || failure === "empty" ? "unavailable" : failure;
      else out.accepted[locale] = answered![locale].trim();
    }
  };

  try {
    await runOne(pkg, 0, false);
  } catch (error) {
    // Keep what was verified (and paid for) before the stop.
    return { outcomes, stats, stopped: { error } };
  }
  return { outcomes, stats };
}
