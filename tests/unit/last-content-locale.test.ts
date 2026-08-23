import { describe, it, expect, beforeEach } from "vitest";
import {
  readLastContentLocale,
  writeLastContentLocale,
  pickRestoredLocale,
} from "~/utils/last-content-locale";

const LOCALES = [
  { locale: "de", primary: true, published: true },
  { locale: "fr", published: true },
  { locale: "es", published: false },
];

const pick = (over: Partial<Parameters<typeof pickRestoredLocale>[0]> = {}) =>
  pickRestoredLocale({
    stored: null,
    primaryLocale: "de",
    shopLocales: LOCALES,
    ...over,
  });

describe("last-content-locale", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the working language", () => {
    expect(readLastContentLocale()).toBeNull();
    writeLastContentLocale("fr");
    expect(readLastContentLocale()).toBe("fr");
  });

  it("reopens the editor in the language the merchant was working in", () => {
    expect(pick({ stored: "fr" })).toBe("fr");
  });

  it("keeps the primary locale when nothing was stored", () => {
    expect(pick({ stored: null })).toBeNull();
  });

  it("lets a ?contentLocale= deep link win over the stored language", () => {
    // The initializer already applied it; overriding here would fight a link
    // the merchant just followed.
    expect(pick({ stored: "fr", initialLocale: "es" })).toBeNull();
    expect(pick({ stored: "fr", initialLocale: "de" })).toBeNull();
  });

  it("refuses a language the shop no longer has", () => {
    expect(pick({ stored: "it" })).toBeNull();
  });

  it("refuses a language the storefront no longer serves", () => {
    // Unpublished: the editor would offer to write translations nobody can see.
    expect(pick({ stored: "es" })).toBeNull();
  });

  it("does not refuse on a MISSING published flag", () => {
    // An absent key is not a negative answer — narrower callers build this
    // type by hand, and a silently dead restore is how the ?locale= collision
    // went unnoticed.
    expect(pick({ stored: "fr", shopLocales: [{ locale: "de", primary: true }, { locale: "fr" }] })).toBe("fr");
  });

  it("refuses everything when the locale lookup failed", () => {
    // An empty list means the lookup failed, never "this shop has one
    // language" (CLAUDE.md) — so it is not evidence that `fr` is gone, and
    // it is not evidence that it is there either.
    expect(pick({ stored: "fr", shopLocales: [] })).toBeNull();
  });

  it("treats the primary locale as nothing to restore", () => {
    // Switching back to the main language is remembered like any other, and
    // restoring it is a no-op rather than a second answer.
    expect(pick({ stored: "de" })).toBeNull();
  });

  it("never restores a locale flagged primary, whatever it is called", () => {
    expect(pick({ stored: "fr", primaryLocale: "en", shopLocales: [{ locale: "en" }, { locale: "fr", primary: true }] }))
      .toBeNull();
  });
});
