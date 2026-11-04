/**
 * Round 3, point 3: the image manager as a FULL view of the product editor.
 *
 * The REAL UnifiedContentEditor (real hook, data router) with a probe in the gallery slot. What is
 * pinned: opening the full view hides every text element by style but never unmounts it (typed text,
 * input identity survive both ways), the item list and the save bar stay, a product without a manager
 * (plan) is untouched, and the switch to another product keeps the view.
 *
 * MOCK-ONLY: layout (display:none really hiding, scroll positions, auto-grow measurement) is not
 * measured in a browser; the classes and inline styles are what is asserted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import polarisEn from "@shopify/polaris/locales/en.json";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";
import { useState } from "react";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));
vi.mock("~/utils/app-fetch", () => ({
  appFetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, images: [], items: [], variants: [] }) }),
  appFetchJson: async () => ({ response: { ok: true, status: 200 }, data: { success: true, images: [] } }),
}));

import { I18nProvider } from "~/contexts/I18nContext";
import { PlanProvider } from "~/contexts/PlanContext";
import { InfoBoxProvider } from "~/contexts/InfoBoxContext";
import { ItemSelectorProvider } from "~/contexts/ItemSelectorContext";
import { ConfirmProvider } from "~/contexts/ConfirmContext";
import { SeoSettingsProvider } from "~/contexts/SeoSettingsContext";
import { NavigationHeightProvider } from "~/contexts/NavigationHeightContext";
import { AltTextOpsProvider } from "~/contexts/AltTextOpsContext";
import { SidebarPanelProvider } from "~/contexts/SidebarPanelContext";
import { en } from "~/i18n/en";
import { UnifiedContentEditor } from "~/components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { PRODUCTS_CONFIG } from "~/config/content-fields.config";

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const items = [1, 2].map((n) => ({
  id: `gid://shopify/Product/${n}`,
  title: `Produkt ${n}`,
  descriptionHtml: "<p>text</p>",
  handle: `p-${n}`,
  seo: { title: "", description: "" },
  translations: [],
  images: [],
  status: "ACTIVE",
}));

let view: { open: boolean; set: (v: boolean) => void };

function Page({ withManager }: { withManager: boolean }) {
  const { items: loaded } = useLoaderData() as { items: any[] };
  const fetcher = useFetcher();
  const [full, setFull] = useState(false);
  view = { open: full, set: setFull };
  const editor = useUnifiedContentEditor({
    config: PRODUCTS_CONFIG,
    items: loaded,
    shopLocales: [{ locale: "de", primary: true, published: true }],
    primaryLocale: "de",
    fetcher,
    showInfoBox: vi.fn(),
    t: en,
    initialItemId: items[0].id,
  } as any);
  return (
    <UnifiedContentEditor
      config={PRODUCTS_CONFIG}
      items={loaded}
      shopLocales={[{ locale: "de", primary: true, published: true } as any]}
      primaryLocale="de"
      editor={editor as any}
      fetcherState={fetcher.state}
      fetcherFormData={fetcher.formData}
      t={en as any}
      revalidator={{ revalidate: vi.fn(), state: "idle" } as any}
      imageManagerFullView={full}
      imageGalleryReplacement={withManager ? (
        <div data-testid="manager">
          <button onClick={() => setFull(!full)}>{full ? "close" : "open"}</button>
        </div>
      ) : undefined}
    />
  );
}

function mount(withManager: boolean) {
  const router = createMemoryRouter([
    { path: "/api/product-images", loader: async () => ({ success: true, images: [] }) },
    { path: "/", element: <Page withManager={withManager} />, loader: async () => ({ items }), action: async () => ({ success: true }) },
  ]);
  return render(
    <AppProvider i18n={polarisEn}>
      <I18nProvider locale="en"><PlanProvider plan={"max" as any} newFeaturesEnabled><InfoBoxProvider><ConfirmProvider><SeoSettingsProvider seoTitleSuffix="" seoLimits={{} as any}><NavigationHeightProvider><ItemSelectorProvider><AltTextOpsProvider><SidebarPanelProvider>
        <RouterProvider router={router} />
      </SidebarPanelProvider></AltTextOpsProvider></ItemSelectorProvider></NavigationHeightProvider></SeoSettingsProvider></ConfirmProvider></InfoBoxProvider></PlanProvider></I18nProvider>
    </AppProvider>,
  );
}

const titleInput = () => screen.getAllByRole("textbox").find((el) => (el as HTMLInputElement).value === "Produkt 1") as HTMLElement;
const hiddenByStyle = (el: HTMLElement) => {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) if (n.style.display === "none") return true;
  return false;
};

describe("image manager full view in the editor", () => {
  beforeEach(() => {
    try { window.localStorage.clear(); } catch { /* none */ }
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }), text: async () => "" })));
  });

  it("opening hides the text fields by style and keeps the very same input mounted with its typed text", async () => {
    const { container } = mount(true);
    await tick(80);
    const input = titleInput();
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "Produkt 1 geändert" } });
    expect((input as HTMLInputElement).value).toBe("Produkt 1 geändert");
    expect(hiddenByStyle(input)).toBe(false);

    fireEvent.click(screen.getByText("open"));
    await tick(20);
    expect(container.querySelector(".field-editor-area.im-full")).toBeTruthy();
    expect(container.querySelector(".unified-editor-container.im-full")).toBeTruthy();
    expect(hiddenByStyle(input)).toBe(true);
    // the manager slot itself is not hidden
    expect(hiddenByStyle(screen.getByTestId("manager"))).toBe(false);
    // the SAME element, with the typed text
    expect(document.contains(input)).toBe(true);
    expect((input as HTMLInputElement).value).toBe("Produkt 1 geändert");

    fireEvent.click(screen.getByText("close"));
    await tick(20);
    expect(container.querySelector(".im-full")).toBeNull();
    expect(hiddenByStyle(input)).toBe(false);
    expect(document.contains(input)).toBe(true);
    expect((input as HTMLInputElement).value).toBe("Produkt 1 geändert");
  });

  it("the item list stays visible in the full view and a product switch keeps the view", async () => {
    const { container } = mount(true);
    await tick(80);
    fireEvent.click(screen.getByText("open"));
    await tick(20);
    const list = container.querySelector(".unified-item-list-container") as HTMLElement;
    expect(list).toBeTruthy();
    expect(hiddenByStyle(list)).toBe(false);
    const other = screen.getAllByText("Produkt 2")[0];
    fireEvent.click(other);
    await tick(80);
    expect(view.open).toBe(true);
    expect(container.querySelector(".field-editor-area.im-full")).toBeTruthy();
  });

  it("a plan without the manager (no replacement) never switches anything", async () => {
    const { container } = mount(false);
    await tick(80);
    expect(screen.queryByTestId("manager")).toBeNull();
    act(() => view.set(true));
    await tick(20);
    expect(container.querySelector(".im-full")).toBeNull();
    expect(hiddenByStyle(titleInput())).toBe(false);
  });
});
