import { describe, it, expect } from "vitest";
import {
  hasKeptEdits,
  isOptionEditUnsaved,
  metafieldEditsAfterSave,
  optionEditsAfterSave,
  hasStructural,
  retypedForeignIds,
  snapshotPrimaryEdits,
  structuralAfterSave,
  type OptionEdit,
  type StructuralLists,
} from "../../app/services/editor/sub-resource-edits.shared";

const option = {
  id: "o1",
  name: "Colour",
  values: [
    { id: "v1", name: "Red" },
    { id: "v2", name: "Blue" },
  ],
};

const EMPTY_STRUCTURAL = { valuesToAdd: {}, linkedToAdd: {}, valuesToDelete: {}, optionsToCreate: [], optionsToDelete: [], optionOrder: null, valueOrder: {} };
const snap = (over: Partial<Parameters<typeof snapshotPrimaryEdits>[0]> = {}) =>
  snapshotPrimaryEdits({ metafieldEdits: {}, optionEdits: {}, optionsToDelete: [], valuesToDelete: {}, structural: EMPTY_STRUCTURAL, ...over });

describe("metafieldEditsAfterSave - settles against the SNAPSHOT, never against an item", () => {
  it("drops what still equals its snapshot (saved or reverted), keeps retypes, drafts and late edits", () => {
    const kept = metafieldEditsAfterSave({
      edits: { saved: "a", retyped: "b2", failed: "c", draft: "d", late: "e" },
      snapshot: { saved: "a", retyped: "b", failed: "c", draft: "d" },
      unverifiedIds: new Set(["draft"]),
    });
    expect(kept).toEqual({ retyped: "b2", draft: "d", late: "e" });
  });

  it("keeps the RETYPE of a field whose sent value failed (not reverted over the merchant's new text)", () => {
    expect(
      metafieldEditsAfterSave({ edits: { f: "new" }, snapshot: { f: "sent" }, unverifiedIds: new Set() }),
    ).toEqual({ f: "new" });
  });

  it("re-keys a retype of a re-created cleared slot to the new GID (the old id is gone after the save)", () => {
    const kept = metafieldEditsAfterSave({
      edits: { slot: "Hanf", other: "x" },
      snapshot: { slot: "Leinen", other: "x" },
      unverifiedIds: new Set(),
      recreated: { slot: "gid://shopify/Metafield/NEW" },
    });
    expect(kept).toEqual({ "gid://shopify/Metafield/NEW": "Hanf" });
  });

  it("an unchanged re-created slot is settled, not re-keyed", () => {
    expect(
      metafieldEditsAfterSave({
        edits: { slot: "Leinen" },
        snapshot: { slot: "Leinen" },
        unverifiedIds: new Set(),
        recreated: { slot: "gid://shopify/Metafield/NEW" },
      }),
    ).toEqual({});
  });
});

describe("optionEditsAfterSave - id-keyed, snapshot-based", () => {
  it("rename + reorder: the rename is settled, nothing pairs a name with the wrong value", () => {
    // Red -> Rouge, and Blue dragged first. The reload gives [Blue, Rouge]; the edit is keyed by id.
    const edits: Record<string, OptionEdit> = { o1: { values: { v1: "Rouge" } } };
    expect(optionEditsAfterSave({ edits, snapshot: snap({ optionEdits: edits }) })).toEqual({});
  });

  it("rename + reorder, then a retype of the renamed value during the save: only the retype stays, on the right value", () => {
    const sent: Record<string, OptionEdit> = { o1: { values: { v1: "Rouge" } } };
    const now: Record<string, OptionEdit> = { o1: { values: { v1: "Rot" } } };
    expect(optionEditsAfterSave({ edits: now, snapshot: snap({ optionEdits: sent }) })).toEqual({
      o1: { values: { v1: "Rot" } },
    });
  });

  it("rename + add: the rename is settled; a retype of the OTHER value during the save survives", () => {
    const sent: Record<string, OptionEdit> = { o1: { values: { v1: "Rouge" } } };
    const now: Record<string, OptionEdit> = { o1: { values: { v1: "Rouge", v2: "Bleu" } } };
    expect(optionEditsAfterSave({ edits: now, snapshot: snap({ optionEdits: sent }) })).toEqual({
      o1: { values: { v2: "Bleu" } },
    });
  });

  it("rename + delete: an edit of the deleted value is dropped, one of a surviving value stays", () => {
    const sent: Record<string, OptionEdit> = { o1: { values: { v1: "Rouge" } } };
    const now: Record<string, OptionEdit> = { o1: { values: { v1: "Rouge2", v2: "Bleu" } } };
    expect(
      optionEditsAfterSave({ edits: now, snapshot: snap({ optionEdits: sent, valuesToDelete: { o1: ["v1"] } }) }),
    ).toEqual({ o1: { values: { v2: "Bleu" } } });
  });

  it("a retyped option NAME stays, an unchanged one is settled; a deleted option's edits go", () => {
    const sent: Record<string, OptionEdit> = { o1: { name: "Farbe", values: {} }, o2: { name: "X", values: {} } };
    const now: Record<string, OptionEdit> = {
      o1: { name: "Farbton", values: {} },
      o2: { name: "X", values: {} },
      o3: { name: "Gone", values: {} },
    };
    expect(
      optionEditsAfterSave({ edits: now, snapshot: snap({ optionEdits: { ...sent, o3: now.o3 }, optionsToDelete: ["o3"] }) }),
    ).toEqual({ o1: { name: "Farbton", values: {} } });
  });

  it("a FAILED option edit is reverted unless it was retyped", () => {
    const sent: Record<string, OptionEdit> = { o1: { name: "Farbe", values: { v1: "Rouge" } } };
    expect(optionEditsAfterSave({ edits: sent, snapshot: snap({ optionEdits: sent }) })).toEqual({});
    expect(
      optionEditsAfterSave({ edits: { o1: { name: "Farbe", values: { v1: "Rot" } } }, snapshot: snap({ optionEdits: sent }) }),
    ).toEqual({ o1: { values: { v1: "Rot" } } });
  });

  it("an edit typed after submit (no snapshot) stays", () => {
    expect(
      optionEditsAfterSave({ edits: { o9: { name: "New", values: { v9: "x" } } }, snapshot: snap() }),
    ).toEqual({ o9: { name: "New", values: { v9: "x" } } });
  });

  it("the snapshot is a copy: later edits cannot reach into what was sent", () => {
    const live: Record<string, OptionEdit> = { o1: { values: { v1: "Rouge" } } };
    const s = snap({ optionEdits: live });
    live.o1.values.v1 = "changed";
    expect(s.optionEdits.o1.values.v1).toBe("Rouge");
  });
});

