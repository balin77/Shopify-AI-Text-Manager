/**
 * A single-field translate is a PARTIAL save: it writes one field and must
 * mark exactly that one as saved.
 *
 * It used to take every value on screen as the new baseline, so a foreign edit
 * the merchant had typed into ANOTHER field and not saved read as clean, was
 * never sent, and was gone at the next reload or item switch — which reads as
 * "I translated the product type and my other values were deleted".
 */
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUiDataLoader } from "~/hooks/useUiDataLoader";
import type { ContentEditorConfig, FieldDefinition } from "~/types/content-editor.types";

const field = (key: string) => ({ key, translationKey: key, type: "text", labelKey: key }) as unknown as FieldDefinition;
const TITLE = field("title");
const TYPE = field("productType");
const config = { contentType: "product" } as unknown as ContentEditorConfig;

function loader() {
  return renderHook(() => useUiDataLoader({ config, primaryLocale: "de" }));
}

describe("single-field translate — a partial save", () => {
  it("moves the baseline of the translated field ONLY", () => {
    const { result } = loader();
    act(() => {
      result.current.refs.baselineValuesRef.current = { title: "Title", productType: "" };
      result.current.refs.originalLoadedValuesRef.current = { title: "Title", productType: "" };
    });
    // The merchant typed a new title and did not save, then translated the type.
    const view = { title: "Typed, not saved", productType: "" };
    act(() => {
      result.current.onTranslateFieldComplete("productType", "productType", "Vase", "en", view);
    });

    expect(result.current.refs.baselineValuesRef.current).toEqual({ title: "Title", productType: "Vase" });
    expect(result.current.refs.originalLoadedValuesRef.current).toEqual({ title: "Title", productType: "Vase" });
  });

  it("stages nothing on screen when the merchant switched language meanwhile", () => {
    const { result } = loader();
    act(() => {
      result.current.refs.baselineValuesRef.current = { title: "Titre", productType: "" };
    });
    let returned: ReturnType<typeof result.current.onTranslateFieldComplete> | undefined;
    act(() => {
      returned = result.current.onTranslateFieldComplete(
        "productType",
        "productType",
        "Vase",
        "en",
        { title: "Titre", productType: "" },
        undefined,
        false,
      );
    });
    // Nothing for the FR view to apply, and FR's baseline is untouched…
    expect(returned?.updatedValues).toBeNull();
    expect(result.current.refs.baselineValuesRef.current).toEqual({ title: "Titre", productType: "" });
    // …while the translation is still staged for EN.
    expect(result.current.refs.localTranslationsRef.current.productType?.en).toBe("Vase");
  });

  it("overlays only the fields the partial save carried", () => {
    const { result } = loader();
    act(() => {
      result.current.onSaveComplete(
        "en",
        { title: "Typed, not saved", productType: "Vase" },
        [TITLE, TYPE],
        undefined,
        new Set(["productType"]),
      );
    });
    expect(result.current.refs.localTranslationsRef.current.productType?.en).toBe("Vase");
    // Staging the unsaved title as if it had been saved is how it vanished.
    expect(result.current.refs.localTranslationsRef.current.title?.en).toBeUndefined();
  });
});
