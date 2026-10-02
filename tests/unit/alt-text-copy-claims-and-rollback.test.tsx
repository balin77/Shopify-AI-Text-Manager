/**
 * A single alt-text copy must claim its item (or the save-response effects
 * skip it and the spinner never clears) and must be undoable when it fails.
 */
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useEditorAltText } from "~/hooks/useEditorAltText";

function setup() {
  const item = { id: "gid://shopify/Product/1", title: "T", images: [{ url: "u", altText: "Quelle" }] };
  const ref = <T,>(current: T) => ({ current });
  const safeSubmit = vi.fn();
  const refs = {
    savedItemIdRef: ref<string | null>(null),
    savedLocaleRef: ref<string | null>(null),
    savedMarketIdRef: ref(""),
    isSavePendingRef: ref(false),
    isSaveFromTranslateRef: ref(false),
    partialSaveRef: ref<any>(null),
    pendingAltTranslateToastRef: ref<string | null>(null),
  };
  const props: any = {
    selectedItem: item,
    selectedItemId: item.id,
    selectedItemRef: ref(item),
    selectedItemIdRef: ref<string | null>(item.id),
    currentLanguage: "fr",
    selectedMarketId: "",
    primaryLocale: "de",
    shopLocales: [],
    config: { contentType: "products" },
    enabledLanguages: ["de", "fr"],
    editableValues: {},
    editableValuesRef: ref({}),
    buildFieldsForSave: () => ({}),
    safeSubmit,
    ...refs,
    revalidatorRef: ref({ state: "idle", revalidate: () => {} }),
    submitAIAction: vi.fn(),
    showInfoBox: vi.fn(),
    t: { content: {}, common: {} },
    suggestionScope: { resourceId: item.id, locale: "fr", marketId: "" },
  };
  const hook = renderHook(() => useEditorAltText(props));
  return { hook, refs, safeSubmit, props };
}

describe("single alt-text copy", () => {
  it("claims the item it saves", () => {
    const { hook, refs, safeSubmit } = setup();
    act(() => hook.result.current.handleCopyAltText(0));
    expect(safeSubmit).toHaveBeenCalledTimes(1);
    expect(refs.savedItemIdRef.current).toBe("gid://shopify/Product/1");
    expect(refs.isSavePendingRef.current).toBe(true);
  });

  it("saves ONLY the copied alt: no text field, no other image's draft", () => {
    const { hook, refs, safeSubmit, props } = setup();
    props.buildFieldsForSave = () => ({ title: "unsaved title draft" });
    act(() => hook.result.current.setImageAltTexts({ 3: "typed draft of image 4" }));
    act(() => hook.result.current.handleCopyAltText(0));
    const form = safeSubmit.mock.calls[0][0];
    expect(form.title).toBeUndefined();
    expect(JSON.parse(form.imageAltTexts)).toEqual({ 0: "Quelle" });
    expect(form.changedFields).toBeUndefined();
    // A partial save that stands for this one alt index only.
    expect(refs.partialSaveRef.current).toMatchObject({ values: {}, altIndices: [0] });
    // The other image's draft keeps its (absent) baseline: still dirty.
    expect(hook.result.current.originalAltTexts[3]).toBeUndefined();
  });

  it("rollback removes the optimistic overlay entry", () => {
    const { hook } = setup();
    act(() => hook.result.current.handleCopyAltText(0));
    expect(hook.result.current.localAltTextOverlayRef.current["fr"]?.[0]).toBe("Quelle");
    act(() => hook.result.current.rollbackCopyAltText());
    expect(hook.result.current.localAltTextOverlayRef.current["fr"]?.[0]).toBeUndefined();
  });

  it("rollback leaves a value written since alone", () => {
    const { hook } = setup();
    act(() => hook.result.current.handleCopyAltText(0));
    hook.result.current.localAltTextOverlayRef.current["fr"][0] = "Neu getippt";
    act(() => hook.result.current.rollbackCopyAltText());
    expect(hook.result.current.localAltTextOverlayRef.current["fr"][0]).toBe("Neu getippt");
  });

  it("failed copy restores field AND baseline to the previous values", () => {
    const { hook } = setup();
    act(() => hook.result.current.setImageAltTexts({ 0: "alt vorher" }));
    act(() => hook.result.current.setOriginalAltTexts({ 0: "alt vorher" }));
    act(() => hook.result.current.handleCopyAltText(0));
    expect(hook.result.current.imageAltTexts[0]).toBe("Quelle");
    // snapshot used by the later baseline write already carries the rollback
    expect(hook.result.current.altBaselineSnapshot([0])[0]).toBe("alt vorher");
    act(() => hook.result.current.rollbackCopyAltText());
    expect(hook.result.current.imageAltTexts[0]).toBe("alt vorher");
    expect(hook.result.current.originalAltTexts[0]).toBe("alt vorher");
  });

  it("exposes the copy's own item id independent of savedItemIdRef", () => {
    const { hook, refs } = setup();
    act(() => hook.result.current.handleCopyAltText(0));
    refs.savedItemIdRef.current = null;
    expect(hook.result.current.getPendingCopyAltItemId()).toBe("gid://shopify/Product/1");
  });

  it("rollback leaves the visible field alone after an item switch", () => {
    const { hook, props } = setup();
    act(() => hook.result.current.handleCopyAltText(0));
    props.selectedItemIdRef.current = "gid://shopify/Product/2";
    act(() => hook.result.current.rollbackCopyAltText());
    expect(hook.result.current.imageAltTexts[0]).toBe("Quelle");
    expect(hook.result.current.localAltTextOverlayRef.current["fr"]?.[0]).toBeUndefined();
  });

  it("rollback leaves the visible field alone after a locale switch", () => {
    const { hook, props } = setup();
    act(() => hook.result.current.handleCopyAltText(0));
    props.currentLanguage = "es";
    hook.rerender();
    // the locale switch itself resets the field; put the same text back by hand
    act(() => hook.result.current.setImageAltTexts({ 0: "Quelle" }));
    act(() => hook.result.current.rollbackCopyAltText());
    expect(hook.result.current.imageAltTexts[0]).toBe("Quelle");
    expect(hook.result.current.localAltTextOverlayRef.current["fr"]?.[0]).toBeUndefined();
  });
});
