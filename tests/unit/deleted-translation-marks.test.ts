import { describe, it, expect } from "vitest";
import {
  buildLocaleDeletedKey,
  dropLocaleMarks,
  dropMarksAfterSave,
  isMarkedDeleted,
} from "~/services/editor/deleted-translation-marks.shared";
import { taskOperationKey, markOperationActive, isOperationActive, reconcileWithServer, clearAllForResource } from "~/hooks/useAIOperationsStore";

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

describe("server task -> operation key", () => {
  it("a per-language run is its own key", () => {
    expect(taskOperationKey({ fieldType: "all", targetLocale: "fr" })).toBe("__translateAllForLocale__fr");
    expect(taskOperationKey({ fieldType: "all", targetLocale: null })).toBe("__translateAll__");
    expect(taskOperationKey({ fieldType: "all", targetLocale: "fr,it" })).toBe("allAltTextsTranslate");
    expect(taskOperationKey({ fieldType: "title" })).toBe("title");
    expect(taskOperationKey({ fieldType: null })).toBeNull();
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
