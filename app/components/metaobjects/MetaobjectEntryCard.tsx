/**
 * ONE entry of a metaobject type, as a card.
 *
 * The metaobjects page used to render one bare text input per entry -- the
 * entry was a form FIELD, so there was no level at which it was an object and
 * therefore nowhere to put "delete this", "here are its other fields" or a
 * swatch. This card is that level. Collapsed it looks like the row it replaced,
 * which is why the change costs the merchant nothing.
 *
 * Three things it says that the old row could not:
 *
 * - **Fields this app cannot edit are NAMED, with their type.** A field that
 *   silently disappears looks like a bug; one with a reason is an explanation.
 *   Same rule as the definitions the create form refuses to offer.
 * - **Whether the entry is in use, three-valued.** "0 products" and "we do not
 *   know" are different answers and are reported as different answers. Only
 *   the KNOWN non-zero one disables the button: Shopify itself refuses to
 *   delete a referenced entry (measured, PLAN_METAOBJECTS_EDITOR V5), so
 *   "unknown" costs a refused attempt rather than a lost variant -- while
 *   blocking on it would strand every shop with no cached products.
 * - **Why delete is disabled**, on the button itself, rather than after the
 *   merchant has typed the entry's name into a confirmation dialog.
 */

import { useMemo, useState, type ReactNode } from "react";
import { BlockStack, Badge, Button, Card, InlineStack, Popover, Text, Tooltip } from "@shopify/polaris";
import { SwatchPreview } from "./SwatchPreview";
import { METAOBJECT_HEX_PATTERN } from "~/services/metaobject-fields.shared";
import type { OptionValueSwatch } from "~/services/product-option-swatch.shared";

/** What the page knows about an entry's usage as a product option value. */
export type MetaobjectEntryUsage =
  | { state: "loading" }
  /** The product cache answered. `products` may legitimately be 0. */
  | { state: "known"; products: number }
  /** Nothing to count from -- NOT the same as zero. */
  | { state: "unknown"; reason: "noProducts" | "lookupFailed" };

export interface MetaobjectEntryCardTexts {
  handleLabel?: string;
  noEditableFields?: string;
  noTranslatableFields?: string;
  unsupportedTitle?: string;
  unsupportedHint?: string;
  deleteLabel?: string;
  deleteInUse?: string;
  usageChecking?: string;
  usageNone?: string;
  usageKnown?: string;
  usageUnknown?: string;
  syncProducts?: string;
  createdBadge?: string;
  editColor?: string;
  colorInvalid?: string;
  readOnlyDefinition?: string;
  readOnlyUnknown?: string;
}

interface Props {
  entryId: string;
  title: string;
  handle?: string;
  /** Colour / image the entry's own fields describe, for the header dot. */
  swatch?: OptionValueSwatch | null;
  /** Fields of the definition this app has no editor for: name + Shopify type. */
  unsupportedFields: Array<{ label: string; fieldType: string }>;
  /** The rendered controls for the fields it CAN edit, minus the colour. */
  /**
   * The entry's field controls, laid out HORIZONTALLY.
   *
   * `wide` takes a whole row. A one-line text box next to another one-line
   * text box reads fine; a textarea, a rich-text preview or a chip list next
   * to anything reads as two half-broken columns, and the chips wrap into a
   * column so narrow that two of them no longer fit on a line.
   */
  children: Array<{ key: string; node: ReactNode; wide?: boolean }>;
  /**
   * The COLOUR control, lifted out of the field list into the header.
   *
   * A colour is the one field whose value the merchant reads as a picture
   * rather than as text, and the card already draws that picture at the top.
   * Leaving the control further down meant looking at the dot and reaching
   * somewhere else to change it. Absent when the definition has no colour
   * field, or when the entry is read-only — then the dot stays a plain dot.
   */
  colorControl?: ReactNode;
  /** The colour as the EDITOR currently holds it, so the dot follows typing. */
  colorValue?: string;
  /** Sits under the colour control: what changing it actually does (V3). */
  colorNote?: string;
  /** Highlighted because it was just created. */
  /**
   * A FOREIGN locale: show the translatable fields and nothing else.
   *
   * Everything else on this card is primary-locale business. A colour, a file
   * reference and a taxonomy value have ONE value per shop, so in a foreign
   * locale they render read-only — a row of controls that cannot be used. The
   * swatch, the handle, the usage line, the "not editable here" list and the
   * delete button say the same thing on every language tab, and none of it is
   * what the merchant came to this tab to do. Before the card existed, a
   * foreign locale WAS just the input and its buttons, and that was right.
   */
  compact?: boolean;
  justCreated?: boolean;
  usage?: MetaobjectEntryUsage;
  onDelete?: () => void;
  onSyncProducts?: () => void;
  /** Set when the whole entry is read-only (its definition refuses our writes). */
  readOnlyReason?: "refused" | "unknown";
  t?: MetaobjectEntryCardTexts;
}

