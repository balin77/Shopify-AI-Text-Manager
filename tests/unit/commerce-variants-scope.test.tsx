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
