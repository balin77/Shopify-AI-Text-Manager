/**
 * Editing a whole group of variants at once.
 *
 * The dangerous half of this feature is not the write, it is what the fields
 * SHOW. A bulk price field that displayed one member's value would invite the
 * merchant either to leave it alone believing all twelve variants are that
 * price, or to touch it and overwrite eleven values they never saw. So the
 * tests are mostly about the difference between "they agree" and "they
 * differ", and about stock staying out of it entirely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { CommerceVariantsSection } from "~/components/unified/CommerceVariantsSection";
import { CommerceDataProvider } from "~/contexts/CommerceDataContext";

const PRODUCT = "gid://shopify/Product/1";

function variant(
  colour: string,
  size: string,
  extra: Partial<Record<string, unknown>> = {},
) {
  const id = `${colour}-${size}`;
  return {
    id,
    gid: `gid://shopify/ProductVariant/${id}`,
    title: `${colour} / ${size}`,
    sku: null,
    price: "10.00",
    compareAtPrice: null,
    inventoryItemId: `gid://shopify/InventoryItem/${id}`,
    inventoryTracked: true,
    cost: null,
    taxable: true,
    requiresShipping: true,
    weight: null,
    weightUnit: "KILOGRAMS",
    harmonizedSystemCode: null,
    countryCodeOfOrigin: null,
    imageUrl: `https://cdn/${colour}.png`,
    imageAlt: colour,
    selectedOptions: [
      { name: "Farbe", value: colour },
      { name: "Grösse", value: size },
    ],
    levels: [],
    levelsTruncated: false,
    ...extra,
  };
}

/** Two colours × two sizes. */
const variants = [
  variant("Weiss", "20cm"),
  variant("Weiss", "30cm", { price: "12.00" }),
  variant("Rot", "20cm"),
  variant("Rot", "30cm"),
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        variants,
        variantsTruncated: false,
        channels: [],
        channelsTruncated: false,
        shopLocations: [],
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ui() {
  return render(
    <AppProvider i18n={en}>
      <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
        <CommerceVariantsSection />
      </CommerceDataProvider>
    </AppProvider>,
  );
}

/** Picks a scope by its option value in the select. */
async function pick(label: string) {
  const select = (await screen.findByLabelText("Variant")) as HTMLSelectElement;
  const option = [...select.options].find((o) => o.textContent === label);
  expect(option, `no scope called ${label}`).toBeTruthy();
  fireEvent.change(select, { target: { value: option!.value } });
}

describe("the scope picker", () => {
  it("offers the groups the catalogue actually has", async () => {
    ui();
    const select = (await screen.findByLabelText("Variant")) as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);

    expect(labels).toContain("Weiss / 20cm");
    expect(labels).toContain("All Weiss");
    expect(labels).toContain("All 20cm");
    expect(labels).toContain("All variants");
  });

  it("shows ONE picture for one variant and several for a group", async () => {
    const { container } = ui();
    await screen.findByLabelText("Variant");

    const count = () => container.querySelectorAll("img").length;
    expect(count()).toBe(1);

    await pick("All variants");
    // Two distinct images across the four variants.
    await waitFor(() => expect(count()).toBe(2));
  });
});

describe("a bulk field", () => {
  it("shows the value the members agree on", async () => {
    ui();
    await pick("All Rot");

    // Both Rot variants are 10.00.
    const price = (await screen.findByLabelText(/^Price/)) as HTMLInputElement;
    expect(price.value).toBe("10.00");
  });

  it("shows NOTHING when they differ, and says so", async () => {
    ui();
    await pick("All Weiss");

    // 10.00 and 12.00 — showing either would be a lie about the other.
    const price = (await screen.findByLabelText(/^Price/)) as HTMLInputElement;
    expect(price.value).toBe("");
    expect(price.placeholder).toMatch(/different/i);
  });

  it("applies what is typed to EVERY member", async () => {
    ui();
    await pick("All Weiss");

    const price = (await screen.findByLabelText(/^Price/)) as HTMLInputElement;
    fireEvent.change(price, { target: { value: "15.00" } });

    // Both Weiss variants now read 15.00 — including the one that was 12.00.
    expect(price.value).toBe("15.00");
    // …and the other colour is untouched: switching to it still shows 10.00.
    await pick("All Rot");
    const other = (await screen.findByLabelText(/^Price/)) as HTMLInputElement;
    expect(other.value).toBe("10.00");
  });
});

