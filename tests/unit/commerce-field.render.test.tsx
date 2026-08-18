/**
 * `CommerceField` renders in every state without breaking the Rules of Hooks.
 *
 * This file exists because of one shipped crash. The variant picker's
 * `shownVariant` was added as a `useMemo` placed BELOW the component's two
 * early returns (foreign locale, plan-blocked). React counts hooks per render,
 * so the moment a render took one of those branches the count dropped and the
 * editor tree unmounted into its error boundary — taking unsaved edits with it.
 *
 * Two real paths hit it: switching to a foreign locale on any product, and
 * every non-Pro shop on every product (the panel asks the endpoint, gets
 * `planRequired`, sets state, re-renders down the short branch). The suite was
 * green throughout, because nothing rendered this component at all.
 *
 * So the test is not about the picker. It is about the component surviving a
 * TRANSITION between its branches, which is the only thing that catches this.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { CommerceField } from "~/components/unified/CommerceField";

const PRODUCT = "gid://shopify/Product/1";

const variant = (id: string, title: string) => ({
  id,
  title,
  sku: null,
  cost: null,
  weight: null,
  weightUnit: null,
  harmonizedSystemCode: null,
  countryCodeOfOrigin: null,
  taxable: true,
  requiresShipping: true,
  inventoryItemId: `gid://shopify/InventoryItem/${id.split("/").pop()}`,
  inventoryTracked: true,
  inventoryPolicy: "DENY",
  levels: [],
  levelsTruncated: false,
});

function ui(props: Partial<Parameters<typeof CommerceField>[0]> = {}) {
  return (
    <AppProvider i18n={en}>
      <CommerceField
        productId={PRODUCT}
        label="Stock and sales channels"
        isPrimaryLocale
        t={{}}
        {...props}
      />
    </AppProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        variants: [variant("gid://shopify/ProductVariant/1", "S"), variant("gid://shopify/ProductVariant/2", "M")],
        variantsTruncated: false,
        channels: [],
        channelsTruncated: false,
        // Two warehouses, one of which the variant is not stocked at — the
        // case that made a merchant think the panel was broken.
        shopLocations: [
          { id: "gid://shopify/Location/1", name: "Berlin", isActive: true },
          { id: "gid://shopify/Location/2", name: "Spanien", isActive: true },
        ],
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommerceField render states", () => {
  it("survives the switch from the primary locale to a foreign one", async () => {
    // THE regression. The same instance renders the full panel, then the
    // short foreign-locale branch — which is where the hook count changed.
    const { rerender } = render(ui());
    await waitFor(() => expect(screen.getByLabelText("Variant")).toBeTruthy());

    expect(() => rerender(ui({ isPrimaryLocale: false }))).not.toThrow();
    expect(() => rerender(ui({ isPrimaryLocale: true }))).not.toThrow();
  });

  it("survives the plan gate answering after the first render", async () => {
    // The non-Pro path: mount renders the panel, the endpoint answers 403, the
    // component re-renders down its plan-blocked branch.
    vi.stubGlobal(
      "fetch",
      // The shape the route really answers with: `success: false` plus the
      // CODE, which the panel turns into its own message rather than into
      // "could not be loaded".
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ success: false, error: "planRequired" }) })),
    );

    render(ui());

    await waitFor(() => expect(screen.getByText(/Pro plan/i)).toBeTruthy());
  });

  it("shows ONE variant box with a picker, not one box per variant", async () => {
    render(ui());

    const picker = (await screen.findByLabelText("Variant")) as HTMLSelectElement;
    // Both variants are OPTIONS of one picker...
    expect([...picker.options].map((o) => o.textContent)).toEqual(["S", "M"]);
    // ...and only the selected one has a box. Before this change there were
    // two of every field on screen, stacked.
    expect(screen.queryAllByLabelText(/Cost per item/i).length).toBe(1);
  });

  it("gives an un-stocked location the same input as the others", async () => {
    // Shopify reports an inventory level only where an item is activated, so
    // the other warehouses are absent from `levels`. They get a field rather
    // than an "activate" button: typing a number IS what a merchant means by
    // "stock it here", and the activation rides along with the save.
    render(ui());

    expect(await screen.findByText("Spanien")).toBeTruthy();
    expect(screen.getByText("Berlin")).toBeTruthy();
    // The fixture's variant has no levels at all, so BOTH warehouses are
    // un-stocked — and both say so rather than being absent.
    expect(screen.getAllByText(/not stocked here/i).length).toBe(2);
    // No button anywhere: the row is editable directly.
    expect(screen.queryByRole("button", { name: /Stock here/i })).toBeNull();
    expect(screen.getAllByLabelText(/On hand/i).length).toBe(2);
  });
});
