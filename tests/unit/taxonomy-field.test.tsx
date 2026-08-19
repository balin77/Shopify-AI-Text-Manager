/**
 * The category picker's browse half — the rules that make a row unambiguous.
 *
 * The search half has been in production and is unchanged; what is new is
 * clicking your way down the tree, and three of its rules are the kind that
 * look like styling until they cost a merchant a wrong category:
 *
 *   - A row WITH children descends and does not select. If it did both, the
 *     click that opens "Bekleidung & Accessoires" would also file the product
 *     under it.
 *   - The branch you are standing in is selectable, but only from its OWN
 *     level, as the first entry. A branch is a valid value on Shopify's side,
 *     so it has to be reachable — just not by mis-clicking.
 *   - A LEAF selects directly. Descending into a leaf is a screen with nothing
 *     on it, at exactly the moment the merchant is done.
 *
 * And `onPick` has to carry the NAME, because the derived product type is
 * built from it and the label exists nowhere else at that moment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { TaxonomyField } from "~/components/unified/TaxonomyField";

const gid = (n: number) => `gid://shopify/TaxonomyCategory/${n}`;

/** Two levels of a miniature taxonomy, keyed by the parent asked for. */
const LEVELS: Record<string, Array<{ id: string; name: string; fullName: string; isLeaf: boolean }>> = {
  "": [
    { id: gid(1), name: "Apparel & Accessories", fullName: "Apparel & Accessories", isLeaf: false },
    { id: gid(2), name: "Furniture", fullName: "Furniture", isLeaf: false },
  ],
  [gid(1)]: [
    { id: gid(11), name: "Clothing", fullName: "Apparel & Accessories > Clothing", isLeaf: false },
    { id: gid(12), name: "Jewelry", fullName: "Apparel & Accessories > Jewelry", isLeaf: true },
  ],
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.searchParams.get("kind") === "taxonomy-children") {
      const parent = url.searchParams.get("parent") ?? "";
      return {
        json: async () => ({
          success: true,
          level: { parentId: parent, categories: LEVELS[parent] ?? [], truncated: false },
        }),
      } as Response;
    }
    return { json: async () => ({ success: true, tooShort: false, categories: [] }) } as Response;
  });
}

function ui(props: Partial<React.ComponentProps<typeof TaxonomyField>> = {}) {
  return (
    <AppProvider i18n={en}>
      <TaxonomyField
        value=""
        onChange={() => {}}
        currentLabel=""
        label="Product category"
        t={{}}
        {...props}
      />
    </AppProvider>
  );
}

/** The activator carries the current value, or "Not set". */
const openPicker = async () => {
  fireEvent.click(screen.getByRole("button", { name: /not set/i }));
  await waitFor(() => expect(screen.getByText("Apparel & Accessories")).toBeTruthy());
};

describe("TaxonomyField — browsing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens on the top level and asks for it with an empty parent", async () => {
    render(ui());
    await openPicker();

    expect(screen.getByText("Furniture")).toBeTruthy();
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("kind=taxonomy-children") && u.includes("parent="))).toBe(true);
  });

  it("descends on a branch row instead of selecting it", async () => {
    const onChange = vi.fn();
    const onPick = vi.fn();
    render(ui({ onChange, onPick }));
    await openPicker();

    fireEvent.click(screen.getByText("Apparel & Accessories"));
    await waitFor(() => expect(screen.getByText("Clothing")).toBeTruthy());

    // The whole point: opening a branch is not choosing it.
    expect(onChange).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("offers the branch it descended into as the one way to choose it", async () => {
    const onChange = vi.fn();
    const onPick = vi.fn();
    render(ui({ onChange, onPick }));
    await openPicker();

    fireEvent.click(screen.getByText("Apparel & Accessories"));
    await waitFor(() => expect(screen.getByText("choose this category")).toBeTruthy());

    fireEvent.click(screen.getByText("choose this category"));
    expect(onChange).toHaveBeenCalledWith(gid(1));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: gid(1), name: "Apparel & Accessories" }));
  });

  it("selects a leaf directly — there is no level below it to open", async () => {
    const onChange = vi.fn();
    const onPick = vi.fn();
    render(ui({ onChange, onPick }));
    await openPicker();

    fireEvent.click(screen.getByText("Apparel & Accessories"));
    await waitFor(() => expect(screen.getByText("Jewelry")).toBeTruthy());

    fireEvent.click(screen.getByText("Jewelry"));
    expect(onChange).toHaveBeenCalledWith(gid(12));
    // The NAME travels with it: the derived product type is built from the
    // leaf, and it exists nowhere else at this moment.
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "Jewelry" }));
  });

  it("climbs back to the level above", async () => {
    render(ui());
    await openPicker();

    fireEvent.click(screen.getByText("Apparel & Accessories"));
    await waitFor(() => expect(screen.getByText("Clothing")).toBeTruthy());

    fireEvent.click(screen.getByText("Back to all"));
    await waitFor(() => expect(screen.getByText("Furniture")).toBeTruthy());
    // And the branch entry is gone with the level it belonged to.
    expect(screen.queryByText("choose this category")).toBeNull();
  });

  it("says a lookup FAILED rather than showing an empty tree", async () => {
    // The rule every list in this app follows: an unanswered question is not a
    // negative answer. Rendered as "no subcategories" this would send the
    // merchant looking for a branch that is right there.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ success: false, error: "boom" }) }) as Response),
    );
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: /not set/i }));

    await waitFor(() => expect(screen.getByText(/could not be loaded/i)).toBeTruthy());
    expect(screen.queryByText(/no subcategories/i)).toBeNull();
  });

  it("shows the whole path once a category is set, never the GID", () => {
    render(
      ui({ value: gid(12), currentLabel: "Apparel & Accessories > Jewelry" }),
    );
    expect(screen.getByRole("button", { name: /Apparel & Accessories > Jewelry/ })).toBeTruthy();
    expect(screen.queryByText(/gid:\/\//)).toBeNull();
  });
});
