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
  return { hook, refs, safeSubmit };
}

describe("single alt-text copy", () => {
  it("claims the item it saves", () => {
    const { hook, refs, safeSubmit } = setup();
    act(() => hook.result.current.handleCopyAltText(0));
    expect(safeSubmit).toHaveBeenCalledTimes(1);
    expect(refs.savedItemIdRef.current).toBe("gid://shopify/Product/1");
    expect(refs.isSavePendingRef.current).toBe(true);
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
});