describe("stock", () => {
  it("is editable for one variant", async () => {
    ui();
    await screen.findByLabelText("Variant");
    // The single-variant scope is selected by default.
    expect(screen.queryByText(/one variant at a time/i)).toBeNull();
  });

  it("is NOT bulk-editable, and the panel says why", async () => {
    // A stock level is a COUNT, per variant per location, written as an
    // absolute quantity compared against the one that was loaded. One number
    // across twelve variants would flatten twelve different counts.
    ui();
    await pick("All variants");

    expect(await screen.findByText(/one variant at a time/i)).toBeTruthy();
  });
});

describe("the stock table", () => {
  /** Two warehouses, like Shopify's own product page. */
  const stocked = [
    variant("Weiss", "20cm", {
      levels: [
        { locationId: "l1", locationName: "Schweiz", locationActive: true, onHand: 20, available: 20, committed: 0, unavailable: 0 },
        { locationId: "l2", locationName: "Spanien", locationActive: true, onHand: 10, available: 8, committed: 2, unavailable: 0 },
      ],
    }),
  ];

  function withLevels() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          variants: stocked,
          variantsTruncated: false,
          channels: [],
          channelsTruncated: false,
          shopLocations: [],
        }),
      })),
    );
  }

  it("shows one row per location and a total", async () => {
    withLevels();
    ui();

    expect(await screen.findByText("Schweiz")).toBeTruthy();
    expect(screen.getByText("Spanien")).toBeTruthy();
    const total = screen.getByText("Total").closest("tr")!;
    // 20 + 10 on hand, 20 + 8 available, 0 + 2 committed.
    expect([...total.querySelectorAll("td")].map((td) => td.textContent)).toEqual([
      "Total", "0", "2", "28", "30",
    ]);
  });

  it("moves the on-hand total with what is typed", async () => {
    // The number a merchant is deciding against has to be the one they are
    // looking at, not the one that was loaded.
    withLevels();
    ui();
    await screen.findByText("Schweiz");

    const inputs = screen.getAllByLabelText(/On hand/i) as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "25" } });

    const total = screen.getByText("Total").closest("tr")!;
    expect([...total.querySelectorAll("td")].map((td) => td.textContent).at(-1)).toBe("35");
  });

  it("shows an em dash, never a zero, for a number it does not have", async () => {
    // `tracked: false` and "never synced" both arrive as null, and 0 would
    // tell a merchant they are sold out of something they can sell freely.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          variants: [
            variant("Weiss", "20cm", {
              levels: [
                { locationId: "l1", locationName: "Schweiz", locationActive: true, onHand: null, available: null, committed: null, unavailable: null },
              ],
            }),
          ],
          variantsTruncated: false,
          channels: [],
          channelsTruncated: false,
          shopLocations: [],
        }),
      })),
    );
    ui();

    const row = (await screen.findByText("Schweiz")).closest("tr")!;
    expect([...row.querySelectorAll("td")].slice(1, 4).map((td) => td.textContent)).toEqual(["—", "—", "—"]);
  });
});

describe("the variant's own settings", () => {
  it("edits SKU and barcode as FIELDS, not as part of the title", async () => {
    // Both used to be readable only as a suffix on the variant's name —
    // visible and uneditable at the same time.
    ui();
    await screen.findByLabelText("Variant");

    const sku = (await screen.findByLabelText(/^SKU/)) as HTMLInputElement;
    const barcode = (await screen.findByLabelText(/^Barcode/)) as HTMLInputElement;
    fireEvent.change(sku, { target: { value: "BX-15" } });
    fireEvent.change(barcode, { target: { value: "4006381333931" } });

    expect(sku.value).toBe("BX-15");
    expect(barcode.value).toBe("4006381333931");
  });

  it("hides the out-of-stock policy while the item is not tracked", async () => {
    // Untracked there is no zero for it to apply to, and a switch that
    // decides nothing invites the merchant to think it does.
    ui();
    await screen.findByLabelText("Variant");
    expect(screen.getByText(/Continue selling/i)).toBeTruthy();

    const tracked = screen.getAllByRole("switch")[0];
    fireEvent.click(tracked);

    await waitFor(() => expect(screen.queryByText(/Continue selling/i)).toBeNull());
  });

  it("says a group DISAGREES rather than picking one member's value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          variants: [
            variant("Weiss", "20cm", { sku: "A" }),
            variant("Weiss", "30cm", { sku: "B" }),
            variant("Rot", "20cm"),
            variant("Rot", "30cm"),
          ],
          variantsTruncated: false,
          channels: [],
          channelsTruncated: false,
          shopLocations: [],
        }),
      })),
    );
    ui();
    await pick("All Weiss");

    const sku = (await screen.findByLabelText(/^SKU/)) as HTMLInputElement;
    expect(sku.value).toBe("");
    expect(sku.placeholder).toMatch(/different/i);
  });
});
