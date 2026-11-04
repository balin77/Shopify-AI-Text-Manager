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

let panelProps: { subTab: "bulkUpload" | "bulkAltText"; selected: string[]; current: boolean } = { subTab: "bulkUpload", selected: [], current: true };
let view: { open: boolean; set: (v: boolean) => void };
let editorRef: { current: any } = { current: null };
// The save's action answers only when the test says so (a save "in flight").
let posts: Array<Record<string, string>> = [];
let answerSave: (body: Record<string, unknown>) => void = () => {};
let holdSaves = false;

function Page({ withManager, panels }: { withManager: boolean; panels?: boolean }) {
  const [rightTab, setRightTab] = useState<"seo" | "images">(panelProps.subTab === "bulkAltText" ? "images" : "seo");
  const { items: loaded } = useLoaderData() as { items: any[] };
  const fetcher = useFetcher();
  const [full, setFull] = useState(false);
  view = { open: full, set: setFull };
  const editor: any = useUnifiedContentEditor({
    config: PRODUCTS_CONFIG,
    items: loaded,
    shopLocales: [{ locale: "de", primary: true, published: true }],
    primaryLocale: "de",
    fetcher,
    showInfoBox: vi.fn(),
    t: en,
    initialItemId: items[0].id,
  } as any);
  editorRef.current = editor;
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
      renderSidebar={panels ? (() => <div data-testid="seo-part">seo</div>) : undefined}
      showImageManager={!!panels}
      imageManager={panels ? ({
        bulkItems: [], onBulkItemsChange: () => {}, selectedBulkIds: new Set(), activeAction: null, onSetAction: () => {},
        onBulkSelect: () => {}, onRemoveBulk: () => {}, activeRightTab: rightTab, onTabChange: setRightTab,
        activeImageSubTab: panelProps.subTab, onImageSubTabChange: () => {}, selectedGalleryGids: panelProps.selected, imageManagerSettings: { firstImageBig: false, showAltTags: false, autoAltText: false },
        variantsCurrent: panelProps.current, variantsForBulk: [{ id: "v1", title: "V", sku: "", position: 1, galleryFileGids: ["g1"], externalVideoUrls: [], threeDModelUrls: [], threeDPreviewUrls: [], galleryOrderJson: null, selectedOptions: [] }], productTitle: "Produkt 1", productId: items[0].id,
      } as any) : undefined}
      imageGalleryReplacement={withManager ? (
        <div data-testid="manager">
          <button onClick={() => setFull(!full)}>{full ? "close" : "open"}</button>
        </div>
      ) : undefined}
    />
  );
}

