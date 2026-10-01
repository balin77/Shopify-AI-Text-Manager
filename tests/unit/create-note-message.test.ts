/**
 * The create path's notes are read by a MERCHANT, so they are codes on the
 * wire and sentences here. These tests pin both halves against the REAL
 * bundles — the neighbouring redirect-note module shipped dead for months
 * because its test invented a fixture bundle and never compared the key path
 * it reads against the one the bundles actually carry.
 */
import { describe, it, expect } from "vitest";
import { createNoteText, type CreateNoteCode } from "~/utils/create-note-message";
import { de } from "~/i18n/de";
import { en } from "~/i18n/en";
import { es } from "~/i18n/es";

const CODES: CreateNoteCode[] = [
  "titleDrift",
  "priceNotStored",
  "imageProcessing",
  "seoNotStored",
  "seoStepFailed",
  "keywordNotAssigned",
  "finishFailed",
  "fieldsNotStored",
];

const bundles = { de, en, es } as const;

describe("createNoteText", () => {
  it.each(Object.keys(bundles))("phrases every code in %s", (name) => {
    const texts = (bundles as any)[name].content.createNotes as Record<string, string>;
    for (const code of CODES) {
      expect(texts[code], `${name}.content.createNotes.${code}`).toBeTruthy();
    }
  });

  it("reads the section the editor actually passes in", () => {
    // The banner is handed `t.content.createNotes`; a rename on either side
    // makes every note fall back to English in all three languages, silently.
    expect(de.content.createNotes.priceNotStored).toBeTruthy();
    expect(createNoteText({ code: "priceNotStored" }, de.content.createNotes)).toBe(
      de.content.createNotes.priceNotStored,
    );
  });

  it("fills the server's values into the sentence", () => {
    const text = createNoteText(
      { code: "titleDrift", params: { sent: "A shirt", got: "A shirt (truncated)" } },
      en.content.createNotes,
    );
    expect(text).toContain("A shirt (truncated)");
    expect(text).toContain("A shirt");
    expect(text).not.toContain("{");
  });

  it("APPENDS a raw Shopify error rather than interpolating it", () => {
    // No sentence in any language has a slot for it, and dropping it leaves
    // the merchant with a refusal and no reason.
    const text = createNoteText(
      { code: "seoNotStored", params: { fields: "title_tag", detail: "Value can't be blank" } },
      en.content.createNotes,
    );
    expect(text).toContain("title_tag");
    expect(text.endsWith("Value can't be blank")).toBe(true);
  });

  it("quotes a title with $ in it VERBATIM", () => {
    // A string replacement reads `$$`, `$&`, "$`" and `$'` as substitution
    // patterns, so the one note whose job is to quote the merchant's title
    // back at them was the one that mangled it.
    const text = createNoteText(
      { code: "titleDrift", params: { sent: "Mega Deal $$$", got: "Mega Deal $& $' x" } },
      en.content.createNotes,
    );
    expect(text).toContain("Mega Deal $$$");
    expect(text).toContain("Mega Deal $& $' x");
  });

  it("renders a sentence an OLDER instance already phrased", () => {
    // Server and client ship together but not atomically: for one restart
    // window an open page can be answered with the strings these replaced,
    // and an object child crashes the banner of a create that worked.
    expect(createNoteText("The price was not stored.", en.content.createNotes)).toBe(
      "The price was not stored.",
    );
  });

  it("falls back to an English SENTENCE, never to the bare code", () => {
    // A code may be added before its translation is written; an untranslated
    // sentence is still information, "seoNotStored" is not.
    expect(createNoteText({ code: "priceNotStored" }, {})).toMatch(/price/i);
    expect(createNoteText({ code: "priceNotStored" }, undefined)).toMatch(/price/i);
  });
});

/**
 * The create ACTION refuses with a code and an English sentence; the editor
 * maps the code onto a bundle key. Nothing read the code for as long as both
 * existed, so these sentences were shown in English on a German shop while
 * the translations sat in the bundles, spent only on a button tooltip. A
 * renamed key would put it straight back, silently — hence this list.
 */
describe("the refusal keys the editor maps errorCode onto", () => {
  const KEYS = [
    "createPlanContentType",
    "createPlanLimit",
    "rulesNeedApiUpgrade",
    "createInvalidPayload",
    "createInvalidRules",
    "createTypeUnknownRequired",
    "createTypeUnsupportedFields",
    "createAlreadyRunning",
  ];

  it.each(Object.keys(bundles))("exist in %s", (name) => {
    const content = (bundles as any)[name].content as Record<string, unknown>;
    for (const key of KEYS) {
      expect(typeof content[key], `${name}.content.${key}`).toBe("string");
      expect(String(content[key]).length).toBeGreaterThan(0);
    }
  });

  it("keeps the two slots the server fills", () => {
    expect(de.content.rulesNeedApiUpgrade).toContain("{version}");
    expect(de.content.createTypeUnsupportedFields).toContain("{detail}");
  });
});
