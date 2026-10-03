/**
 * "Translate all" (main fields, every language) writes the GLOBAL layer. Its
 * answer used to be written over whatever the open view showed:
 *   - with a MARKET open, the global wording landed in the market's fields and
 *     baseline, i.e. it read as a market override nobody typed;
 *   - in the global view, a field the merchant had typed into and not saved
 *     was overwritten and the WHOLE baseline replaced, so other unsaved edits
 *     read as clean;
 *   - every deleted-key mark was cleared, including a market's and other
 *     fields' pending clears.
 */
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUiDataLoader, buildDeletedKey } from "~/hooks/useUiDataLoader";
import type { ContentEditorConfig, FieldDefinition } from "~/types/content-editor.types";

const field = (key: string, translationKey = key) =>
  ({ key, translationKey, type: "text", labelKey: key }) as unknown as FieldDefinition;
const TITLE = field("title");
const BODY = field("body", "body_html");
const SEO = field("seoTitle", "meta_title");
const config = { contentType: "product" } as unknown as ContentEditorConfig;
const MARKET = "gid://shopify/Market/5";

function loader() {
  return renderHook(() => useUiDataLoader({ config, primaryLocale: "de" }));
}

const ANSWER = {
  en: { title: "Vase", body: "A vase" },
  fr: { title: "Vase FR", body: "Un vase" },
};

describe("onTranslateAllComplete", () => {
  it("touches nothing on screen while a market is open, but stages the global answer", () => {
    const { result } = loader();
    act(() => {
      result.current.refs.baselineValuesRef.current = { title: "Swiss", body: "" };
    });
    let r: ReturnType<typeof result.current.onTranslateAllComplete> | undefined;
    act(() => {
      r = result.current.onTranslateAllComplete(ANSWER, [TITLE, BODY], "en", { title: "Swiss", body: "" }, MARKET);
    });
    expect(r?.updatedValues).toBeNull();
    expect(r?.clearedFallbackKeys).toEqual([]);
    expect(r?.shouldMarkLoading).toBe(true);
    expect(result.current.refs.baselineValuesRef.current).toEqual({ title: "Swiss", body: "" });
    // Staged under the GLOBAL locale key, for the next load to resolve.
    expect(result.current.refs.localTranslationsRef.current.title?.en).toBe("Vase");
  });

  it("in the global view skips dirty fields and merges the baseline per applied field", () => {
    const { result } = loader();
    act(() => {
      result.current.refs.baselineValuesRef.current = { title: "Old", body: "", seoTitle: "SEO old" };
      result.current.refs.originalLoadedValuesRef.current = { title: "Old", body: "", seoTitle: "SEO old" };
    });
    // Title typed and unsaved; seoTitle typed and unsaved (not in the answer).
    const view = { title: "Typed", body: "", seoTitle: "SEO typed" };
    let r: ReturnType<typeof result.current.onTranslateAllComplete> | undefined;
    act(() => {
      r = result.current.onTranslateAllComplete(ANSWER, [TITLE, BODY, SEO], "en", view, "");
    });
    expect(r?.updatedValues).toEqual({ title: "Typed", body: "A vase", seoTitle: "SEO typed" });
    expect(r?.clearedFallbackKeys).toEqual(["body"]);
    // Only body's baseline moved: the typed fields still read as changed.
    expect(result.current.refs.baselineValuesRef.current).toEqual({ title: "Old", body: "A vase", seoTitle: "SEO old" });
    expect(result.current.refs.originalLoadedValuesRef.current).toEqual({ title: "Old", body: "A vase", seoTitle: "SEO old" });
  });

  it("clears only the global deleted marks of the answered fields", () => {
    const { result } = loader();
    const deleted = result.current.refs.deletedTranslationKeysRef.current;
    act(() => {
      deleted.add("body_html");
      deleted.add("meta_title");
      deleted.add(buildDeletedKey("body_html", MARKET));
    });
    act(() => {
      result.current.onTranslateAllComplete(ANSWER, [TITLE, BODY, SEO], "fr", { title: "", body: "", seoTitle: "" }, "");
    });
    expect(deleted.has("body_html")).toBe(false);
    expect(deleted.has("meta_title")).toBe(true);
    expect(deleted.has(buildDeletedKey("body_html", MARKET))).toBe(true);
  });
});
