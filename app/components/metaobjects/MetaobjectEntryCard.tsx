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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BlockStack, Badge, Button, Card, InlineStack, Popover, Text, Tooltip } from "@shopify/polaris";
import { SwatchPreview } from "./SwatchPreview";
import { useScrollLock } from "~/hooks/useScrollLock";
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
  /** Colour / image the entry's own fields describe, for the header swatch. */
  swatch?: OptionValueSwatch | null;
  /** Fields of the definition this app has no editor for: name + Shopify type. */
  unsupportedFields: Array<{ label: string; fieldType: string }>;
  /**
   * The entry's field controls, in two shapes — the ones it CAN edit, minus
   * the colour, which the header lifts out.
   *
   * A plain field is a BOX and goes into the card's grid, which fills the row
   * with as many of them as fit. `wide` marks the ones that are not boxes -- a
   * textarea, a rich-text preview, a chip list -- and those are laid out UNDER
   * the grid, each on its own line and capped at two columns' worth. They are
   * kept out of the grid rather than spanning it because a spanning cell keeps
   * every column alive, and `auto-fit` can then no longer collapse the empty
   * ones: one chip list at the top of a card left every box below it frozen at
   * its minimum width with half the card blank beside it.
   *
   * `lead` is the same escape hatch pointing the other way: a row of its own
   * ABOVE the grid. The image is the one field that earns it -- on a colour
   * entry it is the second thing the merchant looks at after the swatch, and
   * in the grid it took a text box's worth of width to render a 48px tile,
   * pushing the fields that actually hold text onto the next row.
   */
  children: Array<{ key: string; node: ReactNode; wide?: boolean; lead?: boolean }>;
  /**
   * The COLOUR control, lifted out of the field list into the header.
   *
   * A colour is the one field whose value the merchant reads as a picture
   * rather than as text, and the card already draws that picture at the top.
   * Leaving the control further down meant looking at the dot and reaching
   * somewhere else to change it. Absent when the definition has no colour
   * field, or when the entry is read-only — then the swatch stays a plain
   * swatch.
   */
  colorControl?: ReactNode;
  /** The colour as the EDITOR currently holds it, so the dot follows typing. */
  colorValue?: string;
  /** Sits under the colour control: what changing it actually does (V3). */
  colorNote?: string;
  /**
   * A FOREIGN locale: show the translatable fields and nothing else.
   *
   * Everything else on this card is primary-locale business. A colour, a file
   * reference and a taxonomy value have ONE value per shop, so in a foreign
   * locale they render read-only — a row of controls that cannot be used. The
   * handle, the usage line, the "not editable here" list and the delete button
   * say the same thing on every language tab, and none of it is what the
   * merchant came to this tab to do. Before the card existed, a foreign locale
   * WAS just the input and its buttons, and that was right.
   *
   * TWO things it does NOT hide. The swatch stays as a plain square — it is an
   * identifier, not a control, and with the handle line gone it is the only
   * thing besides the title that tells one colour entry from another. And a
   * definition this app may not write keeps its reason: the fields stay
   * disabled in a foreign locale too, so hiding the explanation leaves a grey
   * box and no answer.
   */
  compact?: boolean;
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
   * The page is frozen while the colour popover is up.
   *
   * A Polaris `Popover` is portalled to the document and positioned ONCE
   * against its activator, and the pages of this app do not scroll the
   * document -- `.app-page-content` is a non-scrolling frame whose single
   * child scrolls internally, which `PositionedOverlay` never learns about.
   * So a scroll under an open picker leaves it hanging over whatever slid
   * underneath it: the merchant opens a colour on the third card and the panel
   * ends up over the tenth. Same freeze the category picker and the chip
   * combobox already use, same hook.
   *
   * The pane is looked up per EVENT rather than held in a real ref: this
   * component does not render it (Polaris portals it out of the tree), so
   * there is nothing here to attach one to. `useScrollLock` reads `.current`
   * at event time, which is exactly what makes the getter work.
   *
   * Scoped to THIS card's popover through the activator, not
   * `document.querySelector(".Polaris-Popover__Pane")`: a type page renders 25
   * of these cards and the taxonomy chip lists open panes of their own, and a
   * document-wide query answers with whichever pane is first in the DOM. Two
   * can legitimately coexist -- Polaris ignores an outside click for the first
   * 100ms of its enter transition, so a merchant clicking two swatches quickly
   * has both open. Polaris writes the overlay's id onto the activator as
   * `aria-controls`, and that id sits on the popover's CONTENT element with the
   * Pane INSIDE it (verified against @shopify/polaris' PopoverOverlay) -- hence
   * `querySelector` and not `closest`. The global selector stays as the
   * fallback for the frame before Polaris has written the attribute.
   */
  const activatorRef = useRef<HTMLButtonElement | null>(null);
  const paneRef = useMemo(
    () => ({
      get current() {
        const overlayId = activatorRef.current?.getAttribute("aria-controls");
        const own = overlayId
          ? document.getElementById(overlayId)?.querySelector<HTMLElement>(".Polaris-Popover__Pane")
          : null;
        return (
          own ??
          document.querySelector<HTMLElement>(".Polaris-PositionedOverlay .Polaris-Popover__Pane")
        );
      },
    }),
    [],
  );

  /**
   * Is the picker actually ON SCREEN? The Popover below renders only while the
   * card is editable, and both conditions come from the PARENT -- an entry
   * reload that answers `readOnly`, or a switch to a language tab, takes the
   * control away without touching this component's state.
   *
   * Without this the card kept `colorOpen === true` with no popover left: the
   * window-wide wheel/touch block stayed registered around an overlay that had
   * unmounted, so nothing on the page scrolled any more and there was no panel
   * to close -- only a reload recovered. The state is reset as well as gated,
   * or the picker would spring open again by itself the moment the entry
   * became writable.
   */
  const colorPickerOpen = colorOpen && !compact && !!colorControl;
  useEffect(() => {
    if (colorOpen && (compact || !colorControl)) setColorOpen(false);
  }, [colorOpen, compact, colorControl]);
  useScrollLock(colorPickerOpen, paneRef);

  /**
   * The colour the swatch paints, preferring what the merchant has TYPED over
   * what the entry stores. Without this it would keep showing the saved colour
   * while the picker above it shows a different one.
   *
   * The stored IMAGE is dropped while the swatch is the colour control:
   * `resolveSwatch` prefers an image over a colour, so on an entry that has
   * both, the swatch would show the image and the colour picker behind it
   * would have no visible effect at all — a control whose result cannot be
   * seen.
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

  // The card's THREE regions, in the order they are drawn: lead, grid, wide.
  // Split here rather than in the caller: which shape a field has is a LAYOUT
  // question, and the page that renders the cards already answers enough of
  // them. A field is in exactly one region — `lead` wins over `wide`, so a
  // caller that marks both cannot land a field in two.
  const leadFields = useMemo(() => children.filter((child) => child.lead), [children]);
  const boxFields = useMemo(() => children.filter((child) => !child.lead && !child.wide), [children]);
  const wideFields = useMemo(() => children.filter((child) => !child.lead && child.wide), [children]);

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
            {/* In compact the swatch stays a plain SQUARE: it hides no
                control, and with the handle line gone the title would
                otherwise be the only thing telling "Gold" from "Bronze" while
                translating a colour type. Only the control behind it goes. */}
            {compact ? (
              <SwatchPreview name={title} swatch={liveSwatch} />
            ) : colorControl ? (
              // The swatch IS the control. A Popover rather than an inline field:
              // the header is a title row, and a colour picker parked in it
              // permanently would push the name off a narrow screen.
              <Popover
                active={colorPickerOpen}
                onClose={() => setColorOpen(false)}
                activator={
                  <button
                    type="button"
                    ref={activatorRef}
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
                      // The swatch's OWN corner token, so the focus/invalid
                      // ring traces the square instead of drawing a circle
                      // around it.
                      borderRadius: "var(--app-swatch-radius)",
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

        {/* NOT hidden by `compact`. Everything else this flag drops is
            reachable on the primary tab; this is the answer to "why can't I
            type here", and the fields stay disabled in a foreign locale too
            (`fieldsReadOnly` is locale-independent). Without it the merchant
            sees a greyed box and the generic field tooltip, which says the
            value "can still be translated into other languages" — on the very
            tab where that is being refused. */}
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
          // The three regions, and the widths they spend, live in
          // responsive.css. Order INSIDE each one is the definition's,
          // untouched; the split itself reorders two things, and both are
          // deliberate. "Boxes before lists" keeps the boxes packed into full
          // rows instead of leaving one stranded on a line of its own behind a
          // spanning cell. And the LEAD field is hoisted above everything —
          // the entry's picture, which in the grid claimed a whole text column
          // for a 48px tile.
          <BlockStack gap="400">
            {leadFields.map((child) => (
              <div key={child.key} className="metaobject-entry-fields__lead">
                {child.node}
              </div>
            ))}
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
        {children.length === 0 && (compact || !colorControl) && (
          <Text as="p" variant="bodySm" tone="subdued">
            {/* "no field THIS APP can translate HERE", not "this entry has no
                translatable fields". Rich text is read-only by policy and an
                unsupported type has no editor — neither is evidence that
                Shopify considers the key untranslatable, which is the
                `translatableContent` trap stated in the UI instead of in code.
                So it names the limit as ours and points at the admin. */}
            {compact
              ? t.noTranslatableFields ||
                "No field of this entry can be translated here — edit it in the Shopify admin."
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
