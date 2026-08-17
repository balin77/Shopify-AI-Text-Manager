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

import { useMemo, useState } from "react";
import {
  BlockStack,
  Box,
  Button,
  Icon,
  InlineStack,
  Select,
  Tag,
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
  t,
}: AttributeFieldProps) {
  const [draftTag, setDraftTag] = useState("");

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
  const openSuggestions = useMemo(
    () => suggestions.filter((s) => !tags.some((tag) => tag.toLowerCase() === s.toLowerCase())),
    [suggestions, tags],
  );

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    onChange(serializeTags([...tags, tag]));
    setDraftTag("");
  };

  const control = (() => {
    switch (field.type) {
      case "select":
        return (
          <Select
            label={label}
            options={(field.options ?? []).map((o) => ({ label: o.label, value: o.value }))}
            value={value}
            onChange={onChange}
            disabled={locked}
          />
        );

      case "toggle":
        return (
          <Select
            label={label}
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
            label={label}
            value={value}
            onChange={onChange}
            disabled={locked}
            autoComplete="off"
            inputMode="decimal"
            suffix={field.currencyCode || undefined}
            helpText={field.attributeNote}
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
            label={label}
            value={value}
            onChange={onChange}
            disabled={locked}
            autoComplete="off"
            helpText={typeof field.helpText === "string" ? field.helpText : undefined}
          />
        );

      case "tags":
        return (
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{label}</Text>
            {tags.length > 0 && (
              <InlineStack gap="100" wrap>
                {tags.map((tag) => (
                  <Tag key={tag} onRemove={locked ? undefined : () => onChange(serializeTags(tags.filter((x) => x !== tag)))}>
                    {tag}
                  </Tag>
                ))}
              </InlineStack>
            )}
            {!locked && (
              // Enter is how anyone types a list of tags; Polaris TextField
              // exposes no key handler, so it is caught on the wrapper.
              <div
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addTag(draftTag);
                }}
              >
                <Box width="100%">
                  <TextField
                    label={t.addTag || "Add tag"}
                    labelHidden
                    value={draftTag}
                    onChange={setDraftTag}
                    placeholder={t.addTag || "Add tag"}
                    autoComplete="off"
                    // Deliberately NOT committed on blur. Tabbing away from a
                    // half-typed tag would add it and mark the item dirty —
                    // and the merchant would not see why. Enter (below) and
                    // the button are the two explicit ways in.
                    connectedRight={
                      <Button onClick={() => addTag(draftTag)} disabled={!draftTag.trim()}>
                        {t.add || "Add"}
                      </Button>
                    }
                  />
                </Box>
              </div>
            )}
            {!locked && openSuggestions.length > 0 && (
              <InlineStack gap="100" wrap>
                {openSuggestions.slice(0, 12).map((s) => (
                  <Button key={s} size="micro" variant="tertiary" onClick={() => addTag(s)}>
                    {s}
                  </Button>
                ))}
              </InlineStack>
            )}
          </BlockStack>
        );

      default:
        return null;
    }
  })();

  if (!control) return null;

  return (
    <BlockStack gap="150">
      {control}
      {field.attributeNote && (
        <InlineStack gap="100" blockAlign="center" wrap={false}>
          <Icon source={InfoIcon} tone="subdued" />
          <Text as="p" variant="bodySm" tone="subdued">{field.attributeNote}</Text>
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
