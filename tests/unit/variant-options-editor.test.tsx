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
      { id: "gid://shopify/ProductOptionValue/1", name: "Red", linkedValue: "gid://shopify/Metaobject/1" },
      { id: "gid://shopify/ProductOptionValue/2", name: "Blue", linkedValue: "gid://shopify/Metaobject/2" },
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
  onAddLinkedValue: vi.fn(),
  onRemoveLinkedValue: vi.fn(),
});

/**
 * One drag, driven through dnd-kit's mouse sensor.
 *
 * Two things have to be arranged for it, and neither is incidental:
 *
 * jsdom gives every element a 0x0 rect at the origin, and dnd-kit decides what
 * a drag is OVER by comparing rect centres — with every centre at (0, 0) the
 * answer is whichever droppable registered first, i.e. noise. So the rows are
 * given real geometry first: one `ROW_HEIGHT` band each, stacked.
 *
 * And the mouse sensor only starts a drag once the pointer has moved past its
 * 8px activation distance, which is what keeps a click on a value's text field
 * a click. A single jump to the target would arrive with the drag not yet
 * started, so the move is made in two: one past the threshold, one to the row
 * being aimed at.
 *
 * `data-sortable-id` is what dnd-kit knows each row as — the only trace of a
 * drag in the DOM that is not an inline style.
 */
const ROW_HEIGHT = 40;

