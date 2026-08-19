/**
 * What a metaobject entry card shows on a LANGUAGE tab.
 *
 * Everything on this card except the fields is primary-locale business: a
 * colour, a file reference and a taxonomy value have ONE value per shop, so in
 * a foreign locale they render read-only — controls that cannot be used. The
 * swatch, the handle, the usage line, the "not editable here" list and the
 * delete button say the same thing on every language tab and none of it is
 * what the merchant came there to do. Before this page had cards, a foreign
 * locale was the input and its buttons; `compact` is that, restored.
 *
 * The primary half is pinned in the same file, because the risk of a flag like
 * this is not that it hides too little — it is that someone later reads
 * "compact" as "smaller" and applies it everywhere.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { MetaobjectEntryCard } from "~/components/metaobjects/MetaobjectEntryCard";

afterEach(cleanup);

const TEXTS = {
  handleLabel: "Handle",
  deleteLabel: "Delete entry",
  usageNone: "No product uses this entry as an option value.",
  unsupportedTitle: "Not editable here",
  noTranslatableFields: "This entry has no translatable fields.",
  noEditableFields: "None of this entry's fields can be edited here.",
};

function card(compact: boolean, children: Array<{ key: string; node: React.ReactNode }> = [
  { key: "gid#label", node: <input aria-label="Label" defaultValue="Gold" /> },
]) {
  return render(
    <AppProvider i18n={en}>
      <MetaobjectEntryCard
        entryId="gid://shopify/Metaobject/1"
        title="Gold"
        handle="gold"
        swatch={{ color: "#ffd700", imageUrl: null }}
        unsupportedFields={[{ label: "Rich text", fieldType: "rich_text_field" }]}
        compact={compact}
        usage={{ state: "known", products: 0 }}
        onDelete={() => {}}
        t={TEXTS}
      >
        {children}
      </MetaobjectEntryCard>
    </AppProvider>,
  );
}

describe("MetaobjectEntryCard on a language tab", () => {
  it("keeps the title and the field, and drops everything else", () => {
    card(true);
    // The title stays: without it the cards are indistinguishable.
    expect(screen.getByText("Gold")).toBeTruthy();
    expect(screen.getByLabelText("Label")).toBeTruthy();
    // Primary-locale chrome, all of it gone.
    expect(screen.queryByText(/Handle:/)).toBeNull();
    expect(screen.queryByRole("button", { name: TEXTS.deleteLabel })).toBeNull();
    expect(screen.queryByText(TEXTS.usageNone)).toBeNull();
    expect(screen.queryByText(TEXTS.unsupportedTitle)).toBeNull();
  });

  it("says the entry has no TRANSLATABLE fields, not that nothing is editable", () => {
    // Two different statements. "Nothing can be edited here" about an entry
    // whose colour is editable one tab over is simply untrue.
    card(true, []);
    expect(screen.getByText(TEXTS.noTranslatableFields)).toBeTruthy();
    expect(screen.queryByText(TEXTS.noEditableFields)).toBeNull();
  });

  it("still shows the whole card in the PRIMARY locale", () => {
    card(false);
    expect(screen.getByText(/Handle:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: TEXTS.deleteLabel })).toBeTruthy();
    expect(screen.getByText(TEXTS.usageNone)).toBeTruthy();
    expect(screen.getByText(TEXTS.unsupportedTitle)).toBeTruthy();
  });
});
