/**
 * The chrome every field wears: one bold label with its question mark, and one
 * Clear button in one corner.
 *
 * Two of the rules here are not cosmetic and are what this file pins:
 *
 *  - Clearing a chip field must LEAVE the locked entries. A rule-based
 *    collection membership cannot be removed one chip at a time (Shopify
 *    refuses the write and the rule would undo it anyway), so a "clear
 *    everything" that swept it up would be the same refused write wearing a
 *    different label — and, because `productUpdate` is atomic, it would take
 *    the merchant's text edits down with it.
 *  - An enum has no empty value. A Clear button on a status or a sort order
 *    would either write a value Shopify rejects at the schema level or do
 *    nothing at all, so the attribute controls offer it for text only.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { I18nProvider } from "~/contexts/I18nContext";
import { ChipCombobox } from "~/components/unified/ChipCombobox";
import { AttributeField } from "~/components/unified/AttributeField";
import type { FieldDefinition } from "~/types/content-editor.types";

afterEach(cleanup);

function ui(children: React.ReactNode) {
  return (
    <AppProvider i18n={en}>
      <I18nProvider locale="en">{children}</I18nProvider>
    </AppProvider>
  );
}

const attribute = (over: Partial<FieldDefinition>): FieldDefinition => ({
  key: "vendor",
  type: "text",
  label: "Vendor",
  translationKey: "",
  supportsAI: false,
  supportsFormatting: false,
  supportsTranslation: false,
  ...over,
} as FieldDefinition);

describe("ChipCombobox — clearing", () => {
  it("keeps the locked entries and removes the rest", () => {
    const onChange = vi.fn();
    render(ui(
      <ChipCombobox
        label="Collections"
        selected={["a", "b"]}
        options={[
          { value: "a", label: "Manual" },
          { value: "b", label: "Smart", lockedReason: "Managed by this collection's rules" },
        ]}
        onChange={onChange}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith(["b"]);
  });

  it("offers no Clear when everything left is locked", () => {
    render(ui(
      <ChipCombobox
        label="Collections"
        selected={["b"]}
        options={[{ value: "b", label: "Smart", lockedReason: "Managed by this collection's rules" }]}
        onChange={vi.fn()}
      />
    ));

    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });

  it("offers no Clear when the field is read-only", () => {
    render(ui(
      <ChipCombobox
        label="Tags"
        selected={["sale"]}
        options={[{ value: "sale", label: "sale" }]}
        onChange={vi.fn()}
        readOnly
      />
    ));

    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });
});

describe("AttributeField — clearing", () => {
  it("empties a text attribute", () => {
    const onChange = vi.fn();
    render(ui(
      <AttributeField field={attribute({})} value="Acme" onChange={onChange} label="Vendor" isPrimaryLocale t={{}} />
    ));

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("offers nothing to clear on an enum — there is no empty status", () => {
    render(ui(
      <AttributeField
        field={attribute({
          key: "sortOrder",
          type: "select",
          label: "Sort order",
          options: [{ value: "MANUAL", label: "Manual" }],
        })}
        value="MANUAL"
        onChange={vi.fn()}
        label="Sort order"
        isPrimaryLocale
        t={{}}
      />
    ));

    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });

  it("offers no Clear in a foreign locale — the field is read-only there", () => {
    render(ui(
      <AttributeField
        field={attribute({})}
        value="Acme"
        onChange={vi.fn()}
        label="Vendor"
        isPrimaryLocale={false}
        t={{}}
      />
    ));

    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });
});

describe("FieldLabel — the question mark", () => {
  it("draws the help trigger for a key the bundle carries", () => {
    render(ui(
      <AttributeField
        field={attribute({})}
        value=""
        onChange={vi.fn()}
        label="Vendor"
        helpKey="vendor"
        isPrimaryLocale
        t={{}}
      />
    ));

    expect(screen.getByRole("button", { name: /vendor/i })).toBeTruthy();
  });

  it("draws nothing for a key the bundle does not carry", () => {
    // The map may name an entry before anyone has written it — an empty circle
    // that opens an empty popover is worse than no circle.
    const { container } = render(ui(
      <AttributeField
        field={attribute({})}
        value=""
        onChange={vi.fn()}
        label="Vendor"
        helpKey="nothingWrittenYet"
        isPrimaryLocale
        t={{}}
      />
    ));

    expect(container.querySelector(".help-tooltip-trigger")).toBeNull();
  });
});