function sortableRows(container: HTMLElement, match: string) {
  const rows = [...container.querySelectorAll("[data-sortable-id]")].filter((node) =>
    node.getAttribute("data-sortable-id")!.includes(match),
  ) as HTMLElement[];
  rows.forEach((node, index) => {
    const top = index * ROW_HEIGHT;
    node.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + ROW_HEIGHT,
        left: 0,
        right: 200,
        width: 200,
        height: ROW_HEIGHT,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  return rows;
}

/** Picks a row up and holds it over `toIndex`, without letting go. */
async function dragHandleOver(handle: HTMLElement, fromIndex: number, toIndex: number) {
  const y = (index: number) => index * ROW_HEIGHT + ROW_HEIGHT / 2;
  fireEvent.mouseDown(handle, { clientX: 10, clientY: y(fromIndex) });
  // Past the sensor's activation distance...
  fireEvent.mouseMove(document, { clientX: 10, clientY: y(fromIndex) + 20 });
  await waitTick();
  // ...and then onto the row being aimed at.
  fireEvent.mouseMove(document, { clientX: 10, clientY: y(toIndex) });
  await waitTick();
}

/**
 * Lets go, and waits out dnd-kit's teardown.
 *
 * Longer than a tick on purpose: the pointer sensor keeps a capture-phase
 * `click` listener on the DOCUMENT for a moment after a drag, so that letting
 * go over a button does not also press it. `cleanup()` unmounts React trees
 * and does not touch document listeners, so a shorter wait leaves that
 * listener swallowing the FIRST click of the next test in this file.
 */
async function dropHere() {
  fireEvent.mouseUp(document);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Abandons the drag in flight — the pointer sensor listens for Escape. */
async function cancelDrag() {
  fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** Lets dnd-kit's measuring and its drag-start effects run. */
const waitTick = () => new Promise((resolve) => setTimeout(resolve, 20));

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
        swatches: {
          "gid://shopify/ProductOptionValue/1": { color: "#00FF00" },
          "gid://shopify/ProductOptionValue/2": { color: "#0000FF" },
        },
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

    // Both values carry a Shopify swatch AND are colour words, so this asserts
    // the precedence: the shop's own value wins over the derived one.
    expect(painted).toContain("#0000FF");
    expect(painted).toContain("#00FF00");
    expect(painted).not.toContain("#1976D2");
    expect(painted).not.toContain("#D32F2F");
  });

  it("reports a value drag as a new order", async () => {
    const { container, spies } = ui();
    fireEvent.click(screen.getByText("Colour"));
    await screen.findByDisplayValue("Red");

    sortableRows(container, "ProductOptionValue");
    await dragHandleOver(screen.getByLabelText("Reorder Red"), 0, 1);
    await dropHere();

    // The first value decides which variant the storefront shows first.
    expect(spies.onReorderValues).toHaveBeenCalledWith(OPTION, [
      "gid://shopify/ProductOptionValue/2",
      "gid://shopify/ProductOptionValue/1",
    ]);
  });

  it("moves the other values aside WHILE the drag is in flight", async () => {
    // The bug this replaced: a native HTML5 drag reports where the pointer was
    // when the merchant let go and nothing before that, so dragging a value
    // across three others looked exactly like dragging it across none — the
    // only way to find out where it would land was to drop it and read the
    // result. Nothing here is committed yet; the list has simply rearranged
    // under the cursor, and that arrangement is what the drop will store.
    const { container, spies } = ui();
    fireEvent.click(screen.getByText("Colour"));
    await screen.findByDisplayValue("Red");

    const rows = sortableRows(container, "ProductOptionValue");
    await dragHandleOver(screen.getByLabelText("Reorder Red"), 0, 1);

    // "Blue" has stepped up into the place "Red" is being dragged out of...
    expect(rows[1].style.transform).toContain(`-${ROW_HEIGHT}px`);
    // ...and "Red" is ghosted, so it reads as the one in flight.
    expect(rows[0].style.opacity).toBe("0.5");
    // Still a preview: nothing has been reported to the save bar.
    expect(spies.onReorderValues).not.toHaveBeenCalled();

    await dropHere();
    expect(spies.onReorderValues).toHaveBeenCalled();
  });

  it("reports an option drag as a new order", async () => {
    const { container, spies } = ui();

    sortableRows(container, "ProductOption/");
    // From the grip, not from the card: the card opens the option on click and
    // carries the metaobject link, and dnd-kit's activator would make both of
    // those presentational to a screen reader.
    await dragHandleOver(screen.getByLabelText("Reorder Colour"), 0, 1);
    await dropHere();

    // The first option decides which variant the storefront shows first, the
    // same as the first value does within it.
    expect(spies.onReorder).toHaveBeenCalledWith([SECOND, OPTION]);
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
  it("reorders nothing when a drag is abandoned with Escape", async () => {
    // A preview is only safe to show if backing out of it costs nothing. The
    // native implementation this replaced kept the dragged id in state after a
    // release over dead space, so the NEXT drop of anything replayed the move
    // — a reorder the merchant never asked for, with the save bar going dirty
    // behind it. Escape ends the drag through `onDragCancel`, which nothing
    // here listens to, so there is no order to report.
    const { container, spies } = ui();
    fireEvent.click(screen.getByText("Colour"));
    await screen.findByDisplayValue("Red");

    const rows = sortableRows(container, "ProductOptionValue");
    await dragHandleOver(screen.getByLabelText("Reorder Red"), 0, 1);
    // The preview is up...
    expect(rows[1].style.transform).toContain(`-${ROW_HEIGHT}px`);

    await cancelDrag();

    expect(spies.onReorderValues).not.toHaveBeenCalled();
    // ...and it is gone again: nothing left ghosted or displaced.
    expect(rows[0].style.opacity).toBe("1");
    expect(rows[1].style.transform).toBe("");
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

describe("VariantOptionsEditor — the two bugs the merchant saw", () => {
  it("paints swatches on a COLLAPSED card, without opening it", async () => {
    // A collapsed card is where the values are READ, so a swatch that only
    // appears on click is missing exactly where it is wanted. The fetch used
    // to be gated on a card being open, so the only chips a collapsed card
    // showed were the values whose name the local colour table happens to
    // know — one lone swatch in a list of many.
    ui({
      options: [
        {
          id: OPTION,
          name: "Farbe",
          position: 1,
          values: [
            { id: "gid://shopify/ProductOptionValue/1", name: "Eiche" },
            { id: "gid://shopify/ProductOptionValue/2", name: "Nuss" },
            { id: "gid://shopify/ProductOptionValue/3", name: "Schwarz" },
          ],
        },
      ],
    });

    // Nothing was clicked. "Eiche" and "Nuss" are not colour words, so they
    // can only be painted from what Shopify holds.
    await screen.findByText("Eiche");
    const painted = () =>
      [...document.querySelectorAll("span[aria-hidden]")]
        .map((el) => (el as HTMLElement).style.backgroundColor)
        .filter(Boolean);
    await vi.waitFor(() => expect(painted()).toContain("#00FF00"));
    // …alongside the one the table knows on its own.
    expect(painted()).toContain("#000000");
  });

  it("lets a metaobject-linked option's values be reordered", async () => {
    // Their NAMES live in the metaobjects and are not editable here, but their
    // ORDER belongs to the product — and it decides which variant the
    // storefront shows first. The linked branch used to render a read-only
    // chip list with no handles at all, which is why colours could not move.
    const spies = handlers();
    const view = render(
      <AppProvider i18n={en}>
        <VariantOptionsEditor
          productId="gid://shopify/Product/1"
          options={[{ ...options[0], name: "Farbe", isLinked: true }]}
          primaryOptions={{}}
          valuesToAdd={{}}
          valuesToDelete={{}}
          optionsToCreate={[]}
          optionsToDelete={[]}
          {...spies}
        />
      </AppProvider>,
    );
    fireEvent.click(screen.getByText("Farbe"));

    const { container } = view;
    sortableRows(container, "ProductOptionValue");
    await dragHandleOver(screen.getByLabelText("Reorder Red"), 0, 1);
    await dropHere();

    expect(spies.onReorderValues).toHaveBeenCalledWith(OPTION, [
      "gid://shopify/ProductOptionValue/2",
      "gid://shopify/ProductOptionValue/1",
    ]);
    // …and still nothing that would rename or delete a metaobject value.
    expect(screen.queryByDisplayValue("Red")).toBeNull();
  });
});

describe("VariantOptionsEditor — members of a predefined option", () => {
  /** The choices endpoint answers; the details endpoint keeps its own shape. */
  function withChoices(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("metaobject-choices")
          ? { ok: true, json: async () => body }
          : { ok: true, json: async () => ({ success: true, counts: {}, swatches: {} }) },
      ),
    );
  }

  function linkedUi(overrides: Record<string, unknown> = {}) {
    const spies = handlers();
    render(
      <AppProvider i18n={en}>
        <VariantOptionsEditor
          productId="gid://shopify/Product/1"
          options={[{ ...options[0], name: "Farbe", isLinked: true }]}
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
    return spies;
  }

  it("offers the entries not already in use, and queues the pick", async () => {
    withChoices({
      success: true,
      type: "shopify--color-pattern",
      entries: [
        { id: "gid://shopify/Metaobject/1", displayName: "Red", color: "#FF0000" },
        { id: "gid://shopify/Metaobject/3", displayName: "Ocean", color: "#0A5C8A" },
      ],
    });
    const spies = linkedUi();
    fireEvent.click(screen.getByText("Farbe"));
    fireEvent.click(screen.getByRole("button", { name: /Add another value/i }));

    // Metaobject/1 is already a value of this option, so only Ocean is left.
    // "Red" still appears ONCE — as the existing value chip — but is not
    // offered a second time in the picker.
    const ocean = await screen.findByText("Ocean");
    expect(screen.getAllByText("Red").length).toBe(1);

    fireEvent.click(ocean);
    expect(spies.onAddLinkedValue).toHaveBeenCalledWith("gid://shopify/ProductOption/1", {
      id: "gid://shopify/Metaobject/3",
      name: "Ocean",
    });
  });

  it("says the list could not be READ rather than showing an empty one", async () => {
    // An empty list for a failed read would tell the merchant their shop has
    // no colours — the same rule the variant count follows for zero.
    withChoices({ success: false, type: null, entries: [] });
    linkedUi();
    fireEvent.click(screen.getByText("Farbe"));
    fireEvent.click(screen.getByRole("button", { name: /Add another value/i }));

    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
  });

  it("says so when every entry is already in use", async () => {
    withChoices({
      success: true,
      type: "shopify--color-pattern",
      entries: [
        { id: "gid://shopify/Metaobject/1", displayName: "Red" },
        { id: "gid://shopify/Metaobject/2", displayName: "Blue" },
      ],
    });
    linkedUi();
    fireEvent.click(screen.getByText("Farbe"));
    fireEvent.click(screen.getByRole("button", { name: /Add another value/i }));

    expect(await screen.findByText(/already in use/i)).toBeTruthy();
  });

  it("shows a queued entry before the save, and lets it be dropped", async () => {
    withChoices({ success: true, type: "t", entries: [] });
    const spies = linkedUi({
      linkedValuesToAdd: { [OPTION]: [{ id: "gid://shopify/Metaobject/3", name: "Ocean" }] },
    });
    fireEvent.click(screen.getByText("Farbe"));

    expect(screen.getByText("Ocean")).toBeTruthy();
    const removes = screen.getAllByRole("button", { name: /Remove value/i });
    fireEvent.click(removes[removes.length - 1]);
    expect(spies.onRemoveLinkedValue).toHaveBeenCalledWith(OPTION, "gid://shopify/Metaobject/3");
  });

  it("can delete a value of a predefined option, with the variant warning", async () => {
    withChoices({ success: true, type: "t", entries: [] });
    const spies = linkedUi();
    fireEvent.click(screen.getByText("Farbe"));

    fireEvent.click(screen.getAllByRole("button", { name: /Remove value/i })[0]);
    // The same confirmation as any other value: it takes variants with it.
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Delete$/i }));
    expect(spies.onRemoveValue).toHaveBeenCalledWith(OPTION, "gid://shopify/ProductOptionValue/1");
  });
});
