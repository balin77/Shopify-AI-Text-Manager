/**
 * Per-content-type "last selected item" persistence.
 *
 * Stored in localStorage so the same item reopens after a page reload or
 * cross-content-type navigation. Reads are SSR-safe (no localStorage access
 * required to succeed; failure quietly returns null). Writes are user-action-
 * driven only — restore-effects and auto-select fallbacks must NOT write,
 * otherwise a transient missing-from-list state (mid-resync, plan-cap,
 * lazy-load batch) would clobber the user's actual saved selection.
 */

const KEY_PREFIX = "contentpilot_last_selected_";

export function readLastSelectedId(contentType: string): string | null {
  try {
    return localStorage.getItem(`${KEY_PREFIX}${contentType}`);
  } catch {
    return null;
  }
}

export function writeLastSelectedId(contentType: string, id: string): void {
  try {
    localStorage.setItem(`${KEY_PREFIX}${contentType}`, id);
  } catch {}
}
