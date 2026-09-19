/**
 * Editing a whole group of variants at once.
 *
 * The dangerous half of this feature is not the write, it is what the fields
 * SHOW. A bulk price field that displayed one member's value would invite the
 * merchant either to leave it alone believing all twelve variants are that
 * price, or to touch it and overwrite eleven values they never saw. So the
 * tests are mostly about the difference between "they agree" and "they
 * differ" — for stock too, where the same question is asked of a quantity and
 * the wrong answer costs a merchant real inventory, and about the two fields
 * that identify ONE variant and are therefore locked on a group.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { CommerceVariantsSection } from "~/components/unified/CommerceVariantsSection";
import { CommerceDataProvider, useCommerceData } from "~/contexts/CommerceDataContext";

/** Drives the provider's save the way the editor's one save bar does. */
function SaveButton() {
  const commerce = useCommerceData();
  return (
    <button data-testid="save" onClick={() => void commerce?.save?.()}>
      save
    </button>
  );
}

/** The notices the provider produced. They RENDER in `CommerceField`, one
 *  component up, so a panel-only test has to read them from the context. */
function Notices() {
  const commerce = useCommerceData();
  return <div data-testid="notices">{(commerce?.notices ?? []).join(" | ")}</div>;
}

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
    unitQuantityValue: null,
    unitQuantityUnit: null,
    unitReferenceValue: null,
    unitReferenceUnit: null,
    showUnitPrice: false,
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

describe("SKU and barcode", () => {
  it("are editable for ONE variant", async () => {
    ui();
    // The single-variant scope is selected by default.
    const sku = (await screen.findByLabelText(/^SKU/)) as HTMLInputElement;
    const barcode = (await screen.findByLabelText(/^Barcode/)) as HTMLInputElement;
    expect(sku.disabled).toBe(false);
    expect(barcode.disabled).toBe(false);
    expect(screen.queryByText(/one variant at a time/i)).toBeNull();
  });

  it("are LOCKED on a group, and the panel says why", async () => {
    // Both identify exactly one variant: a SKU shared across twelve is lost
    // inventory control, and a shared barcode scans as the wrong article.
    ui();
    await pick("All variants");

    const sku = (await screen.findByLabelText(/^SKU/)) as HTMLInputElement;
    const barcode = (await screen.findByLabelText(/^Barcode/)) as HTMLInputElement;
    expect(sku.disabled).toBe(true);
    expect(barcode.disabled).toBe(true);
    // Shown, not hidden — a field that vanishes on a group reads as a bug.
    expect(await screen.findByText(/one variant at a time/i)).toBeTruthy();
  });

  it("unlocks again when a single variant is picked back", async () => {
    ui();
    await pick("All variants");
    await waitFor(async () =>
      expect(((await screen.findByLabelText(/^SKU/)) as HTMLInputElement).disabled).toBe(true),
    );

    await pick("Weiss / 20cm");
    await waitFor(async () =>
      expect(((await screen.findByLabelText(/^SKU/)) as HTMLInputElement).disabled).toBe(false),
    );
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

  it("moves the total for a quantity typed at a location NOT stocked yet", async () => {
    // Typing a number into such a row IS the request to start stocking it, so
    // it counts. The row contributes a real 0 only while it is left empty.
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
          shopLocations: [
            { id: "l1", name: "Schweiz", isActive: true },
            { id: "l2", name: "Spanien", isActive: true },
            { id: "l3", name: "Italien", isActive: true },
          ],
        }),
      })),
    );
    ui();

    const row = (await screen.findByText("Italien")).closest("tr")!;
    const total = () =>
      [...screen.getByText("Total").closest("tr")!.querySelectorAll("td")].map((td) => td.textContent).at(-1);
    expect(total()).toBe("30");

    fireEvent.change(row.querySelector("input")!, { target: { value: "7" } });
    expect(total()).toBe("37");
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

/**
 * Stock over a GROUP.
 *
 * The write is the easy half: one compare-and-swap per variant, which is what
 * a single variant already got. The table is where a wrong answer costs a
 * merchant real inventory, so most of this is about what a cell SAYS when the
 * twelve variants behind it do not agree.
 */
