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
   * The entry's field controls, in two shapes.
   *
   * A plain field is a BOX and goes into the card's grid, which fills the row
   * with as many of them as fit. `wide` marks the ones that are not boxes -- a
   * textarea, a rich-text preview, a chip list -- and those are laid out UNDER
   * the grid, each on its own line and capped at two columns' worth. They are
   * kept out of the grid rather than spanning it because a spanning cell keeps
   * every column alive, and `auto-fit` can then no longer collapse the empty
   * ones: one chip list at the top of a card left every box below it frozen at
   * its minimum width with half the card blank beside it.
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

  // The card's two regions. Split here rather than in the caller: which shape
  // a field has is a LAYOUT question, and the page that renders the cards
  // already answers enough of them.
  const boxFields = useMemo(() => children.filter((child) => !child.wide), [children]);
  const wideFields = useMemo(() => children.filter((child) => child.wide), [children]);

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
            {colorControl ? (
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
              <Text as="span" variant="bodySm" tone={colorInvalid ? "critical" : "subdued"}>
                {colorInvalid
                  ? t.colorInvalid || "That is not a valid hex colour."
                  : handle
                    ? `${t.handleLabel || "Handle"}: ${handle}`
                    : entryId.split("/").pop()}
              </Text>
            </BlockStack>
          </InlineStack>

          {deleteButton && (
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

        {readOnlyReason && (
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
          // that is a page nobody can survey.
          //
          // The two regions, and the widths they spend, live in responsive.css.
          // Order inside each one is the definition's, untouched: the only
          // thing this split reorders is "boxes before lists", which is what
          // keeps the boxes packed into full rows instead of leaving one of
          // them stranded on a line of its own behind a spanning cell.
          <BlockStack gap="400">
            {boxFields.length > 0 && (
              <div className="metaobject-entry-fields">
                {boxFields.map((child) => (
                  <div key={child.key}>{child.node}</div>
                ))}
              </div>
            )}
            {wideFields.map((child) => (
              <div key={child.key} className="metaobject-entry-fields__wide">
                {child.node}
              </div>
            ))}
          </BlockStack>
        )}
        {/* The COLOUR counts as an editable field even though it renders in the
            header — saying "nothing here can be edited" above a working colour
            picker is the kind of wrong that makes a merchant stop looking. */}
        {children.length === 0 && !colorControl && (
          <Text as="p" variant="bodySm" tone="subdued">
            {t.noEditableFields || "None of this entry's fields can be edited here."}
          </Text>
        )}

        {unsupportedFields.length > 0 && (
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
      </BlockStack>
    </Card>
  );
}
