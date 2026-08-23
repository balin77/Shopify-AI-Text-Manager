import { useMemo, useSyncExternalStore } from "react";

/**
 * Global store for AI suggestions that are WAITING FOR A DECISION.
 *
 * A suggestion is the merchant's property the moment the request comes back:
 * they paid for it, it is on screen, and only "Übernehmen" or "Verwerfen" may
 * take it away. It used to live in `useState` inside the content editor, so
 * every way of leaving the field lost it — switching to another main-nav tab
 * unmounted the editor, and picking another item ran a reset effect. The
 * merchant came back to an empty banner and had to pay for the same
 * generation twice.
 *
 * This is the same shape as [useAIOperationsStore.ts](./useAIOperationsStore.ts),
 * which already keeps the SPINNERS outside React's lifecycle for exactly this
 * reason — a running operation survives navigation, and from now on so does
 * its answer.
 *
 * **The scope is the key, and all four parts are load-bearing.** A suggestion
 * belongs to one field of one item in one locale under one market: the accept
 * handler writes it into the value the editor is currently showing, so a
 * German suggestion accepted while the French tab is open would write German
 * text into the French translation. Keying by field alone is how that could
 * happen — switching locales did not clear the banner. Keying by scope also
 * retires the reset-on-item-change effect: a suggestion for another item is
 * simply not in this scope, so there is nothing to clear and nothing to lose.
 *
 * **Memory only, deliberately.** A reload drops these, like every other
 * unsaved draft in this app (see the create dialog's "no browser storage for
 * drafts" note). What is fixed here is in-app navigation, which is what the
 * merchant actually does between generating and deciding. A suggestion the
 * merchant is shown but does not decide on is theirs until they DO decide, so
 * nothing else takes it away — the store is bounded by count, not by a clock.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuggestionScope {
  /** Item id (Shopify GID or theme resource id). "" = nothing selected. */
  resourceId: string;
  /** The locale the editor was showing when the request was made. */
  locale: string;
  /** Selected market ("" = global). */
  marketId: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * A suggestion lives as long as the page does. There is deliberately NO age
 * limit: a timeout is not observable from React without a timer, so the memo
 * below would keep rendering an "expired" suggestion that the imperative
 * readers already call gone — and the merchant could accept a proposal the
 * store says does not exist. Bounding by COUNT is the same protection without
 * that contradiction, and a reload clears everything anyway.
 */
const MAX_ENTRIES = 100;

/** Alt-text suggestions share the store; the prefix keeps them out of the field record. */
const ALT_TEXT_PREFIX = "altText::";

/** Composite key: `${resourceId}::${locale}::${marketId}::${fieldKey}` → suggestion text. */
const suggestions = new Map<string, string>();

const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion() {
  return version;
}

/** SSR has no store — always the same number, so React does not warn. */
function getServerVersion() {
  return 0;
}

function notify() {
  version++;
  for (const listener of listeners) listener();
}

function makeKey(scope: SuggestionScope, fieldKey: string) {
  return `${scope.resourceId}::${scope.locale}::${scope.marketId}::${fieldKey}`;
}

function scopePrefix(scope: SuggestionScope) {
  return `${scope.resourceId}::${scope.locale}::${scope.marketId}::`;
}

function altTextKey(imageIndex: number) {
  return `${ALT_TEXT_PREFIX}${imageIndex}`;
}

function write(scope: SuggestionScope, fieldKey: string, text: string) {
  // No item, no scope to hang a suggestion on. An empty suggestion is not a
  // suggestion either — and it must not CLEAR the one already on screen, since
  // the merchant may still be deciding on it.
  if (!scope.resourceId || !text || !text.trim()) return;

  const key = makeKey(scope, fieldKey);
  // Delete first so a re-generated suggestion moves to the END of the insertion
  // order — the eviction below drops the oldest WRITE, not the oldest field.
  suggestions.delete(key);
  suggestions.set(key, text);

  while (suggestions.size > MAX_ENTRIES) {
    const oldest = suggestions.keys().next();
    if (oldest.done) break;
    suggestions.delete(oldest.value);
  }
  notify();
}

function clear(scope: SuggestionScope, fieldKey: string) {
  if (suggestions.delete(makeKey(scope, fieldKey))) notify();
}

// ---------------------------------------------------------------------------
// Public API — imperative (callable from anywhere, including async callbacks)
// ---------------------------------------------------------------------------

