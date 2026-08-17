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
  Tooltip,
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
  /** Read-only for a reason of its own (plan gate, unsynced item, …). */
  readOnly?: boolean;
  /** Shown instead of the generic reason when the field is locked. */
  readOnlyHint?: string;
  /** Tags already used in the shop, for the autocomplete. */
  suggestions?: string[];
  t: {
    notTranslatable?: string;
    addTag?: string;
    add?: string;
    yes?: string;
    no?: string;
  };
}

/** Shopify trims tags and ignores empty ones — mirror that so a save does not
 *  report a change the shop would never store. */
export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
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
  suggestions = [],
  t,
}: AttributeFieldProps) {
  const [draftTag, setDraftTag] = useState("");

  // §2.4 / §3.5 — the field exists once per item, so a foreign locale can only
  // look at it. Saying so beats a control that accepts input and discards it.
  const notTranslatable = !isPrimaryLocale;
  const locked = readOnly || notTranslatable;
  const lockedHint = notTranslatable
    ? t.notTranslatable ||
      "This detail exists once per item, not per language. Switch to the main language to change it."
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
              <InlineStack gap="200" blockAlign="end" wrap={false}>
                <Box width="100%">
                  <TextField
                    label={t.addTag || "Add tag"}
                    labelHidden
                    value={draftTag}
                    onChange={setDraftTag}
                    placeholder={t.addTag || "Add tag"}
                    autoComplete="off"
                    // Enter is how anyone types a list of tags. Without it the
                    // merchant reaches for the button on every single one.
                    onBlur={() => addTag(draftTag)}
                    connectedRight={
                      <Button onClick={() => addTag(draftTag)} disabled={!draftTag.trim()}>
                        {t.add || "Add"}
                      </Button>
                    }
                  />
                </Box>
              </InlineStack>
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
        <Text as="p" variant="bodySm" tone="subdued">{lockedHint}</Text>
      )}
    </BlockStack>
  );
}

/** Wraps a locked control so the reason is reachable on hover too — a disabled
 *  control dispatches no pointer events, so a bare Polaris Tooltip never opens
 *  (the same rule as DisabledActionTooltip). */
export function AttributeTooltip({ hint, children }: { hint?: string; children: React.ReactNode }) {
  if (!hint) return <>{children}</>;
  return (
    <Tooltip content={hint} dismissOnMouseOut preferredPosition="above">
      <div>{children}</div>
    </Tooltip>
  );
}
