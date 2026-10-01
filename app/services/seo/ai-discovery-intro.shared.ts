/**
 * The merchant-authored opening paragraph of agents.md / llms.txt — the two
 * pieces of it the EDITOR needs, in their own client-safe module.
 *
 * aeo.service.ts is ~1600 lines of robots parsing and Shopify calls; importing
 * it from the section's React component would pull all of that into the client
 * bundle for one constant and one string helper. Same reasoning as the bulk
 * editor's `columns.shared.ts`.
 */

/** Longest merchant intro accepted — one screen of prose, not a second catalog. */
export const AI_DISCOVERY_INTRO_MAX_CHARS = 2000;

/**
 * Normalize a merchant-authored intro for storage AND for the document: trim,
 * cap, collapse runs of blank lines. Returns "" for anything that carries no
 * text, so "unset" and "whitespace only" become the same state — otherwise a
 * merchant who cleared the box with a stray newline would get a document with
 * a blank paragraph where the generated sentence used to be. Pure.
 */
export function normalizeDiscoveryIntro(raw: string | null | undefined): string {
  return (raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, AI_DISCOVERY_INTRO_MAX_CHARS);
}
