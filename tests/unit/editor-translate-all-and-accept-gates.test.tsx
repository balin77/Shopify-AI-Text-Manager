/**
 * Two refusals in useFieldHandlers that must leave NO state behind:
 *  - whole-item "Translate all" on the primary locale while a primary field or
 *    alt text is an unsaved draft (its later Save would purge what the run
 *    wrote into every language) — refused with the save-first message, nothing
 *    submitted;
 *  - accepting an AI suggestion in a read-only (resource-backed theme) primary
 *    language — refused BEFORE the value lands in the field, so no dirty draft
 *    is left that no save could ever write.
 */
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useFieldHandlers } from "~/hooks/useFieldHandlers";

function setup(overrides: Record<string, unknown>) {
  const item = { id: "gid://shopify/Product/1", title: "Titel", images: [] };
  const spies = {
    safeSubmit: vi.fn(),
    showInfoBox: vi.fn(),
    setEditableValues: vi.fn(),
    submitAIAction: vi.fn(),
    // "Translate all" goes out as its own request (useUnifiedContentEditor).
    submitTranslateRun: vi.fn(),
  };
  const known: Record<string, unknown> = {
    config: { contentType: "products" },
    primaryLocale: "de",
    currentLanguage: "de",
    selectedMarketId: "",
    selectedItem: item,
    selectedItemId: item.id,
    enabledLanguages: ["de", "fr"],
    effectiveFieldDefinitions: [{ key: "title", translationKey: "title", type: "text", label: "Title" }],
    shopLocales: [],
    t: {},
    aiSuggestions: {},
    imageAltTexts: {},
    fallbackFields: new Set<string>(),
    currentLanguageRef: { current: "de" },
    editableValuesRef: { current: { title: "Titel" } },
    baselineValuesRef: { current: { title: "Titel" } },
    originalAltTextsRef: { current: {} },
    ...spies,
    ...overrides,
  };
  const props = new Proxy(known, {
    get: (target, key: string) =>
      key in target ? target[key] : key.endsWith("Ref") ? { current: null } : vi.fn(),
  });
  const { result } = renderHook(() => useFieldHandlers(props as any));
  return { result, ...spies };
}

describe("whole-item Translate all (primary)", () => {
  it("is refused while a primary field is an unsaved draft", () => {
    const { result, safeSubmit, submitTranslateRun, showInfoBox } = setup({
      editableValuesRef: { current: { title: "Neuer Titel" } },
    });
    act(() => result.current.handleTranslateAll());
    expect(safeSubmit).not.toHaveBeenCalled();
    expect(submitTranslateRun).not.toHaveBeenCalled();
    expect(showInfoBox).toHaveBeenCalledWith(expect.stringMatching(/save first/i), "warning");
  });

  it("is refused while a primary alt text is an unsaved draft", () => {
    const { result, safeSubmit, submitTranslateRun } = setup({
      imageAltTexts: { 0: "neu" },
      originalAltTextsRef: { current: { 0: "alt" } },
    });
    act(() => result.current.handleTranslateAll());
    expect(safeSubmit).not.toHaveBeenCalled();
    expect(submitTranslateRun).not.toHaveBeenCalled();
  });

  it("runs when the primary has no draft", () => {
    const { result, safeSubmit, submitTranslateRun } = setup({});
    act(() => result.current.handleTranslateAll());
    expect(submitTranslateRun).toHaveBeenCalledTimes(1);
    expect(safeSubmit).not.toHaveBeenCalled();
  });
});

describe("accepting a suggestion in a read-only primary language", () => {
  it("leaves the field untouched", () => {
    const { result, setEditableValues, showInfoBox } = setup({
      config: { contentType: "system" },
      aiSuggestions: { title: "KI-Titel" },
    });
    act(() => result.current.handleAcceptSuggestion("title"));
    expect(setEditableValues).not.toHaveBeenCalled();
    expect(showInfoBox).toHaveBeenCalledWith(expect.any(String), "warning");
  });
});
