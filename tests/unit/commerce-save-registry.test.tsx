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
import { CommerceDataProvider, type CommerceTexts } from "~/contexts/CommerceDataContext";
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
 *  mattered — a `t` bag rebuilt inline on every render.
 *
 *  `channels: false` leaves the sales-channel half OUT, which is the view a
 *  merchant editing stock actually has: the two halves are two cards, and for
 *  a while everything a save had to say was rendered in this one. */
function Editor({
  channels = true,
  t,
  productId = "gid://shopify/Product/1",
}: {
  channels?: boolean;
  t?: CommerceTexts;
  productId?: string;
} = {}) {
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
      <span data-testid="saving">{String(commerceSave.saving)}</span>
      <button data-testid="discard" onClick={() => commerceSave.discard()}>discard</button>
      <button data-testid="reload" onClick={() => commerceSave.requestReload()}>reload</button>
      <button data-testid="save" onClick={() => void commerceSave.save()}>save</button>
      <CommerceDataProvider
        productId={productId}
        isPrimaryLocale
        t={t ?? { warnings: {}, enumLabels: {} }}
      >
        {channels && <CommerceField label="Vertriebskanäle" />}
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

/**
 * Where a save's own answer is rendered.
 *
 * The report: change a quantity, press Save, and the save bar does not go away
 * — "does it save at all?". It did not, and the panel said so in the SALES
 * CHANNEL card, which is a different card somewhere else on the page. The bar
 * stays up on purpose in that case (the reload keeps what was typed, so the
 * merchant does not have to retype it against a number that just moved), but
 * with the reason out of sight the whole thing reads as a button that does
 * nothing.
 *
 * So each half of the panel renders its OWN notices, and a save that wrote
 * something and was not refused says so.
 */
describe("a save says what it did, in the card that did it", () => {
  /** A variant with one stocked location, so the on-hand input is editable. */
  const STOCK_BODY = {
    ...BODY,
    variants: [
      {
        ...BODY.variants[0],
        levels: [
          {
            locationId: "gid://shopify/Location/1",
            locationName: "Berlin",
            locationActive: true,
            onHand: 5,
            available: 5,
            committed: 0,
            unavailable: 0,
          },
        ],
      },
    ],
    shopLocations: [],
  };

  /** Answers the loader with the stock fixture and the POST with `warnings`. */
  const stubWith = (warnings: string[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) =>
        init?.method === "POST"
          ? { ok: true, status: 200, json: async () => ({ success: true, warnings }) }
          : { ok: true, status: 200, json: async () => STOCK_BODY },
      ),
    );

  const typeAQuantity = async () => {
    const input = await screen.findByLabelText("On hand");
    fireEvent.change(input, { target: { value: "7" } });
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("true"));
  };

  it("puts a refused STOCK write in the stock card, not only in the channel card", async () => {
    // THE defect. `CommerceField` — the channel half — is deliberately not
    // rendered here: this is what a merchant looking at the variants card sees.
    stubWith(["stockNotConfirmed"]);
    render(
      <AppProvider i18n={en}>
        <Editor channels={false} t={{ warnings: { stockNotConfirmed: "Shopify did not confirm it." }, enumLabels: {} }} />
      </AppProvider>,
    );
    await typeAQuantity();
    fireEvent.click(screen.getByTestId("save"));

    await waitFor(() => expect(screen.getByText("Shopify did not confirm it.")).toBeTruthy());
    // Still dirty, on purpose: the typed value is kept so it does not have to
    // be retyped. That is exactly why the reason has to be readable HERE.
    expect(screen.getByTestId("dirty").textContent).toBe("true");
  });

  it("confirms a stock write that went through, and then clears the bar", async () => {
    stubWith([]);
    render(
      <AppProvider i18n={en}>
        <Editor channels={false} t={{ warnings: {}, enumLabels: {}, saveConfirmed: "Saved." }} />
      </AppProvider>,
    );
    await typeAQuantity();
    fireEvent.click(screen.getByTestId("save"));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("false"));
  });

  it("says nothing at all when the save had nothing of this panel's to write", async () => {
    // The save bar fires this on EVERY save, including a plain title edit.
    // A "Saved." banner over a panel that wrote nothing is a claim about
    // somebody else's work.
    stubWith([]);
    render(<AppProvider i18n={en}><Editor channels={false} t={{ warnings: {}, enumLabels: {}, saveConfirmed: "Saved." }} /></AppProvider>);
    await screen.findByLabelText("On hand");
    fireEvent.click(screen.getByTestId("save"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("reports the panel's own write as in flight, so the bar is not idle", async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") {
          await new Promise<void>((resolve) => { release = resolve; });
          return { ok: true, status: 200, json: async () => ({ success: true, warnings: [] }) };
        }
        return { ok: true, status: 200, json: async () => STOCK_BODY };
      }),
    );
    render(<AppProvider i18n={en}><Editor channels={false} t={{ warnings: {}, enumLabels: {} }} /></AppProvider>);
    await typeAQuantity();
    fireEvent.click(screen.getByTestId("save"));

    await waitFor(() => expect(screen.getByTestId("saving").textContent).toBe("true"));
    release?.();
    await waitFor(() => expect(screen.getByTestId("saving").textContent).toBe("false"));
  });
});

