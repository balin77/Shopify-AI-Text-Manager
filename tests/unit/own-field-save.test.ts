/**
 * AI and copy buttons save their OWN field immediately, and only it; a button
 * whose source is an unsaved primary value waits for the Save (owner's rule,
 * 2026-10-02). The pure halves: which fields/alts a button's save carries,
 * how its response moves the alt baseline, the save-first gate, and the image
 * manager's immediate per-image save.
 */
import { describe, it, expect } from "vitest";
import {
  buildOwnSaveForm,
  restrictAltBaseline,
  isUnsavedPrimarySource,
  isUnsavedPrimaryAlt,
  altValuesForSaveResponse,
  hasUnsavedPrimaryTranslateSource,
} from "~/services/editor/own-field-save.shared";
import { planImmediateAltSave } from "~/components/image-manager/alt-draft";

describe("buildOwnSaveForm — a button's save carries its own field and nothing else", () => {
  it("primary: the one field, with changedFields only for that field", () => {
    const form = buildOwnSaveForm({
      itemId: "gid://shopify/Product/1",
      locale: "de",
      primaryLocale: "de",
      marketId: "gid://shopify/Market/9",
      fields: { description: "<p>neu</p>" },
      changedFields: ["description", "title"],
    });
    expect(form).toEqual({
      action: "updateContent",
      itemId: "gid://shopify/Product/1",
      locale: "de",
      primaryLocale: "de",
      description: "<p>neu</p>",
      // `title` was not carried, so it can never be reported as changed.
      changedFields: JSON.stringify(["description"]),
    });
    // The primary locale is always global: no marketId.
    expect(form.marketId).toBeUndefined();
  });

  it("primary without a real change (accept-and-translate) sends no changedFields", () => {
    const form = buildOwnSaveForm({
      itemId: "i",
      locale: "de",
      primaryLocale: "de",
      marketId: "",
      fields: { title: "Neu" },
      changedFields: [],
    });
    expect(form.changedFields).toBeUndefined();
    expect(form.changedAttributeFields).toBeUndefined();
  });

  it("an attribute is reported only when it is the changed field", () => {
    const form = buildOwnSaveForm({
      itemId: "i",
      locale: "de",
      primaryLocale: "de",
      marketId: "",
      fields: { vendor: "Acme" },
      changedFields: ["vendor"],
      changedAttributeFields: ["vendor", "tags"],
    });
    expect(JSON.parse(form.changedAttributeFields)).toEqual(["vendor"]);
  });

  it("foreign: market scope rides along, primary-only lists never do", () => {
    const form = buildOwnSaveForm({
      itemId: "i",
      locale: "fr",
      primaryLocale: "de",
      marketId: "gid://shopify/Market/9",
      fields: { title: "Nouveau" },
      changedFields: ["title"],
      altTexts: { 2: "x" },
      changedAltTextIndices: [2],
    });
    expect(form.marketId).toBe("gid://shopify/Market/9");
    expect(form.changedFields).toBeUndefined();
    expect(form.changedAltTextIndices).toBeUndefined();
    expect(JSON.parse(form.imageAltTexts)).toEqual({ 2: "x" });
  });

  it("alt-only save: only the given indices, changed ones flagged on primary", () => {
    const form = buildOwnSaveForm({
      itemId: "i",
      locale: "de",
      primaryLocale: "de",
      marketId: "",
      altTexts: { 1: "a", 4: "b" },
      changedAltTextIndices: [4, 7],
      policyType: "REFUND_POLICY",
    });
    expect(JSON.parse(form.imageAltTexts)).toEqual({ 1: "a", 4: "b" });
    // 7 was not carried.
    expect(JSON.parse(form.changedAltTextIndices)).toEqual([4]);
    expect(form.policyType).toBe("REFUND_POLICY");
    expect(Object.keys(form).filter((k) => !["action", "itemId", "locale", "primaryLocale", "imageAltTexts", "changedAltTextIndices", "policyType"].includes(k))).toEqual([]);
  });
});

describe("restrictAltBaseline — a partial save moves only the alts it carried", () => {
  const full = () => ({ 0: "saved 0", 1: "typed draft", 2: "saved 2" });
  it("full save (null) takes everything", () => {
    expect(restrictAltBaseline(full, null)({ 0: "a", 1: "b" })).toEqual(full());
  });
  it("partial save keeps every other index's previous baseline", () => {
    expect(restrictAltBaseline(full, [0])({ 1: "old 1", 2: "old 2" })).toEqual({ 0: "saved 0", 1: "old 1", 2: "old 2" });
  });
  it("a field-only partial save (no alt) changes no alt baseline", () => {
    const prev = { 1: "old 1" };
    expect(restrictAltBaseline(full, [])(prev)).toEqual(prev);
  });
  it("an index the update removed (rolled-back copy) is removed", () => {
    const update = () => ({ 1: "x" });
    expect(restrictAltBaseline(update, [0])({ 0: "stale", 1: "y" })).toEqual({ 1: "y" });
  });
});

describe("altValuesForSaveResponse — a partial save is answered with what it SENT", () => {
  it("text typed while the save was in flight is not taken as saved", () => {
    const live = { 0: "sent + typed later", 1: "other draft" };
    const sent = altValuesForSaveResponse(live, { altValues: { 0: "sent" } });
    expect(sent[0]).toBe("sent");
    // The baseline of the carried index becomes the SENT value, so the live
    // field still differs from it and stays a draft for the next Save.
    const baseline = restrictAltBaseline(() => sent, [0])({ 0: "before", 1: "old 1" });
    expect(baseline).toEqual({ 0: "sent", 1: "old 1" });
    expect(live[0]).not.toBe(baseline[0]);
  });
  it("without altValues (a full save) the live map is used unchanged", () => {
    const live = { 0: "a" };
    expect(altValuesForSaveResponse(live, null)).toBe(live);
    expect(altValuesForSaveResponse(live, {})).toBe(live);
  });
});