describe("bulk stock", () => {
  function stocked(colour: string, size: string, onHand: number | null, extra: Record<string, unknown> = {}) {
    return variant(colour, size, {
      levels: [
        {
          locationId: "l1",
          locationName: "Schweiz",
          locationActive: true,
          onHand,
          available: onHand,
          committed: 0,
          unavailable: 0,
        },
      ],
      ...extra,
    });
  }

  /** The POSTs a save produced. */
  function posted() {
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return calls
      .filter((c) => c[1]?.method === "POST")
      .map((c) => Object.fromEntries((c[1].body as FormData).entries()) as Record<string, string>);
  }

  function withVariants(list: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => ({
        ok: true,
        status: 200,
        json: async () =>
          init?.method === "POST"
            ? { success: true, warnings: [] }
            : {
                success: true,
                variants: list,
                variantsTruncated: false,
                channels: [],
                channelsTruncated: false,
                shopLocations: [],
              },
      })),
    );
  }

  function uiWithSave() {
    return render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
          <SaveButton />
          <Notices />
        </CommerceDataProvider>
      </AppProvider>,
    );
  }

  it("shows the quantity the members agree on", async () => {
    withVariants([
      stocked("Weiss", "20cm", 5),
      stocked("Weiss", "30cm", 5),
      stocked("Rot", "20cm", 9),
      stocked("Rot", "30cm", 9),
    ]);
    uiWithSave();
    await pick("All Weiss");

    const row = (await screen.findByText("Schweiz")).closest("tr")!;
    const input = row.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("5");
    expect(input.disabled).toBe(false);
  });

  it("shows ≠ where they differ — never a sum and never one member's number", async () => {
    // A sum would read as a total in a row whose input writes ONE number per
    // variant, which is how a restock turns into an overwrite.
    withVariants([
      stocked("Weiss", "20cm", 5),
      stocked("Weiss", "30cm", 7),
      stocked("Rot", "20cm", 9),
      stocked("Rot", "30cm", 9),
    ]);
    uiWithSave();
    await pick("All Weiss");

    const row = (await screen.findByText("Schweiz")).closest("tr")!;
    const input = row.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("\u2260");
    // The read-only columns say the same thing rather than 12 or 5.
    expect([...row.querySelectorAll("td")].slice(1, 4).map((td) => td.textContent)).toEqual([
      "0", "0", "\u2260",
    ]);
  });

  it("writes the typed number to EVERY member, each against its own quantity", async () => {
    withVariants([
      stocked("Weiss", "20cm", 5),
      stocked("Weiss", "30cm", 7),
      stocked("Rot", "20cm", 9),
      stocked("Rot", "30cm", 9),
    ]);
    const { container } = uiWithSave();
    await pick("All Weiss");

    const row = (await screen.findByText("Schweiz")).closest("tr")!;
    fireEvent.change(row.querySelector("input")!, { target: { value: "10" } });
    fireEvent.click(container.querySelector("[data-testid=save]")!);

    await waitFor(() => expect(posted().length).toBe(2));
    const calls = posted();
    expect(calls.every((c) => c.intent === "stock")).toBe(true);
    expect(calls.map((c) => c.variantId).sort()).toEqual(["Weiss-20cm", "Weiss-30cm"]);
    // Each carries ITS OWN compareQuantity — nothing was summed or averaged.
    const changes = calls.map((c) => JSON.parse(c.changes)[0]);
    expect(changes.map((c) => c.quantity)).toEqual(["10", "10"]);
    expect(changes.map((c) => c.compareQuantity).sort()).toEqual(["5", "7"]);
  });

  it("writes nothing for a mixed field that was typed into and cleared again", async () => {
    withVariants([
      stocked("Weiss", "20cm", 5),
      stocked("Weiss", "30cm", 7),
      stocked("Rot", "20cm", 9),
      stocked("Rot", "30cm", 9),
    ]);
    const { container } = uiWithSave();
    await pick("All Weiss");

    const row = (await screen.findByText("Schweiz")).closest("tr")!;
    fireEvent.change(row.querySelector("input")!, { target: { value: "10" } });
    fireEvent.change(row.querySelector("input")!, { target: { value: "" } });
    fireEvent.click(container.querySelector("[data-testid=save]")!);

    await waitFor(() => expect(posted().length).toBe(0));
  });

  it("names the variant a stock warning is about", async () => {
    // Deduped notices plus a per-variant compare-and-swap: without the title,
    // "the stock changed while you were editing" reads as if the whole save
    // was refused while eleven of twelve variants were in fact written.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => ({
        ok: true,
        status: 200,
        json: async () =>
          init?.method === "POST"
            ? { success: true, warnings: ["stockChangedMeanwhile"] }
            : {
                success: true,
                variants: [
                  stocked("Weiss", "20cm", 5),
                  stocked("Weiss", "30cm", 7),
                  stocked("Rot", "20cm", 9),
                  stocked("Rot", "30cm", 9),
                ],
                variantsTruncated: false,
                channels: [],
                channelsTruncated: false,
                shopLocations: [],
              },
      })),
    );
    const { container } = uiWithSave();
    await pick("All Weiss");

    const row = (await screen.findByText("Schweiz")).closest("tr")!;
    fireEvent.change(row.querySelector("input")!, { target: { value: "10" } });
    fireEvent.click(container.querySelector("[data-testid=save]")!);

    await waitFor(() => {
      const notices = container.querySelector("[data-testid=notices]")!.textContent!;
      expect(notices).toMatch(/Weiss \/ 20cm/);
      expect(notices).toMatch(/Weiss \/ 30cm/);
    });
  });

  it("leaves an untrackable member OUT of the table and says how many", async () => {
    // A variant with no InventoryItem has nothing to write to. Offering a row
    // for it would queue a write the save can only answer with a warning.
    withVariants([
      stocked("Weiss", "20cm", 5),
      stocked("Weiss", "30cm", 5, { inventoryItemId: null }),
      stocked("Rot", "20cm", 9),
      stocked("Rot", "30cm", 9),
    ]);
    const { container } = uiWithSave();
    await pick("All Weiss");

    expect(await screen.findByText(/1 of 2 variants/i)).toBeTruthy();
    // The hint counts the ones that ARE in the table.
    expect(screen.getByText(/for EACH of the 1 variants/i)).toBeTruthy();

    const row = screen.getByText("Schweiz").closest("tr")!;
    fireEvent.change(row.querySelector("input")!, { target: { value: "10" } });
    fireEvent.click(container.querySelector("[data-testid=save]")!);
    await waitFor(() => expect(posted().length).toBe(1));
    expect(posted()[0].variantId).toBe("Weiss-20cm");
  });

  it("says a location is not stocked at EVERY member, and still writes there", async () => {
    // Half the group is activated at the location and half is not. The typed
    // number sets a quantity for the one and starts stocking the other.
    withVariants([
      stocked("Weiss", "20cm", 5),
      variant("Weiss", "30cm", { levels: [] }),
      stocked("Rot", "20cm", 9),
      stocked("Rot", "30cm", 9),
    ]);
    const { container } = uiWithSave();
    await pick("All Weiss");

    expect(await screen.findByText(/not stocked at every variant/i)).toBeTruthy();

    const row = screen.getByText("Schweiz").closest("tr")!;
    fireEvent.change(row.querySelector("input")!, { target: { value: "10" } });
    fireEvent.click(container.querySelector("[data-testid=save]")!);

    await waitFor(() => expect(posted().length).toBe(2));
    const intents = posted().map((c) => c.intent).sort();
    // One compare-and-swap, one activation — never a compare-less overwrite.
    expect(intents).toEqual(["activate", "stock"]);
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

    // BY NAME, not by index: the panel has several switches now and their
    // order is a layout decision.
    const tracked = screen.getByRole("switch", { name: /Track quantity/i });
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

    // Locked on a group, but still SHOWING what it knows: an empty box with no
    // hint would read as "they are all empty".
    const sku = (await screen.findByLabelText(/^SKU/)) as HTMLInputElement;
    expect(sku.value).toBe("");
    expect(sku.placeholder).toMatch(/different/i);
  });
});

