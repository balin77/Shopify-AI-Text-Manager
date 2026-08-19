/**
 * The panel, the registry and the provider TOGETHER.
 *
 * `commerce-field.render.test.tsx` renders the panel on its own, where
 * `useRegisterCommerceSave()` resolves to a no-op — so it cannot see anything
 * about the registration. That gap let a render loop ship: the editor passes
 * the panel a freshly built `t` object on every render, the panel's `save`
 * callback depends on `t`, the registration effect depends on `save`, and the
 * registry called `setState` for every new identity. Select a product and the
 * editor re-rendered until React gave up.
 *
 * The rule this file pins is therefore not "the registry works" but "wiring the
 * three together SETTLES" — the property that was actually violated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useState } from "react";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { CommerceField } from "~/components/unified/CommerceField";
import { CommerceVariantsSection } from "~/components/unified/CommerceVariantsSection";
import { CommerceDataProvider } from "~/contexts/CommerceDataContext";
import { useCommerceSaveRegistry } from "~/contexts/CommerceSaveContext";

let renders = 0;

const BODY = {
  success: true,
  variants: [
    {
      id: "1",
      gid: "gid://shopify/ProductVariant/1",
      title: "S",
      sku: null,
      price: "9.90",
      compareAtPrice: null,
      inventoryItemId: "gid://shopify/InventoryItem/1",
      inventoryTracked: true,
      cost: null,
      taxable: true,
      requiresShipping: true,
      weight: null,
      weightUnit: null,
      harmonizedSystemCode: null,
      countryCodeOfOrigin: null,
      levels: [],
      levelsTruncated: false,
    },
  ],
  variantsTruncated: false,
  channels: [{ publicationId: "gid://shopify/Publication/1", name: "Online Store", isPublished: true, publishDate: null }],
  channelsTruncated: false,
  shopLocations: [],
};

/** Mimics the editor: registry here, provider around it, and — the part that
 *  mattered — a `t` bag rebuilt inline on every render. */
function Editor() {
  const commerceSave = useCommerceSaveRegistry();
  const [, force] = useState(0);
  renders += 1;
  useEffect(() => {
    // A parent that re-renders for its own reasons, exactly once. Without the
    // loop this settles; with it, it never does.
    if (renders === 1) force(1);
  }, []);
  return (
    <commerceSave.Provider value={commerceSave.value}>
      <span data-testid="dirty">{String(commerceSave.hasChanges)}</span>
      <button data-testid="discard" onClick={() => commerceSave.discard()}>discard</button>
      <button data-testid="reload" onClick={() => commerceSave.requestReload()}>reload</button>
      <button data-testid="save" onClick={() => void commerceSave.save()}>save</button>
      <CommerceDataProvider
        productId="gid://shopify/Product/1"
        isPrimaryLocale
        t={{ warnings: {}, enumLabels: {} }}
      >
        <CommerceField label="Vertriebskanäle" />
        <CommerceVariantsSection />
      </CommerceDataProvider>
    </commerceSave.Provider>
  );
}

/** The loader's answer, reused by the mid-reload test. */
const loaded = () => ({
  ok: true,
  status: 200,
  json: async () => BODY,
});

beforeEach(() => {
  renders = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => BODY,
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommerceField + save registry", () => {
  it("settles instead of re-rendering forever", async () => {
    render(<AppProvider i18n={en}><Editor /></AppProvider>);

    await waitFor(() => expect(screen.getByTestId("dirty")).toBeTruthy());
    // Generous on purpose: the loop produced hundreds before React threw, so
    // any honest number separates the two cases.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(renders).toBeLessThan(15);
  });

  it("reports a clean panel as not dirty", async () => {
    render(<AppProvider i18n={en}><Editor /></AppProvider>);
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("false"));
  });

  it("carries the dirty flag up and lets Discard clear it again", async () => {
    // The round trip the first version of this file could not see, because its
    // fixture had no variants and so nothing to make dirty.
    render(<AppProvider i18n={en}><Editor /></AppProvider>);

    const price = await screen.findByLabelText("Price");
    fireEvent.change(price, { target: { value: "12.00" } });
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("true"));

    fireEvent.click(screen.getByTestId("discard"));
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("false"));
  });

  it("Discard NEVER unticks a sales channel, not even mid-reload", async () => {
    // THE defect, reproduced through the path that actually reaches it.
    //
    // `discard()` reseeded the channel ticks from `data`, which is null while a
    // reload is in flight — producing an empty map. Normally the landing load
    // repairs that, but the post-save reload passes `keepEdits: true` whenever
    // the save produced a warning, and the reseed is skipped in that case. So
    // the empty map SURVIVED, `dirtyChannels` read every published channel as
    // "unticked", and the next save posted an unpublish for all of them: the
    // product off the storefront, from a click that says "discard".
    let release: ((body: unknown) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: { method?: string }) => {
        // The save's POST answers with a WARNING — that is what makes the
        // reload keep the edits.
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ success: true, warnings: ["priceNotConfirmed"] }),
          });
        }
        return new Promise((resolve) => {
          release = (body) => resolve({ ok: true, status: 200, json: async () => body });
        });
      }),
    );

    render(<AppProvider i18n={en}><Editor /></AppProvider>);
    release?.(BODY);

    // A pill toggle, but still an <input type="checkbox"> with the channel's
    // name as its accessible label — the assertion is unchanged by the look.
    const channel = (await screen.findByLabelText("Online Store")) as HTMLInputElement;
    expect(channel.checked).toBe(true);

    // Something to save, so the POST runs and comes back with its warning.
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "12.00" } });
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("true"));
    fireEvent.click(screen.getByTestId("save"));

    // The reload is now in flight with `keepEdits`. This is the window.
    await waitFor(() => expect(release).toBeTruthy());
    fireEvent.click(screen.getByTestId("discard"));
    release?.(BODY);

    await waitFor(() => expect((screen.getByLabelText("Online Store") as HTMLInputElement).checked).toBe(true));
    // The badge only appears when the panel believes the product is on NO
    // channel — its presence was the visible half of the bug.
    expect(screen.queryByText(/On no channel/i)).toBeNull();
    expect(screen.getByTestId("dirty").textContent).toBe("false");
  });
});
