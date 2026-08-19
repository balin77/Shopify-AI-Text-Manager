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

/** The popover's scrolling list — the one box the scroll lock lets through.
 *  Found by the property that makes it that box. */
const listBox = () => document.querySelector("[style*='overscroll-behavior']") as HTMLElement;

/** A wheel the page would scroll on, if anything let it. */
function wheelOn(target: EventTarget): boolean {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
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

  it("shows the chosen category once one is set, with the path one hover away", () => {
    render(ui({ value: gid(12), currentLabel: "Apparel & Accessories > Jewelry" }));

    // The CATEGORY on the control — the path is what tells two "Shirts" apart,
    // so it stays reachable rather than being printed at the merchant.
    expect(screen.getByRole("button", { name: "Jewelry" })).toBeTruthy();
    expect(document.querySelector('[title="Apparel & Accessories > Jewelry"]')).toBeTruthy();
    expect(screen.queryByText(/gid:\/\//)).toBeNull();
  });
});

/**
 * The two rules that are about the BOX rather than about the taxonomy.
 *
 * A Polaris popover is positioned once against its activator and re-measures
 * only on scrolls it can see — and the pages here scroll inside a plain
 * container, not a Polaris `Scrollable`. So an open picker over a scrolling
 * page hangs over nothing, which is why the page is frozen while it is open —
 * everywhere except the popover's own list, which still has to scroll.
 */
describe("TaxonomyField — the page behind the popover", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lets the page scroll while the picker is closed", () => {
    render(ui());
    expect(wheelOn(document.body)).toBe(false);
  });

  it("freezes the page while the picker is open and thaws it again on close", async () => {
    render(ui());
    await openPicker();

    expect(wheelOn(document.body)).toBe(true);

    // Choosing closes the popover — and the lock has to go with it, or the
    // page stays frozen for good. A LEAF is what chooses; a branch descends.
    fireEvent.click(screen.getByText("Apparel & Accessories"));
    await waitFor(() => expect(screen.getByText("Jewelry")).toBeTruthy());
    fireEvent.click(screen.getByText("Jewelry"));
    await waitFor(() => expect(screen.queryByText("Jewelry")).toBeNull());
    expect(wheelOn(document.body)).toBe(false);
  });

  it("still lets the popover's own list scroll", async () => {
    render(ui());
    await openPicker();

    const list = listBox();
    expect(list).toBeTruthy();
    expect(wheelOn(list)).toBe(false);
  });

  it("does not freeze anything for a disabled field that cannot open", () => {
    render(ui({ disabled: true }));
    expect(wheelOn(document.body)).toBe(false);
  });
});

/**
 * How wide the two boxes get — and that it is ONE width, not two.
 *
 * Both failure modes were shipped once: a panel with a width of its own hung
 * out past a narrower control, and a panel with no ceiling at all spanned the
 * whole page — this field is as wide as the editor column. The ceiling
 * therefore sits on the CONTROL, and the panel takes the control's width from
 * Polaris' `fullWidth`, so the closed box and the open one cannot come to
 * disagree.
 *
 * The third failure mode is the one that shipped after those two and is what
 * these tests now pin: a width measured by hand here CANNOT win, because
 * `.Polaris-Popover__Content` carries its own `max-width: 25rem` and
 * `.Polaris-Popover` its own 8px side margins. A 480px control opened a 400px
 * panel, indented, no matter what width this component asked for. Only
 * `fullWidth` lifts both — so the panel must ask for no width of its own, and
 * the popover must carry that flag.
 */
