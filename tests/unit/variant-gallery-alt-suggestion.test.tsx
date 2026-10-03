/**
 * A variant gallery shows ✨ generate's result as the editor's suggestion
 * banner under the tile's alt field: Accept / Accept & Translate / Decline.
 * Showing it writes nothing; each button calls its handler once with the tile.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { I18nProvider } from "~/contexts/I18nContext";

vi.mock("~/components/image-manager/SortableImageGrid", () => ({ SortableImageGrid: () => null }));
vi.mock("~/components/localized-images/LocalizedMediaReplaceButton", () => ({
  LocalizedMediaReplaceButtons: () => null,
  LocalizedMediaNotReplaceable: () => null,
}));

import { VariantGallerySection } from "~/components/image-manager/VariantGallerySection";

afterEach(cleanup);

const GID = "gid://shopify/MediaImage/1";
const URL1 = "https://cdn.shopify.com/a.jpg?v=1";

function renderSection(extra: Record<string, unknown> = {}) {
  const variant = {
    id: "gid://shopify/ProductVariant/9",
    title: "Red",
    sku: null,
    galleryFileGids: [GID],
    galleryOrderJson: null,
    externalVideoUrls: [],
    threeDModelUrls: [],
  } as any;
  return render(
    <AppProvider i18n={en}>
      <I18nProvider locale="en">
        <DndContext>
          <VariantGallerySection
            variant={variant}
            fileUrlMap={{ [GID]: URL1 }}
            activeAction={null}
            selectedUrls={new Set([URL1])}
            onSelect={() => {}}
            onReorder={() => {}}
            onDrop={() => {}}
            onRemoveFromGallery={() => {}}
            onGenerateAltFromSku={() => {}}
            onUploadToGallery={() => {}}
            forceOpen
            productMediaIds={new Set([GID])}
            onAltTextChange={() => {}}
            onGenerateAltText={() => {}}
            onTranslateAltToAllLocales={() => {}}
            enabledLanguages={["en", "de"]}
            primaryLocale="en"
            currentLanguage="en"
            {...extra}
          />
        </DndContext>
      </I18nProvider>
    </AppProvider>,
  );
}

const isDisabled = (el: HTMLElement) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

describe("VariantGallerySection — alt suggestion", () => {
  it("shows no banner without a suggestion", () => {
    renderSection({ altSuggestionFor: () => undefined, onAcceptAltSuggestion: vi.fn(), onRejectAltSuggestion: vi.fn() });
    expect(screen.queryByText("AI suggestion:")).toBeNull();
  });

  it("shows the suggestion and saves nothing by itself", () => {
    const accept = vi.fn();
    const reject = vi.fn();
    renderSection({ altSuggestionFor: () => "A red vase", onAcceptAltSuggestion: accept, onRejectAltSuggestion: reject });
    expect(screen.getByText("AI suggestion:")).toBeTruthy();
    expect(screen.getByText("A red vase")).toBeTruthy();
    expect(accept).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("Accept, Accept & Translate and Decline each call their handler once with the tile", () => {
    const accept = vi.fn();
    const reject = vi.fn();
    renderSection({ altSuggestionFor: () => "A red vase", onAcceptAltSuggestion: accept, onRejectAltSuggestion: reject });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(accept).toHaveBeenLastCalledWith(URL1, false);
    fireEvent.click(screen.getByRole("button", { name: "Accept & Translate" }));
    expect(accept).toHaveBeenLastCalledWith(URL1, true);
    expect(accept).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledWith(URL1);
  });

  it("Accept & Translate is not offered in a foreign language; Accept is", () => {
    renderSection({
      altSuggestionFor: () => "Ein roter Vase",
      onAcceptAltSuggestion: vi.fn(),
      onRejectAltSuggestion: vi.fn(),
      currentLanguage: "de",
      // A foreign box is only open for an image that has a primary alt.
      imageMetas: { [URL1]: { altText: "A red vase" } },
      localAltTexts: { [URL1]: "" },
    });
    expect(screen.queryByRole("button", { name: "Accept & Translate" })).toBeNull();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
  });

  it("Accept & Translate is greyed out in a single-language shop", () => {
    renderSection({
      altSuggestionFor: () => "A red vase",
      onAcceptAltSuggestion: vi.fn(),
      onRejectAltSuggestion: vi.fn(),
      enabledLanguages: ["en"],
    });
    expect(isDisabled(screen.getByRole("button", { name: "Accept & Translate" }))).toBe(true);
    expect(isDisabled(screen.getByRole("button", { name: "Accept" }))).toBe(false);
  });

  it("the buttons are greyed out while an AI request is running", () => {
    renderSection({
      altSuggestionFor: () => "A red vase",
      onAcceptAltSuggestion: vi.fn(),
      onRejectAltSuggestion: vi.fn(),
      isAltTextLoading: true,
    });
    expect(isDisabled(screen.getByRole("button", { name: "Accept" }))).toBe(true);
    expect(isDisabled(screen.getByRole("button", { name: "Accept & Translate" }))).toBe(true);
  });
});
