/**
 * Discard returns the editor to its change-detection BASELINE.
 *
 * Regression: in a market view (or wherever the resolve chain used a fallback)
 * Discard re-derived the values from the item's GLOBAL translations, which
 * differ from the baseline the editor compares against -- the editor read as
 * dirty right after "discarding" and the save bar never closed. Reported as:
 * alt draft in the image manager, market switch, "Verwerfen" in the leave
 * dialog -> bar stays up.
 */
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useFieldHandlers } from "~/hooks/useFieldHandlers";

function setup(
  baseline: Record<string, string>,
  originalAlts: Record<number, string> = {},
  loadedFallback: { fields: Set<string>; values: Record<string, string> } | null = null,
) {
  const item = {
    id: "gid://shopify/Product/1",
    title: "Titel",
    handle: "titel",
    translations: [{ key: "title", locale: "fr", value: "Titre global" }],
    marketTranslations: { "gid://shopify/Market/2": { title: { fr: "Titre CH" } } },
  };
  const setEditableValues = vi.fn();
  const setImageAltTexts = vi.fn();
  const setFallbackFields = vi.fn();
  const known: Record<string, unknown> = {
    config: { contentType: "products" },
    primaryLocale: "de",
    currentLanguage: "fr",
    selectedMarketId: "gid://shopify/Market/2",
    selectedItem: item,
    selectedItemId: item.id,
    effectiveFieldDefinitions: [
      { key: "title", translationKey: "title", type: "text", label: "Title" },
      { key: "handle", translationKey: "handle", type: "text", label: "Handle" },
    ],
    shopLocales: [],
    t: {},
    baselineValuesRef: { current: baseline },
    originalAltTextsRef: { current: originalAlts },
    setEditableValues,
    setImageAltTexts,
    setFallbackFields,
    loadedFallbackRef: { current: loadedFallback },
    fallbackFieldsRef: { current: new Set<string>() },
  };
  // Every other prop is irrelevant to Discard: a ref-shaped stub or a no-op.
  const props = new Proxy(known, {
    get: (target, key: string) =>
      key in target ? target[key] : key.endsWith("Ref") ? { current: null } : vi.fn(),
  });
  const { result } = renderHook(() => useFieldHandlers(props as any));
  return { result, setEditableValues, setImageAltTexts, setFallbackFields };
}

describe("editor Discard", () => {
  it("restores the market view's baseline, not the item's global translations", () => {
    const baseline = { title: "Titre CH", handle: "titel" };
    const { result, setEditableValues } = setup(baseline);
    act(() => result.current.handleDiscard());
    expect(setEditableValues).toHaveBeenCalledTimes(1);
    expect(setEditableValues.mock.calls[0][0]).toEqual(baseline);
  });

  it("restores the alt texts to their baseline too", () => {
    const { result, setImageAltTexts } = setup({ title: "Titre CH" }, { 0: "alt fr" });
    act(() => result.current.handleDiscard());
    expect(setImageAltTexts).toHaveBeenCalledWith({ 0: "alt fr" });
  });

  it("falls back to the item when nothing has been loaded yet", () => {
    const { result, setEditableValues } = setup({});
    act(() => result.current.handleDiscard());
    expect(setEditableValues).toHaveBeenCalledTimes(1);
    expect(setEditableValues.mock.calls[0][0].title).toBe("Titre global");
  });

  it("a field typed over an inherited value is inherited again after Discard", () => {
    const baseline = { title: "Titre global", handle: "titel" };
    const { result, setFallbackFields } = setup(baseline, {}, {
      fields: new Set(["title"]),
      values: { title: "Titre global", handle: "titel" },
    });
    act(() => result.current.handleDiscard());
    expect(setFallbackFields).toHaveBeenCalledWith(new Set(["title"]));
  });

  it("a field saved since the load (baseline moved) is not flagged as inherited", () => {
    const baseline = { title: "Titre CH neu", handle: "titel" };
    const { result, setFallbackFields } = setup(baseline, {}, {
      fields: new Set(["title"]),
      values: { title: "Titre global", handle: "titel" },
    });
    act(() => result.current.handleDiscard());
    expect(setFallbackFields).toHaveBeenCalledWith(new Set());
  });
});