export function MetaobjectEntryCard({
  entryId,
  title,
  handle,
  swatch,
  unsupportedFields,
  children,
  colorControl,
  colorValue,
  colorNote,
  compact = false,
  justCreated = false,
  usage,
  onDelete,
  onSyncProducts,
  readOnlyReason,
  t = {},
}: Props) {
  const [colorOpen, setColorOpen] = useState(false);

  /**
   * The colour the dot paints, preferring what the merchant has TYPED over
   * what the entry stores. Without this the dot would keep showing the saved
   * colour while the picker above it shows a different one.
   *
   * The stored IMAGE is dropped while the dot is the colour control:
   * `resolveSwatch` prefers an image over a colour, so on an entry that has
   * both, the dot would show the image and the colour picker behind it would
   * have no visible effect at all — a control whose result cannot be seen.
   */
  const liveSwatch = useMemo(
    () => (colorValue !== undefined ? { color: colorValue, imageUrl: null } : swatch),
    [swatch, colorValue],
  );

  /**
   * A colour the merchant has typed that is not a colour.
   *
   * The control's own error message lives inside a popover that is closed by
   * default, so without this the card would look fine while holding a value
   * `metaobjectUpdate` refuses. Checked with the SAME pattern the parser uses,
   * so the card cannot disagree with the save about what a colour is.
   */
  const colorInvalid = useMemo(() => {
    const value = (colorValue ?? "").trim();
    if (!colorControl || value === "") return false;
    return !METAOBJECT_HEX_PATTERN.test(value.startsWith("#") ? value : `#${value}`);
  }, [colorControl, colorValue]);

  // MEASURED (PLAN_METAOBJECTS_EDITOR V5): Shopify itself refuses to delete an
  // entry a product still references, so nothing can be destroyed by trying.
  // The button therefore only stops for a usage this app KNOWS about -- where
  // it can name the number, which is more useful than Shopify's sentence.
  //
  // "Unknown" no longer blocks. It did while V5 was open, and that was right
  // then; keeping it would now mean a shop whose products are not cached can
  // never delete an entry, with no action that changes the answer. The usage
  // line below still says the count is unknown -- reporting it and refusing on
  // it are different things.
  const deleteBlockedReason =
    !usage || usage.state === "loading"
      ? t.usageChecking || "Checking usage…"
      : usage.state === "known" && usage.products > 0
        ? (t.deleteInUse || "{products} product(s) use this entry as an option value. Remove it there first.").replace(
            "{products}",
            String(usage.products),
          )
        : null;

  const usageLine =
    !usage || usage.state === "loading"
      ? t.usageChecking || "Checking usage…"
      : usage.state === "unknown"
        ? t.usageUnknown || "Usage unknown — no products are cached."
        : usage.products === 0
          ? t.usageNone || "No product uses this entry as an option value."
          : (t.usageKnown || "{products} product(s) use this entry as an option value.").replace(
              "{products}",
              String(usage.products),
            );

  const deleteButton = onDelete ? (
    <Button size="slim" tone="critical" disabled={!!deleteBlockedReason} onClick={onDelete}>
      {t.deleteLabel || "Delete entry"}
    </Button>
  ) : null;

  return (
    <Card padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap={false} gap="200">
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            {compact ? null : colorControl ? (
              // The dot IS the control. A Popover rather than an inline field:
              // the header is a title row, and a colour picker parked in it
              // permanently would push the name off a narrow screen.
              <Popover
                active={colorOpen}
                onClose={() => setColorOpen(false)}
                activator={
                  <button
                    type="button"
                    onClick={() => setColorOpen((open) => !open)}
                    aria-label={t.editColor || "Change colour"}
                    style={{
                      padding: 0,
                      border: "none",
                      background: "none",
                      cursor: "pointer",
                      lineHeight: 0,
                      display: "flex",
                      alignItems: "center",
                      borderRadius: "50%",
                      // A red ring, because the reason itself is behind a
                      // popover the merchant has to open.
                      outline: colorInvalid ? "2px solid var(--p-color-border-critical)" : undefined,
                      outlineOffset: "2px",
                    }}
                  >
                    {/* `showEmpty`: without a colour there is nothing to click,
                        and a control the merchant cannot find is the defect
                        being fixed. */}
                    <SwatchPreview name={title} swatch={liveSwatch} showEmpty />
                  </button>
                }
              >
                <Popover.Section>
                  <BlockStack gap="200">
                    {colorControl}
                    {/* The storefront claim is only made where the entry is
                        KNOWN to be used as an option value. On an entry no
                        product references, "this changes your storefront
                        swatch" is simply untrue — and an unknown usage is not
                        a licence to say it either. */}
                    {colorNote && usage?.state === "known" && usage.products > 0 && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {colorNote}
                      </Text>
                    )}
                  </BlockStack>
                </Popover.Section>
              </Popover>
            ) : (
              <SwatchPreview name={title} swatch={liveSwatch} />
            )}
            <BlockStack gap="050">
              <InlineStack gap="150" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  {title}
                </Text>
                {justCreated && <Badge tone="success">{t.createdBadge || "Just created"}</Badge>}
              </InlineStack>
              {/* The handle and the colour warning are primary-locale facts;
                  on a language tab they are the same line on every card and
                  say nothing about the translation being written. */}
              {!compact && (
                <Text as="span" variant="bodySm" tone={colorInvalid ? "critical" : "subdued"}>
                  {colorInvalid
                    ? t.colorInvalid || "That is not a valid hex colour."
                    : handle
                      ? `${t.handleLabel || "Handle"}: ${handle}`
                      : entryId.split("/").pop()}
                </Text>
              )}
            </BlockStack>
          </InlineStack>

          {!compact && deleteButton && (
            // A DISABLED control dispatches no pointer events, so a bare
            // Tooltip around it never opens — the wrapper span is what makes
            // the reason readable at all.
            deleteBlockedReason ? (
              <Tooltip content={deleteBlockedReason} dismissOnMouseOut preferredPosition="below">
                <span style={{ display: "inline-block" }}>{deleteButton}</span>
              </Tooltip>
            ) : (
              deleteButton
            )
          )}
        </InlineStack>

        {!compact && readOnlyReason && (
          <Text as="p" variant="bodySm" tone="subdued">
            {readOnlyReason === "refused"
              ? t.readOnlyDefinition || "This app cannot change entries of this definition."
              : t.readOnlyUnknown || "Whether this definition is writable is unknown — reload to find out."}
          </Text>
        )}

        {children.length > 0 && (
          // A GRID rather than a stack. Every field used to get a full row of
          // its own, so a five-field entry was five screen-wide lines for
          // controls that are mostly one line tall — on a type with 25 entries
          // that is a page nobody can survey. `auto-fit` + `minmax` needs no
          // breakpoints: the row takes as many columns as fit at the current
          // width and stretches them, and below one column's minimum the
          // fields stack exactly as they did before.
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(var(--app-entry-field-min-width), 1fr))",
              gap: "var(--p-space-300)",
              // Fields differ in height (a text box next to a chip list), and
              // without this each row would stretch every control to the
              // tallest one in it.
              alignItems: "start",
            }}
          >
            {children.map((child) => (
              <div key={child.key} style={child.wide ? { gridColumn: "1 / -1" } : undefined}>
                {child.node}
              </div>
            ))}
          </div>
        )}
        {/* The COLOUR counts as an editable field even though it renders in the
            header — saying "nothing here can be edited" above a working colour
            picker is the kind of wrong that makes a merchant stop looking. */}
        {children.length === 0 && (compact || !colorControl) && (
          <Text as="p" variant="bodySm" tone="subdued">
            {compact
              ? t.noTranslatableFields || "This entry has no translatable fields."
              : t.noEditableFields || "None of this entry's fields can be edited here."}
          </Text>
        )}

        {!compact && unsupportedFields.length > 0 && (
          <BlockStack gap="050">
            <Text as="span" variant="bodySm" fontWeight="medium" tone="subdued">
              {t.unsupportedTitle || "Not editable here"}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {unsupportedFields.map((f) => `${f.label} (${f.fieldType || "?"})`).join(", ")}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {t.unsupportedHint || "This app has no editor for these field types. Edit them in the Shopify admin."}
            </Text>
          </BlockStack>
        )}

        {/* Usage belongs to DELETING an entry, and deleting is a
            primary-locale action. On a language tab it is one more line per
            card that never changes with the language. */}
        {!compact && (
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodySm" tone="subdued">
              {usageLine}
            </Text>
            {usage?.state === "unknown" && onSyncProducts && (
              <Button size="micro" variant="plain" onClick={onSyncProducts}>
                {t.syncProducts || "Sync products"}
              </Button>
            )}
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}
