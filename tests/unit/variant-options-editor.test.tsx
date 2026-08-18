/**
 * The variants card.
 *
 * Written before anyone has seen this component in a browser, and aimed at the
 * three things that are not layout:
 *
 *   1. A collapsed card SHOWS its values and hides its inputs. That is the
 *      whole point of the rebuild — the old card put a text field on screen for
 *      every colour a product has.
 *   2. Deleting a value asks first, and names how many variants go with it.
 *      Shopify deletes those variants with their stock, prices and SKUs, and a
 *      confirmation that does not say so is not a confirmation.
 *   3. Nothing here writes. Every action edits pending state that the editor's
 *      one save bar carries — the same rule the rest of the editor follows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { VariantOptionsEditor } from "~/components/unified/VariantOptionsEditor";
import { variantCountKey } from "~/services/product-options.shared";

const OPTION = "gid://shopify/ProductOption/1";
const SECOND = "gid://shopify/ProductOption/2";

const options = [
  {
    id: OPTION,
    name: "Colour",
    position: 1,
    values: [
      { id: "gid://shopify/ProductOptionValue/1", name: "Red" },
      { id: "gid://shopify/ProductOptionValue/2", name: "Blue" },
    ],
  },
  {
    id: SECOND,
    name: "Size",
    position: 2,
    values: [{ id: "gid://shopify/ProductOptionValue/3", name: "S" }],
  },
];

const handlers = () => ({
  onNameChange: vi.fn(),
  onValuesChange: vi.fn(),
  onAddValue: vi.fn(),
  onRemoveValue: vi.fn(),
  onEditPendingValue: vi.fn(),
  onCreateOption: vi.fn(),
  onDeleteOption: vi.fn(),
  onReorder: vi.fn(),
  onCancelCreateOption: vi.fn(),
  onReorderValues: vi.fn(),
  onOpenMetaobjects: vi.fn(),
});

function ui(overrides: Record<string, unknown> = {}) {
  const spies = handlers();
  const view = render(
    <AppProvider i18n={en}>
      <VariantOptionsEditor
        productId="gid://shopify/Product/1"
        options={options}
        primaryOptions={{}}
        valuesToAdd={{}}
        valuesToDelete={{}}
        optionsToCreate={[]}
        optionsToDelete={[]}
        {...spies}
        {...overrides}
      />
    </AppProvider>,
  );
  return { ...view, spies };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        counts: { [variantCountKey("Colour", "Red")]: 3 },
        swatches: { "gid://shopify/ProductOptionValue/2": { color: "#0000FF" } },
      }),
    })),
  );
  // jsdom here provides no `confirm`, so it is stubbed rather than spied on.
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VariantOptionsEditor", () => {
  it("shows values without showing inputs until a card is opened", () => {
    ui();

    // Both options and all their values are readable...
    expect(screen.getByText("Colour")).toBeTruthy();
    expect(screen.getByText("Red")).toBeTruthy();
    expect(screen.getByText("S")).toBeTruthy();
    // ...and not one of them is a text field. The old card rendered one per
    // value, which is what filled the screen.
    expect(screen.queryAllByRole("textbox").length).toBe(0);
  });

  it("opens one card at a time, on click", () => {
    ui();

    fireEvent.click(screen.getByText("Colour"));

    // The option's name and its two values are now editable — and Size is not.
    const boxes = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(boxes.some((b) => b.value === "Colour")).toBe(true);
    expect(boxes.some((b) => b.value === "Red")).toBe(true);
    expect(boxes.some((b) => b.value === "S")).toBe(false);
  });

  it("names the number of variants a value delete would take with it", async () => {
    const { spies } = ui();
    fireEvent.click(screen.getByText("Colour"));
    // The impact is fetched when the card opens.
    await screen.findByDisplayValue("Red");

    fireEvent.click(screen.getAllByRole("button", { name: /Remove value/i })[0]);

    // A Polaris Modal, not `window.confirm`: inside the embedded admin iframe
    // the native dialog is a focus trap, and the browser's "prevent additional
    // dialogs" checkbox suppresses it entirely — deleting a merchant's
    // variants with no confirmation at all.
    expect(window.confirm as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(screen.getByText(/3 variant/i)).toBeTruthy();
    // Nothing happens until the modal is answered.
    expect(spies.onRemoveValue).not.toHaveBeenCalled();

    // The card has a Delete button of its own, so the modal's is addressed
    // through the dialog rather than by label.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Delete$/i }));
    expect(spies.onRemoveValue).toHaveBeenCalledWith(OPTION, "gid://shopify/ProductOptionValue/1");
  });

  it("keeps the value when the confirmation is dismissed", async () => {
    const { spies } = ui();
    fireEvent.click(screen.getByText("Colour"));
    await screen.findByDisplayValue("Red");
    fireEvent.click(screen.getAllByRole("button", { name: /Remove value/i })[0]);

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    expect(spies.onRemoveValue).not.toHaveBeenCalled();
  });

  it("counts under the SAVED name, not the one being typed", async () => {
    // The map is keyed on what Shopify reports in `selectedOptions`, so looking
    // it up under a pending rename made every count read as unavailable.
    const { spies } = ui({ primaryOptions: { [OPTION]: { name: "Colour", values: ["Crimson", "Blue"] } } });
    fireEvent.click(screen.getByText("Colour"));
    await screen.findByDisplayValue("Crimson");

    fireEvent.click(screen.getAllByRole("button", { name: /Remove value/i })[0]);

    expect(screen.getByText(/3 variant/i)).toBeTruthy();
    expect(spies.onRemoveValue).not.toHaveBeenCalled();
  });

  it("says it could not count rather than showing a zero", async () => {
    // A zero would read as "nothing depends on this, delete freely" — the exact
    // opposite of what an unanswered question means.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ success: false }) })));
    ui();
    fireEvent.click(screen.getByText("Colour"));
    await screen.findByDisplayValue("Red");
    fireEvent.click(screen.getAllByRole("button", { name: /Remove value/i })[0]);

    expect(screen.getByText(/could not be read/i)).toBeTruthy();
  });

  it("refuses to remove the last value of an option", () => {
    // Shopify keeps every option on at least one value.
    const { spies } = ui();
    fireEvent.click(screen.getByText("Size"));

    const remove = screen.getAllByRole("button", { name: /Remove value/i })[0];
    // Polaris marks a disabled button with `aria-disabled` and no `disabled`
    // attribute, so the assertion has to read what it actually renders — and
    // the click is asserted too, since aria-disabled alone is decoration.
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(remove);
    expect(spies.onRemoveValue).not.toHaveBeenCalled();
  });

  it("refuses to delete the last option", () => {
    const { spies } = ui({ options: [options[0]] });
    fireEvent.click(screen.getByText("Colour"));

    const del = screen.getAllByRole("button", { name: /^Delete$/i })[0];
    expect(del.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(del);
    expect(spies.onDeleteOption).not.toHaveBeenCalled();
  });

  it("shows a pending add straight away, before any save", () => {
    // Rendering only the saved list would make the merchant's own addition look
    // like it had not registered.
    ui({ valuesToAdd: { [OPTION]: ["Green"] } });

    expect(screen.getByText("Green")).toBeTruthy();
  });

  it("hides a value that is pending deletion", () => {
    ui({ valuesToDelete: { [OPTION]: ["gid://shopify/ProductOptionValue/2"] } });

    expect(screen.queryByText("Blue")).toBeNull();
    expect(screen.getByText("Red")).toBeTruthy();
  });

  it("hides an option that is pending deletion", () => {
    ui({ optionsToDelete: [SECOND] });

    expect(screen.queryByText("Size")).toBeNull();
  });

  it("collects a brand-new option instead of writing it", () => {
    const { spies } = ui();

    fireEvent.click(screen.getByRole("button", { name: /Add variant/i }));
    const nameField = screen.getByLabelText("Option name");
    fireEvent.change(nameField, { target: { value: "Material" } });
    const valueFields = screen.getAllByLabelText("Value");
    fireEvent.change(valueFields[valueFields.length - 1], { target: { value: "Cotton" } });
    fireEvent.click(screen.getByRole("button", { name: /^Done$/i }));

    expect(spies.onCreateOption).toHaveBeenCalledWith("Material", ["Cotton"]);
  });
});

describe("VariantOptionsEditor — a product with no options yet", () => {
  it("still offers to add one", () => {
    // A single-variant product HAS no options (the loader drops Shopify's
    // "Title" placeholder), and it is exactly the product for which adding one
    // is the point.
    ui({ options: [] });

    expect(screen.getByRole("button", { name: /Add variant/i })).toBeTruthy();
  });

  it("lets a queued option be dropped again before it is saved", () => {
    // Nothing has been written, so this takes nothing with it — without it the
    // only way out of a mistyped option was discarding every other edit too.
    const spies = handlers();
    render(
      <AppProvider i18n={en}>
        <VariantOptionsEditor
          productId="gid://shopify/Product/1"
          options={options}
          primaryOptions={{}}
          valuesToAdd={{}}
          valuesToDelete={{}}
          optionsToCreate={[{ name: "Material", values: ["Cotton"] }]}
          optionsToDelete={[]}
          {...spies}
        />
      </AppProvider>,
    );

    const remove = screen.getAllByRole("button", { name: /Remove value/i });
    fireEvent.click(remove[remove.length - 1]);

    expect(spies.onCancelCreateOption).toHaveBeenCalledWith(0);
  });
});

describe("VariantOptionsEditor — colours and order", () => {
  it("paints Shopify's swatch, and derives one from a name it is sure of", async () => {
    const { container } = ui();
    fireEvent.click(screen.getByText("Colour"));
    await screen.findByDisplayValue("Red");

    const painted = [...container.querySelectorAll("span[aria-hidden]")]
      .map((el) => (el as HTMLElement).style.backgroundColor)
      .filter(Boolean);

    // "Blue" carries a swatch from Shopify (#0000FF) — and is ALSO a colour
    // word (#1976D2), so this asserts that Shopify's own value wins.
    expect(painted).toContain("#0000FF");
    expect(painted).not.toContain("#1976D2");
    // "Red" has no Shopify swatch and falls to the word table.
    expect(painted).toContain("#D32F2F");
  });

  it("reports a value drag as a new order", async () => {
    const { spies } = ui();
    fireEvent.click(screen.getByText("Colour"));
    await screen.findByDisplayValue("Red");

    const rows = screen.getAllByDisplayValue(/Red|Blue/).map((input) => input.closest("[draggable]")!);
    fireEvent.dragStart(rows[0]);
    fireEvent.dragOver(rows[1]);
    fireEvent.drop(rows[1]);

    // The first value decides which variant the storefront shows first.
    expect(spies.onReorderValues).toHaveBeenCalledWith(OPTION, [
      "gid://shopify/ProductOptionValue/2",
      "gid://shopify/ProductOptionValue/1",
    ]);
  });

  it("offers the metaobject page for a linked option", () => {
    const spies = handlers();
    render(
      <AppProvider i18n={en}>
        <VariantOptionsEditor
          productId="gid://shopify/Product/1"
          options={[{ ...options[0], isLinked: true }]}
          primaryOptions={{}}
          valuesToAdd={{}}
          valuesToDelete={{}}
          optionsToCreate={[]}
          optionsToDelete={[]}
          {...spies}
        />
      </AppProvider>,
    );
    fireEvent.click(screen.getByText("Colour"));

    // A linked option's values live in metaobjects, so the place to edit them
    // is this app's own metaobjects page.
    fireEvent.click(screen.getByRole("button", { name: /Edit these values/i }));
    expect(spies.onOpenMetaobjects).toHaveBeenCalled();
  });
});

describe("VariantOptionsEditor — an abandoned drag", () => {
  it("does not replay a released value drag on the next drop", () => {
    // Released over dead space the id stayed set, and the next drop of
    // anything replayed the move — a reorder the merchant never asked for,
    // with the save bar going dirty behind it.
    const { spies } = ui();
    fireEvent.click(screen.getByText("Colour"));

    const rows = screen.getAllByDisplayValue(/Red|Blue/).map((input) => input.closest("[draggable]")!);
    fireEvent.dragStart(rows[0]);
    fireEvent.dragEnd(rows[0]);

    fireEvent.dragOver(rows[1]);
    fireEvent.drop(rows[1]);

    expect(spies.onReorderValues).not.toHaveBeenCalled();
  });

  it("does not paint a hex-shaped SIZE", async () => {
    // "DDD" is a bra cup size and also a valid three-digit hex.
    const { container } = ui({
      options: [
        {
          id: SECOND,
          name: "Size",
          position: 1,
          values: [
            { id: "gid://shopify/ProductOptionValue/9", name: "DDD" },
            { id: "gid://shopify/ProductOptionValue/10", name: "EEE" },
          ],
        },
      ],
    });
    fireEvent.click(screen.getByText("Size"));
    await screen.findByDisplayValue("DDD");

    const painted = [...container.querySelectorAll("span[aria-hidden]")]
      .map((el) => (el as HTMLElement).style.backgroundColor)
      .filter(Boolean);
    expect(painted).toEqual([]);
  });
});
