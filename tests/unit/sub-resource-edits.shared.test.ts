import { describe, it, expect } from "vitest";
import {
  metafieldEditsAfterSave,
  optionEditsAfterSave,
  isOptionEditUnsaved,
} from "../../app/services/editor/sub-resource-edits.shared";

const mf = (id: string, value = "old") => ({ id, type: "single_line_text_field", value });
const option = { id: "o1", name: "Colour", values: [{ id: "v1", name: "Red" }, { id: "v2", name: "Blue" }] };

describe("metafieldEditsAfterSave", () => {
  const find = (id: string) => mf(id);
  it("drops saved + reverted, keeps drafts, retypes and never-sent edits", () => {
    const kept = metafieldEditsAfterSave({
      edits: { saved: "a", retyped: "b2", failed: "c", draft: "d", late: "e" },
      sent: { saved: "a", retyped: "b", failed: "c", draft: "d" },
      failedIds: ["failed", "draft"],
      unverifiedIds: new Set(["draft"]),
      findOriginal: find,
    });
    expect(kept).toEqual({ retyped: "b2", draft: "d", late: "e" });
  });
});

describe("optionEditsAfterSave", () => {
  const find = (id: string) => (id === "o1" ? option : undefined);
  it("drops an edit that still holds what was sent, keeps a retype", () => {
    const sent = { o1: { name: "Farbe", valueUpdates: [{ id: "v1", name: "Rot" }] } };
    expect(optionEditsAfterSave({ edits: { o1: { name: "Farbe", values: ["Rot", "Blue"] } }, sent, failedIds: [], findOriginal: find })).toEqual({});
    expect(optionEditsAfterSave({ edits: { o1: { name: "Farbe", values: ["Rot2", "Blue"] } }, sent, failedIds: [], findOriginal: find })).toEqual({
      o1: { name: "Farbe", values: ["Rot2", "Blue"] },
    });
  });
  it("reverts a failed option and drops one whose values were added/removed in the same save", () => {
    expect(optionEditsAfterSave({ edits: { o1: { name: "X", values: ["Red", "Blue"] } }, sent: { o1: { name: "X" } }, failedIds: ["o1"], findOriginal: find })).toEqual({});
    expect(optionEditsAfterSave({ edits: { o1: { name: "Y", values: ["Red", "Blue"] } }, sent: { o1: { name: "X", valuesToAdd: ["Green"] } }, failedIds: [], findOriginal: find })).toEqual({});
  });
  it("an unsent edit stays only when it is a real difference", () => {
    expect(optionEditsAfterSave({ edits: { o1: { name: "Colour", values: ["Red", "Blue"] } }, sent: {}, failedIds: [], findOriginal: find })).toEqual({});
    expect(isOptionEditUnsaved(option, { name: "Colour", values: ["Red", "Blue2"] })).toBe(true);
  });
});