describe("hasUnsavedPrimaryTranslateSource — whole-item Translate all waits for Save", () => {
  const base = {
    currentLanguage: "de",
    primaryLocale: "de",
    fieldKeys: ["title", "body"],
    values: { title: "Titel", body: "Text", status: "DRAFT" },
    baseline: { title: "Titel", body: "Text", status: "ACTIVE" },
    alts: {} as Record<number, string>,
    originalAlts: {} as Record<number, string>,
  };
  it("clean primary: allowed (an unsaved ATTRIBUTE is not a translate source)", () => {
    expect(hasUnsavedPrimaryTranslateSource(base)).toBe(false);
  });
  it("an unsaved translatable primary field blocks it", () => {
    expect(hasUnsavedPrimaryTranslateSource({ ...base, values: { ...base.values, title: "Neu" } })).toBe(true);
  });
  it("an unsaved primary alt text blocks it", () => {
    expect(hasUnsavedPrimaryTranslateSource({ ...base, alts: { 0: "neu" }, originalAlts: { 0: "alt" } })).toBe(true);
  });
  it("never on a foreign locale", () => {
    expect(
      hasUnsavedPrimaryTranslateSource({ ...base, currentLanguage: "fr", values: { ...base.values, title: "Neu" } }),
    ).toBe(false);
  });
});

describe("save-first gate — a button never takes an unsaved primary value as its source", () => {
  it("dirty primary field is gated", () => {
    expect(isUnsavedPrimarySource({ currentLanguage: "de", primaryLocale: "de", value: "neu", baseline: "alt" })).toBe(true);
  });
  it("clean primary field is not", () => {
    expect(isUnsavedPrimarySource({ currentLanguage: "de", primaryLocale: "de", value: "alt", baseline: "alt" })).toBe(false);
  });
  it("no baseline yet (nothing loaded) is not a draft", () => {
    expect(isUnsavedPrimarySource({ currentLanguage: "de", primaryLocale: "de", value: "x", baseline: undefined })).toBe(false);
  });
  it("never on a foreign locale", () => {
    expect(isUnsavedPrimarySource({ currentLanguage: "fr", primaryLocale: "de", value: "neu", baseline: "alt" })).toBe(false);
  });
  it("alt: an untouched image (no entries) is clean; a typed one is dirty", () => {
    expect(isUnsavedPrimaryAlt({ currentLanguage: "de", primaryLocale: "de", value: undefined, original: undefined })).toBe(false);
    expect(isUnsavedPrimaryAlt({ currentLanguage: "de", primaryLocale: "de", value: "typed", original: undefined })).toBe(true);
    expect(isUnsavedPrimaryAlt({ currentLanguage: "de", primaryLocale: "de", value: "same", original: "same" })).toBe(false);
    expect(isUnsavedPrimaryAlt({ currentLanguage: "fr", primaryLocale: "de", value: "typed", original: undefined })).toBe(false);
  });
});

describe("planImmediateAltSave — an AI result in the image manager saves that image only", () => {
  const G1 = "gid://shopify/MediaImage/1";
  const G2 = "gid://shopify/MediaImage/2";
  const gids: Record<string, string> = {
    "https://cdn/a.jpg?v=1": G1,
    "https://cdn/a.jpg?v=2": G1,
    "https://cdn/b.jpg?v=1": G2,
  };
  const gidOf = (u: string) => gids[u];

  it("plans the generated image and leaves another image's draft alone", () => {
    const entry = planImmediateAltSave({
      url: "https://cdn/a.jpg?v=1",
      dirtyUrls: ["https://cdn/a.jpg?v=1", "https://cdn/b.jpg?v=1"],
      texts: { "https://cdn/a.jpg?v=1": "AI text", "https://cdn/b.jpg?v=1": "typed draft" },
      gidOf,
      locale: "de",
      productId: "p",
      editOrder: new Map([["https://cdn/b.jpg?v=1", 1], ["https://cdn/a.jpg?v=1", 2]]),
    });
    expect(entry).toMatchObject({ url: "https://cdn/a.jpg?v=1", mediaId: G1, altText: "AI text", locale: "de", productId: "p" });
    expect(entry?.aliases).toBeUndefined();
  });

  it("another tile of the SAME medium rides along as an alias, the AI result winning", () => {
    const entry = planImmediateAltSave({
      url: "https://cdn/a.jpg?v=1",
      dirtyUrls: ["https://cdn/a.jpg?v=2", "https://cdn/a.jpg?v=1"],
      texts: { "https://cdn/a.jpg?v=1": "AI text", "https://cdn/a.jpg?v=2": "older draft" },
      gidOf,
      locale: "fr",
      marketId: "gid://shopify/Market/3",
      productId: "p",
      editOrder: new Map([["https://cdn/a.jpg?v=2", 1], ["https://cdn/a.jpg?v=1", 2]]),
    });
    expect(entry).toMatchObject({ url: "https://cdn/a.jpg?v=1", altText: "AI text", marketId: "gid://shopify/Market/3" });
    expect(entry?.aliases).toEqual([{ url: "https://cdn/a.jpg?v=2", altText: "older draft" }]);
  });

  it("an image without a media id (unsaved upload) cannot be saved: null", () => {
    expect(planImmediateAltSave({
      url: "blob:preview",
      dirtyUrls: ["blob:preview"],
      texts: { "blob:preview": "AI text" },
      gidOf,
      productId: "p",
    })).toBeNull();
  });
});