/**
 * Three ways the verdict of a save went missing again, each found in review of
 * the fix above and each a state the merchant reaches by doing nothing unusual.
 */
describe("the verdict survives the reload it triggers", () => {
  const STOCK_BODY = {
    ...BODY,
    variants: [
      {
        ...BODY.variants[0],
        levels: [
          {
            locationId: "gid://shopify/Location/1",
            locationName: "Berlin",
            locationActive: true,
            onHand: 5,
            available: 5,
            committed: 0,
            unavailable: 0,
          },
        ],
      },
    ],
    shopLocations: [],
  };
  const TEXTS = {
    warnings: { stockNotConfirmed: "Shopify did not confirm it." },
    enumLabels: {},
    saveConfirmed: "Saved.",
    loadFailed: "Stock and channels could not be loaded.",
  };

  it("keeps the warning on screen while the post-save reload is in flight", async () => {
    // `save()` ends with `load()`, and `load()` blanks `data` at once — so the
    // card renders its spinner branch for as long as the reload takes. Under
    // that branch the warning used to be gone, and the merchant was looking at
    // a spinner under a save bar that had not moved.
    /** Every loader request, held open until this test lets it answer. */
    const pending: Array<(body: unknown) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ success: true, warnings: ["stockNotConfirmed"] }),
          });
        }
        return new Promise((resolve) => {
          pending.push((body) => resolve({ ok: true, status: 200, json: async () => body }));
        });
      }),
    );
    const answer = () => pending.shift()?.(STOCK_BODY);

    render(<AppProvider i18n={en}><Editor channels={false} t={TEXTS} /></AppProvider>);
    await waitFor(() => expect(pending.length).toBe(1));
    answer();

    fireEvent.change(await screen.findByLabelText("On hand"), { target: { value: "7" } });
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("true"));
    fireEvent.click(screen.getByTestId("save"));

    // The post-save reload is in flight: nothing is loaded, and this is the
    // window the warning used to vanish in.
    await waitFor(() => expect(pending.length).toBe(1));
    expect(screen.getByText("Shopify did not confirm it.")).toBeTruthy();
    answer();
    await waitFor(() => expect(screen.getByText("Shopify did not confirm it.")).toBeTruthy());
  });

  it("still shows it when that reload fails", async () => {
    // The likeliest sequel to a refused write, and the branch that renders a
    // load error INSTEAD of the table — where the save's own reason used to be
    // dropped for good.
    let sawPost = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => {
        if (init?.method === "POST") {
          sawPost = true;
          return { ok: true, status: 200, json: async () => ({ success: true, warnings: ["stockNotConfirmed"] }) };
        }
        return sawPost
          ? { ok: true, status: 200, json: async () => ({ success: false, error: "boom" }) }
          : { ok: true, status: 200, json: async () => STOCK_BODY };
      }),
    );
    render(<AppProvider i18n={en}><Editor channels={false} t={TEXTS} /></AppProvider>);
    fireEvent.change(await screen.findByLabelText("On hand"), { target: { value: "7" } });
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("true"));
    fireEvent.click(screen.getByTestId("save"));

    await waitFor(() => expect(screen.getByText("Stock and channels could not be loaded.")).toBeTruthy());
    expect(screen.getByText("Shopify did not confirm it.")).toBeTruthy();
  });

  it("does not carry one product's verdict over to the next product", async () => {
    // The provider is not keyed by product, and nothing else clears this.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) =>
        init?.method === "POST"
          ? { ok: true, status: 200, json: async () => ({ success: true, warnings: ["stockNotConfirmed"] }) }
          : { ok: true, status: 200, json: async () => STOCK_BODY },
      ),
    );
    const { rerender } = render(
      <AppProvider i18n={en}><Editor channels={false} t={TEXTS} productId="gid://shopify/Product/1" /></AppProvider>,
    );
    fireEvent.change(await screen.findByLabelText("On hand"), { target: { value: "7" } });
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("true"));
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByText("Shopify did not confirm it.")).toBeTruthy());

    rerender(
      <AppProvider i18n={en}><Editor channels={false} t={TEXTS} productId="gid://shopify/Product/2" /></AppProvider>,
    );
    // Waited for the NEW product's table, not merely for the blank frame in
    // between: during the reload the card renders no table either way, so
    // asserting there would pass while the notice sat untouched in state.
    await waitFor(() => expect(screen.getByLabelText("On hand")).toBeTruthy());
    expect(screen.queryByText("Shopify did not confirm it.")).toBeNull();
  });
});
