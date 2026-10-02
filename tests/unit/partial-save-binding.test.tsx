/**
 * A partial save's description travels WITH its request.
 *
 * It lived in one shared slot, so a queued single-field translate had its
 * description consumed by the response of the save in flight before it: that
 * FULL save was then handled as partial (its fields stayed dirty), and the
 * partial one as full (it absorbed unsaved input).
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEditorAutoSave } from "~/hooks/useEditorAutoSave";

const ref = <T,>(current: T) => ({ current });

function setup(fetcherState: "idle" | "submitting") {
  const fetcher = { state: fetcherState, submit: vi.fn() };
  const refs = {
    saveQueueRef: ref<any[]>([]),
    partialSaveRef: ref<any>(null),
    inFlightPartialRef: ref<any>(null),
    pendingAltTranslateToastRef: ref<any>(null),
    inFlightToastRef: ref<any>(null),
    preserveEditsUntilRef: ref(0),
  };
  const { result } = renderHook(() =>
    useEditorAutoSave({
      selectedItemId: "p1",
      selectedItemIdRef: ref("p1"),
      currentLanguage: "en",
      primaryLocale: "de",
      config: { contentType: "products" } as never,
      fetcher,
      editableValuesRef: ref({}),
      imageAltTextsRef: ref({}),
      originalAltTextsRef: ref({}),
      effectiveFieldDefinitions: [],
      selectedItem: null,
      shopLocales: [],
      savedLocaleRef: ref("en"),
      savedMarketIdRef: ref(""),
      savedItemIdRef: ref("p1"),
      isSavePendingRef: ref(false),
      isSaveFromTranslateRef: ref(false),
      fallbackFieldsRef: ref(new Set<string>()),
      originalLoadedValuesRef: ref({}),
      originalTemplateValuesRef: ref({}),
      deletedTranslationKeysRef: ref(new Set<string>()),
      isAcceptAndTranslateFlowRef: ref(false),
      savedPrimaryValuesRef: ref({}),
      justSubmittedRef: ref(false),
      fetcherRef: ref(fetcher),
      ...refs,
    } as never),
  );
  return { result, refs, fetcher };
}

const partial = { locale: "en", marketId: "", values: { productType: "Vase" } };

describe("safeSubmit binds a partial save to its own request", () => {
  it("in flight: moves the staged description into the in-flight slot", () => {
    const { result, refs, fetcher } = setup("idle");
    refs.partialSaveRef.current = partial;
    result.current.safeSubmit({ action: "updateContent" });
    expect(fetcher.submit).toHaveBeenCalled();
    expect(refs.inFlightPartialRef.current).toBe(partial);
    expect(refs.partialSaveRef.current).toBeNull();
    expect(refs.preserveEditsUntilRef.current).toBeGreaterThan(Date.now());
  });

  it("queued: the description rides on the queue entry, the in-flight slot is untouched", () => {
    const { result, refs, fetcher } = setup("submitting");
    const inFlight = { locale: "fr", marketId: "", values: {} };
    refs.inFlightPartialRef.current = inFlight;
    refs.partialSaveRef.current = partial;
    result.current.safeSubmit({ action: "updateContent" });
    expect(fetcher.submit).not.toHaveBeenCalled();
    expect(refs.saveQueueRef.current[0].partial).toBe(partial);
    expect(refs.inFlightPartialRef.current).toBe(inFlight);
  });

  it("the success toast travels with its own request, not a shared slot", () => {
    const { result, refs } = setup("submitting");
    refs.inFlightToastRef.current = null;
    refs.pendingAltTranslateToastRef.current = "translated";
    result.current.safeSubmit({ action: "updateContent" });
    expect(refs.saveQueueRef.current[0].successToast).toBe("translated");
    expect(refs.pendingAltTranslateToastRef.current).toBeNull();
    expect(refs.inFlightToastRef.current).toBeNull();
  });

  it("a FULL save clears the in-flight slot and opens no preserve window", () => {
    const { result, refs } = setup("idle");
    refs.inFlightPartialRef.current = partial;
    result.current.safeSubmit({ action: "updateContent" });
    expect(refs.inFlightPartialRef.current).toBeNull();
    expect(refs.preserveEditsUntilRef.current).toBe(0);
  });
});

describe("safeSubmit — a submit that THROWS settles what it staged", () => {
  function setupThrowing(error: Error) {
    const fetcher = { state: "idle", submit: vi.fn(() => { throw error; }) };
    let ownSaves: any[] = [];
    const setOwnSavesInFlight = vi.fn((update: any) => {
      ownSaves = typeof update === "function" ? update(ownSaves) : update;
    });
    const refs = {
      saveQueueRef: ref<any[]>([]),
      partialSaveRef: ref<any>(null),
      inFlightPartialRef: ref<any>(null),
      pendingAltTranslateToastRef: ref<any>(null),
      inFlightToastRef: ref<any>(null),
      preserveEditsUntilRef: ref(0),
      inFlightScopeRef: ref<any>(null),
    };
    const { result } = renderHook(() =>
      useEditorAutoSave({
        selectedItemId: "p1",
        currentLanguage: "en",
        primaryLocale: "de",
        config: { contentType: "products" } as never,
        editableValuesRef: ref({}),
        imageAltTextsRef: ref({}),
        originalAltTextsRef: ref({}),
        effectiveFieldDefinitions: [],
        selectedItem: null,
        savedLocaleRef: ref("en"),
        savedMarketIdRef: ref(""),
        savedItemIdRef: ref("p1"),
        isSavePendingRef: ref(false),
        isSaveFromTranslateRef: ref(false),
        fallbackFieldsRef: ref(new Set<string>()),
        originalLoadedValuesRef: ref({}),
        originalTemplateValuesRef: ref({}),
        deletedTranslationKeysRef: ref(new Set<string>()),
        isAcceptAndTranslateFlowRef: ref(false),
        savedPrimaryValuesRef: ref({}),
        justSubmittedRef: ref(false),
        fetcherRef: ref(fetcher),
        setOwnSavesInFlight,
        ...refs,
      } as never),
    );
    return { result, refs, ownSaves: () => ownSaves };
  }

  it("a non-Abort throw drops the own-save entry and the in-flight slots, so a switch is not refused for good", () => {
    const { result, refs, ownSaves } = setupThrowing(new Error("boom"));
    refs.partialSaveRef.current = { locale: "en", marketId: "", values: { productType: "Vase" } };
    refs.pendingAltTranslateToastRef.current = "translated";
    expect(() => result.current.safeSubmit({ action: "updateContent" })).toThrow("boom");
    expect(ownSaves()).toEqual([]);
    expect(refs.inFlightPartialRef.current).toBeNull();
    expect(refs.inFlightToastRef.current).toBeNull();
    expect(refs.inFlightScopeRef.current).toBeNull();
  });

  it("an AbortError keeps the entry (the request may have gone out)", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const { result, refs, ownSaves } = setupThrowing(abort);
    const staged = { locale: "en", marketId: "", values: { productType: "Vase" } };
    refs.partialSaveRef.current = staged;
    result.current.safeSubmit({ action: "updateContent" });
    expect(ownSaves()).toHaveLength(1);
    expect(refs.inFlightPartialRef.current).toBe(staged);
  });
});
