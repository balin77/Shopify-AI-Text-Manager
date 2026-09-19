/**
 * PLAN §Phase 3.3 — turning the server's redirect NOTE into a sentence.
 *
 * The server answers with a code plus the old path, never with prose: this app
 * ships in three languages and only the client knows which one the merchant is
 * reading. This is the one place that maps code → sentence, because the save
 * response is handled in two places (the ordinary save and the
 * "Accept & Translate" save, which returns early down its own branch) and a
 * second copy is how one of them silently stopped reporting failed redirects.
 *
 * A failed redirect is a WARNING, not a footnote: the merchant has just changed
 * an address and cannot see from the editor whether their existing links still
 * resolve. Only the success case is a success tone.
 */

import type { InfoBoxTone } from "../types/content-editor.types";

export interface HandleRedirectMessage {
  text: string;
  tone: InfoBoxTone;
}

/** The wire shape `handleUpdateContent` attaches on a handle change. */
export interface HandleRedirectNotePayload {
  code?: string;
  fromPath?: string;
}

export function buildRedirectMessage(
  note: HandleRedirectNotePayload | null | undefined,
  t: { content?: Record<string, unknown> } | null | undefined,
): HandleRedirectMessage | null {
  if (!note?.code) return null;
  const path = note.fromPath || "";
  // The keys live in the CONTENT section of every bundle, which is where the
  // save messages these are appended to live. This read used to name
  // `t.common` — a section that carries a `changesSaved` of its own, so the
  // save line beside the note was translated while every note in this module
  // silently fell through to its English fallback, in all three languages. The
  // unit test's fixture invented its own `common`, so the wiring was never
  // compared against a real bundle; it now is.
  const s = (key: string, fallback: string) =>
    String(t?.content?.[key] ?? fallback).replace("{path}", path);

  switch (note.code) {
    case "created":
      return { text: s("redirectCreated", "The old URL {path} now redirects to the new one."), tone: "success" };
    // The blog's own URL was redirected; every ARTICLE under it moved too and
    // Shopify redirects have no wildcards, so those are NOT covered. Reported
    // as a warning precisely because the "created" wording would be a
    // half-truth the merchant has no way to check.
    case "blogArticlesUncovered":
      return {
        text: s(
          "redirectBlogArticlesUncovered",
          "The old blog URL {path} now redirects — the URLs of this blog's articles do not.",
        ),
        tone: "warning",
      };
    // The rename worked AND an existing redirect had to be removed, because it
    // sat on the new URL and Shopify would have served it in preference to the
    // page. That may have been a redirect the merchant set up themselves, so
    // it is said out loud rather than folded into "created".
    case "shadowRemoved":
      return {
        text: s(
          "redirectShadowRemoved",
          "The old URL {path} now redirects. An existing redirect on the new URL was removed — it would have hidden the page.",
        ),
        tone: "warning",
      };
    case "notConfirmed":
      return { text: s("redirectNotConfirmed", "The old URL {path} could not be redirected — set it up in Shopify if the old link matters."), tone: "warning" };
    case "failed":
      return { text: s("redirectFailed", "The old URL {path} could not be redirected — set it up in Shopify if the old link matters."), tone: "warning" };
    case "missingBlogHandle":
      return {
        text: s("redirectMissingBlog", "The old article URL was not redirected: its blog is unknown. Set it up in Shopify if the old link matters."),
        tone: "warning",
      };
    // Foreign locales only. The blog IS known — but its own handle is
    // translated as well, so the article's URL has two translatable segments
    // and this app does not know which spelling the storefront serves. A
    // guessed redirect would cover a URL that never existed and leave the real
    // one broken, so none is created and the merchant is told why.
    case "localeBlogHandleUnknown":
      return {
        text: s(
          "redirectLocaleBlogUnknown",
          "The old article URL was not redirected: the blog's handle is translated too. Set it up in Shopify if needed.",
        ),
        tone: "warning",
      };
    default:
      // An unknown code is a newer server talking to an older client. Saying
      // nothing beats inventing a claim about the merchant's URLs.
      return null;
  }
}

/** Reads the note off a save response without assuming its wider shape. */
export function redirectNoteOf(data: unknown): HandleRedirectNotePayload | undefined {
  if (!data || typeof data !== "object" || !("redirectNote" in data)) return undefined;
  const note = (data as { redirectNote?: unknown }).redirectNote;
  return note && typeof note === "object" ? (note as HandleRedirectNotePayload) : undefined;
}
