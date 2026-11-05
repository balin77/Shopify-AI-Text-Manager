/**
 * The product gallery's Alle / Nicht zugewiesen filter, rendered for real (editor + image manager,
 * full view): both buttons exist, they sit in the header's left group beside the toggle, and a click
 * flips aria-pressed. Layout is not asserted here (image-manager-phone-layout.test.ts guards the CSS).
 */
import { describe, it, vi, expect } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import polarisEn from "@shopify/polaris/locales/en.json";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";
import { useState } from "react";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));
const svg = (c: string, n: number) => "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='200' height='200' fill='${c}'/><text x='100' y='120' font-size='80' text-anchor='middle' fill='white'>${n}</text></svg>`);
const COLORS = ["#c0392b","#2980b9","#27ae60","#8e44ad","#d35400","#16a085","#7f8c8d","#2c3e50","#f39c12","#1abc9c"];
const N = 4;
const gid = (n: number) => `gid://shopify/MediaImage/${n}`;
const imgUrl = (n: number) => svg(COLORS[n % COLORS.length], n);
vi.mock("~/utils/app-fetch", () => ({
  appFetch: async (input: string) => {
    const path = String(input).split("?")[0];
    if (path === "/api/product-variants") {
      return { ok: true, status: 200, json: async () => ({
        variants: [1,2,3].map((i) => ({ shopifyGid: `gid://shopify/ProductVariant/${i}`, title: ["Red","Blue","Green"][i-1], sku: "s"+i, position: i,
          galleryJson: JSON.stringify([1,2,3,4,5,6].map((k) => gid(i*2+k))), galleryOrderJson: null, image: { url: imgUrl(i*2+1) }, selectedOptions: [] })),
        mediaMap: Object.fromEntries(Array.from({length: N+10}, (_, n) => [gid(n+1), imgUrl(n+1)])),
        mediaMetaMap: Object.fromEntries(Array.from({length: N+10}, (_, n) => [gid(n+1), { kind: "image", previewUrl: imgUrl(n+1) }])),
      }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, images: [], items: [] }) };
  },
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
import { VariantImageManager } from "~/components/image-manager/VariantImageManager";
import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { PRODUCTS_CONFIG } from "~/config/content-fields.config";

const items = [1, 2].map((n) => ({ id: `gid://shopify/Product/${n}`, title: `Produkt ${n}`, descriptionHtml: "<p>text</p>", handle: `p-${n}`, seo: { title: "", description: "" }, translations: [], images: [], status: "ACTIVE" }));
const productImages = Array.from({ length: N }, (_, i) => ({ url: imgUrl(i+1), mediaId: gid(i+1), id: gid(i+1), altText: "Alt " + (i+1) }));
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function Page() {
  const { items: loaded } = useLoaderData() as { items: any[] };
  const fetcher = useFetcher();
  const [full, setFull] = useState(false);
  const editor: any = useUnifiedContentEditor({ config: PRODUCTS_CONFIG, items: loaded, shopLocales: [{ locale: "de", primary: true, published: true }, { locale: "en", primary: false, published: true }], primaryLocale: "de", fetcher, showInfoBox: vi.fn(), t: en, initialItemId: items[0].id } as any);
  return (
    <UnifiedContentEditor config={PRODUCTS_CONFIG} items={loaded} shopLocales={[{ locale: "de", primary: true, published: true } as any, { locale: "en", primary: false, published: true } as any]} primaryLocale="de" editor={editor as any}
      fetcherState={fetcher.state} fetcherFormData={fetcher.formData} t={en as any} revalidator={{ revalidate: vi.fn(), state: "idle" } as any}
      imageManagerFullView={full}
      imageGalleryReplacement={<VariantImageManager productId={items[0].id} productImages={productImages as any} bulkItems={[]} activeAction={null} selectedBulkIds={new Set()} onRemoveBulk={() => {}} onSetAction={() => {}}
        imageManagerSettings={{ firstImageBig: false, showAltTags: false, autoAltText: false, thumbSize: 80 }} fullView={full} onFullViewChange={setFull} enabledLanguages={["de","en"]} primaryLocale="de" currentLanguage="de" />}
    />
  );
}


describe("image manager filter", () => {
  it("a click on the filter flips aria-pressed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }), text: async () => "" })));
    const router = createMemoryRouter([{ path: "/", element: <Page />, loader: async () => ({ items }) }]);
    render(<AppProvider i18n={polarisEn}><I18nProvider locale="en"><PlanProvider plan={"max" as any} newFeaturesEnabled><InfoBoxProvider><ConfirmProvider><SeoSettingsProvider seoTitleSuffix="" seoLimits={{} as any}><NavigationHeightProvider><ItemSelectorProvider><AltTextOpsProvider><SidebarPanelProvider>
      <RouterProvider router={router} /></SidebarPanelProvider></AltTextOpsProvider></ItemSelectorProvider></NavigationHeightProvider></SeoSettingsProvider></ConfirmProvider></InfoBoxProvider></PlanProvider></I18nProvider></AppProvider>);
    await tick(100);
    fireEvent.click(await screen.findByText("Show all"));
    await tick(300);
    const all = (await screen.findByText(en.imageManager.all)).closest("button")!;
    const unassigned = screen.getByText(en.imageManager.unassigned).closest("button")!;
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(unassigned.getAttribute("aria-pressed")).toBe("false");
    // both live in the same left group as the title toggle
    const left = all.closest(".im-head-left")!;
    expect(left.contains(document.querySelector("[data-im-product-toggle]"))).toBe(true);
    expect(left.contains(unassigned)).toBe(true);
    fireEvent.click(unassigned);
    await tick(50);
    expect(unassigned.getAttribute("aria-pressed")).toBe("true");
    expect(all.getAttribute("aria-pressed")).toBe("false");
  });
});
