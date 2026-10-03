import { describe, expect, it } from "vitest";

import {
  dropSavedFieldsFromFallbackSnapshot,
  fallbackFieldsAfterDiscard,
} from "~/services/editor/discard-fallback.shared";

describe("discard fallback snapshot", () => {
  const snapshot = {
    fields: new Set(["title", "seoTitle"]),
    values: { title: "Titre global", seoTitle: "SEO global" },
  };

  it("re-flags an inherited field whose baseline still holds the loaded value", () => {
    expect([...fallbackFieldsAfterDiscard(snapshot, { title: "Titre global", seoTitle: "SEO global" })].sort())
      .toEqual(["seoTitle", "title"]);
  });

  it("a field SAVED with exactly the inherited value is not re-flagged by Discard", () => {
    // The save stored "Titre global" as the field's own value: the baseline is
    // unchanged, so only dropping the key from the snapshot keeps it unflagged.
    const afterSave = dropSavedFieldsFromFallbackSnapshot(snapshot, ["title"]);
    expect([...fallbackFieldsAfterDiscard(afterSave, { title: "Titre global", seoTitle: "SEO global" })])
      .toEqual(["seoTitle"]);
    // The original snapshot is not mutated.
    expect(snapshot.fields.has("title")).toBe(true);
  });

  it("returns the same snapshot when the save stored none of its fields, and passes null through", () => {
    expect(dropSavedFieldsFromFallbackSnapshot(snapshot, ["body"])).toBe(snapshot);
    expect(dropSavedFieldsFromFallbackSnapshot(null, ["title"])).toBeNull();
  });
});
