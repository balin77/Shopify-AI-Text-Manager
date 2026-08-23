/**
 * The control that empties a field renders BOTH of its shapes, and CSS shows
 * one.
 *
 * That is not something jsdom can observe — container queries do not compute
 * here — so these tests pin the STRUCTURE the stylesheet depends on: the query
 * container is on the field's own box, both variants exist under the classes
 * responsive.css toggles, either one clears, and both carry the same accessible
 * name. If someone "simplifies" this to a single morphing button, the CSS goes
 * quiet rather than wrong, which is the failure these tests exist to make loud.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { I18nProvider } from "~/contexts/I18nContext";
import { FieldClearOverlay } from "~/components/unified/FieldChrome";

afterEach(cleanup);

function overlay(onClear: (() => void) | undefined, hasValue: boolean) {
  return render(
    <AppProvider i18n={en}>
      <I18nProvider locale="en">
        <FieldClearOverlay onClear={onClear} hasValue={hasValue} fieldLabel="Vendor">
          <input aria-label="Vendor" />
        </FieldClearOverlay>
      </I18nProvider>
    </AppProvider>,
  );
}

const icon = () => document.querySelector(".app-field-clear--icon");
const word = () => document.querySelector(".app-field-clear--word");

describe("the field clear control", () => {
  it("makes the FIELD the query container, so the width it reads is the field's", () => {
    overlay(() => {}, true);
    const scope = document.querySelector(".app-field-clear-scope");
    expect(scope).not.toBeNull();
    // The control has to be inside the box whose width decides its shape.
    expect(scope!.contains(icon()!)).toBe(true);
  });

  it("renders both shapes, so the stylesheet has one of each to choose from", () => {
    overlay(() => {}, true);
    expect(icon()).not.toBeNull();
    expect(word()).not.toBeNull();
    expect(word()!.textContent).toBe("Clear");
    // The icon variant carries no text — its name is its accessible name.
    expect(icon()!.textContent).toBe("");
  });

  it("names the field in BOTH shapes, opening with the visible word", () => {
    overlay(() => {}, true);
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Clear: Vendor", "Clear: Vendor"]);
  });

  it("clears from either shape", () => {
    const onClear = vi.fn();
    overlay(onClear, true);
    fireEvent.click(icon()!.querySelector("button")!);
    fireEvent.click(word()!.querySelector("button")!);
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  it("draws nothing while the field is empty, and nothing at all without onClear", () => {
    // The WRAPPER stays — responsive.css reserves the label row for it on
    // mobile, and a row that appeared on the first keystroke would shove the
    // input down as the merchant typed.
    overlay(() => {}, false);
    expect(document.querySelector(".field-clear-overlay")).not.toBeNull();
    expect(icon()).toBeNull();
    expect(word()).toBeNull();

    cleanup();
    overlay(undefined, true);
    expect(document.querySelector(".field-clear-overlay")).toBeNull();
  });
});
