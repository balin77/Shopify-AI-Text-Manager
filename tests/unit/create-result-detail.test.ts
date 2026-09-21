/**
 * Which post-create report the merchant gets.
 *
 * An ordinary create reports in ONE sentence through the app-wide InfoBox,
 * like a delete and a duplicate do. The banner is for the cases where one
 * sentence is not enough — and the whole point of the split is that those
 * cases are the exception, so the predicate deciding it is pinned here.
 */
import { describe, it, expect } from "vitest";
import { createResultNeedsDetail, handleWasChanged, type CreatedItemInfo } from "~/hooks/useCreateItem";

const clean: CreatedItemInfo = {
  id: "gid://shopify/Collection/1",
  resource: "collection",
  title: "Testkollektion",
  handle: "testkollektion",
  handleChanged: false,
  synced: true,
  notes: [],
};

describe("createResultNeedsDetail", () => {
  it("says NO for a plain successful create — that one goes to the InfoBox", () => {
    expect(createResultNeedsDetail(clean)).toBe(false);
  });

  it("says YES when the cache sync failed", () => {
    // The case the banner exists for: it has to stand still, carry a reload
    // and say "do not create it a second time".
    expect(createResultNeedsDetail({ ...clean, synced: false })).toBe(true);
  });

  it("says YES when Shopify assigned a different handle", () => {
    expect(createResultNeedsDetail({ ...clean, handle: "testkollektion-1", handleChanged: true })).toBe(true);
  });

  it("ignores a handle the merchant never asked for", () => {
    // Derived from the title because the field was left empty — not news.
    expect(createResultNeedsDetail({ ...clean, handle: "testkollektion" })).toBe(false);
  });

  it("says YES for a note from the write path", () => {
    expect(createResultNeedsDetail({ ...clean, notes: ["The price was not stored."] })).toBe(true);
  });

  it("says YES for a warning code, including one appended after the fact", () => {
    // The chained translate-all appends this seconds after the create was
    // already reported as clean; the banner has to appear then.
    expect(createResultNeedsDetail({ ...clean, warningCodes: ["translateChainFailed"] })).toBe(true);
  });

  it("treats an empty warning list like no warnings", () => {
    expect(createResultNeedsDetail({ ...clean, warningCodes: [] })).toBe(false);
  });
});

describe("handleWasChanged", () => {
  it("reports a handle that differs from the one the merchant typed", () => {
    expect(handleWasChanged("kontakt", "Kontakt", "kontakt-1")).toBe(true);
  });

  it("stays silent when the typed handle is what Shopify stored", () => {
    expect(handleWasChanged("kontakt", "Kontakt", "kontakt")).toBe(false);
  });

  it("reports a COLLISION suffix on a handle nobody typed", () => {
    // A second page called "Contact" lands on /pages/contact-1 — worth a word
    // even though the merchant asked for no particular handle.
    expect(handleWasChanged(null, "Contact", "contact-1")).toBe(true);
  });

  it("says nothing about a handle Shopify simply derived", () => {
    expect(handleWasChanged(null, "Contact", "contact")).toBe(false);
  });

  it("stays SILENT when our transliteration disagrees with Shopify's", () => {
    // The whole reason the untyped case tests for a numeric suffix rather
    // than for equality: a base we cannot reproduce must produce silence,
    // never "Shopify changed your handle" on every umlaut in the shop.
    expect(handleWasChanged(null, "Grüne Vasen", "gruene-vasen")).toBe(false);
    expect(handleWasChanged(null, "Grüne Vasen", "gruene-vasen-1")).toBe(false);
  });

  it("does not read a dashed word as a collision suffix", () => {
    expect(handleWasChanged(null, "Vasen", "vasen-gross")).toBe(false);
  });

  it("answers no when Shopify reported no handle at all", () => {
    expect(handleWasChanged("kontakt", "Kontakt", null)).toBe(false);
  });
});
