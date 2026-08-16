/**
 * Per-section "help banner dismissed" persistence for the SEO tab.
 *
 * Stored in localStorage so a merchant who closed a section's intro box keeps
 * it closed across reloads. Keyed by help id (usually the SEO section id), so
 * closing one section's box never touches another's. Reads are SSR-safe: a
 * failing/absent storage quietly means "not dismissed", which is the default
 * the boxes ship with (visible).
 */

const KEY_PREFIX = "contentpilot_seo_help_hidden_";

export function readSeoHelpHidden(helpId: string): boolean {
  try {
    return localStorage.getItem(`${KEY_PREFIX}${helpId}`) === "1";
  } catch {
    return false;
  }
}

export function writeSeoHelpHidden(helpId: string, hidden: boolean): void {
  try {
    if (hidden) {
      localStorage.setItem(`${KEY_PREFIX}${helpId}`, "1");
    } else {
      localStorage.removeItem(`${KEY_PREFIX}${helpId}`);
    }
  } catch {}
}