describe("what a bulk save SENDS", () => {
  /** The POSTs a save produced, as {intent, variantId, …} objects. */
  function posted() {
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return calls
      .filter((c) => c[1]?.method === "POST")
      .map((c) => Object.fromEntries((c[1].body as FormData).entries()) as Record<string, string>);
  }

  function withVariants(list: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => ({
        ok: true,
        status: 200,
        json: async () =>
          init?.method === "POST"
            ? { success: true, warnings: [] }
            : {
                success: true,
                variants: list,
                variantsTruncated: false,
                channels: [],
                channelsTruncated: false,
                shopLocations: [],
              },
      })),
    );
  }

  it("writes NOTHING for a mixed field the merchant typed into and cleared again", async () => {
    // The field shows "" because the members DISAGREE — that is "unknown", not
    // "empty". Without a way back to untouched, a merchant who typed a
    // character and deleted it again sent `barcode: ""` for every member and
    // Shopify cleared values they had never seen.
    withVariants([
      variant("Weiss", "20cm", { compareAtPrice: "19.00" }),
      variant("Weiss", "30cm", { compareAtPrice: "21.00" }),
      variant("Rot", "20cm"),
      variant("Rot", "30cm"),
    ]);
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
          <SaveButton />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await pick("All Weiss");

    const compareAt = (await screen.findByLabelText(/^Compare-at/)) as HTMLInputElement;
    expect(compareAt.value).toBe("");
    fireEvent.change(compareAt, { target: { value: "9" } });
    fireEvent.change(compareAt, { target: { value: "" } });

    fireEvent.click(container.querySelector("[data-testid=save]")!);
    await waitFor(() => expect(posted().length).toBe(0));
  });

  it("still CLEARS a field the members agree on", async () => {
    // Where they agree the field was showing the value being erased, so ""
    // keeps its ordinary meaning.
    withVariants([
      variant("Weiss", "20cm", { compareAtPrice: "19.00" }),
      variant("Weiss", "30cm", { compareAtPrice: "19.00" }),
      variant("Rot", "20cm"),
      variant("Rot", "30cm"),
    ]);
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
          <SaveButton />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await pick("All Weiss");

    const compareAt = (await screen.findByLabelText(/^Compare-at/)) as HTMLInputElement;
    expect(compareAt.value).toBe("19.00");
    fireEvent.change(compareAt, { target: { value: "" } });

    fireEvent.click(container.querySelector("[data-testid=save]")!);
    await waitFor(() => expect(posted().length).toBe(2));
    expect(posted().every((p) => p.compareAtPrice === "" && p.intent === "price")).toBe(true);
  });

  it("skips members that already hold the typed value", async () => {
    withVariants([
      variant("Weiss", "20cm", { price: "10.00" }),
      variant("Weiss", "30cm", { price: "12.00" }),
      variant("Rot", "20cm"),
      variant("Rot", "30cm"),
    ]);
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
          <SaveButton />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await pick("All Weiss");

    const price = (await screen.findByLabelText(/^Price/)) as HTMLInputElement;
    fireEvent.change(price, { target: { value: "10.00" } });

    fireEvent.click(container.querySelector("[data-testid=save]")!);
    // Only the 12.00 one moved.
    await waitFor(() => expect(posted().length).toBe(1));
    expect(posted()[0].variantId).toBe("Weiss-30cm");
  });
});

