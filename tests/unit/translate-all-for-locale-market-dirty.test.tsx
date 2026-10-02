/**
 * "Translate all for this language" writes the GLOBAL layer of ONE locale.
 * Its late answer used to be written over whatever the open view showed:
 *   - with a MARKET open in that locale, the global wording landed in the
 *     market's fields and baseline (a market override nobody typed);
 *   - in the global view, a field the merchant had typed into and not saved was
 *     overwritten and the WHOLE baseline replaced, so other unsaved edits read
 *     as clean (and on a theme page the template baseline too);
 *   - every deleted-key mark was cleared, including a market's and other
 *     fields' pending clears.
 * And on the theme page, the cached rows were matched by key alone, so the
 * global answer overwrote a MARKET override row of the same key.
 */
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUiDataLoader, buildDeletedKey } from "~/hooks/useUiDataLoader";
import { upsertGlobalThemeRow } from "~/components/ThemeContentDomainPage";
import type { ContentEditorConfig, FieldDefinition } from "~/types/content-editor.types";
import type { ThemeTranslationRecord } from "~/types/theme-content-domain";

const field = (key: string, translationKey = key) =>
  ({ key, translationKey, type: "text", labelKey: key }) as unknown as FieldDefinition;
const TITLE = field("title");
const BODY = field("body", "body_html");
const SEO = field("seoTitle", "meta_title");
const MARKET = "gid://shopify/Market/5";

function loader(contentType = "product") {
  const config = { contentType } as unknown as ContentEditorConfig;
  return renderHook(() => useUiDataLoader({ config, primaryLocale: "de" }));
}

const ANSWER = { title: "Vase", body: "A vase" };

