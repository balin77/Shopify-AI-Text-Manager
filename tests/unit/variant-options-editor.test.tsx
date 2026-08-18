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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    const removeButtons = screen.getAllByRole("button", { name: /Remove value/i });
    fireEvent.click(removeButtons[0]);

    expect(window.confirm as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringContaining("3"));
    expect(spies.onRemoveValue).toHaveBeenCalledWith(OPTION, "gid://shopify/ProductOptionValue/1");
  });

  it("says it could not count rather than showing a zero", async () => {
    // A zero would read as "nothing depends on this, delete freely" — the exact
    // opposite of what an unanswered question means.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ success: false }) })));
    ui();
    fireEvent.click(screen.getByText("Size"));
    await screen.findByDisplayValue("S");

    // Size has one value, so its remove button is disabled — open Colour, whose
    // values are not in the fetched (empty) map either.
    cleanup();
    ui();
    fireEvent.click(screen.getByText("Colour"));
    await screen.findByDisplayValue("Red");
    fireEvent.click(screen.getAllByRole("button", { name: /Remove value/i })[0]);

    expect(window.confirm as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringMatching(/could not be read/i));
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

    const del = screen.getByRole("button", { name: /^Delete$/i });
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
