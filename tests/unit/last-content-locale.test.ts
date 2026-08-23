import { describe, it, expect, beforeEach } from "vitest";
import {
  readLastContentLocale,
  writeLastContentLocale,
  pickRestoredLocale,
  resolveInitialLocale,
} from "~/utils/last-content-locale";

function withShop(shop: string) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, search: `?shop=${shop}` },
    writable: true,
    configurable: true,
  });
}

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
    withShop("a.myshopify.com");
    expect(readLastContentLocale()).toBeNull();
    writeLastContentLocale("fr");
    expect(readLastContentLocale()).toBe("fr");
  });

  it("keeps one shop's language out of another's", () => {
    // An embedded app serves every shop from ONE origin, and unlike an item id
    // a locale code matches everywhere.
    withShop("a.myshopify.com");
    writeLastContentLocale("fr");
    withShop("b.myshopify.com");
    expect(readLastContentLocale()).toBeNull();
    writeLastContentLocale("es");
    withShop("a.myshopify.com");
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
    expect(
      pick({
        stored: "fr",
        initialLocale: "it",
        shopLocales: [...LOCALES, { locale: "it", published: true }],
      }),
    ).toBeNull();
  });

  it("keeps the remembered language when the deep link is one the editor ignores", () => {
    // Same function decides both, so "the link was honoured" and "step aside
    // for the link" can never disagree: a stale or primary-naming link costs
    // the merchant nothing.
    expect(pick({ stored: "fr", initialLocale: "de" })).toBe("fr"); // primary
    expect(pick({ stored: "fr", initialLocale: "it" })).toBe("fr"); // not a shop locale
  });

  it("resolveInitialLocale honours only a language the shop has", () => {
    expect(resolveInitialLocale("fr", "de", LOCALES)).toBe("fr");
    expect(resolveInitialLocale("es", "de", LOCALES)).toBe("es"); // unpublished, still editable
    expect(resolveInitialLocale("it", "de", LOCALES)).toBe("de"); // unknown
    expect(resolveInitialLocale("de", "de", LOCALES)).toBe("de");
    expect(resolveInitialLocale(undefined, "de", LOCALES)).toBe("de");
    expect(resolveInitialLocale("fr", "de", [])).toBe("de"); // failed lookup
  });

  it("refuses a language the shop no longer has", () => {
    expect(pick({ stored: "it" })).toBeNull();
  });

  it("remembers a language that is not published yet", () => {
    // Translating before publishing the language is the normal order of work,
    // and the editor's language bar offers every locale the shop HAS — so a
    // `published` gate here would refuse exactly the merchant this app is for.
    expect(pick({ stored: "es" })).toBe("es");
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
