import { describe, it, expect } from "vitest";
import {
  hasKeptEdits,
  isOptionEditUnsaved,
  metafieldEditsAfterSave,
  optionEditsAfterSave,
  snapshotPrimaryEdits,
  type OptionEdit,
} from "../../app/services/editor/sub-resource-edits.shared";

const option = {
  id: "o1",
  name: "Colour",
  values: [
    { id: "v1", name: "Red" },
    { id: "v2", name: "Blue" },
  ],
};

const snap = (over: Partial<Parameters<typeof snapshotPrimaryEdits>[0]> = {}) =>
  snapshotPrimaryEdits({ metafieldEdits: {}, optionEdits: {}, optionsToDelete: [], valuesToDelete: {}, ...over });

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