describe("a mixed group's BOOLEAN controls", () => {
  function withMixedTracking() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          variants: [
            variant("Weiss", "20cm", { inventoryTracked: true }),
            variant("Weiss", "30cm", { inventoryTracked: false }),
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
  }

  it("does not render a half-tracked group as OFF", async () => {
    // A switch's POSITION is the claim a merchant reads, and "off" over a
    // group that is half tracked asserts something untrue about half of it.
    withMixedTracking();
    ui();
    await pick("All Weiss");

    const tracked = screen.getByRole("switch", { name: /Track quantity/i });
    expect(tracked.getAttribute("aria-checked")).toBe("mixed");
  });

  it("keeps the out-of-stock policy REACHABLE on a mixed group", async () => {
    // It used to disappear entirely: the same expression gated the render and
    // read false for a mixed group, so the setting became invisible and
    // uneditable with no explanation.
    withMixedTracking();
    ui();
    await pick("All Weiss");

    expect(await screen.findByText(/Continue selling/i)).toBeTruthy();
  });
});

describe("the layout the merchant asked for", () => {
  it("shows no title inside the box — the picker already says it", async () => {
    ui();
    const select = await screen.findByLabelText("Variant");

    // Every occurrence of the variant's name belongs to the PICKER. It used to
    // be repeated as a heading inside the box directly beneath it.
    const picker = select.closest(".Polaris-Select")!;
    for (const node of screen.getAllByText("Weiss / 20cm")) {
      expect(picker.contains(node)).toBe(true);
    }
  });

  it("keeps the badge's row even for ONE variant, so nothing jumps", async () => {
    // Switching from a single variant to a group used to move the whole panel
    // down by the height of a badge that had just appeared.
    const { container } = ui();
    await screen.findByLabelText("Variant");

    const reserved = () =>
      [...container.querySelectorAll("div")].find((d) => d.style.minHeight === "20px");
    expect(reserved()).toBeTruthy();
    expect(reserved()!.textContent).toBe("");

    await pick("All variants");
    expect(reserved()!.textContent).toMatch(/4 variants/);
  });

  it("charges tax through a switch that WRITES, not a read-only readout", async () => {
    ui();
    await screen.findByLabelText("Variant");

    const taxable = screen.getByRole("switch", { name: /Charge tax/i });
    expect(taxable.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(taxable);
    expect(taxable.getAttribute("aria-checked")).toBe("false");
  });

  it("puts SKU and barcode under the stock table", async () => {
    ui();
    const sku = await screen.findByLabelText(/^SKU/);
    const table = document.querySelector("table");
    expect(table).toBeTruthy();
    // `compareDocumentPosition` says which comes first in the document.
    expect(table!.compareDocumentPosition(sku) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the shipping card", () => {
  it("folds the customs fields away, and opens them on request", async () => {
    // An HS code and a country of origin matter to merchants who ship across a
    // border and to nobody else; unfolded they doubled the card's height.
    ui();
    await screen.findByLabelText("Variant");

    expect(screen.queryByLabelText(/HS code/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /More details/i }));
    expect(await screen.findByLabelText(/HS code/i)).toBeTruthy();
    expect(screen.getByLabelText(/Country of origin/i)).toBeTruthy();
  });

  it("disables every shipping input when it is not a physical product", async () => {
    // There is no weight to declare and no customs to clear, so the fields are
    // locked rather than left to be filled with numbers Shopify ignores.
    ui();
    await screen.findByLabelText("Variant");
    fireEvent.click(screen.getByRole("button", { name: /More details/i }));

    const weight = (await screen.findByLabelText(/^Weight/i)) as HTMLInputElement;
    const unit = screen.getByLabelText(/^Unit/i) as HTMLSelectElement;
    const hs = screen.getByLabelText(/HS code/i) as HTMLInputElement;
    expect(weight.disabled).toBe(false);

    fireEvent.click(screen.getByRole("switch", { name: /Physical product/i }));

    await waitFor(() => expect(weight.disabled).toBe(true));
    expect(unit.disabled).toBe(true);
    expect(hs.disabled).toBe(true);
    // …and the switch itself stays usable, or there would be no way back.
    expect((screen.getByRole("switch", { name: /Physical product/i }) as HTMLInputElement).disabled).toBe(false);
  });
});

describe("the Grundpreis in the panel", () => {
  function posted() {
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return calls
      .filter((c) => c[1]?.method === "POST")
      .map((c) => Object.fromEntries((c[1].body as FormData).entries()) as Record<string, string>);
  }

  function withVariants(list: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) => ({
        ok: true,
        status: 200,
        json: async () =>
          init?.method === "POST"
            ? { success: true, warnings: [] }
            : {
                success: true,
                variants: list,
                variantsTruncated: false,
                channels: [],
                channelsTruncated: false,
                shopLocations: [],
              },
      })),
    );
  }

  async function openUnitPrice() {
    fireEvent.click(await screen.findByText(/Unit price/));
  }

  const WITH_UNIT = {
    unitQuantityValue: "500",
    unitQuantityUnit: "G",
    unitReferenceValue: "1",
    unitReferenceUnit: "KG",
  };

  it("shows the value in the FOLDED label, so nobody has to unfold to check", async () => {
    withVariants([variant("Weiss", "20cm", WITH_UNIT)]);
    render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
        </CommerceDataProvider>
      </AppProvider>,
    );

    expect(await screen.findByText(/500 g \/ 1 kg/)).toBeTruthy();
  });

  it("puts both cards on the section's shared rows, so the buttons line up", async () => {
    // The mechanism, not the pixels — jsdom computes no layout. Each card is a
    // subgrid spanning the section's two rows with exactly two children,
    // content and footer, so the footer row starts at the same y in both
    // whatever is open. Pinning each button to the bottom of its own card
    // looked identical while both were closed and came apart the moment one
    // was opened.
    withVariants([variant("Weiss", "20cm", WITH_UNIT)]);
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await screen.findByText(/Unit price/);

    const cards = [...container.querySelectorAll("div")].filter(
      (el) => (el as HTMLElement).style.gridTemplateRows === "subgrid",
    ) as HTMLElement[];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.style.gridRow).toBe("span 2");
      expect(card.children).toHaveLength(2);
      // The disclosure lives in the SECOND row, which is the one that has to
      // start at a shared line.
      expect(card.children[1].querySelector("button")).toBeTruthy();
    }
  });

  it("gives the two unit pickers DISTINCT names, without a visible caption", async () => {
    // Two rules that pull against each other. A screen reader must be able to
    // tell pack quantity from reference quantity — and from the shipping
    // weight one card over, which is also called "Unit" — so the names differ.
    // But a name that distinct wraps over a box two words wide, which stepped
    // the number and its unit out of line, so it is hidden rather than shown.
    withVariants([variant("Weiss", "20cm", WITH_UNIT)]);
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await openUnitPrice();

    expect(await screen.findByLabelText("Total quantity unit")).toBeTruthy();
    expect(await screen.findByLabelText("Reference unit")).toBeTruthy();
    // Hidden, not absent: Polaris keeps the element and takes it out of the
    // visual flow.
    const labels = [...container.querySelectorAll("#commerce-unit-price label")];
    const unitLabels = labels.filter((l) => /unit$/i.test(l.textContent ?? ""));
    expect(unitLabels).toHaveLength(2);
    for (const label of unitLabels) {
      expect(label.closest(".Polaris-Labelled--hidden")).toBeTruthy();
    }
  });

  it("sends ALL FOUR fields when only ONE of them changed", async () => {
    // Shopify REPLACES the measurement object rather than merging into it, so
    // a save carrying only the field that moved would write a measurement
    // three quarters empty.
    withVariants([variant("Weiss", "20cm", WITH_UNIT)]);
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
          <SaveButton />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await openUnitPrice();

    const quantity = (await screen.findByLabelText(/Total quantity$/)) as HTMLInputElement;
    fireEvent.change(quantity, { target: { value: "250" } });
    fireEvent.click(container.querySelector("[data-testid=save]")!);

    await waitFor(() => expect(posted().length).toBe(1));
    expect(posted()[0]).toMatchObject({
      unitQuantityValue: "250",
      unitQuantityUnit: "G",
      unitReferenceValue: "1",
      unitReferenceUnit: "KG",
    });
  });

  it("sends nothing at all when the measurement was not touched", async () => {
    // The four fields are read off every variant on every save; a diff that
    // compared them wrongly would repost an unchanged Grundpreis for the whole
    // catalogue.
    withVariants([variant("Weiss", "20cm", WITH_UNIT), variant("Rot", "20cm", WITH_UNIT)]);
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
          <SaveButton />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await openUnitPrice();
    fireEvent.click(container.querySelector("[data-testid=save]")!);

    await waitFor(() => expect(posted().length).toBe(0));
  });

  it("does not wipe a measurement the merchant never saw", async () => {
    // The dangerous shape of this feature: on a group whose members DISAGREE
    // the four boxes show "" — which means "unknown", not "empty". A merchant
    // who types into one and deletes it again must send nothing.
    withVariants([
      variant("Weiss", "20cm", WITH_UNIT),
      variant("Weiss", "30cm"),
      variant("Rot", "20cm"),
      variant("Rot", "30cm"),
    ]);
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
          <SaveButton />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await pick("All Weiss");
    await openUnitPrice();

    const quantity = (await screen.findByLabelText(/Total quantity$/)) as HTMLInputElement;
    expect(quantity.value).toBe("");
    fireEvent.change(quantity, { target: { value: "9" } });
    fireEvent.change(quantity, { target: { value: "" } });

    fireEvent.click(container.querySelector("[data-testid=save]")!);
    await waitFor(() => expect(posted().length).toBe(0));
  });

  it("names the variant when a group edit refuses for one member", async () => {
    // The member with no measurement gets a partial quartet — for a
    // Grundpreis the merchant never saw. The refusal is unavoidable; a
    // sentence with no subject is not.
    const list = [
      variant("Weiss", "20cm", WITH_UNIT),
      variant("Weiss", "30cm"),
      variant("Rot", "20cm"),
      variant("Rot", "30cm"),
    ];
    // The server's own rule, stubbed: a quartet that is neither wholly empty
    // nor wholly filled is refused.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; body?: FormData }) => {
        if (init?.method !== "POST") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true, variants: list, variantsTruncated: false,
              channels: [], channelsTruncated: false, shopLocations: [],
            }),
          };
        }
        const sent = ["unitQuantityValue", "unitQuantityUnit", "unitReferenceValue", "unitReferenceUnit"]
          .map((key) => String(init.body?.get(key) ?? ""));
        const filled = sent.filter((value) => value !== "").length;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            warnings: filled > 0 && filled < 4 ? ["unitPriceIncomplete"] : [],
          }),
        };
      }),
    );
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider
          productId={PRODUCT}
          isPrimaryLocale
          t={{ warnings: { unitPriceIncomplete: "needs all four" } }}
        >
          <CommerceVariantsSection />
          <SaveButton />
          <Notices />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await pick("All Weiss");
    await openUnitPrice();

    // Only the reference VALUE is typed, so the member without a measurement
    // sends one field of four.
    fireEvent.change(await screen.findByLabelText(/Reference quantity$/), { target: { value: "2" } });
    fireEvent.click(container.querySelector("[data-testid=save]")!);

    await waitFor(() =>
      expect(screen.getByTestId("notices").textContent).toMatch(/Weiss \/ 30cm: needs all four/),
    );
  });

  it("clears all four when the merchant empties the boxes", async () => {
    withVariants([variant("Weiss", "20cm", WITH_UNIT)]);
    const { container } = render(
      <AppProvider i18n={en}>
        <CommerceDataProvider productId={PRODUCT} isPrimaryLocale t={{}}>
          <CommerceVariantsSection />
          <SaveButton />
        </CommerceDataProvider>
      </AppProvider>,
    );
    await openUnitPrice();

    fireEvent.change(await screen.findByLabelText(/Total quantity$/), { target: { value: "" } });
    fireEvent.change(await screen.findByLabelText(/Reference quantity$/), { target: { value: "" } });
    // Scoped to the disclosure: "Unit" is also the weight field's label one
    // card over, and picking by label alone reaches the wrong Select.
    const units = container.querySelectorAll("#commerce-unit-price select");
    expect(units).toHaveLength(2);
    for (const select of units) fireEvent.change(select, { target: { value: "" } });

    fireEvent.click(container.querySelector("[data-testid=save]")!);
    await waitFor(() => expect(posted().length).toBe(1));
    expect(posted()[0]).toMatchObject({
      unitQuantityValue: "",
      unitQuantityUnit: "",
      unitReferenceValue: "",
      unitReferenceUnit: "",
    });
  });
});
