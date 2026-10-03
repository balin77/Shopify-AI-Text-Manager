/**
 * The theme image field in the PRIMARY language: the same picker as in a
 * foreign language, the original shown, a pick handed to the editor as a DRAFT
 * (onChange only - nothing is saved by the click), the picked file's id
 * remembered for the save, and no way to clear the original.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import polarisEn from "@shopify/polaris/locales/en.json";
import type { ReactElement } from "react";

import { en } from "~/i18n/en";

vi.mock("~/contexts/I18nContext", () => ({ useI18n: () => ({ t: en, locale: "en" }) }));
vi.mock("~/components/image-manager/FilePickerModal", () => ({
  FilePickerModal: (props: { open: boolean; imagesOnly?: boolean; title: string; onAdd: (items: unknown[]) => void }) =>
    props.open ? (
      <div>
        <span data-testid="picker-title">{props.title}</span>
        <span data-testid="images-only">{String(!!props.imagesOnly)}</span>
        <button
          onClick={() =>
            props.onAdd([
              {
                source: "library",
                gid: "gid://shopify/MediaImage/99",
                kind: "image",
                previewUrl: "https://cdn.shopify.com/s/files/1/x/files/new-logo.png?v=1",
                assetUrl: "https://cdn.shopify.com/s/files/1/x/files/new-logo.png?v=1",
                alt: null,
              },
            ])
          }
        >
          pick
        </button>
      </div>
    ) : null,
}));

import { ThemeImageField } from "~/components/localized-images/ThemeImageField";
import { fileIdForThemeImage } from "~/utils/theme-image-reference.shared";

const render = (ui: ReactElement) => rtlRender(<AppProvider i18n={polarisEn}>{ui}</AppProvider>);

const ORIGINAL = "shopify://shop_images/old-logo.png";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ files: [] }) })));
});

describe("ThemeImageField, primary language", () => {
  it("offers the picker (images only) instead of the Theme-editor text, and hands the pick over as a draft", async () => {
    const onChange = vi.fn();
    render(<ThemeImageField label="Logo" value={ORIGINAL} primaryValue={ORIGINAL} onChange={onChange} isPrimaryLocale currentLanguage="de" />);

    expect(screen.queryByText(en.localizedImages.primaryReadOnly)).toBeNull();
    expect(screen.getByText(en.localizedImages.primaryHint)).toBeTruthy();
    // The original is shown, and there is no reset / clear for it.
    expect(screen.getByText("old-logo.png")).toBeTruthy();
    expect(screen.queryByText(en.localizedImages.reset)).toBeNull();

    fireEvent.click(screen.getByText(en.localizedImages.changeImage));
    expect(screen.getByTestId("images-only").textContent).toBe("true");
    expect(screen.getByTestId("picker-title").textContent).toBe(en.localizedImages.primaryPickerTitle);
    fireEvent.click(screen.getByText("pick"));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith("shopify://shop_images/new-logo.png");
    // The save will name the file by id; the server derives the reference.
    expect(fileIdForThemeImage("shopify://shop_images/new-logo.png")).toBe("gid://shopify/MediaImage/99");
  });

  it("shows the DRAFT as the original once picked, flagged as unsaved", () => {
    render(
      <ThemeImageField label="Logo" value="shopify://shop_images/new-logo.png" primaryValue={ORIGINAL} onChange={vi.fn()} isPrimaryLocale currentLanguage="de" />,
    );
    expect(screen.getByText("new-logo.png")).toBeTruthy();
    expect(screen.getByText(en.localizedImages.unsavedBadge)).toBeTruthy();
  });

  it("offers a way back to the loaded value, so an unsavable pick never forces Discard-all", () => {
    const onChange = vi.fn();
    render(
      <ThemeImageField label="Logo" value="shopify://shop_images/new-logo.png" primaryValue={ORIGINAL} onChange={onChange} isPrimaryLocale currentLanguage="de" />,
    );
    fireEvent.click(screen.getByText(en.localizedImages.resetToSaved));
    expect(onChange).toHaveBeenCalledWith(ORIGINAL);
  });

  it("shows an original that no theme file can hold read-only, with the explanation and no picker", () => {
    render(<ThemeImageField label="Logo" value={ORIGINAL} primaryValue={ORIGINAL} onChange={vi.fn()} isPrimaryLocale primaryUnsavable currentLanguage="de" />);
    expect(screen.getByText(en.localizedImages.primaryReadOnly)).toBeTruthy();
    expect(screen.queryByText(en.localizedImages.changeImage)).toBeNull();
  });

  it("keeps the old explanation, and no picker, where the primary value is read-only", () => {
    render(<ThemeImageField label="Logo" value={ORIGINAL} primaryValue={ORIGINAL} onChange={vi.fn()} isPrimaryLocale readOnly currentLanguage="de" />);
    expect(screen.getByText(en.localizedImages.primaryReadOnly)).toBeTruthy();
    expect(screen.queryByText(en.localizedImages.changeImage)).toBeNull();
  });
});