function mount(withManager: boolean, panels = false) {
  const router = createMemoryRouter([
    { path: "/api/product-images", loader: async () => ({ success: true, images: [] }) },
    { path: "/", element: <Page withManager={withManager} panels={panels} />, loader: async () => ({ items }), action: async ({ request }: any) => {
      posts.push(Object.fromEntries((await request.formData()) as any) as Record<string, string>);
      if (!holdSaves) return { success: true };
      return new Promise((resolve) => { answerSave = resolve as any; });
    } },
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
    posts = []; holdSaves = false;
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

describe("image manager full view: sidebar, mobile toolbar, saves in flight", () => {
  beforeEach(() => {
    try { window.localStorage.clear(); } catch { /* none */ }
    posts = []; holdSaves = false;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }), text: async () => "" })));
  });
  const hiddenUp = (el: HTMLElement | null) => {
    for (let n: HTMLElement | null = el; n; n = n.parentElement) if (n.style.display === "none") return true;
    return false;
  };

  it("the right SEO sidebar and its resizer are hidden (kept mounted, same element) in the full view", async () => {
    const { container } = mount(true);
    await tick(80);
    const sidebar = container.querySelector(".seo-sidebar-container") as HTMLElement;
    const resizer = container.querySelector(".sidebar-resizer") as HTMLElement;
    expect(sidebar).toBeTruthy();
    expect(hiddenUp(sidebar)).toBe(false);
    fireEvent.click(screen.getByText("open"));
    await tick(20);
    expect(hiddenUp(sidebar)).toBe(true);
    expect(hiddenUp(resizer)).toBe(true);
    expect(container.querySelector(".seo-sidebar-container")).toBe(sidebar);
    fireEvent.click(screen.getByText("close"));
    await tick(20);
    expect(hiddenUp(sidebar)).toBe(false);
    expect(container.querySelector(".seo-sidebar-container")).toBe(sidebar);
  });

  it("with the image-processing tabs the sidebar column stays: the bulk upload panel is reachable, the SEO part is hidden but mounted", async () => {
    const { container } = mount(true, true);
    await tick(80);
    const sidebar = container.querySelector(".seo-sidebar-container") as HTMLElement;
    const seoTab = screen.getAllByText(en.imageManager?.seoScoreTab ?? "SEO Score")[0];
    expect(seoTab).toBeTruthy();
    const seoPartEl = screen.getByTestId("seo-part");
    expect(hiddenUp(seoPartEl)).toBe(false);
    fireEvent.click(screen.getByText("open"));
    await tick(20);
    expect(hiddenUp(sidebar)).toBe(false);
    // The switch between SEO and images is hidden, the image-processing sub tabs are shown.
    expect(hiddenUp(screen.getAllByText(en.imageManager?.seoScoreTab ?? "SEO Score")[0])).toBe(true);
    const bulk = screen.getByText(en.imageManager?.bulkUploadSubTab ?? "Bulk Upload");
    expect(hiddenUp(bulk)).toBe(false);
    expect(screen.getByTestId("seo-part")).toBe(seoPartEl);
    expect(hiddenUp(seoPartEl)).toBe(true);
    fireEvent.click(screen.getByText("close"));
    await tick(20);
    expect(hiddenUp(screen.getAllByText(en.imageManager?.seoScoreTab ?? "SEO Score")[0])).toBe(false);
    // The SEO section is back (previous tab restored) and the image sub tabs are gone again.
    expect(screen.queryByText(en.imageManager?.bulkUploadSubTab ?? "Bulk Upload")).toBeNull();
    expect(screen.getByTestId("seo-part")).toBe(seoPartEl);
    expect(hiddenUp(seoPartEl)).toBe(false);
  });

  it("the selection kept from the full view does not scope the bulk alt text SKU action once the view is closed", async () => {
    panelProps = { subTab: "bulkAltText", selected: ["gid://shopify/MediaImage/1", "gid://shopify/MediaImage/2"], current: true };
    try {
      mount(true, true);
      await tick(80);
      fireEvent.click(screen.getByText("open"));
      await tick(20);
      expect(screen.getByRole("button", { name: /Selected only \(2\)/ })).toBeTruthy();
      fireEvent.click(screen.getByText("close"));
      await tick(20);
      expect(screen.queryByRole("button", { name: /Selected only \(2\)/ })).toBeNull();
      expect(screen.getByRole("button", { name: /Selected only \(0\)/ })).toBeTruthy();
    } finally {
      panelProps = { subTab: "bulkUpload", selected: [], current: true };
    }
  });

  it("LOW: the bulk alt text 'All' action waits while the variants list is not current", async () => {
    panelProps = { subTab: "bulkAltText", selected: [], current: false };
    try {
      mount(true, true);
      await tick(80);
      fireEvent.click(screen.getByText("open"));
      await tick(20);
      const all = screen.getByRole("button", { name: "All" }) as HTMLButtonElement;
      expect(all.disabled || all.getAttribute("aria-disabled") === "true").toBe(true);
    } finally {
      panelProps = { subTab: "bulkUpload", selected: [], current: true };
    }
  });

  it("the phone toolbar keeps only its language part: its actions are hidden but mounted", async () => {
    const { container } = mount(true);
    await tick(80);
    const more = container.querySelector(".toolbar-mobile-only button[aria-label=\"More actions\"]") as HTMLElement;
    expect(more).toBeTruthy();
    expect(hiddenUp(more)).toBe(false);
    fireEvent.click(screen.getByText("open"));
    await tick(20);
    expect(hiddenUp(more)).toBe(true);
    expect(container.querySelector(".toolbar-mobile-only button[aria-label=\"More actions\"]")).toBe(more);
    fireEvent.click(screen.getByText("close"));
    await tick(20);
    expect(hiddenUp(more)).toBe(false);
  });

  it("every hidden block is hidden by an explicit class, not by its position", async () => {
    const { container } = mount(true);
    await tick(80);
    fireEvent.click(screen.getByText("open"));
    await tick(20);
    const area = container.querySelector(".field-editor-area") as HTMLElement;
    const later = Array.from(area.children).slice(1) as HTMLElement[];
    expect(later.length).toBeGreaterThan(0);
    for (const el of later) expect(el.classList.contains("im-hide-when-full")).toBe(true);
  });

  it("a text save that is in flight when the view switches finishes and keeps the typed input mounted", async () => {
    holdSaves = true;
    mount(true);
    await tick(80);
    const input = titleInput();
    fireEvent.change(input, { target: { value: "Produkt 1 neu" } });
    await tick(20);
    await act(async () => { editorRef.current.handlers.handleSave(); });
    await tick(30);
    expect(posts.length).toBe(1);
    expect(posts[0].title).toBe("Produkt 1 neu");
    expect(editorRef.current.state.isSavingCurrentItem).toBe(true);
    fireEvent.click(screen.getByText("open"));
    await tick(20);
    expect(editorRef.current.state.isSavingCurrentItem).toBe(true);
    fireEvent.click(screen.getByText("close"));
    await tick(20);
    expect(posts.length).toBe(1);
    expect(document.contains(input)).toBe(true);
    await act(async () => { answerSave({ success: true }); });
    await tick(50);
    expect(editorRef.current.state.isSavingCurrentItem).toBe(false);
    expect(posts.length).toBe(1);
    expect(document.contains(input)).toBe(true);
    expect((input as HTMLInputElement).value).toBe("Produkt 1 neu");
  });
});
