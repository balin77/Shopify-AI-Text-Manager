import { describe, it, expect } from "vitest";
import {
  buildLocaleDeletedKey,
  buildStageMark,
  dropStageMarksOfLayer,
  layerMarkOfStage,
  dropLocaleMarks,
  dropMarksAfterSave,
  isMarkedDeleted,
} from "~/services/editor/deleted-translation-marks.shared";
import { subResourceSaveRacesRun } from "~/services/editor/sub-resource-clear.shared";
import { taskOperationKey, taskShowsInView, markOperationActive, isOperationActive, reconcileWithServer, clearAllForResource } from "~/hooks/useAIOperationsStore";

describe("deleted marks", () => {
  it("a locale mark hides one locale only, a layer mark every locale", () => {
    const marks = new Set([buildLocaleDeletedKey("title", "", "it")]);
    expect(isMarkedDeleted(marks, "title", "", "it")).toBe(true);
    expect(isMarkedDeleted(marks, "title", "", "fr")).toBe(false);
    marks.add("body_html");
    expect(isMarkedDeleted(marks, "body_html", "", "fr")).toBe(true);
  });

  it("a save drops its own locale's marks (only its keys when partial), never another's", () => {
    const marks = new Set(["title##it", "body_html##it", "title##fr", "meta_title", "title@@gid://shopify/Market/1##it"]);
    dropMarksAfterSave(marks, { locale: "it", marketId: "" }, new Set(["title"]));
    expect([...marks].sort()).toEqual(["body_html##it", "title##fr", "title@@gid://shopify/Market/1##it"]);
    dropMarksAfterSave(marks, null);
    expect([...marks].sort()).toEqual(["body_html##it", "title##fr", "title@@gid://shopify/Market/1##it"]);
  });

  it("dropLocaleMarks keeps what a save that is out stands behind", () => {
    const marks = new Set(["title##it", "body_html##it", "title##fr"]);
    dropLocaleMarks(marks, "it", "", new Set(["body_html##it"]));
    expect([...marks].sort()).toEqual(["body_html##it", "title##fr"]);
  });
});

describe("stage marks (a translated locale exempted from a layer mark)", () => {
  it("exempt ONLY their locale from the layer mark; a locale mark of it still applies", () => {
    const marks = new Set(["title", buildStageMark("title", "", "fr")]);
    expect(isMarkedDeleted(marks, "title", "", "fr")).toBe(false);
    expect(isMarkedDeleted(marks, "title", "", "es")).toBe(true);
    marks.add(buildLocaleDeletedKey("title", "", "fr"));
    expect(isMarkedDeleted(marks, "title", "", "fr")).toBe(true);
  });

  it("are per market and per key", () => {
    const marks = new Set(["title@@m1", buildStageMark("title", "m1", "fr")]);
    expect(isMarkedDeleted(marks, "title", "m1", "fr")).toBe(false);
    expect(isMarkedDeleted(marks, "title", "m1", "es")).toBe(true);
    expect(isMarkedDeleted(new Set(["body_html", buildStageMark("title", "", "fr")]), "body_html", "", "fr")).toBe(true);
  });

  it("go with the layer marks on any save, and survive a locale/market/discard drop", () => {
    const stage = buildStageMark("title", "", "fr");
    const marks = new Set(["title", stage]);
    dropLocaleMarks(marks, "fr", "", null);
    expect(marks.has(stage)).toBe(true);
    dropMarksAfterSave(marks, { locale: "fr", marketId: "" });
    expect([...marks]).toEqual([]);
    const again = new Set(["title", stage]);
    dropMarksAfterSave(again, null);
    expect([...again]).toEqual([]);
  });
});

