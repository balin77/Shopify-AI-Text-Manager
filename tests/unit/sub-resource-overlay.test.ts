import { describe, expect, it } from "vitest";
import {
  changedIdsOfPrimarySave,
  dropOverlayForPrimaryChange,
  overlayKeepingOnly,
  recordConfirmedForeignSave,
  savedIdsAfterPartialSave,
  stageTranslateAnswer,
  translateAnswerPlan,
  updateKeepIds,
} from "../../app/services/editor/sub-resource-overlay.shared";
import { hasPurgeUnconfirmedWarning } from "../../app/services/editor/unconfirmed-cleared.shared";
import { answerPredatesSave, altConfirmKey } from "../../app/components/image-manager/alt-load-guard";

describe("recordConfirmedForeignSave", () => {
  it("overwrites a staged translate value with what was saved, skipping failed ones", () => {
    const overlay = { de: { a: { name: "staged" }, b: { name: "old-b" } } };
    recordConfirmedForeignSave(overlay, "de", { a: { name: "typed" }, b: { name: "typed-b" } }, ["b"]);
    expect(overlay.de.a.name).toBe("typed");
    expect(overlay.de.b.name).toBe("old-b");
  });
  it("leaves untranslatable resources alone and keys by the market-folded key", () => {
    const overlay: Record<string, Record<string, Record<string, string>>> = {};
    recordConfirmedForeignSave(overlay, "de::m1", { a: { value: "v" }, c: { value: "x" } }, [], ["c"]);
    expect(overlay).toEqual({ "de::m1": { a: { value: "v" } } });
  });
});

describe("recordConfirmedForeignSave market removal and savedIds", () => {
  it("deletes a staged market entry on a confirmed removal instead of staging empty", () => {
    const overlay: Record<string, Record<string, Record<string, string>>> = { "de::m1": { a: { name: "old" } } };
    expect(recordConfirmedForeignSave(overlay, "de::m1", { a: { name: "" } }, [], [], { marketLayer: true })).toBe(true);
    expect(overlay).toEqual({});
  });
  it("still stages an empty value in the global layer", () => {
    const overlay: Record<string, Record<string, Record<string, string>>> = {};
    recordConfirmedForeignSave(overlay, "de", { a: { name: "" } });
    expect(overlay).toEqual({ de: { a: { name: "" } } });
  });
  it("intersects with the server's savedResources", () => {
    const overlay: Record<string, Record<string, Record<string, string>>> = {};
    recordConfirmedForeignSave(overlay, "de", { a: { name: "x" }, b: { name: "y" } }, [], [], { savedIds: ["a"] });
    expect(overlay).toEqual({ de: { a: { name: "x" } } });
  });
});

describe("savedIdsAfterPartialSave", () => {
  it("drops failed options with their values and failed metafields", () => {
    const ids = savedIdsAfterPartialSave(
      { o1: { name: "n", valueUpdates: [{ id: "v1" }] }, o2: { name: "m", valueUpdates: [{ id: "v2" }] } },
      { m1: 1, m2: 2 },
      ["o2"],
      ["m2"],
    );
    expect(ids.sort()).toEqual(["m1", "o1", "v1"]);
  });
});

describe("dropOverlayForPrimaryChange", () => {
  it("removes changed resources from every locale except unconfirmed ones", () => {
    const overlay = {
      de: { a: { name: "x" }, b: { name: "y" } },
      fr: { a: { name: "z" } },
    };
    dropOverlayForPrimaryChange(overlay, ["a", "b"], new Set(["b"]));
    expect(overlay).toEqual({ de: { b: { name: "y" } } });
  });
});

describe("keep ids", () => {
  it("drops an id a later save returned confirmed and adds unconfirmed ones", () => {
    const keep = new Set(["a", "b"]);
    updateKeepIds(keep, ["a"], ["c"]);
    expect([...keep].sort()).toEqual(["b", "c"]);
  });
  it("overlayKeepingOnly empties without keep ids", () => {
    expect(overlayKeepingOnly({ de: { a: { name: "x" } } }, new Set())).toEqual({});
    expect(overlayKeepingOnly({ de: { a: { name: "x" }, b: { name: "y" } } }, new Set(["b"]))).toEqual({
      de: { b: { name: "y" } },
    });
  });
});

describe("translateAnswerPlan", () => {
  const cur = { itemId: "p1", locale: "de", marketId: "" };
  it("applies when the requested view is still showing", () => {
    expect(translateAnswerPlan({ itemId: "p1", locale: "de", marketId: "" }, cur)).toBe("apply");
  });
  it("stages only when the language changed meanwhile", () => {
    expect(translateAnswerPlan({ itemId: "p1", locale: "fr", marketId: "" }, cur)).toBe("stage");
  });
  it("skips another item; a market target is staged globally, never applied", () => {
    expect(translateAnswerPlan({ itemId: "p2", locale: "de", marketId: "" }, cur)).toBe("skip");
    expect(translateAnswerPlan({ itemId: "p1", locale: "de", marketId: "m" }, cur)).toBe("stage");
    expect(translateAnswerPlan({ itemId: "p1", locale: "de", marketId: "m" }, { ...cur, marketId: "m" })).toBe("stage");
    expect(translateAnswerPlan({ itemId: "p1", locale: "de", marketId: "" }, { ...cur, marketId: "m" })).toBe("stage");
    expect(translateAnswerPlan(null, cur)).toBe("skip");
  });
  it("stages under the requested locale, ignoring empty values", () => {
    const overlay: Record<string, Record<string, Record<string, string>>> = {};
    expect(stageTranslateAnswer(overlay, "fr", { a: { name: "n", other: "q" }, b: { name: "" } })).toBe(true);
    expect(overlay).toEqual({ fr: { a: { name: "n" } } });
  });
});

describe("changedIdsOfPrimarySave", () => {
  it("collects options, value updates and metafields", () => {
    expect(
      changedIdsOfPrimarySave({ o1: { name: "n", valueUpdates: [{ id: "v1" }] }, o2: { name: "m" } }, { m1: "x" }).sort(),
    ).toEqual(["m1", "o1", "o2", "v1"]);
  });
  it("does not name an option whose name did not change", () => {
    expect(
      changedIdsOfPrimarySave({ o1: { valueUpdates: [{ id: "v1" }] }, o2: { valuesToAdd: [] } as any }, {}).sort(),
    ).toEqual(["v1"]);
  });
});

describe("hasPurgeUnconfirmedWarning", () => {
  it("reads the warning code from a save answer", () => {
    expect(hasPurgeUnconfirmedWarning({ warnings: ["x", "translationPurgeUnconfirmed"] })).toBe(true);
    expect(hasPurgeUnconfirmedWarning({ warnings: [] })).toBe(false);
    expect(hasPurgeUnconfirmedWarning(null)).toBe(false);
  });
});

describe("answerPredatesSave", () => {
  it("ignores an answer requested before the image's confirmed save", () => {
    expect(answerPredatesSave(2000, 1000)).toBe(true);
    expect(answerPredatesSave(500, 1000)).toBe(false);
    expect(answerPredatesSave(undefined, 1000)).toBe(false);
  });
});

describe("altConfirmKey", () => {
  it("separates language and market layers of one image", () => {
    expect(altConfirmKey("u", "de", "")).not.toBe(altConfirmKey("u", "fr", ""));
    expect(altConfirmKey("u", "de", undefined)).toBe(altConfirmKey("u", "de", ""));
    expect(altConfirmKey("u", "de", "m1")).not.toBe(altConfirmKey("u", "de", ""));
  });
});
