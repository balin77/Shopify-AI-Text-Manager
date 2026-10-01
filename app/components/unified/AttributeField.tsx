/**
 * AttributeField — the PLAN_CONTENT_CREATION §Phase 3 merchandising controls.
 *
 * Status, sort order, tags, published state: the fields that decide how an item
 * behaves in the shop rather than what it says. They share one property that
 * shapes this whole component — **they are not translatable**. Shopify stores
 * one value per item, not one per locale, so in a foreign locale they render
 * read-only with an explanation instead of looking editable and then writing
 * the primary value behind the merchant's back (§2.4).
 *
 * Deliberately free of AI controls, translate buttons and suggestion state.
 * A vendor name is not generated, a status is not improved, and offering either
 * would be an invitation to break a shop's merchandising with a click.
 *
 * ── Tags ───────────────────────────────────────────────────────────────────
 * Stored as one comma-joined string in the editor's flat value map (every other
 * field is a string too, and `getChangedFields` compares strings), split into
 * chips only for display. The split/join is normalising on purpose: Shopify
 * trims tags and drops empties, so doing the same here keeps a save from
 * reporting a change that is not one.
 */

import { useMemo } from "react";
import { ChipCombobox } from "./ChipCombobox";
import { FieldClearOverlay, FieldLabel } from "./FieldChrome";
import {
  BlockStack,
  Button,
  Icon,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { InfoIcon } from "@shopify/polaris-icons";
import type { FieldDefinition } from "../../types/content-editor.types";

export interface AttributeFieldProps {
  field: FieldDefinition;
  /** Flat editor value. `tags` carries a comma-joined list; `toggle` "true"/"false". */
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** False ⇒ read-only with the not-translatable explanation. */
  isPrimaryLocale: boolean;
  /** Read-only for a reason of its own (plan gate, …). */
  readOnly?: boolean;
  /** Shown instead of the generic reason when the field is locked. */
  readOnlyHint?: string;
  /**
   * False ⇒ this item's attribute block has never been fetched, so the value
   * below is the migration's default (null / [] / true) and NOT the merchant's
   * data — the `attributesSyncedAt` rule, applied to an editable control.
   *
   * The control is disabled and says so rather than showing an empty vendor as
   * if the merchant had left it blank: this is the field they would "fix",
   * and the fix would write over what is actually in the shop. `undefined`
   * means the caller cannot tell, which is treated as known — the four types
   * that HAVE an attribute block all supply the flag.
   */
  attributesKnown?: boolean;
  /** The way out of the unknown state: reload this item from Shopify. */
  onReloadAttributes?: () => void;
  /** Tags already used in the shop, for the autocomplete. */
  suggestions?: string[];
  /**
   * Shopify ENUM values → what the merchant reads, keyed "<field>.<VALUE>".
   *
   * The map is passed in rather than baked into the field config because the
   * config is shared with the server and with the bulk grid, and a label is a
   * per-language thing. Without it this rendered `ALPHA_ASC` and `AUTO_PUBLISHED`
   * verbatim — not English prose either, just the wire format.
   */
  optionLabels?: Record<string, string>;
  /** The explanatory line under the control, already translated. */
  attributeNote?: string;
  /** Key into `t.help` — the question mark beside the label. Unknown keys draw
   *  nothing, so a field may always name one. */
  helpKey?: string;
  t: {
    notTranslatable?: string;
    addTag?: string;
    add?: string;
    yes?: string;
    no?: string;
    notSyncedYet?: string;
    reload?: string;
  };
}

/** Shopify trims tags and ignores empty ones — mirror that so a save does not
 *  report a change the shop would never store. */
export function parseTags(value: string): string[] {
  // De-duplicated on the way IN as well as out. A cached list can hold "Sale"
  // and "sale" (Shopify collapses them, an older cache row may not), and two
  // chips whose text matches would collide as React keys — removing one would
  // remove both.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function serializeTags(tags: string[]): string {
  // De-duplicated case-insensitively, because Shopify treats "Sale" and "sale"
  // as the same tag and would silently collapse them — leaving the editor
  // showing two where the shop has one.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(", ");
}

export function AttributeField({
  field,
  value,
  onChange,
  label,
  isPrimaryLocale,
  readOnly,
  readOnlyHint,
  attributesKnown,
  onReloadAttributes,
  suggestions = [],
  optionLabels,
  attributeNote,
  helpKey,
  t,
}: AttributeFieldProps) {
  // §2.4 / §3.5 — the field exists once per item, so a foreign locale can only
  // look at it. Saying so beats a control that accepts input and discards it.
  const notTranslatable = !isPrimaryLocale;
  // §2.4 — "we have not fetched this" is its own state, not an empty value.
  const unknown = attributesKnown === false;
  const locked = readOnly || notTranslatable || unknown;
  const lockedHint = notTranslatable
    ? t.notTranslatable ||
      "This detail exists once per item, not per language. Switch to the main language to change it."
    : unknown
    ? t.notSyncedYet ||
      "This item's details have not been loaded from Shopify yet — reload it to see and edit them."
    : readOnlyHint;

  const tags = useMemo(() => parseTags(value), [value]);

  // One label for every branch below: bold, with its question mark. Passed as
  // a NODE into the Polaris controls, which is what lets the help bubble sit
  // beside the words instead of under the box.
  const labelNode = <FieldLabel label={label} helpKey={helpKey} />;

  /**
   * Emptying the field.
   *
   * Only where "" is a value the field can HOLD. A select and a toggle are
   * enums — Shopify stores one of their options, never nothing, and a Clear
   * button on a status would either write a value the API refuses or silently
   * do nothing. The tags control clears itself (`ChipCombobox`), because it
   * has to keep the locked entries.
   *
   * And never on a REQUIRED field. An article's author is `type: "text"` and
   * required, so it grew a Clear button that `attributeInputFor` then refuses:
   * the save reports success, the author is not written, and the old value
   * comes back on the next revalidation. A button that visibly does nothing
   * reads as a bug — the same rule `ChipCombobox.clearAll` states for the
   * locked entries it keeps.
   */
  const clearable = !locked && !field.required && (field.type === "text" || field.type === "money");

  const control = (() => {
    switch (field.type) {
      case "select":
        return (
          <Select
            label={labelNode}
            options={(field.options ?? []).map((o) => ({
              // `field.label` is the raw enum value — the config has no
              // language. A missing entry falls back to it rather than to "",
              // because an untranslated value still identifies the option.
              label: optionLabels?.[`${field.key}.${o.value}`] ?? o.label,
              value: o.value,
            }))}
            value={value}
            onChange={onChange}
            disabled={locked}
          />
        );

      case "toggle":
        return (
          <Select
            label={labelNode}
            options={[
              { label: field.toggleLabels?.on || t.yes || "Yes", value: "true" },
              { label: field.toggleLabels?.off || t.no || "No", value: "false" },
            ]}
            // Anything other than an explicit "false" reads as on, matching the
            // column defaults (`isPublished` defaults to true on both sides).
            value={value === "false" ? "false" : "true"}
            onChange={onChange}
            disabled={locked}
          />
        );

      case "money":
        // Parsing happens SERVER-side (the same `parseMoney` the grid uses), so
        // this stays a plain text field: locale-specific money input is a
        // minefield — "1.299" is 1299 to a German merchant and 1.30 to an
        // English one — and a control that silently normalises would pick one
        // reading and be wrong for the other half of the shops.
        return (
          <TextField
            label={labelNode}
            value={value}
            onChange={onChange}
            disabled={locked}
            autoComplete="off"
            inputMode="decimal"
            suffix={field.currencyCode || undefined}
            helpText={attributeNote ?? field.attributeNote}
          />
        );

      // Vendor, author, template suffix: plain text, but merchandising all the
      // same. They belong here rather than in the generic text renderer for two
      // reasons that only this component knows — they must lock when the
      // attribute block was never fetched, and they carry no AI or translation
      // controls at all.
      case "text":
        return (
          <TextField
            label={labelNode}
            value={value}
            onChange={onChange}
            disabled={locked}
            autoComplete="off"
            helpText={typeof field.helpText === "string" ? field.helpText : undefined}
          />
        );

      case "tags":
        // One line plus the chips that are actually set. It used to print
        // every tag as a chip AND a permanently visible row of up to twelve
        // suggestion buttons, which on a well-tagged product was taller than
        // the description field.
        return (
          <ChipCombobox
            label={label}
            helpKey={helpKey}
            selected={tags}
            options={suggestions.map((tag) => ({ value: tag, label: tag }))}
            onChange={(next) => onChange(serializeTags(next))}
            readOnly={locked}
            // A merchant invents tags; the suggestions are a convenience, not
            // a vocabulary.
            allowFreeText
            placeholder={t.addTag || "Add tag"}
          />
        );

      default:
        return null;
    }
  })();

  if (!control) return null;

  return (
    <BlockStack gap="150">
      {/* Same clear affordance, same corner, as every other field in the card. */}
      <FieldClearOverlay
        onClear={clearable ? () => onChange("") : undefined}
        hasValue={!!value}
        fieldLabel={label}
      >
        {control}
      </FieldClearOverlay>
      {(attributeNote ?? field.attributeNote) && (
        <InlineStack gap="100" blockAlign="center" wrap={false}>
          <Icon source={InfoIcon} tone="subdued" />
          <Text as="p" variant="bodySm" tone="subdued">{attributeNote ?? field.attributeNote}</Text>
        </InlineStack>
      )}
      {locked && lockedHint && (
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="p" variant="bodySm" tone="subdued">{lockedHint}</Text>
          {/* The unknown state is the ONE lock with a way out, so it offers it
              right here instead of leaving the merchant to find the sidebar. */}
          {unknown && onReloadAttributes && (
            <Button variant="plain" size="micro" onClick={onReloadAttributes}>
              {t.reload || "Reload"}
            </Button>
          )}
        </InlineStack>
      )}
    </BlockStack>
  );
}