describe("stage marks follow their layer mark", () => {
  it("layerMarkOfStage reads the layer back (with and without a market)", () => {
    expect(layerMarkOfStage(buildStageMark("title", "", "fr"))).toBe("title");
    expect(layerMarkOfStage(buildStageMark("title", "gid://shopify/Market/1", "fr"))).toBe("title@@gid://shopify/Market/1");
  });

  it("dropStageMarksOfLayer removes only the stage marks of that key and market", () => {
    const marks = new Set([
      buildStageMark("title", "", "fr"),
      buildStageMark("title", "", "es"),
      buildStageMark("title", "m1", "fr"),
      buildStageMark("body_html", "", "fr"),
      "title",
    ]);
    dropStageMarksOfLayer(marks, "title", "");
    expect([...marks].sort()).toEqual([buildStageMark("body_html", "", "fr"), buildStageMark("title", "m1", "fr"), "title"].sort());
  });
});

describe("server task -> operation key", () => {
  it("a per-language run is its own key", () => {
    expect(taskOperationKey({ fieldType: "all", targetLocale: "fr" })).toBe("__translateAllForLocale__fr");
    expect(taskOperationKey({ fieldType: "all", targetLocale: null })).toBe("__translateAll__");
    // A legacy "all" row with a locale list (the single-image alt translate
    // now writes `altText_<i>`) cannot be mapped unambiguously: not seeded.
    expect(taskOperationKey({ fieldType: "all", targetLocale: "fr,it" })).toBeNull();
    expect(taskOperationKey({ fieldType: "altText_2", targetLocale: "fr,it" })).toBe("altText_2");
    // Only the editor's own whole-item task type is a run.
    expect(taskOperationKey({ fieldType: "all", targetLocale: null, type: "seoBulkMeta" })).toBeNull();
    expect(taskOperationKey({ fieldType: "title" })).toBe("title");
    expect(taskOperationKey({ fieldType: null })).toBeNull();
  });

  it("a per-field task of another language does not show in this view", () => {
    expect(taskShowsInView({ targetLocale: "fr" }, "title", "de", "en")).toBe(false);
    expect(taskShowsInView({ targetLocale: "de" }, "title", "de", "en")).toBe(true);
    expect(taskShowsInView({ targetLocale: null }, "title", "de", "en")).toBe(true);
    expect(taskShowsInView({ targetLocale: "fr" }, "__translateAllForLocale__fr", "de", "en")).toBe(true);
    expect(taskShowsInView({ targetLocale: null }, "__translateAll__", "de", "en")).toBe(true);
    expect(taskShowsInView({ targetLocale: "fr,de" }, "altText_0", "en", "en")).toBe(true);
    expect(taskShowsInView({ targetLocale: "fr,de" }, "altText_0", "de", "en")).toBe(false);
  });

  it("reconcile keeps a run the client still awaits", () => {
    const id = "gid://shopify/Product/9";
    clearAllForResource(id);
    markOperationActive(id, "__translateAllForLocale__fr", "translateAllForLocale", "fr");
    markOperationActive(id, "title", "translate");
    reconcileWithServer(id, new Set(), (key) => key === "__translateAllForLocale__fr");
    expect(isOperationActive(id, "__translateAllForLocale__fr")).toBe(true);
    expect(isOperationActive(id, "title")).toBe(false);
  });
});

describe("the options & metafields card's save races a run", () => {
  const form = (entries: Record<string, string>) => (key: string) => entries[key] ?? null;
  it("the PRIMARY save (productId, no locale) races a run into any language", () => {
    const primary = form({ action: "savePrimarySubResources", productId: "P1" });
    expect(subResourceSaveRacesRun(primary, "P1", "fr")).toBe(true);
    expect(subResourceSaveRacesRun(primary, "P1", "*")).toBe(true);
    expect(subResourceSaveRacesRun(primary, "P2", "fr")).toBe(false);
  });
  it("a foreign save races a run of its language or every language only", () => {
    const foreign = form({ action: "saveSubResourceTranslations", itemId: "P1", locale: "it" });
    expect(subResourceSaveRacesRun(foreign, "P1", "it")).toBe(true);
    expect(subResourceSaveRacesRun(foreign, "P1", "*")).toBe(true);
    expect(subResourceSaveRacesRun(foreign, "P1", "fr")).toBe(false);
  });
  it("the Phase-2 load is not a save", () => {
    expect(subResourceSaveRacesRun(form({ action: "loadSubResourceTranslations", itemId: "P1" }), "P1", "fr")).toBe(false);
  });
});
