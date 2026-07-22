/**
 * Free keyword research via Google's autocomplete endpoint
 * (PLAN_KEYWORDS_EXPANSION.md §6). No official API, no paid quota — which is
 * exactly why this module is built to be AMPUTATABLE: nothing else in the app
 * depends on it, and a 429/403 surfaces as a coded error the UI turns into a
 * friendly message (no retry bombs).
 *
 * ⚠ Deploy risk (plan §6.1): Railway egress IPs are datacenter IPs and Google
 * throttles suggestqueries far more aggressively for those. The mandatory
 * spike — verify the endpoint answers reliably FROM RAILWAY — has not been
 * run yet; if it fails, this whole phase is dropped or replaced by a paid
 * source. Local/dev traffic behaving well proves nothing about production.
 *
 * Fetch pattern: sequential with ~200 ms delay (Google throttles > ~5 QPS) —
 * a plain loop, no dependency. The initial fetch stays small (1 direct + a
 * handful of question-word calls); the 26-call alphabet expansion is opt-in
 * ("load more") so the synchronous action stays well under embedded-iframe
 * timeout territory.
 */

import { logger } from "../../utils/logger.server";

export class SuggestionsRateLimitedError extends Error {
  constructor() {
    super("Autocomplete endpoint refused the request (rate limited or blocked)");
    this.name = "SuggestionsRateLimitedError";
  }
}

const SUGGEST_ENDPOINT = "https://suggestqueries.google.com/complete/search";
const USER_AGENT = "ContentPilot-SEO/1.0";
const FETCH_TIMEOUT_MS = 5000;
export const FETCH_DELAY_MS = 200;

/** Question-word expansions per UI language (fallback: en). */
const QUESTION_WORDS: Record<string, string[]> = {
  de: ["wie", "was", "warum", "wo", "welche", "wann"],
  en: ["how", "what", "why", "where", "which", "when"],
  es: ["cómo", "qué", "por qué", "dónde", "cuál", "cuándo"],
  fr: ["comment", "quoi", "pourquoi", "où", "quel", "quand"],
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

export interface SuggestionGroups {
  direct: string[];
  questions: string[];
  alphabet: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One autocomplete call: `client=firefox` returns plain JSON
 * `[query, [suggestions...]]`. 429/403 throw the coded rate-limit error; any
 * other failure returns [] (best-effort — one dead modifier must not kill
 * the whole research run).
 */
export async function fetchAutocomplete(seed: string, hl: string): Promise<string[]> {
  const url = `${SUGGEST_ENDPOINT}?client=firefox&hl=${encodeURIComponent(hl)}&q=${encodeURIComponent(seed)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn("[KeywordSuggestions] fetch failed", { context: "SEO", seed, error: String(err) });
    return [];
  }
  if (res.status === 429 || res.status === 403) throw new SuggestionsRateLimitedError();
  if (!res.ok) return [];
  try {
    const parsed = (await res.json()) as unknown;
    if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) return [];
    return (parsed[1] as unknown[]).filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/**
 * Gather grouped suggestions for one seed. `expandAlphabet: false` keeps the
 * run at ~7 sequential calls (direct + question words); `true` adds the 26
 * `<seed> a…z` calls — noticeably slower and the first thing Google throttles,
 * hence opt-in. `delayMs` is injectable for tests.
 */
export async function gatherSuggestions(
  seed: string,
  hl: string,
  opts: { expandAlphabet: boolean; delayMs?: number },
): Promise<SuggestionGroups> {
  const delayMs = opts.delayMs ?? FETCH_DELAY_MS;
  const normalizedSeed = seed.trim().toLowerCase();
  const dedupe = new Set<string>([normalizedSeed]);
  const take = (list: string[], into: string[]) => {
    for (const s of list) {
      const norm = s.trim().toLowerCase();
      if (!norm || dedupe.has(norm)) continue;
      dedupe.add(norm);
      into.push(norm);
    }
  };

  const direct: string[] = [];
  take(await fetchAutocomplete(normalizedSeed, hl), direct);

  const questions: string[] = [];
  const questionWords = QUESTION_WORDS[hl.toLowerCase().split("-")[0]] ?? QUESTION_WORDS.en;
  for (const word of questionWords) {
    await sleep(delayMs);
    take(await fetchAutocomplete(`${word} ${normalizedSeed}`, hl), questions);
  }

  const alphabet: string[] = [];
  if (opts.expandAlphabet) {
    for (const letter of ALPHABET) {
      await sleep(delayMs);
      take(await fetchAutocomplete(`${normalizedSeed} ${letter}`, hl), alphabet);
    }
  }

  return { direct, questions, alphabet };
}

// ── Per-shop rate limiting (plan §6.2: max 3 seeds/min) ────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_SEEDS = 3;
const seedTimestampsByShop = new Map<string, number[]>();

/** In-memory limiter — enough for a single-instance deployment; swap for a
 *  DB bucket (ImageOperationCounter pattern) if the app ever scales out. */
export function checkSuggestionsRateLimit(shop: string, now = Date.now()): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const timestamps = (seedTimestampsByShop.get(shop) ?? []).filter((t) => t > cutoff);
  if (timestamps.length >= RATE_MAX_SEEDS) {
    seedTimestampsByShop.set(shop, timestamps);
    return false;
  }
  timestamps.push(now);
  seedTimestampsByShop.set(shop, timestamps);
  return true;
}

/** Test hook. */
export function resetSuggestionsRateLimit(): void {
  seedTimestampsByShop.clear();
}
