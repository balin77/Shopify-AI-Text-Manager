/**
 * The colour popover freezes the page behind it — and lets it go again.
 *
 * A Polaris `Popover` is positioned ONCE against its activator and portalled
 * out; the pages of this app scroll inside a frame `PositionedOverlay` never
 * learns about, so a scroll under an open picker leaves the panel hanging over
 * whatever slid underneath it. `useScrollLock` cancels the wheel event instead,
 * which is what these tests observe: a wheel event that comes back
 * `defaultPrevented` is a frozen page.
 *
 * The second test is the one that matters. The lock lives on `window` and
 * outlives the popover's unmount, so it has to be gated on the picker really
 * being on screen — and BOTH conditions that take the picker away come from the
 * parent, not from a click: an entry reload that answers `readOnly` drops
 * `colorControl`, and a language tab sets `compact`. Ungated, the card kept a
 * page-wide wheel block around an overlay that no longer existed, with no panel
 * left to close it: nothing scrolled until the merchant reloaded.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { MetaobjectEntryCard } from "~/components/metaobjects/MetaobjectEntryCard";

afterEach(cleanup);

function card(props: { colorControl?: React.ReactNode; compact?: boolean }) {
  return (
    <AppProvider i18n={en}>
      <MetaobjectEntryCard
        entryId="gid://shopify/Metaobject/1"
        title="Gold"
        handle="gold"
        swatch={{ color: "#ffd700", imageUrl: null }}
        unsupportedFields={[]}
        usage={{ state: "known", products: 0 }}
        colorValue="#ffd700"
        colorControl={props.colorControl}
        compact={props.compact}
      >
        {[]}
      </MetaobjectEntryCard>
    </AppProvider>
  );
}

/** True when the page behind the overlay is frozen. Dispatched at the body so
 *  it passes window's CAPTURE listener on its way down, which is where the
 *  hook registers. */
function pageIsFrozen(): boolean {
  const wheel = new Event("wheel", { cancelable: true, bubbles: true });
  document.body.dispatchEvent(wheel);
  return wheel.defaultPrevented;
}

const swatch = () => screen.getByRole("button", { name: "Change colour" });

describe("metaobject entry card — colour popover scroll lock", () => {
  it("does not freeze the page while the picker is closed", () => {
    render(card({ colorControl: <input aria-label="Hex" /> }));
    expect(pageIsFrozen()).toBe(false);
  });

  it("freezes the page while the picker is open, and releases it on close", () => {
    render(card({ colorControl: <input aria-label="Hex" /> }));
    fireEvent.click(swatch());
    expect(pageIsFrozen()).toBe(true);
    fireEvent.click(swatch());
    expect(pageIsFrozen()).toBe(false);
  });

  it("releases the page when the control is taken away under an open picker", () => {
    const { rerender } = render(card({ colorControl: <input aria-label="Hex" /> }));
    fireEvent.click(swatch());
    expect(pageIsFrozen()).toBe(true);

    // What an entry reload answering `readOnly` does: the control goes, the
    // card keeps its identity and therefore its state.
    rerender(card({ colorControl: undefined }));
    expect(pageIsFrozen()).toBe(false);
    // And the picker must not spring open by itself once it comes back.
    rerender(card({ colorControl: <input aria-label="Hex" /> }));
    expect(pageIsFrozen()).toBe(false);
  });

  it("releases the page when a language tab makes the card compact", () => {
    const { rerender } = render(card({ colorControl: <input aria-label="Hex" /> }));
    fireEvent.click(swatch());
    expect(pageIsFrozen()).toBe(true);

    rerender(card({ colorControl: <input aria-label="Hex" />, compact: true }));
    expect(pageIsFrozen()).toBe(false);
  });
});