describe("TaxonomyField — how wide the boxes get", () => {
  /** The panel is the box that carries the width; the list sits inside it. */
  const panelStyle = () =>
    (document.querySelector("[style*='overscroll-behavior']")?.parentElement?.parentElement
      ?.getAttribute("style") ?? "");

  /** The control the panel hangs off — the box the ceiling is spent on. */
  const controlStyle = () =>
    document.querySelector("[style*='--app-dropdown-panel-max-width']")?.getAttribute("style") ?? "";

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("caps the control itself, so the closed box cannot span the page", () => {
    render(ui());

    // The ONE ceiling, spent as a max-width — and as the token, never as a
    // number this component made up.
    expect(controlStyle()).toContain("max-width: var(--app-dropdown-panel-max-width)");
  });

  it("hands the panel's width to Polaris instead of measuring one here", async () => {
    // A number of its own here would be the second clamp — and the losing one:
    // Polaris' `.Polaris-Popover__Content` cuts it at 25rem regardless. So the
    // panel FILLS the box `fullWidth` sized for it, and asks for nothing else.
    render(ui());
    await openPicker();

    expect(panelStyle()).toContain("width: 100%");
    expect(panelStyle()).not.toMatch(/width:\s*\d+px/);
  });

  it("opens the popover in fullWidth, which is what lifts Polaris' own 400px cap", async () => {
    // The flag does all three things this field needs: the overlay gets the
    // activator's measured width, `.Polaris-Popover__Content`'s `max-width:
    // 25rem` is lifted, and the popover's 8px side margins become `auto` so the
    // panel sits on the control's edges. Without it a 480px control opened a
    // 400px panel, indented by 8px.
    render(ui());
    await openPicker();

    expect(document.querySelector(".Polaris-Popover--fullWidth")).toBeTruthy();
  });

  it("still spends the ceiling on the control, so the panel inherits one number", async () => {
    // The panel has no width of its own, so the control's max-width is the ONLY
    // ceiling in play — open or closed.
    render(ui());
    await openPicker();

    expect(controlStyle()).toContain("max-width: var(--app-dropdown-panel-max-width)");
    expect(panelStyle()).not.toContain("--app-dropdown-panel-max-width");
  });
});

/**
 * The label on the closed control.
 *
 * It comes from the product CACHE, which the sync filled from the Admin API —
 * the one source that answers in English only. So the field was the single
 * untranslated spot in an otherwise localized picker, and it printed the whole
 * path where the merchant only wanted to know which category is set.
 */
describe("TaxonomyField — the label on the control", () => {
  const NAME_RESPONSE = {
    success: true,
    category: {
      id: gid(12),
      fullName: "Bekleidung & Accessoires > Schmuck",
      name: "Schmuck",
    },
  };

  /** The level/search mock, plus an answer for the single-name lookup. */
  function mockFetchWithName(category: unknown) {
    const levels = mockFetch();
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.searchParams.get("kind") === "taxonomy-name") {
        return { json: async () => ({ success: true, category }) } as Response;
      }
      return levels(input);
    });
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("replaces the cached English label with the shop's language", async () => {
    vi.stubGlobal("fetch", mockFetchWithName(NAME_RESPONSE.category));

    render(ui({ value: gid(12), currentLabel: "Apparel & Accessories > Jewelry" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Schmuck" })).toBeTruthy());
    // And the hover carries the localized PATH, not the English one it replaced.
    expect(
      document.querySelector('[title="Bekleidung & Accessoires > Schmuck"]'),
    ).toBeTruthy();
  });

  it("asks for the stored category only, and only once there is one", async () => {
    vi.stubGlobal("fetch", mockFetchWithName(NAME_RESPONSE.category));

    const { rerender } = render(ui({ value: "", currentLabel: "" }));
    const nameCalls = () =>
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("kind=taxonomy-name"));

    // A product without a category costs no request at all.
    expect(nameCalls()).toHaveLength(0);

    rerender(ui({ value: gid(12), currentLabel: "Apparel & Accessories > Jewelry" }));
    await waitFor(() => expect(nameCalls()).toHaveLength(1));
    expect(nameCalls()[0]).toContain(encodeURIComponent(gid(12)));
  });

  it("keeps the cached label when there is no localized name", async () => {
    // `category: null` is not an error and not "unknown" — an English shop, or
    // a category newer than the pinned release. A blank field would be the one
    // wrong answer.
    vi.stubGlobal("fetch", mockFetchWithName(null));

    render(ui({ value: gid(12), currentLabel: "Apparel & Accessories > Jewelry" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Jewelry" })).toBeTruthy());
  });

  it("keeps the cached label when the lookup fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));

    render(ui({ value: gid(12), currentLabel: "Apparel & Accessories > Jewelry" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Jewelry" })).toBeTruthy());
  });

  it("drops a response that arrives after the merchant switched products", async () => {
    vi.stubGlobal("fetch", mockFetchWithName(NAME_RESPONSE.category));

    const { rerender } = render(
      ui({ value: gid(12), currentLabel: "Apparel & Accessories > Jewelry" }),
    );
    // The next product carries a different category; the first answer must not
    // land on it.
    rerender(ui({ value: gid(1), currentLabel: "Furniture" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Furniture" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Schmuck" })).toBeNull();
  });
});