/**
 * Park a field suggestion for the merchant to accept or reject.
 *
 * Call it with the scope the REQUEST was made in, never with wherever the
 * merchant happens to be when the answer lands: an answer that arrives after
 * they switched locales belongs to the locale they asked from.
 */
export function setFieldSuggestion(scope: SuggestionScope, fieldKey: string, text: string) {
  write(scope, fieldKey, text);
}

/** Remove a field suggestion — the merchant accepted or rejected it. */
export function clearFieldSuggestion(scope: SuggestionScope, fieldKey: string) {
  clear(scope, fieldKey);
}

/** Read one field suggestion without subscribing (for imperative handlers). */
export function getFieldSuggestion(scope: SuggestionScope, fieldKey: string): string | undefined {
  return suggestions.get(makeKey(scope, fieldKey));
}

/** Park an alt-text suggestion for one image of the current item. */
export function setAltTextSuggestion(scope: SuggestionScope, imageIndex: number, text: string) {
  write(scope, altTextKey(imageIndex), text);
}

/** Remove one alt-text suggestion. */
export function clearAltTextSuggestion(scope: SuggestionScope, imageIndex: number) {
  clear(scope, altTextKey(imageIndex));
}

/** Read one alt-text suggestion without subscribing. */
export function getAltTextSuggestion(scope: SuggestionScope, imageIndex: number): string | undefined {
  return getFieldSuggestion(scope, altTextKey(imageIndex));
}

/**
 * Drop every suggestion of one scope — fields and alt texts alike. This is
 * "Alles leeren": the merchant just emptied this item in this locale, and a
 * banner that survives it is an offer to undo their own click. It is the whole
 * scope on purpose, including the title the clear deliberately keeps, because
 * "clear everything" that leaves one banner standing is the more surprising of
 * the two rules.
 */
export function clearSuggestionsForScope(scope: SuggestionScope) {
  const prefix = scopePrefix(scope);
  let changed = false;
  for (const key of [...suggestions.keys()]) {
    if (key.startsWith(prefix)) {
      suggestions.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Test seam — the store is module state and would leak between test cases. */
export function __resetSuggestionStore() {
  suggestions.clear();
  notify();
}

// ---------------------------------------------------------------------------
// Pure readers (exported for tests; the hooks below are thin wrappers)
// ---------------------------------------------------------------------------

export function readFieldSuggestions(scope: SuggestionScope): Record<string, string> {
  const record: Record<string, string> = {};
  if (!scope.resourceId) return record;
  const prefix = scopePrefix(scope);
  for (const [key, text] of suggestions) {
    if (!key.startsWith(prefix)) continue;
    const fieldKey = key.slice(prefix.length);
    if (fieldKey.startsWith(ALT_TEXT_PREFIX)) continue;
    record[fieldKey] = text;
  }
  return record;
}

export function readAltTextSuggestions(scope: SuggestionScope): Record<number, string> {
  const record: Record<number, string> = {};
  if (!scope.resourceId) return record;
  const prefix = `${scopePrefix(scope)}${ALT_TEXT_PREFIX}`;
  for (const [key, text] of suggestions) {
    if (!key.startsWith(prefix)) continue;
    const imageIndex = Number(key.slice(prefix.length));
    if (!Number.isFinite(imageIndex)) continue;
    record[imageIndex] = text;
  }
  return record;
}

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

/**
 * Every field suggestion of one scope, as the `Record<fieldKey, text>` the
 * editor has always rendered from. Memoised on the store version and the
 * scope so the identity only changes when the content does — several effects
 * downstream take this object as a dependency.
 */
export function useFieldSuggestions(scope: SuggestionScope): Record<string, string> {
  const storeVersion = useSyncExternalStore(subscribe, getVersion, getServerVersion);
  return useMemo(
    () => readFieldSuggestions(scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeVersion, scope.resourceId, scope.locale, scope.marketId],
  );
}

/** The same, for the image gallery's per-index alt-text suggestions. */
export function useAltTextSuggestions(scope: SuggestionScope): Record<number, string> {
  const storeVersion = useSyncExternalStore(subscribe, getVersion, getServerVersion);
  return useMemo(
    () => readAltTextSuggestions(scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeVersion, scope.resourceId, scope.locale, scope.marketId],
  );
}
