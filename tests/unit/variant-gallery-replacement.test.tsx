/**
 * The variant galleries are coupled to "all images" for per-language
 * replacements: a tile of a PRODUCT medium shows the replacement and, selected
 * alone, gets the same replace button (same media GID); a tile that is not a
 * product medium gets the disabled "not replaceable" button instead.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { I18nProvider } from "~/contexts/I18nContext";

const gridProps: any[] = [];
vi.mock("~/components/image-manager/SortableImageGrid", () => ({
  SortableImageGrid: (p: any) => {
    gridProps.push(p);
    return null;
  },
}));
vi.mock("~/components/localized-images/LocalizedMediaReplaceButton", () => ({
  LocalizedMediaReplaceButtons: ({ mediaId }: { mediaId: string }) => <span data-testid="replace">{mediaId}</span>,
  LocalizedMediaNotReplaceable: ({ reason }: { reason?: string }) => <span data-testid="not-replaceable" data-reason={reason ?? "notProductMedium"} />,
}));

import { VariantGallerySection } from "~/components/image-manager/VariantGallerySection";

afterEach(() => {
  cleanup();
  gridProps.length = 0;
});

const PRODUCT_MEDIUM = "gid://shopify/MediaImage/1";
const LIBRARY_ONLY = "gid://shopify/MediaImage/2";
const fileUrlMap = {
  [PRODUCT_MEDIUM]: "https://cdn.shopify.com/a.jpg?v=1",
  [LIBRARY_ONLY]: "https://cdn.shopify.com/b.jpg",
};

function renderSection(selected: string, extra: Record<string, unknown> = {}, gids: string[] = [PRODUCT_MEDIUM, LIBRARY_ONLY]) {
  const variant = {
    id: "gid://shopify/ProductVariant/9",
    title: "Red",
    sku: null,
    galleryFileGids: gids,
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
            fileUrlMap={fileUrlMap}
            activeAction={null}
            selectedUrls={new Set([selected])}
            onSelect={() => {}}
            onReorder={() => {}}
            onDrop={() => {}}
            onRemoveFromGallery={() => {}}
            onGenerateAltFromSku={() => {}}
            onUploadToGallery={() => {}}
            forceOpen
            productMediaIds={new Set([PRODUCT_MEDIUM])}
            {...extra}
          />
        </DndContext>
      </I18nProvider>
    </AppProvider>,
  );
}

describe("VariantGallerySection — per-language replacements", () => {
  it("forwards the replacements map to its grid", () => {
    const replacements = { [fileUrlMap[PRODUCT_MEDIUM]]: { src: "r.jpg" } };
    renderSection(fileUrlMap[PRODUCT_MEDIUM], { replacements });
    expect(gridProps.at(-1)?.replacements).toBe(replacements);
  });

  it("offers the replace button for a product medium, with its media GID", () => {
    renderSection(fileUrlMap[PRODUCT_MEDIUM]);
    expect(screen.getByTestId("replace").textContent).toBe(PRODUCT_MEDIUM);
    expect(screen.queryByTestId("not-replaceable")).toBeNull();
  });

  it("a medium that is only in the variant gallery gets the disabled reason, not the button", () => {
    renderSection(fileUrlMap[LIBRARY_ONLY]);
    expect(screen.queryByTestId("replace")).toBeNull();
    expect(screen.getByTestId("not-replaceable")).toBeTruthy();
  });

  it("a YouTube link stored on the variant is not replaceable either", () => {
    const yt = "https://www.youtube.com/watch?v=abcdefghijk";
    renderSection(yt, { externalVideoUrls: [yt] });
    expect(screen.queryByTestId("replace")).toBeNull();
    expect(screen.getByTestId("not-replaceable")).toBeTruthy();
  });

  it("an unsaved upload offers nothing (no false 'only in the variant gallery' reason)", () => {
    const upload = "staged://upload-1";
    renderSection("blob:http://localhost/preview", { fileUrlMap: { ...fileUrlMap, [upload]: "blob:http://localhost/preview" } }, [PRODUCT_MEDIUM, upload]);
    expect(screen.queryByTestId("replace")).toBeNull();
    expect(screen.queryByTestId("not-replaceable")).toBeNull();
  });

  it("a 3D model gets its own reason", () => {
    const glb = "https://cdn.shopify.com/m.glb";
    renderSection(glb, { threeDModelUrls: [glb] });
    expect(screen.getByTestId("not-replaceable").getAttribute("data-reason")).toBe("model3d");
  });

  it("translate-to-all is disabled while the image's primary alt is an unsaved draft", () => {
    const url = fileUrlMap[PRODUCT_MEDIUM];
    const common = { onAltTextChange: () => {}, onTranslateAltToAllLocales: () => {}, enabledLanguages: ["en", "de"], primaryLocale: "en", currentLanguage: "en" };
    renderSection(url, { ...common, isAltDirty: () => true });
    const dirtyButton = screen.getByRole("button", { name: /Translate to all languages/ });
    expect(dirtyButton.hasAttribute("disabled") || dirtyButton.getAttribute("aria-disabled") === "true").toBe(true);
    cleanup();
    renderSection(url, { ...common, isAltDirty: () => false });
    const cleanButton = screen.getByRole("button", { name: /Translate to all languages/ });
    expect(cleanButton.hasAttribute("disabled") || cleanButton.getAttribute("aria-disabled") === "true").toBe(false);
  });
});