describe("helpers", () => {
  it("isOptionEditUnsaved compares by value id", () => {
    expect(isOptionEditUnsaved(option, { values: { v2: "Blue" } })).toBe(false);
    expect(isOptionEditUnsaved(option, { values: { v2: "Bleu" } })).toBe(true);
    expect(isOptionEditUnsaved(option, { values: { gone: "x" } })).toBe(false);
    expect(isOptionEditUnsaved(option, { name: "Farbe", values: {} })).toBe(true);
  });

  it("hasKeptEdits is true while anything is kept", () => {
    expect(hasKeptEdits({}, {})).toBe(false);
    expect(hasKeptEdits({ a: "x" }, {})).toBe(true);
    expect(hasKeptEdits({}, { o: {} })).toBe(true);
  });
});

describe("structuralAfterSave - only what the save carried leaves", () => {
  const lists = (over: Partial<StructuralLists> = {}): StructuralLists => ({ ...EMPTY_STRUCTURAL, ...over });

  it("keeps a value added AFTER the press, removes the carried one (by value, once)", () => {
    const carried = lists({ valuesToAdd: { o1: ["Blue"] } });
    const current = lists({ valuesToAdd: { o1: ["Blue", "Green"] } });
    expect(structuralAfterSave(current, carried).valuesToAdd).toEqual({ o1: ["Green"] });
    // two pending adds of the same text: only the carried one goes
    expect(structuralAfterSave(lists({ valuesToAdd: { o1: ["X", "X"] } }), lists({ valuesToAdd: { o1: ["X"] } })).valuesToAdd).toEqual({ o1: ["X"] });
  });

  it("deletes, linked entries and created options likewise", () => {
    const carried = lists({
      valuesToDelete: { o1: ["v1"] },
      linkedToAdd: { o1: [{ id: "m1", name: "A" }] },
      optionsToCreate: [{ name: "Material", values: ["Cotton"] }],
      optionsToDelete: ["o9"],
    });
    const current = lists({
      valuesToDelete: { o1: ["v1", "v2"] },
      linkedToAdd: { o1: [{ id: "m1", name: "A" }, { id: "m2", name: "B" }] },
      optionsToCreate: [{ name: "Material", values: ["Cotton"] }, { name: "Finish", values: ["Matte"] }],
      optionsToDelete: ["o9", "o8"],
    });
    const rest = structuralAfterSave(current, carried);
    expect(rest.valuesToDelete).toEqual({ o1: ["v2"] });
    expect(rest.linkedToAdd).toEqual({ o1: [{ id: "m2", name: "B" }] });
    expect(rest.optionsToCreate).toEqual([{ name: "Finish", values: ["Matte"] }]);
    expect(rest.optionsToDelete).toEqual(["o8"]);
  });

  it("an order the merchant changed after the press stays; the carried one goes", () => {
    expect(structuralAfterSave(lists({ optionOrder: ["a", "b"] }), lists({ optionOrder: ["a", "b"] })).optionOrder).toBeNull();
    expect(structuralAfterSave(lists({ optionOrder: ["b", "a"] }), lists({ optionOrder: ["a", "b"] })).optionOrder).toEqual(["b", "a"]);
    const rest = structuralAfterSave(lists({ valueOrder: { o1: ["v2", "v1"], o2: ["x"] } }), lists({ valueOrder: { o1: ["v2", "v1"] } }));
    expect(rest.valueOrder).toEqual({ o2: ["x"] });
  });

  it("nothing carried -> nothing removed; everything carried -> nothing left", () => {
    const all = lists({ valuesToAdd: { o1: ["A"] }, optionsToDelete: ["o"] });
    expect(structuralAfterSave(all, EMPTY_STRUCTURAL)).toEqual(all);
    expect(hasStructural(structuralAfterSave(all, all))).toBe(false);
    expect(hasStructural(all)).toBe(true);
  });
});

describe("retypedForeignIds", () => {
  it("names the carried ids whose text differs now, and only those", () => {
    const sent = { a: { value: "one" }, b: { name: "two" }, c: { value: "three" } };
    const now: Record<string, string> = { a: "one", b: "two!", c: "three" };
    expect(retypedForeignIds(sent, (id) => now[id])).toEqual(new Set(["b"]));
    // an unreadable field is not "retyped"
    expect(retypedForeignIds(sent, () => undefined)).toEqual(new Set());
  });
});
