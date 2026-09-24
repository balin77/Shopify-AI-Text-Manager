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

  it("a FULL save clears the in-flight slot and opens no preserve window", () => {
    const { result, refs } = setup("idle");
    refs.inFlightPartialRef.current = partial;
    result.current.safeSubmit({ action: "updateContent" });
    expect(refs.inFlightPartialRef.current).toBeNull();
    expect(refs.preserveEditsUntilRef.current).toBe(0);
  });
});
