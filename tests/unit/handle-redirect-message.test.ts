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
import { de } from "~/i18n/de";
import { en } from "~/i18n/en";
import { es } from "~/i18n/es";

const t = {
  content: {
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

/**
 * The wiring, against the REAL bundles.
 *
 * This module read the keys from `t.common` while all three bundles carry them
 * in `t.content`, so every redirect note in the app rendered its hardcoded
 * English fallback — on German and Spanish shops too. Nothing caught it: the
 * fixture above invents its own section, so it passes whichever one the module
 * happens to name. A merchant reported it from a German shop, where the save
 * line beside the note ("Änderungen erfolgreich gespeichert!") WAS translated,
 * because `changesSaved` happens to exist in both sections.
 *
 * So the fixture is no longer the only witness: each bundle answers for itself.
 */
describe("buildRedirectMessage against the shipped bundles", () => {
  const CODES = [
    "created",
    "notConfirmed",
    "failed",
    "blogArticlesUncovered",
    "shadowRemoved",
    "missingBlogHandle",
    "localeBlogHandleUnknown",
  ] as const;

  for (const [name, bundle] of [["de", de], ["en", en], ["es", es]] as const) {
    it(`phrases every code from the ${name} bundle, never from the fallback`, () => {
      for (const code of CODES) {
        const message = buildRedirectMessage({ code, fromPath: "/blogs/b/old" }, bundle);
        expect(message, `${name}/${code} produced no message`).not.toBeNull();
        // The bundle's own string, not the fallback in the module. Compared by
        // VALUE against the bundle rather than by "is it English", because the
        // en bundle is English too and would pass such a check while unwired.
        const key = {
          created: "redirectCreated",
          notConfirmed: "redirectNotConfirmed",
          failed: "redirectFailed",
          blogArticlesUncovered: "redirectBlogArticlesUncovered",
          shadowRemoved: "redirectShadowRemoved",
          missingBlogHandle: "redirectMissingBlog",
          localeBlogHandleUnknown: "redirectLocaleBlogUnknown",
        }[code];
        const expected = String(
          (bundle.content as Record<string, unknown>)[key],
        ).replace("{path}", "/blogs/b/old");
        expect(message?.text, `${name}/${code} did not come from the bundle`).toBe(expected);
      }
    });
  }

  it("keeps every note short enough for the info box's two-line clamp", () => {
    // The note is APPENDED to the save message in one box
    // (useUnifiedContentEditor: "One box, one outcome"), and MainNavigation
    // clamps that box to two lines. A note that overran it got its ACTION HALF
    // cut off — the merchant was told a redirect was skipped and not what to
    // do about it, which is the one sentence that mattered. The budget is the
    // clamp's rough capacity minus the longest save line; keep new wording
    // inside it rather than raising the number.
    const BUDGET = 130;
    for (const [name, bundle] of [["de", de], ["en", en], ["es", es]] as const) {
      for (const code of CODES) {
        const text = buildRedirectMessage({ code, fromPath: "/blogs/b/old" }, bundle)!.text;
        expect(text.length, `${name}/${code} is ${text.length} chars: "${text}"`).toBeLessThanOrEqual(BUDGET);
      }
    }
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
