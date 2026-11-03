/**
 * The variants read of the image manager when the rate limiter refuses it, and when it is aborted.
 * Test-only: the real component, its fetch mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import { createMemoryRouter, RouterProvider, useSearchParams } from "react-router";
import enPolaris from "@shopify/polaris/locales/en.json";
import { en } from "~/i18n/en";

const appFetch = vi.fn();
vi.mock("~/utils/app-fetch", () => ({ appFetch: (...a: unknown[]) => appFetch(...a), appFetchJson: () => new Promise(() => {}) }));
vi.mock("~/contexts/I18nContext", () => ({ useI18n: () => ({ t: en, locale: "en" }) }));
vi.mock("~/contexts/PlanContext", () => ({ usePlan: () => ({ plan: "max" }) }));
vi.mock("~/contexts/InfoBoxContext", () => ({ useInfoBox: () => ({ showInfoBox: vi.fn() }) }));

import { VariantImageManager } from "~/components/image-manager/VariantImageManager";

const props: any = {
  productId: "gid://shopify/Product/1",
  productImages: [],
  bulkItems: [],
  activeAction: null,
  selectedBulkIds: new Set(),
  onRemoveBulk: () => {},
  onSetAction: () => {},
  imageManagerSettings: {},
  enabledLanguages: ["en"],
  currentLanguage: "en",
  primaryLocale: "en",
  settlingMedia: [],
};
function Harness() {
  const [params] = useSearchParams();
  return <AppProvider i18n={enPolaris as any}><VariantImageManager {...props} productId={params.get("p") ?? props.productId} /></AppProvider>;
}
const view = () => {
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  return { router, ...render(<RouterProvider router={router} />) };
};
// Only the variants read is under test; every other read stays pending.
const route = (variants: (init?: RequestInit) => Promise<Response>) =>
  appFetch.mockImplementation((url: string, init?: RequestInit) =>
    String(url).startsWith("/api/product-variants") ? variants(init) : new Promise(() => {}));

beforeEach(() => { appFetch.mockReset(); });

describe("variants read", () => {
  it("a refusal by the limiter shows the translated load error, never the English limiter text", async () => {
    route(async () => new Response(JSON.stringify({ error: "Many requests right now", rateLimited: true }), { status: 429 }));
    view();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByText("Many requests right now")).toBeNull();
    expect(screen.getByText(en.imageManager.variantsLoadError)).toBeTruthy();
  });
  it("a read aborted by a product switch shows no error, and the new product's read is made", async () => {
    const seen: string[] = [];
    route((init) => {
      seen.push("x");
      // The second read (the new product) is answered, so the banner area is not a spinner.
      if (seen.length > 1) return Promise.resolve(new Response(JSON.stringify({ variants: [], mediaMap: {}, mediaMetaMap: {} }), { status: 200 }));
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    });
    const { router } = view();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    await act(async () => { await router.navigate("/?p=gid%3A%2F%2Fshopify%2FProduct%2F2"); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(seen.length).toBe(2);
    expect(screen.queryByText(en.imageManager.variantsLoadError)).toBeNull();
  });
});