describe("onTranslateAllForLocaleComplete", () => {
  it("touches nothing on screen while a market is open in that locale, but stages the global answer", () => {
    const { result } = loader();
    act(() => {
      result.current.refs.baselineValuesRef.current = { title: "Swiss", body: "" };
      result.current.refs.originalLoadedValuesRef.current = { title: "Swiss", body: "" };
    });
    let r: ReturnType<typeof result.current.onTranslateAllForLocaleComplete> | undefined;
    act(() => {
      r = result.current.onTranslateAllForLocaleComplete(ANSWER, [TITLE, BODY], "en", "en", { title: "Swiss", body: "" }, MARKET);
    });
    expect(r?.updatedValues).toBeNull();
    expect(r?.clearedFallbackKeys).toEqual([]);
    expect(result.current.refs.baselineValuesRef.current).toEqual({ title: "Swiss", body: "" });
    expect(result.current.refs.originalLoadedValuesRef.current).toEqual({ title: "Swiss", body: "" });
    // Staged under the GLOBAL locale key, never the market's.
    expect(result.current.refs.localTranslationsRef.current.title?.en).toBe("Vase");
    expect(result.current.refs.localTranslationsRef.current.title?.[`en@@${MARKET}`]).toBeUndefined();
  });

  it("defaults to the live market selection when none is passed", () => {
    const { result } = loader();
    act(() => {
      result.current.refs.selectedMarketIdRef.current = MARKET;
      result.current.refs.baselineValuesRef.current = { title: "Swiss", body: "" };
    });
    let r: ReturnType<typeof result.current.onTranslateAllForLocaleComplete> | undefined;
    act(() => {
      r = result.current.onTranslateAllForLocaleComplete(ANSWER, [TITLE, BODY], "en", "en", { title: "Swiss", body: "" });
    });
    expect(r?.updatedValues).toBeNull();
  });

  it("leaves screen and baseline alone when the merchant moved to another locale", () => {
    const { result } = loader();
    act(() => {
      result.current.refs.baselineValuesRef.current = { title: "Titre", body: "" };
    });
    let r: ReturnType<typeof result.current.onTranslateAllForLocaleComplete> | undefined;
    act(() => {
      r = result.current.onTranslateAllForLocaleComplete(ANSWER, [TITLE, BODY], "en", "fr", { title: "Titre", body: "" }, "");
    });
    expect(r?.updatedValues).toBeNull();
    expect(result.current.refs.baselineValuesRef.current).toEqual({ title: "Titre", body: "" });
    expect(result.current.refs.localTranslationsRef.current.title?.en).toBe("Vase");
  });

  it("in the global view skips dirty fields and merges the baseline per applied field", () => {
    const { result } = loader();
    act(() => {
      result.current.refs.baselineValuesRef.current = { title: "Old", body: "", seoTitle: "SEO old" };
      result.current.refs.originalLoadedValuesRef.current = { title: "Old", body: "", seoTitle: "SEO old" };
    });
    const view = { title: "Typed", body: "", seoTitle: "SEO typed" };
    let r: ReturnType<typeof result.current.onTranslateAllForLocaleComplete> | undefined;
    act(() => {
      r = result.current.onTranslateAllForLocaleComplete(ANSWER, [TITLE, BODY, SEO], "en", "en", view, "");
    });
    expect(r?.updatedValues).toEqual({ title: "Typed", body: "A vase", seoTitle: "SEO typed" });
    expect(r?.clearedFallbackKeys).toEqual(["body"]);
    expect(result.current.refs.baselineValuesRef.current).toEqual({ title: "Old", body: "A vase", seoTitle: "SEO old" });
    expect(result.current.refs.originalLoadedValuesRef.current).toEqual({ title: "Old", body: "A vase", seoTitle: "SEO old" });
  });

  it("merges the template baseline per applied field on a theme page", () => {
    const { result } = loader("templates");
    act(() => {
      result.current.refs.baselineValuesRef.current = { title: "Old", body: "" };
      result.current.refs.originalTemplateValuesRef.current = { title: "Old", body: "", other: "kept" };
    });
    act(() => {
      result.current.onTranslateAllForLocaleComplete(ANSWER, [TITLE, BODY], "en", "en", { title: "Typed", body: "" }, "");
    });
    expect(result.current.refs.originalTemplateValuesRef.current).toEqual({ title: "Old", body: "A vase", other: "kept" });
  });

  it("an empty answer changes nothing", () => {
    const { result } = loader();
    const deleted = result.current.refs.deletedTranslationKeysRef.current;
    act(() => {
      result.current.refs.baselineValuesRef.current = { title: "Old", body: "" };
      deleted.add("body_html");
    });
    let r: ReturnType<typeof result.current.onTranslateAllForLocaleComplete> | undefined;
    act(() => {
      r = result.current.onTranslateAllForLocaleComplete({}, [TITLE, BODY], "en", "en", { title: "Old", body: "" }, "");
    });
    expect(r?.updatedValues).toBeNull();
    expect(deleted.has("body_html")).toBe(true);
    expect(result.current.refs.baselineValuesRef.current).toEqual({ title: "Old", body: "" });
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
      result.current.onTranslateAllForLocaleComplete(ANSWER, [TITLE, BODY, SEO], "en", "en", { title: "", body: "", seoTitle: "" }, "");
    });
    expect(deleted.has("body_html")).toBe(false);
    expect(deleted.has("meta_title")).toBe(true);
    expect(deleted.has(buildDeletedKey("body_html", MARKET))).toBe(true);
  });
});

describe("upsertGlobalThemeRow", () => {
  it("updates the global row and never a market override of the same key", () => {
    const rows: ThemeTranslationRecord[] = [
      { key: "hero.title", value: "Swiss wording", locale: "de", marketId: MARKET },
      { key: "hero.title", value: "Old", locale: "de", marketId: "" },
    ];
    upsertGlobalThemeRow(rows, "hero.title", "New", "de");
    expect(rows).toEqual([
      { key: "hero.title", value: "Swiss wording", locale: "de", marketId: MARKET },
      { key: "hero.title", value: "New", locale: "de", marketId: "" },
    ]);
  });

  it("adds a global row when only a market override exists", () => {
    const rows: ThemeTranslationRecord[] = [
      { key: "hero.title", value: "Swiss wording", locale: "de", marketId: MARKET },
    ];
    upsertGlobalThemeRow(rows, "hero.title", "New", "de");
    expect(rows[0].value).toBe("Swiss wording");
    expect(rows[1]).toEqual({ key: "hero.title", value: "New", locale: "de", marketId: "" });
  });

  it("treats a row without marketId as global", () => {
    const rows: ThemeTranslationRecord[] = [{ key: "k", value: "Old", locale: "de" }];
    upsertGlobalThemeRow(rows, "k", "New", "de");
    expect(rows).toEqual([{ key: "k", value: "New", locale: "de" }]);
  });
});
