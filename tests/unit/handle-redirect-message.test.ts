/**
 * PLAN §Phase 3.3 — code → sentence, on the client.
 *
 * This helper exists because the save response is handled in TWO places (the
 * ordinary save and the "Accept & Translate" save, which returns early down its
 * own branch), and the first version of this feature only phrased the note in
 * one of them — so a FAILED redirect after Accept & Translate was swallowed and
 * the merchant went on believing the old URL still resolved.
 *
 * The tone matters as much as the text: only an actual success is a success.
 */

import { describe, it, expect } from "vitest";
import { buildRedirectMessage, redirectNoteOf } from "~/utils/handle-redirect-message";

const t = {
  common: {
    redirectCreated: "Alt {path} → neu.",
    redirectNotConfirmed: "{path} nicht weitergeleitet.",
    redirectFailed: "{path} fehlgeschlagen.",
    redirectMissingBlog: "Blog unbekannt.",
    redirectBlogArticlesUncovered: "{path} weitergeleitet, Artikel nicht.",
  },
};

describe("buildRedirectMessage", () => {
  it("says nothing when there is nothing to say", () => {
    expect(buildRedirectMessage(undefined, t)).toBeNull();
    expect(buildRedirectMessage({}, t)).toBeNull();
  });

  it("phrases a created redirect as a success, with the path filled in", () => {
    expect(buildRedirectMessage({ code: "created", fromPath: "/products/old" }, t)).toEqual({
      text: "Alt /products/old → neu.",
      tone: "success",
    });
  });

  it("treats every non-success outcome as a WARNING", () => {
    // The merchant has just changed an address and cannot tell from the editor
    // whether their links still resolve. A footnote tone would bury that.
    for (const code of ["notConfirmed", "failed", "missingBlogHandle", "blogArticlesUncovered", "localeBlogHandleUnknown"]) {
      expect(buildRedirectMessage({ code, fromPath: "/products/old" }, t)?.tone).toBe("warning");
    }
  });

  it("warns for a renamed blog even though the redirect succeeded", () => {
    // The blog's own URL is covered; its articles' are not, and Shopify
    // redirects have no wildcards. "Created" alone would be a half-truth.
    const message = buildRedirectMessage({ code: "blogArticlesUncovered", fromPath: "/blogs/old" }, t);
    expect(message).toEqual({ text: "/blogs/old weitergeleitet, Artikel nicht.", tone: "warning" });
  });

  it("stays silent on a code it does not know", () => {
    // A newer server talking to an older client. Inventing a claim about the
    // merchant's URLs is worse than saying nothing.
    expect(buildRedirectMessage({ code: "somethingNew", fromPath: "/x" }, t)).toBeNull();
  });

  it("falls back to English when a translation is missing", () => {
    const message = buildRedirectMessage({ code: "created", fromPath: "/pages/old" }, {});
    expect(message?.text).toContain("/pages/old");
    expect(message?.tone).toBe("success");
  });
});

describe("redirectNoteOf", () => {
  it("finds the note on a save response", () => {
    expect(redirectNoteOf({ success: true, redirectNote: { code: "created", fromPath: "/a" } })).toEqual({
      code: "created",
      fromPath: "/a",
    });
  });

  it("returns undefined for every shape that carries none", () => {
    // Most saves do not change a handle, so this is the common path — it must
    // not throw on any of them.
    expect(redirectNoteOf(undefined)).toBeUndefined();
    expect(redirectNoteOf(null)).toBeUndefined();
    expect(redirectNoteOf({ success: true })).toBeUndefined();
    expect(redirectNoteOf("nonsense")).toBeUndefined();
    expect(redirectNoteOf({ redirectNote: "nonsense" })).toBeUndefined();
  });
});
